"""
Account, session, friendship, match-stat and achievement persistence.

Kept separate from the gameplay repository: these rows are durable and are
never purged with finished rooms/players, so profile stats survive room
cleanup and process restarts.
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime
from typing import Optional

from .sqlite import _get_connection, _lock

_USER_COLUMNS = (
    "id, username, display_name, password_hash, friend_code, avatar, bio, "
    "default_mode, default_overs, default_wickets, created_at, updated_at"
)


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _row_to_user(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "password_hash": row["password_hash"],
        "friend_code": row["friend_code"],
        "avatar": row["avatar"],
        "bio": row["bio"],
        "default_mode": row["default_mode"],
        "default_overs": row["default_overs"],
        "default_wickets": row["default_wickets"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


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
        row = conn.execute(f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row)


def get_user_by_id(user_id: str) -> Optional[dict]:
    if not user_id:
        return None
    with _lock, _get_connection() as conn:
        row = conn.execute(f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row) if row else None


def get_user_by_username(username: str) -> Optional[dict]:
    if not username:
        return None
    with _lock, _get_connection() as conn:
        row = conn.execute(
            f"SELECT {_USER_COLUMNS} FROM users WHERE username = ? COLLATE NOCASE",
            (username.strip(),),
        ).fetchone()
    return _row_to_user(row) if row else None


def get_user_by_friend_code(code: str) -> Optional[dict]:
    if not code:
        return None
    with _lock, _get_connection() as conn:
        row = conn.execute(
            f"SELECT {_USER_COLUMNS} FROM users WHERE friend_code = ?",
            (code.strip().upper(),),
        ).fetchone()
    return _row_to_user(row) if row else None


def friend_code_exists(code: str) -> bool:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM users WHERE friend_code = ?", (code.upper(),)
        ).fetchone()
    return row is not None


def username_exists(username: str) -> bool:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", (username,)
        ).fetchone()
    return row is not None


def update_user(user_id: str, fields: dict) -> Optional[dict]:
    allowed = {
        "display_name",
        "avatar",
        "bio",
        "default_mode",
        "default_overs",
        "default_wickets",
        "password_hash",
    }
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return get_user_by_id(user_id)
    updates["updated_at"] = _now_iso()
    assignments = ", ".join(f"{key} = ?" for key in updates)
    values = list(updates.values()) + [user_id]
    with _lock, _get_connection() as conn:
        conn.execute(f"UPDATE users SET {assignments} WHERE id = ?", values)
        row = conn.execute(f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (user_id,)).fetchone()
    return _row_to_user(row) if row else None


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


def get_session(token_hash: str) -> Optional[dict]:
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


def touch_session(session_id: str, expires_at: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute(
            "UPDATE user_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?",
            (_now_iso(), expires_at, session_id),
        )


def delete_session(token_hash: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute("DELETE FROM user_sessions WHERE token_hash = ?", (token_hash,))


def delete_other_sessions(user_id: str, keep_session_id: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute(
            "DELETE FROM user_sessions WHERE user_id = ? AND id != ?",
            (user_id, keep_session_id),
        )


def purge_expired_sessions() -> None:
    with _lock, _get_connection() as conn:
        conn.execute("DELETE FROM user_sessions WHERE expires_at < ?", (_now_iso(),))


# ---------------------------------------------------------------------------
# Friendships
# ---------------------------------------------------------------------------

def get_friendship_between(user_a: str, user_b: str) -> Optional[dict]:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            """
            SELECT * FROM friendships
            WHERE (requester_id = ? AND addressee_id = ?)
               OR (requester_id = ? AND addressee_id = ?)
            LIMIT 1
            """,
            (user_a, user_b, user_b, user_a),
        ).fetchone()
    return dict(row) if row else None


def get_friendship(friendship_id: str) -> Optional[dict]:
    with _lock, _get_connection() as conn:
        row = conn.execute("SELECT * FROM friendships WHERE id = ?", (friendship_id,)).fetchone()
    return dict(row) if row else None


def create_friendship(requester_id: str, addressee_id: str, status: str = "PENDING") -> dict:
    friendship_id = str(uuid.uuid4())
    now = _now_iso()
    with _lock, _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (friendship_id, requester_id, addressee_id, status, now, now),
        )
    return {
        "id": friendship_id,
        "requester_id": requester_id,
        "addressee_id": addressee_id,
        "status": status,
        "created_at": now,
        "updated_at": now,
    }


def set_friendship_status(friendship_id: str, status: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute(
            "UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?",
            (status, _now_iso(), friendship_id),
        )


def delete_friendship(friendship_id: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute("DELETE FROM friendships WHERE id = ?", (friendship_id,))


def delete_friendship_between(user_a: str, user_b: str) -> bool:
    with _lock, _get_connection() as conn:
        cursor = conn.execute(
            """
            DELETE FROM friendships
            WHERE (requester_id = ? AND addressee_id = ?)
               OR (requester_id = ? AND addressee_id = ?)
            """,
            (user_a, user_b, user_b, user_a),
        )
    return cursor.rowcount > 0


def _friend_rows(query: str, params: tuple) -> list[dict]:
    with _lock, _get_connection() as conn:
        rows = conn.execute(query, params).fetchall()
    return [dict(row) for row in rows]


def list_friends(user_id: str) -> list[dict]:
    return _friend_rows(
        """
        SELECT f.id AS friendship_id, f.created_at AS friends_since,
               u.id, u.username, u.display_name, u.avatar, u.friend_code, u.bio
        FROM friendships f
        JOIN users u ON u.id = CASE
            WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
        WHERE f.status = 'ACCEPTED' AND (f.requester_id = ? OR f.addressee_id = ?)
        ORDER BY u.display_name COLLATE NOCASE ASC
        """,
        (user_id, user_id, user_id),
    )


def list_incoming_requests(user_id: str) -> list[dict]:
    return _friend_rows(
        """
        SELECT f.id AS friendship_id, f.created_at AS requested_at,
               u.id, u.username, u.display_name, u.avatar, u.friend_code, u.bio
        FROM friendships f
        JOIN users u ON u.id = f.requester_id
        WHERE f.addressee_id = ? AND f.status = 'PENDING'
        ORDER BY f.created_at DESC
        """,
        (user_id,),
    )


def list_outgoing_requests(user_id: str) -> list[dict]:
    return _friend_rows(
        """
        SELECT f.id AS friendship_id, f.created_at AS requested_at,
               u.id, u.username, u.display_name, u.avatar, u.friend_code, u.bio
        FROM friendships f
        JOIN users u ON u.id = f.addressee_id
        WHERE f.requester_id = ? AND f.status = 'PENDING'
        ORDER BY f.created_at DESC
        """,
        (user_id,),
    )


def count_friends(user_id: str) -> int:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS n FROM friendships
            WHERE status = 'ACCEPTED' AND (requester_id = ? OR addressee_id = ?)
            """,
            (user_id, user_id),
        ).fetchone()
    return int(row["n"] or 0)


