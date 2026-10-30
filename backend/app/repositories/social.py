"""
Social-world persistence: live presence, direct messages and play requests.

Presence is derived from the ephemeral gameplay tables (players/memberships/
rooms) so it never goes stale on its own; messages and play requests are
durable rows that survive room cleanup.
"""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timedelta
from typing import Iterable, Optional

from ..domain.models import RoomStatus
from .sqlite import _get_connection, _lock

PLAY_REQUEST_TTL_SECONDS = 10 * 60

_IN_PLAY = {
    RoomStatus.TOSS.value,
    RoomStatus.MATCH_SETUP.value,
    RoomStatus.AWAITING_FIRST_BALL.value,
    RoomStatus.INNINGS_ACTIVE.value,
    RoomStatus.INNINGS_BREAK.value,
    RoomStatus.PAUSED.value,
}
_IN_LOBBY = {
    RoomStatus.WAITING_FOR_PLAYERS.value,
    RoomStatus.LOBBY_READY.value,
    RoomStatus.RULEBOOK_REQUIRED.value,
}

_PRESENCE_PRIORITY = {"online": 0, "in_lobby": 1, "spectating": 2, "in_match": 3}


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _parse(ts: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None


def _public_presence(status: str, row: Optional[sqlite3.Row] = None) -> dict:
    payload = {"status": status}
    if row is not None:
        payload.update(
            {
                "room_id": row["room_id"],
                "join_code": row["join_code"],
                "mode": row["mode"],
            }
        )
    return payload


# ---------------------------------------------------------------------------
# Presence
# ---------------------------------------------------------------------------

def presence_map(user_ids: Iterable[str]) -> dict[str, dict]:
    """Map account id → {status, room_id?, join_code?, mode?}.

    Status precedence is in_match > spectating > in_lobby > online > offline so a
    player juggling several rooms is always reported by their most active one.
    """
    ids = [uid for uid in dict.fromkeys(user_ids) if uid]
    result: dict[str, dict] = {uid: {"status": "offline"} for uid in ids}
    if not ids:
        return result

    placeholders = ",".join("?" for _ in ids)
    with _lock, _get_connection() as conn:
        online_rows = conn.execute(
            f"""
            SELECT DISTINCT user_id FROM players
            WHERE connection_state = 'CONNECTED' AND user_id IN ({placeholders})
            """,
            tuple(ids),
        ).fetchall()
        room_rows = conn.execute(
            f"""
            SELECT p.user_id, m.team, r.id AS room_id, r.join_code, r.mode, r.status
            FROM players p
            JOIN memberships m ON m.player_id = p.id
            JOIN rooms r ON r.id = m.room_id
            WHERE p.connection_state = 'CONNECTED'
              AND p.user_id IN ({placeholders})
              AND r.status != ?
            """,
            (*ids, RoomStatus.MATCH_COMPLETE.value),
        ).fetchall()

    for row in online_rows:
        result[row["user_id"]] = {"status": "online"}

    for row in room_rows:
        user_id = row["user_id"]
        if row["team"] is None:
            status = "spectating"
        elif row["status"] in _IN_PLAY:
            status = "in_match"
        elif row["status"] in _IN_LOBBY:
            status = "in_lobby"
        else:
            status = "online"
        current = result.get(user_id, {"status": "offline"})
        if _PRESENCE_PRIORITY[status] >= _PRESENCE_PRIORITY[current["status"]]:
            result[user_id] = _public_presence(status, row)
    return result


# ---------------------------------------------------------------------------
# User search
# ---------------------------------------------------------------------------

def search_users(query: str, exclude_user_id: str, limit: int = 12) -> list[dict]:
    cleaned = (query or "").strip()
    if len(cleaned) < 2:
        return []
    like = f"%{cleaned}%"
    with _lock, _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, username, display_name, friend_code, avatar, bio, created_at
            FROM users
            WHERE id != ?
              AND (display_name LIKE ? COLLATE NOCASE OR username LIKE ? COLLATE NOCASE)
            ORDER BY
              CASE WHEN display_name LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END,
              display_name COLLATE NOCASE ASC
            LIMIT ?
            """,
            (exclude_user_id, like, like, f"{cleaned}%", max(1, min(limit, 25))),
        ).fetchall()
    return [dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Direct messages
# ---------------------------------------------------------------------------

def _message_row(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "sender_id": row["sender_id"],
        "recipient_id": row["recipient_id"],
        "body": row["body"],
        "created_at": row["created_at"],
        "read_at": row["read_at"],
    }


def insert_message(sender_id: str, recipient_id: str, body: str) -> dict:
    message_id = str(uuid.uuid4())
    now = _now_iso()
    with _lock, _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO direct_messages (id, sender_id, recipient_id, body, created_at, read_at)
            VALUES (?, ?, ?, ?, ?, NULL)
            """,
            (message_id, sender_id, recipient_id, body, now),
        )
        row = conn.execute("SELECT * FROM direct_messages WHERE id = ?", (message_id,)).fetchone()
    return _message_row(row)


