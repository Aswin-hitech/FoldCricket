"""
In-memory repositories for V1.
Replace with database-backed repositories in production.
"""

from __future__ import annotations

import threading
from typing import Dict, List, Optional

from ..domain.models import Delivery, Match, Membership, Player, Room


_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Player repository
# ---------------------------------------------------------------------------
_players: Dict[str, Player] = {}        # keyed by player.id
_players_by_session: Dict[str, str] = {}  # session_token → player_id
_players_by_socket: Dict[str, str] = {}   # socket_id → player_id


def save_player(player: Player) -> Player:
    with _lock:
        _players[player.id] = player
        _players_by_session[player.session_token] = player.id
        if player.socket_id:
            _players_by_socket[player.socket_id] = player.id
    return player


def get_player(player_id: str) -> Optional[Player]:
    return _players.get(player_id)


def get_player_by_session(token: str) -> Optional[Player]:
    pid = _players_by_session.get(token)
    return _players.get(pid) if pid else None


def get_player_by_socket(socket_id: str) -> Optional[Player]:
    pid = _players_by_socket.get(socket_id)
    return _players.get(pid) if pid else None


def update_player_socket(player_id: str, socket_id: Optional[str]) -> None:
    with _lock:
        player = _players.get(player_id)
        if not player:
            return
        # Remove old socket mapping
        if player.socket_id and player.socket_id in _players_by_socket:
            del _players_by_socket[player.socket_id]
        player.socket_id = socket_id
        if socket_id:
            _players_by_socket[socket_id] = player_id


# ---------------------------------------------------------------------------
# Room repository
# ---------------------------------------------------------------------------
_rooms: Dict[str, Room] = {}             # keyed by room.id
_rooms_by_code: Dict[str, str] = {}      # join_code → room_id


def save_room(room: Room) -> Room:
    with _lock:
        _rooms[room.id] = room
        _rooms_by_code[room.join_code] = room.id
    return room


def get_room(room_id: str) -> Optional[Room]:
    return _rooms.get(room_id)


def get_room_by_code(code: str) -> Optional[Room]:
    rid = _rooms_by_code.get(code.upper())
    return _rooms.get(rid) if rid else None


# ---------------------------------------------------------------------------
# Membership repository
# ---------------------------------------------------------------------------
_memberships: Dict[str, List[Membership]] = {}  # room_id → [Membership]


def save_membership(m: Membership) -> Membership:
    with _lock:
        _memberships.setdefault(m.room_id, [])
        # Replace if already exists
        lst = _memberships[m.room_id]
        for i, existing in enumerate(lst):
            if existing.player_id == m.player_id:
                lst[i] = m
                return m
        lst.append(m)
    return m


def get_membership(room_id: str, player_id: str) -> Optional[Membership]:
    for m in _memberships.get(room_id, []):
        if m.player_id == player_id:
            return m
    return None


def get_room_members(room_id: str) -> List[Membership]:
    return list(_memberships.get(room_id, []))


# ---------------------------------------------------------------------------
# Match repository
# ---------------------------------------------------------------------------
_matches: Dict[str, Match] = {}          # match_id
_match_by_room: Dict[str, str] = {}      # room_id → match_id


def save_match(match: Match) -> Match:
    with _lock:
        _matches[match.id] = match
        _match_by_room[match.room_id] = match.id
    return match


def get_match(match_id: str) -> Optional[Match]:
    return _matches.get(match_id)


def get_match_by_room(room_id: str) -> Optional[Match]:
    mid = _match_by_room.get(room_id)
    return _matches.get(mid) if mid else None


# ---------------------------------------------------------------------------
# Delivery repository
# ---------------------------------------------------------------------------
_deliveries: Dict[str, List[Delivery]] = {}  # match_id → [Delivery]


def save_delivery(d: Delivery) -> Delivery:
    with _lock:
        _deliveries.setdefault(d.match_id, [])
        lst = _deliveries[d.match_id]
        for i, ex in enumerate(lst):
            if ex.id == d.id:
                lst[i] = d
                return d
        lst.append(d)
    return d


def get_deliveries(match_id: str) -> List[Delivery]:
    return list(_deliveries.get(match_id, []))


def get_current_delivery(match_id: str) -> Optional[Delivery]:
    """Returns the last uncommitted delivery, if any."""
    for d in reversed(_deliveries.get(match_id, [])):
        if not d.committed:
            return d
    return None
