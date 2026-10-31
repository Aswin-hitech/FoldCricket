"""
Durable account storage in Neon Postgres (or any PostgreSQL server).

The backend connects directly with libpq over TLS using ``DATABASE_URL``.
Passwords never reach this module in plaintext: the account service hashes
them with Werkzeug (scrypt) first, so only the hash is stored, and session
tokens only ever arrive as SHA-256 hashes.

Tables are created by ``backend/neon/accounts_schema.sql``. Timestamps are
stored as ``timestamptz`` but are returned as naive UTC ISO strings, which is
the same contract the SQLite implementation and the account service expect.
"""

from __future__ import annotations

import logging
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator, Optional

import psycopg
from psycopg import errors as pg_errors
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool, PoolTimeout

logger = logging.getLogger(__name__)

USERS_TABLE = "app_users"
SESSIONS_TABLE = "app_user_sessions"

USER_COLUMNS = (
    "id",
    "username",
    "display_name",
    "password_hash",
    "friend_code",
    "avatar",
    "bio",
    "default_mode",
    "default_overs",
    "default_wickets",
    "created_at",
    "updated_at",
)

_SESSION_COLUMNS = (
    "id",
    "user_id",
    "token_hash",
    "user_agent",
    "created_at",
    "last_used_at",
    "expires_at",
)

_USER_SELECT = ", ".join(USER_COLUMNS)
_SESSION_SELECT = ", ".join(_SESSION_COLUMNS)

_INSERT_USER_COLUMNS = (
    "id",
    "username",
    "username_key",
    "display_name",
    "password_hash",
    "friend_code",
    "avatar",
    "bio",
    "default_mode",
    "default_overs",
    "default_wickets",
    "created_at",
    "updated_at",
)

_UPDATE_FIELDS = frozenset(
    {
        "display_name",
        "avatar",
        "bio",
        "default_mode",
        "default_overs",
        "default_wickets",
        "password_hash",
    }
)

_MAX_PAGE = 1000

_settings = {"dsn": "", "timeout": 8.0}
_pool: Optional[ConnectionPool] = None
_pool_lock = threading.Lock()


class PostgresStoreError(RuntimeError):
    """The remote account store is unreachable or answered unexpectedly."""


class DuplicateRowError(PostgresStoreError):
    """A unique column (username, friend code, token) is already taken."""


def configure(dsn: str, timeout: float = 8.0) -> None:
    """Point the store at a database. A changed DSN retires the old pool."""
    global _pool
    normalized = _normalize_dsn(dsn)
    with _pool_lock:
        if normalized != _settings["dsn"]:
            _close_pool_locked()
        _settings["dsn"] = normalized
        _settings["timeout"] = timeout


def configured() -> bool:
    return bool(_settings["dsn"])


def close() -> None:
    global _pool
    with _pool_lock:
        _close_pool_locked()


def _close_pool_locked() -> None:
    global _pool
    pool, _pool = _pool, None
    if pool is not None:
        try:
            pool.close(timeout=2.0)
        except Exception:
            pass


def _normalize_dsn(dsn: str) -> str:
    value = (dsn or "").strip()
    if not value:
        return ""
    if value.startswith("postgres://"):
        value = "postgresql://" + value[len("postgres://") :]
    if "://" not in value:
        return value
    separator = "&" if "?" in value else "?"
    if "neon.tech" in value and "sslmode=" not in value:
        value += f"{separator}sslmode=require"
        separator = "&"
    if "connect_timeout=" not in value:
        value += f"{separator}connect_timeout=10"
    return value


def _get_pool() -> ConnectionPool:
    global _pool
    if not configured():
        raise PostgresStoreError("postgres_account_store_not_configured")
    with _pool_lock:
        if _pool is None:
            pool = ConnectionPool(
                conninfo=_settings["dsn"],
                min_size=1,
                max_size=5,
                timeout=_settings["timeout"],
                max_idle=240,
                max_lifetime=1800,
                open=False,
                check=ConnectionPool.check_connection,
                kwargs={"application_name": "handcricket-accounts"},
                name="handcricket-accounts",
            )
            try:
                pool.open(wait=True, timeout=_settings["timeout"])
            except Exception as error:
                try:
                    pool.close(timeout=1.0)
                except Exception:
                    pass
                raise PostgresStoreError(
                    f"postgres_unreachable: {type(error).__name__}"
                ) from None
            _pool = pool
    return _pool