def list_messages(user_a: str, user_b: str, limit: int = 60, before: str = "") -> list[dict]:
    limit = max(1, min(limit, 200))
    params: list = [user_a, user_b, user_b, user_a]
    clause = ""
    if before:
        clause = "AND created_at < ?"
        params.append(before)
    params.append(limit)
    with _lock, _get_connection() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM direct_messages
            WHERE ((sender_id = ? AND recipient_id = ?)
                OR (sender_id = ? AND recipient_id = ?))
              {clause}
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()
    return [_message_row(row) for row in reversed(rows)]


def list_threads(user_id: str, limit: int = 100) -> list[dict]:
    with _lock, _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM (
                SELECT dm.*,
                       CASE WHEN dm.sender_id = ? THEN dm.recipient_id ELSE dm.sender_id END AS peer_id,
                       ROW_NUMBER() OVER (
                           PARTITION BY CASE WHEN dm.sender_id = ? THEN dm.recipient_id ELSE dm.sender_id END
                           ORDER BY dm.created_at DESC, dm.rowid DESC
                       ) AS rn
                FROM direct_messages dm
                WHERE dm.sender_id = ? OR dm.recipient_id = ?
            ) WHERE rn = 1
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (user_id, user_id, user_id, user_id, max(1, min(limit, 300))),
        ).fetchall()
    return [dict(row) for row in rows]


def unread_counts(user_id: str) -> dict[str, int]:
    with _lock, _get_connection() as conn:
        rows = conn.execute(
            """
            SELECT sender_id, COUNT(*) AS n FROM direct_messages
            WHERE recipient_id = ? AND read_at IS NULL
            GROUP BY sender_id
            """,
            (user_id,),
        ).fetchall()
    return {row["sender_id"]: int(row["n"]) for row in rows}


def unread_total(user_id: str) -> int:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM direct_messages WHERE recipient_id = ? AND read_at IS NULL",
            (user_id,),
        ).fetchone()
    return int(row["n"] or 0)


def mark_thread_read(user_id: str, peer_id: str) -> int:
    with _lock, _get_connection() as conn:
        cursor = conn.execute(
            """
            UPDATE direct_messages SET read_at = ?
            WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL
            """,
            (_now_iso(), user_id, peer_id),
        )
    return cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0


# ---------------------------------------------------------------------------
# Play requests
# ---------------------------------------------------------------------------

STATUS_PENDING = "PENDING"
STATUS_ACCEPTED = "ACCEPTED"
STATUS_DECLINED = "DECLINED"
STATUS_CANCELLED = "CANCELLED"
STATUS_EXPIRED = "EXPIRED"


