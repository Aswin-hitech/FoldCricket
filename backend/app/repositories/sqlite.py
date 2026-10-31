"""
HandCricket Live – Durable SQLite Repository Layer.
Provides ACID transactions, WAL mode, foreign keys, and atomic idempotency constraints.
Preserves match, room, player, delivery and voice permission state across process restarts.
Maintains an in-memory Identity Map for fast object reference consistency.
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import threading
from datetime import datetime, timedelta
from typing import List, Optional

from ..domain.models import (
    ConnectionState,
    Delivery,
    DeliveryResult,
    GameMode,
    InningsPhase,
    Match,
    Membership,
    Player,
    PlayerRole,
    ReadinessState,
    Room,
    RoomStatus,
)

_lock = threading.RLock()

# Fast identity map caches for active in-memory object references
_players_cache: dict[str, Player] = {}
_rooms_cache: dict[str, Room] = {}
_memberships_cache: dict[str, list[Membership]] = {}
_matches_cache: dict[str, Match] = {}
_deliveries_cache: dict[str, list[Delivery]] = {}

# Database path configurable via SQLITE_PATH (or a legacy sqlite:/// DATABASE_URL).
# A Postgres DATABASE_URL must never be mistaken for a local file path.
DEFAULT_DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "handcricket.db",
)


def _resolve_db_path() -> str:
    explicit = os.getenv("SQLITE_PATH", "").strip()
    if explicit:
        return explicit[len("sqlite:///"):] if explicit.startswith("sqlite:///") else explicit
    legacy = os.getenv("DATABASE_URL", "").strip()
    if legacy.startswith("sqlite:///"):
        return legacy[len("sqlite:///"):]
    if legacy and "://" not in legacy:
        return legacy
    return DEFAULT_DB_PATH


DB_PATH = _resolve_db_path()


@contextlib.contextmanager
def _get_connection():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA busy_timeout=15000;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Create all required relational schema and indexes if they do not exist."""
    with _lock, _get_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS players (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                session_token TEXT UNIQUE NOT NULL,
                connection_state TEXT NOT NULL,
                socket_id TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY,
                join_code TEXT UNIQUE NOT NULL,
                host_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                status TEXT NOT NULL,
                capacity INTEGER NOT NULL,
                rules_version TEXT NOT NULL,
                overs INTEGER NOT NULL,
                wickets INTEGER NOT NULL,
                allowed_overs TEXT NOT NULL,
                toss TEXT,
                team_a_name TEXT NOT NULL,
                team_b_name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS memberships (
                room_id TEXT NOT NULL,
                player_id TEXT NOT NULL,
                team TEXT,
                is_captain INTEGER NOT NULL,
                is_host INTEGER NOT NULL,
                role TEXT NOT NULL,
                readiness TEXT NOT NULL,
                voice_mode TEXT NOT NULL,
                allowed_recipients TEXT NOT NULL,
                joined_at TEXT NOT NULL,
                PRIMARY KEY (room_id, player_id)
            );

            CREATE TABLE IF NOT EXISTS matches (
                id TEXT PRIMARY KEY,
                room_id TEXT NOT NULL,
                phase TEXT NOT NULL,
                overs INTEGER NOT NULL,
                wickets INTEGER,
                team_a_name TEXT NOT NULL,
                team_b_name TEXT NOT NULL,
                team_a_runs INTEGER NOT NULL,
                team_a_wickets INTEGER NOT NULL,
                team_b_runs INTEGER NOT NULL,
                team_b_wickets INTEGER NOT NULL,
                target INTEGER,
                team_a_extra_wickets INTEGER NOT NULL,
                team_b_extra_wickets INTEGER NOT NULL,
                current_over INTEGER NOT NULL,
                current_ball INTEGER NOT NULL,
                batting_team TEXT NOT NULL,
                first_batting_team TEXT NOT NULL,
                active_batter_id TEXT,
                active_bowler_id TEXT,
                delivery_deadline TEXT,
                innings_break_deadline TEXT,
                winner TEXT,
                result_summary TEXT,
                dismissed_batters_a TEXT NOT NULL,
                dismissed_batters_b TEXT NOT NULL,
                is_all_out INTEGER NOT NULL,
                all_out_team TEXT,
                is_all_out_a INTEGER NOT NULL,
                is_all_out_b INTEGER NOT NULL,
                all_out_announced_a INTEGER NOT NULL,
                all_out_announced_b INTEGER NOT NULL,
                is_super_over INTEGER NOT NULL,
                main_match_team_a_runs INTEGER NOT NULL,
                main_match_team_b_runs INTEGER NOT NULL,
                main_match_team_a_wickets INTEGER NOT NULL,
                main_match_team_b_wickets INTEGER NOT NULL,
                team_a_size INTEGER NOT NULL,
                team_b_size INTEGER NOT NULL,
                version INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS deliveries (
                id TEXT PRIMARY KEY,
                match_id TEXT NOT NULL,
                innings TEXT NOT NULL,
                over_index INTEGER NOT NULL,
                ball_index INTEGER NOT NULL,
                batter_pick INTEGER,
                bowler_pick INTEGER,
                batter_id TEXT,
                bowler_id TEXT,
                result TEXT,
                runs_scored INTEGER NOT NULL,
                timeout_reason TEXT,
                committed INTEGER NOT NULL,
                commit_sequence INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS voice_permissions (
                room_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                receiver_id TEXT NOT NULL,
                status TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (room_id, sender_id, receiver_id)
            );

            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                friend_code TEXT NOT NULL UNIQUE,
                avatar TEXT NOT NULL DEFAULT '🏏',
                bio TEXT NOT NULL DEFAULT '',
                default_mode TEXT NOT NULL DEFAULT 'SOLO',
                default_overs INTEGER NOT NULL DEFAULT 2,
                default_wickets INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                user_agent TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                last_used_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS friendships (
                id TEXT PRIMARY KEY,
                requester_id TEXT NOT NULL,
                addressee_id TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(requester_id, addressee_id)
            );

            CREATE TABLE IF NOT EXISTS user_match_stats (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                match_id TEXT NOT NULL,
                room_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                team TEXT,
                result TEXT NOT NULL,
                opponent_name TEXT NOT NULL DEFAULT '',
                runs_scored INTEGER NOT NULL DEFAULT 0,
                wickets_taken INTEGER NOT NULL DEFAULT 0,
                wickets_lost INTEGER NOT NULL DEFAULT 0,
                balls_faced INTEGER NOT NULL DEFAULT 0,
                balls_bowled INTEGER NOT NULL DEFAULT 0,
                dead_balls INTEGER NOT NULL DEFAULT 0,
                super_over INTEGER NOT NULL DEFAULT 0,
                overs INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                UNIQUE(user_id, match_id)
            );

            CREATE TABLE IF NOT EXISTS user_achievements (
                user_id TEXT NOT NULL,
                code TEXT NOT NULL,
                earned_at TEXT NOT NULL,
                PRIMARY KEY (user_id, code)
            );

            CREATE TABLE IF NOT EXISTS direct_messages (
                id TEXT PRIMARY KEY,
                sender_id TEXT NOT NULL,
                recipient_id TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL,
                read_at TEXT
            );

            CREATE TABLE IF NOT EXISTS play_requests (
                id TEXT PRIMARY KEY,
                requester_id TEXT NOT NULL,
                recipient_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                overs INTEGER NOT NULL,
                wickets INTEGER NOT NULL,
                status TEXT NOT NULL,
                room_id TEXT,
                room_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_memberships_room ON memberships(room_id);
            CREATE INDEX IF NOT EXISTS idx_matches_room ON matches(room_id);
            CREATE INDEX IF NOT EXISTS idx_deliveries_match ON deliveries(match_id);
            CREATE INDEX IF NOT EXISTS idx_voice_perm_room ON voice_permissions(room_id);
            CREATE INDEX IF NOT EXISTS idx_matches_created ON matches(created_at);
            CREATE INDEX IF NOT EXISTS idx_deliveries_created ON deliveries(created_at);
            CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
            CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);
            CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);
            CREATE INDEX IF NOT EXISTS idx_user_match_stats_user ON user_match_stats(user_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(sender_id, recipient_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_dm_recipient_unread ON direct_messages(recipient_id, read_at);
            CREATE INDEX IF NOT EXISTS idx_play_requests_recipient ON play_requests(recipient_id, status);
            CREATE INDEX IF NOT EXISTS idx_play_requests_requester ON play_requests(requester_id, status);
            """
        )
        try:
            conn.execute("ALTER TABLE matches ADD COLUMN innings_break_deadline TEXT;")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE players ADD COLUMN user_id TEXT;")
        except Exception:
            pass

    _migrate_deliveries_rebowl()


def _migrate_deliveries_rebowl() -> None:
    """
    A dead ball is re-bowled, so two deliveries may legitimately share the same
    (match, innings, over, ball). Older databases carry a UNIQUE constraint that
    would reject the re-bowled row; rebuild the table without it.
    """
    with _lock, _get_connection() as conn:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='deliveries'"
        ).fetchone()
        if not row or "UNIQUE" not in (row["sql"] or "").upper():
            return

        conn.execute("DROP INDEX IF EXISTS idx_deliveries_match;")
        conn.execute("ALTER TABLE deliveries RENAME TO deliveries_legacy;")
        conn.execute(
            """
            CREATE TABLE deliveries (
                id TEXT PRIMARY KEY,
                match_id TEXT NOT NULL,
                innings TEXT NOT NULL,
                over_index INTEGER NOT NULL,
                ball_index INTEGER NOT NULL,
                batter_pick INTEGER,
                bowler_pick INTEGER,
                batter_id TEXT,
                bowler_id TEXT,
                result TEXT,
                runs_scored INTEGER NOT NULL,
                timeout_reason TEXT,
                committed INTEGER NOT NULL,
                commit_sequence INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute("INSERT INTO deliveries SELECT * FROM deliveries_legacy;")
        conn.execute("DROP TABLE deliveries_legacy;")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_deliveries_match ON deliveries(match_id);")


# Initialize schema on module load
init_db()


# ---------------------------------------------------------------------------
# Player repository
# ---------------------------------------------------------------------------

def save_player(player: Player) -> Player:
    with _lock:
        _players_cache[player.id] = player
        with _get_connection() as conn:
            conn.execute(
                """
                INSERT INTO players (id, display_name, session_token, connection_state, socket_id, created_at, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    display_name=excluded.display_name,
                    session_token=excluded.session_token,
                    connection_state=excluded.connection_state,
                    socket_id=excluded.socket_id,
                    user_id=excluded.user_id
                """,
                (
                    player.id,
                    player.display_name,
                    player.session_token,
                    player.connection_state.value if hasattr(player.connection_state, "value") else str(player.connection_state),
                    player.socket_id,
                    player.created_at.isoformat() if hasattr(player.created_at, "isoformat") else str(player.created_at),
                    getattr(player, "user_id", None),
                ),
            )
    return player


def get_player(player_id: str) -> Optional[Player]:
    with _lock:
        if player_id in _players_cache:
            return _players_cache[player_id]
        with _get_connection() as conn:
            row = conn.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()
            if not row:
                return None
            p = _row_to_player(row)
            _players_cache[p.id] = p
            return p


def get_player_by_session(token: str) -> Optional[Player]:
    with _lock:
        for p in _players_cache.values():
            if p.session_token == token:
                return p
        with _get_connection() as conn:
            row = conn.execute("SELECT * FROM players WHERE session_token = ?", (token,)).fetchone()
            if not row:
                return None
            p = _row_to_player(row)
            _players_cache[p.id] = p
            return p


def get_player_by_socket(socket_id: str) -> Optional[Player]:
    if not socket_id:
        return None
    with _lock:
        for p in _players_cache.values():
            if p.socket_id == socket_id:
                return p
        with _get_connection() as conn:
            row = conn.execute("SELECT * FROM players WHERE socket_id = ?", (socket_id,)).fetchone()
            if not row:
                return None
            p = _row_to_player(row)
            _players_cache[p.id] = p
            return p


def get_connected_player_for_user(user_id: str) -> Optional[Player]:
    """Newest live socket-backed player linked to an account, if any."""
    if not user_id:
        return None
    with _lock:
        for p in _players_cache.values():
            if p.user_id == user_id and p.connection_state == ConnectionState.CONNECTED:
                return p
        with _get_connection() as conn:
            row = conn.execute(
                """
                SELECT * FROM players
                WHERE user_id = ? AND connection_state = 'CONNECTED'
                ORDER BY created_at DESC LIMIT 1
                """,
                (user_id,),
            ).fetchone()
            if not row:
                return None
            p = _row_to_player(row)
            _players_cache[p.id] = p
            return p


def get_player_for_user(user_id: str, room_id: Optional[str] = None) -> Optional[Player]:
    """Newest player linked to an account, preferring one still in a live room.

    ``room_id`` narrows the lookup to the identity that account holds in that
    room, which is how a reconnecting signed-in client recovers its player
    when its guest token is gone.
    """
    if not user_id:
        return None
    with _lock, _get_connection() as conn:
        if room_id:
            row = conn.execute(
                """
                SELECT p.* FROM players p
                JOIN memberships m ON m.player_id = p.id
                WHERE p.user_id = ? AND m.room_id = ?
                ORDER BY p.created_at DESC LIMIT 1
                """,
                (user_id, room_id),
            ).fetchone()
            if row:
                p = _row_to_player(row)
                _players_cache[p.id] = p
                return p
        row = conn.execute(
            """
            SELECT p.* FROM players p
            WHERE p.user_id = ?
            ORDER BY (
                SELECT COUNT(*) FROM memberships m
                JOIN rooms r ON r.id = m.room_id
                WHERE m.player_id = p.id AND r.status != ?
            ) DESC, p.created_at DESC
            LIMIT 1
            """,
            (user_id, RoomStatus.MATCH_COMPLETE.value),
        ).fetchone()
        if not row:
            return None
        p = _row_to_player(row)
        _players_cache[p.id] = p
        return p


def update_player_socket(player_id: str, socket_id: Optional[str]) -> None:
    with _lock:
        p = _players_cache.get(player_id)
        if p:
            p.socket_id = socket_id
        with _get_connection() as conn:
            conn.execute(
                "UPDATE players SET socket_id = ? WHERE id = ?",
                (socket_id, player_id),
            )


def _row_to_player(row: sqlite3.Row) -> Player:
    try:
        created = datetime.fromisoformat(row["created_at"])
    except Exception:
        created = datetime.utcnow()
    try:
        user_id = row["user_id"]
    except (KeyError, IndexError):
        user_id = None
    return Player(
        id=row["id"],
        display_name=row["display_name"],
        session_token=row["session_token"],
        connection_state=ConnectionState(row["connection_state"]),
        socket_id=row["socket_id"],
        created_at=created,
        user_id=user_id,
    )


# ---------------------------------------------------------------------------
# Room repository
# ---------------------------------------------------------------------------

def save_room(room: Room) -> Room:
    with _lock:
        _rooms_cache[room.id] = room
        with _get_connection() as conn:
            conn.execute(
                """
                INSERT INTO rooms (
                    id, join_code, host_id, mode, status, capacity, rules_version,
                    overs, wickets, allowed_overs, toss, team_a_name, team_b_name, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status,
                    overs=excluded.overs,
                    wickets=excluded.wickets,
                    allowed_overs=excluded.allowed_overs,
                    toss=excluded.toss,
                    team_a_name=excluded.team_a_name,
                    team_b_name=excluded.team_b_name
                """,
                (
                    room.id,
                    room.join_code,
                    room.host_id,
                    room.mode.value if hasattr(room.mode, "value") else str(room.mode),
                    room.status.value if hasattr(room.status, "value") else str(room.status),
                    room.capacity,
                    room.rules_version,
                    room.overs,
                    room.wickets,
                    json.dumps(room.allowed_overs),
                    json.dumps(room.toss) if room.toss else None,
                    room.team_a_name,
                    room.team_b_name,
                    room.created_at.isoformat() if hasattr(room.created_at, "isoformat") else str(room.created_at),
                ),
            )
    return room


def get_room(room_id: str) -> Optional[Room]:
    with _lock:
        if room_id in _rooms_cache:
            return _rooms_cache[room_id]
        with _get_connection() as conn:
            row = conn.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
            if not row:
                return None
            r = _row_to_room(row)
            _rooms_cache[r.id] = r
            return r


def get_room_by_code(code: str) -> Optional[Room]:
    code_clean = code.upper().strip()
    with _lock:
        for r in _rooms_cache.values():
            if r.join_code == code_clean:
                return r
        with _get_connection() as conn:
            row = conn.execute("SELECT * FROM rooms WHERE join_code = ?", (code_clean,)).fetchone()
            if not row:
                return None
            r = _row_to_room(row)
            _rooms_cache[r.id] = r
            return r


def delete_room(room_id: str) -> None:
    """Permanently remove a room and everything attached to it."""
    with _lock:
        _rooms_cache.pop(room_id, None)
        _memberships_cache.pop(room_id, None)
        with _get_connection() as conn:
            match_ids = [
                r["id"]
                for r in conn.execute("SELECT id FROM matches WHERE room_id = ?", (room_id,)).fetchall()
            ]
            for match_id in match_ids:
                conn.execute("DELETE FROM deliveries WHERE match_id = ?", (match_id,))
                _deliveries_cache.pop(match_id, None)
                _matches_cache.pop(match_id, None)
            conn.execute("DELETE FROM matches WHERE room_id = ?", (room_id,))
            conn.execute("DELETE FROM memberships WHERE room_id = ?", (room_id,))
            conn.execute("DELETE FROM voice_permissions WHERE room_id = ?", (room_id,))
            conn.execute("DELETE FROM rooms WHERE id = ?", (room_id,))


def _row_to_room(row: sqlite3.Row) -> Room:
    try:
        created = datetime.fromisoformat(row["created_at"])
    except Exception:
        created = datetime.utcnow()

    allowed = json.loads(row["allowed_overs"]) if row["allowed_overs"] else list(range(1, 11))
    toss = json.loads(row["toss"]) if row["toss"] else None

    return Room(
        id=row["id"],
        join_code=row["join_code"],
        host_id=row["host_id"],
        mode=GameMode(row["mode"]),
        status=RoomStatus(row["status"]),
        capacity=row["capacity"],
        rules_version=row["rules_version"],
        created_at=created,
        overs=row["overs"],
        wickets=row["wickets"],
        allowed_overs=allowed,
        toss=toss,
        team_a_name=row["team_a_name"],
        team_b_name=row["team_b_name"],
    )


# ---------------------------------------------------------------------------
# Membership repository
# ---------------------------------------------------------------------------

def save_membership(m: Membership) -> Membership:
    with _lock:
        _memberships_cache.setdefault(m.room_id, [])
        lst = _memberships_cache[m.room_id]
        replaced = False
        for i, existing in enumerate(lst):
            if existing.player_id == m.player_id:
                lst[i] = m
                replaced = True
                break
        if not replaced:
            lst.append(m)

        with _get_connection() as conn:
            conn.execute(
                """
                INSERT INTO memberships (
                    room_id, player_id, team, is_captain, is_host, role, readiness,
                    voice_mode, allowed_recipients, joined_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(room_id, player_id) DO UPDATE SET
                    team=excluded.team,
                    is_captain=excluded.is_captain,
                    is_host=excluded.is_host,
                    role=excluded.role,
                    readiness=excluded.readiness,
                    voice_mode=excluded.voice_mode,
                    allowed_recipients=excluded.allowed_recipients
                """,
                (
                    m.room_id,
                    m.player_id,
                    m.team,
                    1 if m.is_captain else 0,
                    1 if m.is_host else 0,
                    m.role.value if hasattr(m.role, "value") else str(m.role),
                    m.readiness.value if hasattr(m.readiness, "value") else str(m.readiness),
                    getattr(m, "voice_mode", "EVERYONE"),
                    json.dumps(getattr(m, "allowed_recipients", [])),
                    m.joined_at.isoformat() if hasattr(m.joined_at, "isoformat") else str(m.joined_at),
                ),
            )
    return m


def get_membership(room_id: str, player_id: str) -> Optional[Membership]:
    with _lock:
        lst = _memberships_cache.get(room_id)
        if lst is not None:
            for m in lst:
                if m.player_id == player_id:
                    return m
        with _get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM memberships WHERE room_id = ? AND player_id = ?",
                (room_id, player_id),
            ).fetchone()
            if not row:
                return None
            return _row_to_membership(row)


def get_room_members(room_id: str) -> List[Membership]:
    with _lock:
        if room_id in _memberships_cache:
            return list(_memberships_cache[room_id])
        with _get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM memberships WHERE room_id = ? ORDER BY joined_at ASC",
                (room_id,),
            ).fetchall()
            res = [_row_to_membership(r) for r in rows]
            _memberships_cache[room_id] = res
            return list(res)


def get_memberships_for_player(player_id: str) -> List[Membership]:
    with _lock:
        res = []
        for lst in _memberships_cache.values():
            for m in lst:
                if m.player_id == player_id:
                    res.append(m)
        if res:
            return res
        with _get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM memberships WHERE player_id = ? ORDER BY joined_at ASC",
                (player_id,),
            ).fetchall()
            return [_row_to_membership(r) for r in rows]


def remove_membership(room_id: str, player_id: str) -> None:
    with _lock:
        if room_id in _memberships_cache:
            _memberships_cache[room_id] = [m for m in _memberships_cache[room_id] if m.player_id != player_id]
        with _get_connection() as conn:
            conn.execute(
                "DELETE FROM memberships WHERE room_id = ? AND player_id = ?",
                (room_id, player_id),
            )


def _row_to_membership(row: sqlite3.Row) -> Membership:
    try:
        joined = datetime.fromisoformat(row["joined_at"])
    except Exception:
        joined = datetime.utcnow()

    allowed = json.loads(row["allowed_recipients"]) if row["allowed_recipients"] else []

    return Membership(
        room_id=row["room_id"],
        player_id=row["player_id"],
        team=row["team"],
        is_captain=bool(row["is_captain"]),
        is_host=bool(row["is_host"]),
        role=PlayerRole(row["role"]),
        readiness=ReadinessState(row["readiness"]),
        voice_mode=row["voice_mode"],
        allowed_recipients=allowed,
        joined_at=joined,
    )


# ---------------------------------------------------------------------------
# Match repository
# ---------------------------------------------------------------------------

def save_match(match: Match) -> Match:
    with _lock:
        _matches_cache[match.id] = match
        with _get_connection() as conn:
            conn.execute(
                """
                INSERT INTO matches (
                    id, room_id, phase, overs, wickets, team_a_name, team_b_name,
                    team_a_runs, team_a_wickets, team_b_runs, team_b_wickets, target,
                    team_a_extra_wickets, team_b_extra_wickets, current_over, current_ball,
                    batting_team, first_batting_team, active_batter_id, active_bowler_id,
                    delivery_deadline, innings_break_deadline, winner, result_summary, dismissed_batters_a, dismissed_batters_b,
                    is_all_out, all_out_team, is_all_out_a, is_all_out_b, all_out_announced_a, all_out_announced_b,
                    is_super_over, main_match_team_a_runs, main_match_team_b_runs,
                    main_match_team_a_wickets, main_match_team_b_wickets,
                    team_a_size, team_b_size, version, created_at
                )
                VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT(id) DO UPDATE SET
                    phase=excluded.phase,
                    overs=excluded.overs,
                    wickets=excluded.wickets,
                    team_a_name=excluded.team_a_name,
                    team_b_name=excluded.team_b_name,
                    team_a_runs=excluded.team_a_runs,
                    team_a_wickets=excluded.team_a_wickets,
                    team_b_runs=excluded.team_b_runs,
                    team_b_wickets=excluded.team_b_wickets,
                    target=excluded.target,
                    team_a_extra_wickets=excluded.team_a_extra_wickets,
                    team_b_extra_wickets=excluded.team_b_extra_wickets,
                    current_over=excluded.current_over,
                    current_ball=excluded.current_ball,
                    batting_team=excluded.batting_team,
                    first_batting_team=excluded.first_batting_team,
                    active_batter_id=excluded.active_batter_id,
                    active_bowler_id=excluded.active_bowler_id,
                    delivery_deadline=excluded.delivery_deadline,
                    innings_break_deadline=excluded.innings_break_deadline,
                    winner=excluded.winner,
                    result_summary=excluded.result_summary,
                    dismissed_batters_a=excluded.dismissed_batters_a,
                    dismissed_batters_b=excluded.dismissed_batters_b,
                    is_all_out=excluded.is_all_out,
                    all_out_team=excluded.all_out_team,
                    is_all_out_a=excluded.is_all_out_a,
                    is_all_out_b=excluded.is_all_out_b,
                    all_out_announced_a=excluded.all_out_announced_a,
                    all_out_announced_b=excluded.all_out_announced_b,
                    is_super_over=excluded.is_super_over,
                    main_match_team_a_runs=excluded.main_match_team_a_runs,
                    main_match_team_b_runs=excluded.main_match_team_b_runs,
                    main_match_team_a_wickets=excluded.main_match_team_a_wickets,
                    main_match_team_b_wickets=excluded.main_match_team_b_wickets,
                    team_a_size=excluded.team_a_size,
                    team_b_size=excluded.team_b_size,
                    version=excluded.version
                """,
                (
                    match.id,
                    match.room_id,
                    match.phase.value if hasattr(match.phase, "value") else str(match.phase),
                    match.overs,
                    match.wickets,
                    match.team_a_name,
                    match.team_b_name,
                    match.team_a_runs,
                    match.team_a_wickets,
                    match.team_b_runs,
                    match.team_b_wickets,
                    match.target,
                    match.team_a_extra_wickets,
                    match.team_b_extra_wickets,
                    match.current_over,
                    match.current_ball,
                    match.batting_team,
                    match.first_batting_team,
                    match.active_batter_id,
                    match.active_bowler_id,
                    match.delivery_deadline.isoformat() if match.delivery_deadline else None,
                    match.innings_break_deadline.isoformat() if getattr(match, "innings_break_deadline", None) else None,
                    match.winner,
                    match.result_summary,
                    json.dumps(getattr(match, "dismissed_batters_a", [])),
                    json.dumps(getattr(match, "dismissed_batters_b", [])),
                    1 if getattr(match, "is_all_out", False) else 0,
                    getattr(match, "all_out_team", None),
                    1 if getattr(match, "is_all_out_a", False) else 0,
                    1 if getattr(match, "is_all_out_b", False) else 0,
                    1 if getattr(match, "all_out_announced_a", False) else 0,
                    1 if getattr(match, "all_out_announced_b", False) else 0,
                    1 if getattr(match, "is_super_over", False) else 0,
                    getattr(match, "main_match_team_a_runs", 0),
                    getattr(match, "main_match_team_b_runs", 0),
                    getattr(match, "main_match_team_a_wickets", 0),
                    getattr(match, "main_match_team_b_wickets", 0),
                    getattr(match, "_team_a_size", 10),
                    getattr(match, "_team_b_size", 10),
                    match.version,
                    match.created_at.isoformat() if hasattr(match.created_at, "isoformat") else str(match.created_at),
                ),
            )
    return match


def get_match(match_id: str) -> Optional[Match]:
    with _lock:
        if match_id in _matches_cache:
            return _matches_cache[match_id]
        with _get_connection() as conn:
            row = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
            if not row:
                return None
            m = _row_to_match(row)
            _matches_cache[m.id] = m
            return m


def get_match_by_room(room_id: str) -> Optional[Match]:
    with _lock:
        # The cache stores every match ever played in the room, so return the
        # newest one – matching the ORDER BY created_at DESC query below.
        newest = None
        for m in _matches_cache.values():
            if m.room_id == room_id and (newest is None or m.created_at > newest.created_at):
                newest = m
        if newest is not None:
            return newest
        with _get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM matches WHERE room_id = ? ORDER BY created_at DESC LIMIT 1",
                (room_id,),
            ).fetchone()
            if not row:
                return None
            m = _row_to_match(row)
            _matches_cache[m.id] = m
            return m


def _row_to_match(row: sqlite3.Row) -> Match:
    try:
        created = datetime.fromisoformat(row["created_at"])
    except Exception:
        created = datetime.utcnow()

    deadline = None
    if row["delivery_deadline"]:
        try:
            deadline = datetime.fromisoformat(row["delivery_deadline"])
        except Exception:
            deadline = None

    break_deadline = None
    try:
        if "innings_break_deadline" in row.keys() and row["innings_break_deadline"]:
            break_deadline = datetime.fromisoformat(row["innings_break_deadline"])
    except Exception:
        break_deadline = None

    d_a = json.loads(row["dismissed_batters_a"]) if row["dismissed_batters_a"] else []
    d_b = json.loads(row["dismissed_batters_b"]) if row["dismissed_batters_b"] else []

    m = Match(
        id=row["id"],
        room_id=row["room_id"],
        phase=InningsPhase(row["phase"]),
        overs=row["overs"],
        wickets=row["wickets"],
        team_a_name=row["team_a_name"],
        team_b_name=row["team_b_name"],
        team_a_runs=row["team_a_runs"],
        team_a_wickets=row["team_a_wickets"],
        team_b_runs=row["team_b_runs"],
        team_b_wickets=row["team_b_wickets"],
        target=row["target"],
        team_a_extra_wickets=row["team_a_extra_wickets"],
        team_b_extra_wickets=row["team_b_extra_wickets"],
        current_over=row["current_over"],
        current_ball=row["current_ball"],
        batting_team=row["batting_team"],
        first_batting_team=row["first_batting_team"],
        active_batter_id=row["active_batter_id"],
        active_bowler_id=row["active_bowler_id"],
        delivery_deadline=deadline,
        innings_break_deadline=break_deadline,
        winner=row["winner"],
        result_summary=row["result_summary"],
        dismissed_batters_a=d_a,
        dismissed_batters_b=d_b,
        is_all_out=bool(row["is_all_out"]),
        all_out_team=row["all_out_team"],
        is_all_out_a=bool(row["is_all_out_a"]),
        is_all_out_b=bool(row["is_all_out_b"]),
        all_out_announced_a=bool(row["all_out_announced_a"]),
        all_out_announced_b=bool(row["all_out_announced_b"]),
        is_super_over=bool(row["is_super_over"]),
        main_match_team_a_runs=row["main_match_team_a_runs"],
        main_match_team_b_runs=row["main_match_team_b_runs"],
        main_match_team_a_wickets=row["main_match_team_a_wickets"],
        main_match_team_b_wickets=row["main_match_team_b_wickets"],
        version=row["version"],
        created_at=created,
    )
    m._team_a_size = row["team_a_size"]
    m._team_b_size = row["team_b_size"]
    return m


# ---------------------------------------------------------------------------
# Delivery repository
# ---------------------------------------------------------------------------

def save_delivery(d: Delivery) -> Delivery:
    with _lock:
        _deliveries_cache.setdefault(d.match_id, [])
        lst = _deliveries_cache[d.match_id]
        replaced = False
        for i, ex in enumerate(lst):
            if ex.id == d.id:
                lst[i] = d
                replaced = True
                break
        if not replaced:
            lst.append(d)

        with _get_connection() as conn:
            conn.execute(
                """
                INSERT INTO deliveries (
                    id, match_id, innings, over_index, ball_index,
                    batter_pick, bowler_pick, batter_id, bowler_id,
                    result, runs_scored, timeout_reason, committed, commit_sequence, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    batter_pick=excluded.batter_pick,
                    bowler_pick=excluded.bowler_pick,
                    batter_id=excluded.batter_id,
                    bowler_id=excluded.bowler_id,
                    result=excluded.result,
                    runs_scored=excluded.runs_scored,
                    timeout_reason=excluded.timeout_reason,
                    committed=excluded.committed,
                    commit_sequence=excluded.commit_sequence
                """,
                (
                    d.id,
                    d.match_id,
                    d.innings.value if hasattr(d.innings, "value") else str(d.innings),
                    d.over_index,
                    d.ball_index,
                    d.batter_pick,
                    d.bowler_pick,
                    d.batter_id,
                    d.bowler_id,
                    d.result.value if d.result and hasattr(d.result, "value") else (str(d.result) if d.result else None),
                    d.runs_scored,
                    d.timeout_reason,
                    1 if d.committed else 0,
                    d.commit_sequence,
                    d.created_at.isoformat() if hasattr(d.created_at, "isoformat") else str(d.created_at),
                ),
            )
    return d


def get_deliveries(match_id: str) -> List[Delivery]:
    with _lock:
        if match_id in _deliveries_cache:
            return list(_deliveries_cache[match_id])
        with _get_connection() as conn:
            rows = conn.execute(
                "SELECT * FROM deliveries WHERE match_id = ? ORDER BY over_index ASC, ball_index ASC, created_at ASC",
                (match_id,),
            ).fetchall()
            res = [_row_to_delivery(r) for r in rows]
            _deliveries_cache[match_id] = res
            return list(res)


def get_current_delivery(match_id: str) -> Optional[Delivery]:
    """Returns the last uncommitted delivery for this match, if any."""
    with _lock:
        lst = _deliveries_cache.get(match_id, [])
        for d in reversed(lst):
            if not d.committed:
                return d
        with _get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM deliveries WHERE match_id = ? AND committed = 0 ORDER BY created_at DESC LIMIT 1",
                (match_id,),
            ).fetchone()
            if not row:
                return None
            return _row_to_delivery(row)


