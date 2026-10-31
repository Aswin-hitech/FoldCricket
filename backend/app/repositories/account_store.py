"""
Account storage selection.

Players are stored either in the local SQLite file (default, used by tests and
offline development) or in Neon Postgres (any PostgreSQL database). In Postgres
mode every user/session write is also mirrored into the local file so the
existing SQL joins (friend lists, user search) keep working unchanged, and the
local file is reconciled with Postgres at startup.

Only users and sessions live here. Friendships, match stats and achievements
stay in the local repository, exactly as before.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from datetime import datetime
from typing import Optional

from . import postgres_accounts
from .sqlite import _get_connection, _lock

logger = logging.getLogger(__name__)

BACKEND_SQLITE = "sqlite"
BACKEND_POSTGRES = "postgres"

_USER_COLUMNS = (
    "id, username, display_name, password_hash, friend_code, avatar, bio, "
    "default_mode, default_overs, default_wickets, created_at, updated_at"
)
_USER_FIELDS = tuple(column.strip() for column in _USER_COLUMNS.split(","))

UserStoreConflict = postgres_accounts.DuplicateRowError

_state = {"backend": BACKEND_SQLITE}
_cache: dict[tuple[str, str], tuple[float, dict]] = {}
_CACHE_TTL_SECONDS = 20.0


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _row_to_user(row) -> dict:
    return {column: row[column] for column in _USER_FIELDS}


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------

def configure(config) -> str:
    """Pick the account backend once per application boot."""
    requested = str(config.get("USER_STORE", "auto") or "auto").strip().lower()
    postgres_accounts.configure(config.get("DATABASE_URL", "") or "")

    backend = BACKEND_SQLITE
    if requested in (BACKEND_POSTGRES, "neon", "auto"):
        if not postgres_accounts.configured():
            if requested in (BACKEND_POSTGRES, "neon"):
                logger.warning(
                    "USER_STORE=%s but DATABASE_URL is missing; falling back to the "
                    "local account store.",
                    requested,
                )
        elif postgres_accounts.probe():
            backend = BACKEND_POSTGRES
        elif postgres_accounts.ensure_schema() and postgres_accounts.probe():
            logger.info("Created the missing Neon/Postgres account tables.")
            backend = BACKEND_POSTGRES
        else:
            logger.warning(
                "Neon/Postgres is unreachable or the account tables could not be "
                "created; using the local account store. Check DATABASE_URL and "
                "the database role's CREATE permission."
            )

    _state["backend"] = backend
    _cache.clear()
    return backend


def active_backend() -> str:
    return _state["backend"]


def is_postgres() -> bool:
    return _state["backend"] == BACKEND_POSTGRES


def set_backend_for_tests(backend: str) -> None:
    _state["backend"] = backend
    _cache.clear()


# ---------------------------------------------------------------------------
# User cache (Postgres mode only; avoids one query per friend/profile row)
# ---------------------------------------------------------------------------

def _cache_key(kind: str, value: str) -> tuple[str, str]:
    return (kind, value)


def _cache_get(kind: str, value: str) -> Optional[dict]:
    entry = _cache.get(_cache_key(kind, value))
    if not entry:
        return None
    expires_at, user = entry
    if expires_at < time.monotonic():
        _cache.pop(_cache_key(kind, value), None)
        return None
    return dict(user)


def _cache_put(user: Optional[dict]) -> None:
    if not user:
        return
    expires_at = time.monotonic() + _CACHE_TTL_SECONDS
    snapshot = dict(user)
    keys = [("id", str(user.get("id") or ""))]
    if user.get("username"):
        keys.append(("username", str(user["username"]).lower()))
    if user.get("friend_code"):
        keys.append(("code", str(user["friend_code"]).upper()))
    for kind, value in keys:
        if value:
            _cache[_cache_key(kind, value)] = (expires_at, snapshot)


def _cache_clear() -> None:
    _cache.clear()


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

def create_user(
    *,
    username: str,
    display_name: str,
    password_hash: str,
    friend_code: str,
    avatar: str,
) -> dict:
    if not is_postgres():
        return _sqlite_create_user(
            username=username,
            display_name=display_name,
            password_hash=password_hash,
            friend_code=friend_code,
            avatar=avatar,
        )

    user = postgres_accounts.create_user(
        username=username,
        display_name=display_name,
        password_hash=password_hash,
        friend_code=friend_code,
        avatar=avatar,
    )
    _cache_put(user)
    _mirror_user(user)
    return user


def get_user_by_id(user_id: str) -> Optional[dict]:
    if not is_postgres():
        return _sqlite_get_user("id", user_id)
    if not user_id:
        return None
    cached = _cache_get("id", user_id)
    if cached:
        return cached
    user = postgres_accounts.get_user_by_id(user_id)
    _cache_put(user)
    return user


def get_user_by_username(username: str) -> Optional[dict]:
    if not is_postgres():
        return _sqlite_get_user("username", username)
    if not username:
        return None
    key = username.strip().lower()
    cached = _cache_get("username", key)
    if cached:
        return cached
    user = postgres_accounts.get_user_by_username(username)
    _cache_put(user)
    return user


def get_user_by_friend_code(code: str) -> Optional[dict]:
    if not is_postgres():
        return _sqlite_get_user("code", code)
    if not code:
        return None
    key = code.strip().upper()
    cached = _cache_get("code", key)
    if cached:
        return cached
    user = postgres_accounts.get_user_by_friend_code(code)
    _cache_put(user)
    return user


def get_users_by_ids(user_ids: list[str]) -> dict[str, dict]:
    ids = [uid for uid in dict.fromkeys(user_ids) if uid]
    if not ids:
        return {}
    if not is_postgres():
        found = _sqlite_get_users_by_ids(ids)
        return {user["id"]: user for user in found}

    result: dict[str, dict] = {}
    missing: list[str] = []
    for user_id in ids:
        cached = _cache_get("id", user_id)
        if cached:
            result[user_id] = cached
        else:
            missing.append(user_id)
    if missing:
        for user in postgres_accounts.get_users_by_ids(missing):
            _cache_put(user)
            result[user["id"]] = user
    return result


def friend_code_exists(code: str) -> bool:
    if not is_postgres():
        return _sqlite_friend_code_exists(code)
    return postgres_accounts.friend_code_exists(code)


def username_exists(username: str) -> bool:
    if not is_postgres():
        return _sqlite_username_exists(username)
    return postgres_accounts.username_exists(username)


def update_user(user_id: str, fields: dict) -> Optional[dict]:
    if not is_postgres():
        return _sqlite_update_user(user_id, fields)
    user = postgres_accounts.update_user(user_id, fields)
    _cache_clear()
    if user:
        _cache_put(user)
        _mirror_user(user)
    return user


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def create_session(
    *,
    user_id: str,
    token_hash: str,
    user_agent: str,
    expires_at: str,
) -> dict:
    if not is_postgres():
        return _sqlite_create_session(
            user_id=user_id,
            token_hash=token_hash,
            user_agent=user_agent,
            expires_at=expires_at,
        )
    session = postgres_accounts.create_session(
        user_id=user_id,
        token_hash=token_hash,
        user_agent=user_agent,
        expires_at=expires_at,
    )
    _mirror_session(
        {
            "id": session["id"],
            "user_id": user_id,
            "token_hash": token_hash,
            "user_agent": (user_agent or "")[:255],
            "created_at": _now_iso(),
            "last_used_at": _now_iso(),
            "expires_at": expires_at,
        }
    )
    return session


def get_session(token_hash: str) -> Optional[dict]:
    if not is_postgres():
        return _sqlite_get_session(token_hash)
    return postgres_accounts.get_session(token_hash)


def touch_session(session_id: str, expires_at: str) -> None:
    if not is_postgres():
        _sqlite_touch_session(session_id, expires_at)
        return
    postgres_accounts.touch_session(session_id, expires_at)
    _mirror_session_update(session_id, {"last_used_at": _now_iso(), "expires_at": expires_at})


def delete_session(token_hash: str) -> None:
    if not is_postgres():
        _sqlite_delete_session(token_hash)
        return
    postgres_accounts.delete_session(token_hash)
    _mirror_session_delete(token_hash)


def delete_other_sessions(user_id: str, keep_session_id: str) -> None:
    if not is_postgres():
        _sqlite_delete_other_sessions(user_id, keep_session_id)
        return
    postgres_accounts.delete_other_sessions(user_id, keep_session_id)
    with _lock, _get_connection() as conn:
        conn.execute(
            "DELETE FROM user_sessions WHERE user_id = ? AND id != ?",
            (user_id, keep_session_id),
        )


def purge_expired_sessions() -> None:
    if not is_postgres():
        _sqlite_purge_expired_sessions()
        return
    postgres_accounts.purge_expired_sessions()
    with _lock, _get_connection() as conn:
        conn.execute("DELETE FROM user_sessions WHERE expires_at < ?", (_now_iso(),))


# ---------------------------------------------------------------------------
# SQLite implementation
# ---------------------------------------------------------------------------

def _sqlite_create_user(
    *,
    username: str,
    display_name: str,
    password_hash: str,
    friend_code: str,
    avatar: str,
) -> dict:
    import uuid

    user_id = str(uuid.uuid4())
    now = _now_iso()
    with _lock, _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO users (
                id, username, display_name, password_hash, friend_code, avatar,
                bio, default_mode, default_overs, default_wickets, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, '', 'SOLO', 2, 1, ?, ?)
            """,
            (user_id, username, display_name, password_hash, friend_code, avatar, now, now),
        )
        row = conn.execute(
            f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    return _row_to_user(row)


def _sqlite_get_user(kind: str, value: str) -> Optional[dict]:
    if not value:
        return None
    with _lock, _get_connection() as conn:
        if kind == "id":
            row = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (value,)
            ).fetchone()
        elif kind == "username":
            row = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users WHERE username = ? COLLATE NOCASE",
                (value.strip(),),
            ).fetchone()
        elif kind == "code":
            row = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users WHERE friend_code = ?",
                (value.strip().upper(),),
            ).fetchone()
        else:
            return None
    return _row_to_user(row) if row else None


