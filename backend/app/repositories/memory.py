"""
HandCricket Live – Repository Interface Layer.
Delegates to durable SQLite repository (backend/app/repositories/sqlite.py)
providing ACID transactions, atomic delivery uniqueness constraints, and process restart persistence.
Includes backward-compatible dictionary facades for test fixtures.
"""

from __future__ import annotations

from typing import Any, Dict

from .sqlite import (
    _lock,
    cleanup_player_voice_permissions,
    clear_all as _sqlite_clear_all,
    delete_room,
    delete_voice_permission,
    get_current_delivery,
    get_deliveries,
    get_deliveries_for_match,
    get_match,
    get_match_by_room,
    get_match_for_room,
    get_membership,
    get_memberships_for_player,
    get_player,
    get_player_by_session,
    get_player_by_socket,
    get_player_for_user,
    get_room,
    get_room_by_code,
    get_room_members,
    get_room_voice_permissions,
    get_voice_permission,
    init_db,
    purge_stale_data,
    remove_membership,
    save_delivery,
    save_match,
    save_membership,
    save_player,
    save_room,
    set_voice_permission,
    update_player_socket,
)


class _ClearProxyDict(dict):
    def clear(self):
        super().clear()
        _sqlite_clear_all()


_players = _ClearProxyDict()
_players_by_session = _ClearProxyDict()
_players_by_socket = _ClearProxyDict()
_rooms = _ClearProxyDict()
_rooms_by_code = _ClearProxyDict()
_memberships = _ClearProxyDict()
_matches = _ClearProxyDict()
_match_by_room = _ClearProxyDict()
_deliveries = _ClearProxyDict()


def clear_all():
    _players.clear()
    _players_by_session.clear()
    _players_by_socket.clear()
    _rooms.clear()
    _rooms_by_code.clear()
    _memberships.clear()
    _matches.clear()
    _match_by_room.clear()
    _deliveries.clear()
    _sqlite_clear_all()


__all__ = [
    "_lock",
    "_players",
    "_players_by_session",
    "_players_by_socket",
    "_rooms",
    "_rooms_by_code",
    "_memberships",
    "_matches",
    "_match_by_room",
    "_deliveries",
    "init_db",
    "clear_all",
    "save_player",
    "get_player",
    "get_player_by_session",
    "get_player_by_socket",
    "get_player_for_user",
    "update_player_socket",
    "save_room",
    "get_room",
    "get_room_by_code",
    "delete_room",
    "save_membership",
    "get_membership",
    "get_room_members",
    "remove_membership",
    "save_match",
    "get_match",
    "get_match_by_room",
    "save_delivery",
    "get_deliveries",
    "get_current_delivery",
    "set_voice_permission",
    "get_voice_permission",
    "get_room_voice_permissions",
    "delete_voice_permission",
    "cleanup_player_voice_permissions",
    "purge_stale_data",
]
