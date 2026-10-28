"""1:1 video call signalling tests (pending state, consent, cleanup)."""

from datetime import datetime, timedelta

import pytest

from app.repositories import memory as repo
from app.services import room_service


@pytest.fixture(autouse=True)
def clean_memory():
    repo._players.clear()
    repo._players_by_socket.clear()
    repo._players_by_session.clear()
    repo._rooms.clear()
    repo._rooms_by_code.clear()
    repo._memberships.clear()
    repo._matches.clear()
    repo._match_by_room.clear()
    repo._deliveries.clear()
    room_service._pending_video_calls.clear()


def _solo_pair():
    p1, _ = room_service.create_or_restore_player("VideoHost", None)
    p2, _ = room_service.create_or_restore_player("VideoGuest", None)
    room, _ = room_service.create_room(p1, "SOLO", 2)
    room_service.join_room(p2, room.join_code)
    return room, p1, p2


def _team_pair():
    p1, _ = room_service.create_or_restore_player("TeamAHost", None)
    p2, _ = room_service.create_or_restore_player("TeamBGuest", None)
    room, _ = room_service.create_room(p1, "TEAM", 2)
    room_service.join_room(p2, room.join_code)
    room_service.assign_team(room, p1, p1.id, "A")
    room_service.assign_team(room, p1, p2.id, "B")
    return room, p1, p2


def test_video_call_request_and_accept_in_solo():
    room, p1, p2 = _solo_pair()

    payload, _ = room_service.request_video_call(room, p1, p2.id)
    assert payload["from_player_id"] == p1.id
    assert payload["to_player_id"] == p2.id
    assert room_service.has_pending_video_call(room, p1.id, p2.id) is True
    # A request alone must not become an accepted call
    assert room_service.respond_video_call(room, p2, p1.id, accept=False)[0] is False
    assert room_service.has_pending_video_call(room, p1.id, p2.id) is False

    room_service.request_video_call(room, p1, p2.id)
    accepted, _ = room_service.respond_video_call(room, p2, p1.id, accept=True)
    assert accepted is True
    assert room_service.has_pending_video_call(room, p1.id, p2.id) is False
    # SOLO media is always authorized between the two players
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is True


def test_cross_team_video_accept_grants_media_consent():
    room, p1, p2 = _team_pair()
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is False

    room_service.request_video_call(room, p1, p2.id)
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is False

    accepted, _ = room_service.respond_video_call(room, p2, p1.id, accept=True)
    assert accepted is True
    # Accepting a cross-team video call opens bidirectional media both ways
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is True
    assert room_service.is_voice_signal_authorized(room, p2.id, p1.id) is True

    # Ending the call stops the pending state but keeps the granted consent
    room_service.end_video_call(room, p1, p2.id)
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is True


def test_video_call_requires_pending_request_and_valid_members():
    room, p1, p2 = _solo_pair()

    with pytest.raises(ValueError):
        room_service.respond_video_call(room, p2, p1.id, accept=True)
    with pytest.raises(ValueError):
        room_service.request_video_call(room, p1, p1.id)
    with pytest.raises(ValueError):
        room_service.request_video_call(room, p1, "not_a_member")
    with pytest.raises(ValueError):
        room_service.request_video_call("no_such_room", p1, p2.id)


def test_pending_video_calls_expire():
    room, p1, p2 = _solo_pair()
    key = (room.id, p1.id, p2.id)
    room_service._pending_video_calls[key] = datetime.utcnow() - timedelta(
        seconds=room_service.VIDEO_CALL_PENDING_TTL_SECONDS + 5
    )
    assert room_service.has_pending_video_call(room, p1.id, p2.id) is False


def test_cleanup_player_video_calls_notifies_peer():
    room, p1, p2 = _solo_pair()
    room_service.request_video_call(room, p1, p2.id)

    peers = room_service.cleanup_player_video_calls(room.id, p1.id)
    assert peers == [p2.id]
    assert room_service._pending_video_calls == {}
