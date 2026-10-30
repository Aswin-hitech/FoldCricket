"""
Lobby membership tests: voluntary exit and captain/host removal.
"""

import pytest

from app.domain.models import RoomStatus
from app.repositories import memory as repo
from app.services import room_service


@pytest.fixture(autouse=True)
def clean_memory():
    repo.clear_all()


def _make_lobby(count=2):
    players = []
    room = None
    for i in range(count):
        p, _ = room_service.create_or_restore_player(f"Player{i + 1}", None)
        players.append(p)
        if room is None:
            room, _ = room_service.create_room(p, "TEAM", 2, wickets=2)
        else:
            room_service.join_room(p, room.join_code)
    return repo.get_room(room.id), players


def test_player_can_leave_lobby():
    room, players = _make_lobby(2)
    assert room.status == RoomStatus.LOBBY_READY

    room = room_service.leave_lobby(room, players[1])

    assert room is not None
    assert repo.get_membership(room.id, players[1].id) is None
    assert len(repo.get_room_members(room.id)) == 1
    assert room.status == RoomStatus.WAITING_FOR_PLAYERS


def test_host_leaving_transfers_host_and_keeps_room():
    room, players = _make_lobby(2)
    remaining = players[1]

    room = room_service.leave_lobby(room, players[0])

    assert room is not None
    new_host_mem = repo.get_membership(room.id, remaining.id)
    assert new_host_mem.is_host is True
    assert room.host_id == remaining.id
    assert room.status == RoomStatus.WAITING_FOR_PLAYERS


def test_last_player_leaving_deletes_the_room():
    room, players = _make_lobby(1)
    room_id = room.id

    result = room_service.leave_lobby(room, players[0])

    assert result is None
    assert repo.get_room(room_id) is None
    assert repo.get_room_members(room_id) == []


def test_host_can_remove_a_player_from_the_lobby():
    room, players = _make_lobby(3)
    host, target = players[0], players[2]

    room = room_service.remove_player_from_lobby(room, host, target.id)

    assert room is not None
    assert repo.get_membership(room.id, target.id) is None
    assert len(repo.get_room_members(room.id)) == 2


def _promote_captain(room, player):
    mem = repo.get_membership(room.id, player.id)
    mem.is_captain = True
    repo.save_membership(mem)


def test_team_captain_can_remove_a_teammate_but_not_the_other_team():
    room, players = _make_lobby(4)
    host, captain, mate, opponent = players
    room_service.assign_team(room, host, captain.id, "B")
    room_service.assign_team(room, host, mate.id, "B")
    room_service.assign_team(room, host, opponent.id, "A")
    _promote_captain(room, captain)

    with pytest.raises(PermissionError):
        room_service.remove_player_from_lobby(room, captain, opponent.id)

    room = room_service.remove_player_from_lobby(room, captain, mate.id)
    assert repo.get_membership(room.id, mate.id) is None
    assert len(repo.get_room_members(room.id)) == 3


def test_removing_a_captain_promotes_a_teammate():
    room, players = _make_lobby(4)
    host, captain, mate, _ = players
    room_service.assign_team(room, host, captain.id, "B")
    room_service.assign_team(room, host, mate.id, "B")
    _promote_captain(room, captain)

    room_service.remove_player_from_lobby(room, host, captain.id)

    promoted = repo.get_membership(room.id, mate.id)
    assert promoted.is_captain is True


def test_non_captain_cannot_remove_players():
    room, players = _make_lobby(3)
    plain_player, target = players[1], players[2]

    with pytest.raises(PermissionError):
        room_service.remove_player_from_lobby(room, plain_player, target.id)


def test_cannot_remove_self_or_the_host():
    room, players = _make_lobby(3)
    host, other = players[0], players[1]

    with pytest.raises(ValueError):
        room_service.remove_player_from_lobby(room, host, host.id)
    with pytest.raises(PermissionError):
        room_service.remove_player_from_lobby(room, other, host.id)


def test_leaving_is_blocked_once_the_match_is_live():
    room, players = _make_lobby(2)
    room.status = RoomStatus.INNINGS_ACTIVE
    repo.save_room(room)

    with pytest.raises(ValueError):
        room_service.leave_lobby(room, players[0])
    with pytest.raises(ValueError):
        room_service.remove_player_from_lobby(room, players[0], players[1].id)