@contextmanager
def _connection() -> Iterator[psycopg.Connection]:
    pool = _get_pool()
    try:
        with pool.connection() as conn:
            yield conn
    except PostgresStoreError:
        raise
    except pg_errors.UniqueViolation as error:
        raise DuplicateRowError("duplicate_row") from error
    except (pg_errors.Error, PoolTimeout, OSError) as error:
        raise PostgresStoreError(f"postgres_error: {type(error).__name__}") from None


def _iso(value) -> object:
    """Naive UTC ISO string, matching the SQLite rows and service comparisons."""
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value.isoformat()
    return value


def _utc(value) -> object:
    """Read naive ISO input as UTC so a timestamptz column never shifts it."""
    if not isinstance(value, str) or not value:
        return value
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _user_row(row) -> Optional[dict]:
    if not row:
        return None
    user = {column: row.get(column) for column in USER_COLUMNS}
    user["created_at"] = _iso(user["created_at"])
    user["updated_at"] = _iso(user["updated_at"])
    return user


def _session_row(row) -> dict:
    session = {column: row.get(column) for column in _SESSION_COLUMNS}
    for field in ("created_at", "last_used_at", "expires_at"):
        session[field] = _iso(session[field])
    return session


def probe() -> bool:
    """True when both account tables exist and are readable."""
    if not configured():
        return False
    try:
        with _connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "select to_regclass('public.app_users'), "
                    "to_regclass('public.app_user_sessions')"
                )
                row = cur.fetchone()
                return bool(row and row[0] and row[1])
    except PostgresStoreError:
        return False


_ACCOUNT_SCHEMA_SQL = """
create table if not exists public.app_users (
    id              text primary key,
    username        text not null,
    username_key    text not null,
    display_name    text not null,
    password_hash   text not null,
    friend_code     text not null,
    avatar          text not null default '🏏',
    bio             text not null default '',
    default_mode    text not null default 'SOLO'
                    check (default_mode in ('SOLO', 'TEAM')),
    default_overs   integer not null default 2
                    check (default_overs between 1 and 10),
    default_wickets integer not null default 1
                    check (default_wickets between 1 and 10),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint app_users_username_key_unique unique (username_key),
    constraint app_users_friend_code_unique unique (friend_code)
);
create table if not exists public.app_user_sessions (
    id           text primary key,
    user_id      text not null
                 references public.app_users (id) on delete cascade,
    token_hash   text not null,
    user_agent   text not null default '',
    created_at   timestamptz not null default now(),
    last_used_at timestamptz not null default now(),
    expires_at   timestamptz not null,
    constraint app_user_sessions_token_hash_unique unique (token_hash)
);
create index if not exists idx_app_users_username_key
    on public.app_users (username_key);
create index if not exists idx_app_users_friend_code
    on public.app_users (friend_code);
create index if not exists idx_app_user_sessions_user
    on public.app_user_sessions (user_id);
create index if not exists idx_app_user_sessions_expires
    on public.app_user_sessions (expires_at);
"""


def ensure_schema() -> bool:
    """Create the two account tables on first boot. Idempotent."""
    if not configured():
        return False
    try:
        with _connection() as conn:
            with conn.cursor() as cur:
                cur.execute(_ACCOUNT_SCHEMA_SQL)
        return True
    except PostgresStoreError as error:
        logger.warning("Could not create the Neon/Postgres account tables: %s", error)
        return False


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
    user_id = str(uuid.uuid4())
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"""
                INSERT INTO public.{USERS_TABLE} (
                    id, username, username_key, display_name, password_hash,
                    friend_code, avatar, bio, default_mode, default_overs,
                    default_wickets, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, '', 'SOLO', 2, 1, now(), now())
                RETURNING {_USER_SELECT}
                """,
                (
                    user_id,
                    username,
                    username.strip().lower(),
                    display_name,
                    password_hash,
                    friend_code,
                    avatar,
                ),
            )
            user = _user_row(cur.fetchone())
    if not user:
        raise PostgresStoreError("postgres_create_user_missing_row")
    return user