def count_incoming_requests(user_id: str) -> int:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM friendships WHERE addressee_id = ? AND status = 'PENDING'",
            (user_id,),
        ).fetchone()
    return int(row["n"] or 0)


# ---------------------------------------------------------------------------
# Match stats
# ---------------------------------------------------------------------------

def insert_match_stat(stat: dict) -> bool:
    with _lock, _get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO user_match_stats (
                id, user_id, match_id, room_id, mode, team, result, opponent_name,
                runs_scored, wickets_taken, wickets_lost, balls_faced, balls_bowled,
                dead_balls, super_over, overs, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                stat["user_id"],
                stat["match_id"],
                stat["room_id"],
                stat["mode"],
                stat.get("team"),
                stat["result"],
                stat.get("opponent_name", ""),
                int(stat.get("runs_scored", 0)),
                int(stat.get("wickets_taken", 0)),
                int(stat.get("wickets_lost", 0)),
                int(stat.get("balls_faced", 0)),
                int(stat.get("balls_bowled", 0)),
                int(stat.get("dead_balls", 0)),
                1 if stat.get("super_over") else 0,
                int(stat.get("overs", 0)),
                stat["created_at"],
            ),
        )
    return cursor.rowcount > 0


def aggregate_stats(user_id: str) -> dict:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS matches,
                COALESCE(SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END), 0) AS wins,
                COALESCE(SUM(CASE WHEN result = 'LOSS' THEN 1 ELSE 0 END), 0) AS losses,
                COALESCE(SUM(CASE WHEN result = 'TIE' THEN 1 ELSE 0 END), 0) AS ties,
                COALESCE(SUM(CASE WHEN super_over = 1 THEN 1 ELSE 0 END), 0) AS super_overs,
                COALESCE(SUM(CASE WHEN super_over = 1 AND result = 'WIN' THEN 1 ELSE 0 END), 0) AS super_over_wins,
                COALESCE(SUM(CASE WHEN mode = 'TEAM' THEN 1 ELSE 0 END), 0) AS team_matches,
                COALESCE(SUM(runs_scored), 0) AS runs,
                COALESCE(SUM(wickets_taken), 0) AS wickets,
                COALESCE(SUM(wickets_lost), 0) AS wickets_lost,
                COALESCE(SUM(balls_faced), 0) AS balls_faced,
                COALESCE(SUM(balls_bowled), 0) AS balls_bowled,
                COALESCE(SUM(dead_balls), 0) AS dead_balls,
                COALESCE(MAX(runs_scored), 0) AS best_score
            FROM user_match_stats
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()
    return dict(row) if row else {}


def list_recent_matches(user_id: str, limit: int = 5) -> list[dict]:
    with _lock, _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT match_id, mode, team, result, opponent_name, runs_scored,
                   wickets_taken, wickets_lost, super_over, overs, created_at
            FROM user_match_stats
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (user_id, max(1, min(limit, 50))),
        ).fetchall()
    return [dict(row) for row in rows]


def list_results_chronological(user_id: str) -> list[str]:
    with _lock, _get_connection() as conn:
        rows = conn.execute(
            "SELECT result FROM user_match_stats WHERE user_id = ? ORDER BY created_at ASC, rowid ASC",
            (user_id,),
        ).fetchall()
    return [row["result"] for row in rows]


# ---------------------------------------------------------------------------
# Achievements
# ---------------------------------------------------------------------------

def list_achievement_codes(user_id: str) -> set[str]:
    with _lock, _get_connection() as conn:
        rows = conn.execute(
            "SELECT code FROM user_achievements WHERE user_id = ?", (user_id,)
        ).fetchall()
    return {row["code"] for row in rows}


def add_achievement(user_id: str, code: str, earned_at: Optional[str] = None) -> bool:
    with _lock, _get_connection() as conn:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO user_achievements (user_id, code, earned_at) VALUES (?, ?, ?)",
            (user_id, code, earned_at or _now_iso()),
        )
    return cursor.rowcount > 0
