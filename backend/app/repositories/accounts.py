"""
Account, session, friendship, match-stat and achievement persistence.

User and session rows are owned by ``account_store`` so they can live in the
Neon Postgres database; everything below (friendships, stats, achievements)
stays in the local repository and is keyed by the same user id.
These rows are durable and are never purged with finished rooms/players, so
profile stats survive room cleanup and process restarts.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from .account_store import (
    create_session,
    create_user,
    delete_other_sessions,
    delete_session,
    friend_code_exists,
    get_session,
    get_user_by_friend_code,
    get_user_by_id,
    get_user_by_username,
    get_users_by_ids,
    purge_expired_sessions,
    touch_session,
    update_user,
    username_exists,
)
from .sqlite import _get_connection, _lock


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


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