def _sqlite_get_users_by_ids(user_ids: list[str]) -> list[dict]:
    users: list[dict] = []
    for start in range(0, len(user_ids), 200):
        chunk = user_ids[start : start + 200]
        placeholders = ",".join("?" for _ in chunk)
        with _lock, _get_connection() as conn:
            rows = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users WHERE id IN ({placeholders})",
                tuple(chunk),
            ).fetchall()
        users.extend(_row_to_user(row) for row in rows)
    return users


def _sqlite_friend_code_exists(code: str) -> bool:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM users WHERE friend_code = ?", (code.upper(),)
        ).fetchone()
    return row is not None


def _sqlite_username_exists(username: str) -> bool:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ).fetchone()
    return row is not None


def _sqlite_update_user(user_id: str, fields: dict) -> Optional[dict]:
    allowed = {
        "display_name",
        "avatar",
        "bio",
        "default_mode",
        "default_overs",
        "default_wickets",
        "password_hash",
    }
    updates = {key: value for key, value in fields.items() if key in allowed}
    if not updates:
        return _sqlite_get_user("id", user_id)
    updates["updated_at"] = _now_iso()
    assignments = ", ".join(f"{key} = ?" for key in updates)
    values = list(updates.values()) + [user_id]
    with _lock, _get_connection() as conn:
        conn.execute(f"UPDATE users SET {assignments} WHERE id = ?", values)
        row = conn.execute(
            f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    return _row_to_user(row) if row else None


def _sqlite_create_session(
    *,
    user_id: str,
    token_hash: str,
    user_agent: str,
    expires_at: str,
) -> dict:
    import uuid

    session_id = str(uuid.uuid4())
    now = _now_iso()
    with _lock, _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO user_sessions (
                id, user_id, token_hash, user_agent, created_at, last_used_at, expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (session_id, user_id, token_hash, user_agent[:255], now, now, expires_at),
        )
    return {"id": session_id, "user_id": user_id, "expires_at": expires_at}


def _sqlite_get_session(token_hash: str) -> Optional[dict]:
    if not token_hash:
        return None
    with _lock, _get_connection() as conn:
        row = conn.execute(
            """
            SELECT s.id AS session_id, s.user_id AS session_user_id,
                   s.expires_at AS session_expires_at, s.last_used_at AS session_last_used_at,
                   u.id, u.username, u.display_name, u.password_hash, u.friend_code,
                   u.avatar, u.bio, u.default_mode, u.default_overs, u.default_wickets,
                   u.created_at, u.updated_at
            FROM user_sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
    if not row:
        return None
    user = _row_to_user(row)
    user["session_id"] = row["session_id"]
    user["session_expires_at"] = row["session_expires_at"]
    user["session_last_used_at"] = row["session_last_used_at"]
    return user


def _sqlite_touch_session(session_id: str, expires_at: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute(
            "UPDATE user_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?",
            (_now_iso(), expires_at, session_id),
        )


def _sqlite_delete_session(token_hash: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute("DELETE FROM user_sessions WHERE token_hash = ?", (token_hash,))


def _sqlite_delete_other_sessions(user_id: str, keep_session_id: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute(
            "DELETE FROM user_sessions WHERE user_id = ? AND id != ?",
            (user_id, keep_session_id),
        )


def _sqlite_purge_expired_sessions() -> None:
    with _lock, _get_connection() as conn:
        conn.execute("DELETE FROM user_sessions WHERE expires_at < ?", (_now_iso(),))


# ---------------------------------------------------------------------------
# Local mirror (Postgres mode)
# ---------------------------------------------------------------------------

def _mirror_user(user: Optional[dict]) -> None:
    if not user:
        return
    try:
        with _lock, _get_connection() as conn:
            conn.execute(
                """
                INSERT INTO users (
                    id, username, display_name, password_hash, friend_code, avatar,
                    bio, default_mode, default_overs, default_wickets, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    username=excluded.username,
                    display_name=excluded.display_name,
                    password_hash=excluded.password_hash,
                    friend_code=excluded.friend_code,
                    avatar=excluded.avatar,
                    bio=excluded.bio,
                    default_mode=excluded.default_mode,
                    default_overs=excluded.default_overs,
                    default_wickets=excluded.default_wickets,
                    updated_at=excluded.updated_at
                """,
                tuple(user.get(field) for field in _USER_FIELDS),
            )
    except sqlite3.IntegrityError:
        logger.warning("Local mirror skipped a user row that conflicts with an existing row.")


def _mirror_session(session: dict) -> None:
    try:
        with _lock, _get_connection() as conn:
            conn.execute(
                """
                INSERT INTO user_sessions (
                    id, user_id, token_hash, user_agent, created_at, last_used_at, expires_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    last_used_at=excluded.last_used_at,
                    expires_at=excluded.expires_at
                """,
                (
                    session["id"],
                    session["user_id"],
                    session["token_hash"],
                    session.get("user_agent", ""),
                    session.get("created_at") or _now_iso(),
                    session.get("last_used_at") or _now_iso(),
                    session.get("expires_at"),
                ),
            )
    except sqlite3.IntegrityError:
        logger.warning("Local mirror skipped a session row that conflicts with an existing row.")


def _mirror_session_update(session_id: str, fields: dict) -> None:
    with _lock, _get_connection() as conn:
        conn.execute(
            "UPDATE user_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?",
            (
                fields.get("last_used_at"),
                fields.get("expires_at"),
                session_id,
            ),
        )


def _mirror_session_delete(token_hash: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute("DELETE FROM user_sessions WHERE token_hash = ?", (token_hash,))


def _sqlite_list_users() -> list[dict]:
    with _lock, _get_connection() as conn:
        rows = conn.execute(f"SELECT {_USER_COLUMNS} FROM users").fetchall()
    return [_row_to_user(row) for row in rows]


def _sqlite_list_sessions() -> list[dict]:
    with _lock, _get_connection() as conn:
        rows = conn.execute("SELECT * FROM user_sessions").fetchall()
    return [dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Startup reconciliation
# ---------------------------------------------------------------------------

def reconcile() -> dict:
    """Union of Postgres and local rows, Postgres winning on conflicts.

    Runs once at boot in Postgres mode. It hydrates the local mirror so joins
    and search work, and pushes any accounts/sessions created while the local
    store was active into Postgres so a config change or short outage cannot
    strand them.
    """
    if not is_postgres():
        return {"users": 0, "sessions": 0}

    try:
        remote_users = postgres_accounts.fetch_all_users()
        remote_sessions = postgres_accounts.fetch_all_sessions()
    except postgres_accounts.PostgresStoreError as error:
        logger.warning("Postgres account sync skipped: %s", error)
        return {"users": 0, "sessions": 0}

    remote_user_ids = {user["id"] for user in remote_users}
    local_only_users = [
        user for user in _sqlite_list_users() if user["id"] not in remote_user_ids
    ]
    if local_only_users:
        try:
            postgres_accounts.upsert_users(local_only_users)
            logger.info("Pushed %s local account(s) to Postgres.", len(local_only_users))
        except postgres_accounts.PostgresStoreError as error:
            logger.warning("Could not push local accounts to Postgres: %s", error)

    mirrored = 0
    for user in remote_users:
        _mirror_user(user)
        _cache_put(user)
        mirrored += 1

    now = _now_iso()
    remote_session_ids = {session["id"] for session in remote_sessions}
    local_only_sessions = [
        session
        for session in _sqlite_list_sessions()
        if session["id"] not in remote_session_ids
        and str(session.get("expires_at") or "") > now
    ]
    if local_only_sessions:
        try:
            postgres_accounts.upsert_sessions(local_only_sessions)
            logger.info("Pushed %s local session(s) to Postgres.", len(local_only_sessions))
        except postgres_accounts.PostgresStoreError as error:
            logger.warning("Could not push local sessions to Postgres: %s", error)

    for session in remote_sessions:
        _mirror_session(session)

    return {"users": mirrored, "sessions": len(remote_sessions)}