def _row_to_delivery(row: sqlite3.Row) -> Delivery:
    try:
        created = datetime.fromisoformat(row["created_at"])
    except Exception:
        created = datetime.utcnow()

    res = DeliveryResult(row["result"]) if row["result"] else None

    return Delivery(
        id=row["id"],
        match_id=row["match_id"],
        innings=InningsPhase(row["innings"]),
        over_index=row["over_index"],
        ball_index=row["ball_index"],
        batter_pick=row["batter_pick"],
        bowler_pick=row["bowler_pick"],
        batter_id=row["batter_id"],
        bowler_id=row["bowler_id"],
        result=res,
        runs_scored=row["runs_scored"],
        timeout_reason=row["timeout_reason"],
        committed=bool(row["committed"]),
        commit_sequence=row["commit_sequence"],
        created_at=created,
    )


# ---------------------------------------------------------------------------
# Voice Permissions repository (Server-Enforced Cross-Team Routing)
# ---------------------------------------------------------------------------

def set_voice_permission(room_id: str, sender_id: str, receiver_id: str, status: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO voice_permissions (room_id, sender_id, receiver_id, status, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(room_id, sender_id, receiver_id) DO UPDATE SET
                status=excluded.status,
                updated_at=excluded.updated_at
            """,
            (room_id, sender_id, receiver_id, status, datetime.utcnow().isoformat()),
        )


def get_voice_permission(room_id: str, sender_id: str, receiver_id: str) -> Optional[str]:
    with _lock, _get_connection() as conn:
        row = conn.execute(
            "SELECT status FROM voice_permissions WHERE room_id = ? AND sender_id = ? AND receiver_id = ?",
            (room_id, sender_id, receiver_id),
        ).fetchone()
        return row["status"] if row else None


def get_room_voice_permissions(room_id: str) -> dict[tuple[str, str], str]:
    with _lock, _get_connection() as conn:
        rows = conn.execute(
            "SELECT sender_id, receiver_id, status FROM voice_permissions WHERE room_id = ?",
            (room_id,),
        ).fetchall()
        return {(r["sender_id"], r["receiver_id"]): r["status"] for r in rows}


def delete_voice_permission(room_id: str, p1: str, p2: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute(
            """
            DELETE FROM voice_permissions
            WHERE room_id = ? AND (
                (sender_id = ? AND receiver_id = ?) OR
                (sender_id = ? AND receiver_id = ?)
            )
            """,
            (room_id, p1, p2, p2, p1),
        )


def purge_stale_data(max_age_seconds: int = 3600) -> int:
    """
    Purges any rooms, matches, deliveries, voice permissions, and inactive players older than max_age_seconds (1 hour).
    Ensures zero residual activity remains after 1 hour.
    """
    cutoff = datetime.utcnow() - timedelta(seconds=max_age_seconds)
    cutoff_iso = cutoff.isoformat()
    with _lock, _get_connection() as conn:
        rows = conn.execute("SELECT id FROM rooms WHERE created_at < ?;", (cutoff_iso,)).fetchall()
        stale_room_ids = [r["id"] for r in rows]

        if stale_room_ids:
            placeholders = ",".join("?" * len(stale_room_ids))
            conn.execute(f"DELETE FROM voice_permissions WHERE room_id IN ({placeholders});", stale_room_ids)
            conn.execute(f"DELETE FROM deliveries WHERE match_id IN (SELECT id FROM matches WHERE room_id IN ({placeholders}));", stale_room_ids)
            conn.execute(f"DELETE FROM matches WHERE room_id IN ({placeholders});", stale_room_ids)
            conn.execute(f"DELETE FROM memberships WHERE room_id IN ({placeholders});", stale_room_ids)
            conn.execute(f"DELETE FROM rooms WHERE id IN ({placeholders});", stale_room_ids)

            for rid in stale_room_ids:
                _rooms_cache.pop(rid, None)
                _memberships_cache.pop(rid, None)
                _matches_cache.pop(rid, None)

        # Purge players older than cutoff with no remaining room memberships
        conn.execute("DELETE FROM players WHERE created_at < ? AND id NOT IN (SELECT player_id FROM memberships);", (cutoff_iso,))
        for pid, p in list(_players_cache.items()):
            if p.created_at < cutoff:
                _players_cache.pop(pid, None)

        return len(stale_room_ids)


def cleanup_player_voice_permissions(room_id: str, player_id: str) -> None:
    with _lock, _get_connection() as conn:
        conn.execute(
            "DELETE FROM voice_permissions WHERE room_id = ? AND (sender_id = ? OR receiver_id = ?)",
            (room_id, player_id, player_id),
        )


# ---------------------------------------------------------------------------
# Test & maintenance helpers
# ---------------------------------------------------------------------------

def clear_all() -> None:
    """Clear all memory caches and all database tables (used in unit test teardowns)."""
    with _lock:
        _players_cache.clear()
        _rooms_cache.clear()
        _memberships_cache.clear()
        _matches_cache.clear()
        _deliveries_cache.clear()
        with _get_connection() as conn:
            conn.execute("DELETE FROM voice_permissions;")
            conn.execute("DELETE FROM deliveries;")
            conn.execute("DELETE FROM matches;")
            conn.execute("DELETE FROM memberships;")
            conn.execute("DELETE FROM rooms;")
            conn.execute("DELETE FROM players;")
            conn.execute("DELETE FROM play_requests;")
            conn.execute("DELETE FROM direct_messages;")
            conn.execute("DELETE FROM user_achievements;")
            conn.execute("DELETE FROM user_match_stats;")
            conn.execute("DELETE FROM friendships;")
            conn.execute("DELETE FROM user_sessions;")
            conn.execute("DELETE FROM users;")


# Aliases for interface compatibility
get_match_for_room = get_match_by_room
get_deliveries_for_match = get_deliveries