def _play_request_row(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "requester_id": row["requester_id"],
        "recipient_id": row["recipient_id"],
        "mode": row["mode"],
        "overs": int(row["overs"]),
        "wickets": int(row["wickets"]),
        "status": row["status"],
        "room_id": row["room_id"],
        "room_code": row["room_code"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def expire_stale_play_requests(ttl_seconds: int = PLAY_REQUEST_TTL_SECONDS, now: Optional[datetime] = None) -> None:
    cutoff = ((now or datetime.utcnow()) - timedelta(seconds=ttl_seconds)).isoformat()
    with _lock, _get_connection() as conn:
        conn.execute(
            """
            UPDATE play_requests SET status = ?, updated_at = ?
            WHERE status = ? AND created_at < ?
            """,
            (STATUS_EXPIRED, _now_iso(), STATUS_PENDING, cutoff),
        )


def create_play_request(
    requester_id: str,
    recipient_id: str,
    mode: str,
    overs: int,
    wickets: int,
) -> dict:
    request_id = str(uuid.uuid4())
    now = _now_iso()
    with _lock, _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO play_requests (
                id, requester_id, recipient_id, mode, overs, wickets,
                status, room_id, room_code, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
            """,
            (request_id, requester_id, recipient_id, mode, int(overs), int(wickets),
             STATUS_PENDING, now, now),
        )
        row = conn.execute("SELECT * FROM play_requests WHERE id = ?", (request_id,)).fetchone()
    return _play_request_row(row)


def get_play_request(request_id: str) -> Optional[dict]:
    with _lock, _get_connection() as conn:
        row = conn.execute("SELECT * FROM play_requests WHERE id = ?", (request_id,)).fetchone()
    return _play_request_row(row) if row else None


def find_pending_play_request(requester_id: str, recipient_id: str) -> Optional[dict]:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            """
            SELECT * FROM play_requests
            WHERE requester_id = ? AND recipient_id = ? AND status = ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (requester_id, recipient_id, STATUS_PENDING),
        ).fetchone()
    return _play_request_row(row) if row else None


def list_play_requests(user_id: str) -> tuple[list[dict], list[dict]]:
    """Return (incoming, outgoing) pending requests, newest first."""
    with _lock, _get_connection() as conn:
        incoming = conn.execute(
            """
            SELECT * FROM play_requests
            WHERE recipient_id = ? AND status = ?
            ORDER BY created_at DESC LIMIT 20
            """,
            (user_id, STATUS_PENDING),
        ).fetchall()
        outgoing = conn.execute(
            """
            SELECT * FROM play_requests
            WHERE requester_id = ? AND status = ?
            ORDER BY created_at DESC LIMIT 20
            """,
            (user_id, STATUS_PENDING),
        ).fetchall()
    return (
        [_play_request_row(row) for row in incoming],
        [_play_request_row(row) for row in outgoing],
    )


def update_play_request(
    request_id: str,
    status: str,
    room_id: Optional[str] = None,
    room_code: Optional[str] = None,
) -> Optional[dict]:
    with _lock, _get_connection() as conn:
        conn.execute(
            """
            UPDATE play_requests
            SET status = ?, room_id = COALESCE(?, room_id),
                room_code = COALESCE(?, room_code), updated_at = ?
            WHERE id = ?
            """,
            (status, room_id, room_code, _now_iso(), request_id),
        )
        row = conn.execute("SELECT * FROM play_requests WHERE id = ?", (request_id,)).fetchone()
    return _play_request_row(row) if row else None


# ---------------------------------------------------------------------------
# Social graph helpers
# ---------------------------------------------------------------------------

def social_user_ids(user_id: str) -> list[str]:
    """Accounts this player shares context with: friends, DM peers and invites."""
    with _lock, _get_connection() as conn:
        friend_rows = conn.execute(
            """
            SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS peer
            FROM friendships
            WHERE status IN ('ACCEPTED', 'PENDING')
              AND (requester_id = ? OR addressee_id = ?)
            """,
            (user_id, user_id, user_id),
        ).fetchall()
        dm_rows = conn.execute(
            """
            SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer
            FROM direct_messages
            WHERE sender_id = ? OR recipient_id = ?
            """,
            (user_id, user_id, user_id),
        ).fetchall()
        play_rows = conn.execute(
            """
            SELECT CASE WHEN requester_id = ? THEN recipient_id ELSE requester_id END AS peer
            FROM play_requests
            WHERE status = ? AND (requester_id = ? OR recipient_id = ?)
            """,
            (user_id, STATUS_PENDING, user_id, user_id),
        ).fetchall()
    peers = {row["peer"] for row in (*friend_rows, *dm_rows, *play_rows) if row["peer"]}
    peers.discard(user_id)
    return sorted(peers)