def get_user_by_id(user_id: str) -> Optional[dict]:
    if not user_id:
        return None
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"SELECT {_USER_SELECT} FROM public.{USERS_TABLE} "
                "WHERE id = %s LIMIT 1",
                (user_id,),
            )
            return _user_row(cur.fetchone())


def get_user_by_username(username: str) -> Optional[dict]:
    if not username:
        return None
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"SELECT {_USER_SELECT} FROM public.{USERS_TABLE} "
                "WHERE username_key = %s LIMIT 1",
                (username.strip().lower(),),
            )
            return _user_row(cur.fetchone())


def get_user_by_friend_code(code: str) -> Optional[dict]:
    if not code:
        return None
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"SELECT {_USER_SELECT} FROM public.{USERS_TABLE} "
                "WHERE friend_code = %s LIMIT 1",
                (code.strip().upper(),),
            )
            return _user_row(cur.fetchone())


def friend_code_exists(code: str) -> bool:
    if not code:
        return False
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT 1 FROM public.{USERS_TABLE} WHERE friend_code = %s LIMIT 1",
                (code.strip().upper(),),
            )
            return cur.fetchone() is not None


def username_exists(username: str) -> bool:
    if not username:
        return False
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT 1 FROM public.{USERS_TABLE} WHERE username_key = %s LIMIT 1",
                (username.strip().lower(),),
            )
            return cur.fetchone() is not None


def get_users_by_ids(user_ids: list[str]) -> list[dict]:
    ids = [user_id for user_id in dict.fromkeys(user_ids) if user_id]
    if not ids:
        return []
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"SELECT {_USER_SELECT} FROM public.{USERS_TABLE} WHERE id = ANY(%s)",
                (ids,),
            )
            return [row for row in (_user_row(item) for item in cur.fetchall()) if row]


def update_user(user_id: str, fields: dict) -> Optional[dict]:
    updates = {key: value for key, value in fields.items() if key in _UPDATE_FIELDS}
    if not updates:
        return get_user_by_id(user_id)
    assignments = ", ".join(f"{key} = %s" for key in updates)
    params = list(updates.values()) + [user_id]
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"UPDATE public.{USERS_TABLE} SET {assignments}, updated_at = now() "
                f"WHERE id = %s RETURNING {_USER_SELECT}",
                params,
            )
            return _user_row(cur.fetchone())


def upsert_users(users: list[dict]) -> None:
    if not users:
        return
    rows = [
        tuple(
            _utc(user.get(column))
            if column in ("created_at", "updated_at")
            else str(user.get("username") or "").strip().lower()
            if column == "username_key"
            else user.get(column)
            for column in _INSERT_USER_COLUMNS
        )
        for user in users
    ]
    placeholders = ", ".join("%s" for _ in _INSERT_USER_COLUMNS)
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                f"""
                INSERT INTO public.{USERS_TABLE} ({", ".join(_INSERT_USER_COLUMNS)})
                VALUES ({placeholders})
                ON CONFLICT (id) DO UPDATE SET
                    username = EXCLUDED.username,
                    username_key = EXCLUDED.username_key,
                    display_name = EXCLUDED.display_name,
                    password_hash = EXCLUDED.password_hash,
                    friend_code = EXCLUDED.friend_code,
                    avatar = EXCLUDED.avatar,
                    bio = EXCLUDED.bio,
                    default_mode = EXCLUDED.default_mode,
                    default_overs = EXCLUDED.default_overs,
                    default_wickets = EXCLUDED.default_wickets,
                    updated_at = EXCLUDED.updated_at
                """,
                rows,
            )


def fetch_all_users() -> list[dict]:
    users: list[dict] = []
    offset = 0
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            while True:
                cur.execute(
                    f"SELECT {_USER_SELECT} FROM public.{USERS_TABLE} "
                    "ORDER BY created_at ASC, id ASC LIMIT %s OFFSET %s",
                    (_MAX_PAGE, offset),
                )
                page = cur.fetchall()
                users.extend(row for row in (_user_row(item) for item in page) if row)
                if len(page) < _MAX_PAGE:
                    return users
                offset += _MAX_PAGE


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
    session_id = str(uuid.uuid4())
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO public.{SESSIONS_TABLE} (
                    id, user_id, token_hash, user_agent,
                    created_at, last_used_at, expires_at
                )
                VALUES (%s, %s, %s, %s, now(), now(), %s)
                """,
                (
                    session_id,
                    user_id,
                    token_hash,
                    (user_agent or "")[:255],
                    _utc(expires_at),
                ),
            )
    return {"id": session_id, "user_id": user_id, "expires_at": expires_at}


def get_session(token_hash: str) -> Optional[dict]:
    if not token_hash:
        return None
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"""
                SELECT
                    s.id AS session_id,
                    s.expires_at AS session_expires_at,
                    s.last_used_at AS session_last_used_at,
                    u.id, u.username, u.display_name, u.password_hash,
                    u.friend_code, u.avatar, u.bio, u.default_mode,
                    u.default_overs, u.default_wickets, u.created_at, u.updated_at
                FROM public.{SESSIONS_TABLE} s
                JOIN public.{USERS_TABLE} u ON u.id = s.user_id
                WHERE s.token_hash = %s
                LIMIT 1
                """,
                (token_hash,),
            )
            row = cur.fetchone()
    user = _user_row(row)
    if not user:
        return None
    user["session_id"] = row["session_id"]
    user["session_expires_at"] = _iso(row["session_expires_at"])
    user["session_last_used_at"] = _iso(row["session_last_used_at"])
    return user


def touch_session(session_id: str, expires_at: str) -> None:
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE public.{SESSIONS_TABLE} "
                "SET last_used_at = now(), expires_at = %s WHERE id = %s",
                (_utc(expires_at), session_id),
            )


def delete_session(token_hash: str) -> None:
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"DELETE FROM public.{SESSIONS_TABLE} WHERE token_hash = %s",
                (token_hash,),
            )


def delete_other_sessions(user_id: str, keep_session_id: str) -> None:
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"DELETE FROM public.{SESSIONS_TABLE} WHERE user_id = %s AND id <> %s",
                (user_id, keep_session_id),
            )


def purge_expired_sessions() -> None:
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.execute(f"DELETE FROM public.{SESSIONS_TABLE} WHERE expires_at < now()")


def fetch_all_sessions() -> list[dict]:
    sessions: list[dict] = []
    offset = 0
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            while True:
                cur.execute(
                    f"SELECT {_SESSION_SELECT} FROM public.{SESSIONS_TABLE} "
                    "ORDER BY created_at ASC, id ASC LIMIT %s OFFSET %s",
                    (_MAX_PAGE, offset),
                )
                page = cur.fetchall()
                sessions.extend(_session_row(item) for item in page)
                if len(page) < _MAX_PAGE:
                    return sessions
                offset += _MAX_PAGE


def upsert_sessions(sessions: list[dict]) -> None:
    if not sessions:
        return
    rows = [
        tuple(
            _utc(session.get(column))
            if column in ("created_at", "last_used_at", "expires_at")
            else session.get(column)
            for column in _SESSION_COLUMNS
        )
        for session in sessions
    ]
    placeholders = ", ".join("%s" for _ in _SESSION_COLUMNS)
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                f"""
                INSERT INTO public.{SESSIONS_TABLE} ({", ".join(_SESSION_COLUMNS)})
                VALUES ({placeholders})
                ON CONFLICT (id) DO UPDATE SET
                    token_hash = EXCLUDED.token_hash,
                    user_agent = EXCLUDED.user_agent,
                    created_at = EXCLUDED.created_at,
                    last_used_at = EXCLUDED.last_used_at,
                    expires_at = EXCLUDED.expires_at
                """,
                rows,
            )
