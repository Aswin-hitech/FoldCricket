"""
Voice security and mutual-consent authorization tests.
"""

import pytest

from app.domain.models import RoomStatus
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


def test_team_match_voice_privacy_and_mutual_consent():
    """Verify default team isolation and strict mutual-consent cross-team authorization."""
    # 1. Setup 4 players in a TEAM room
    p1, _ = room_service.create_or_restore_player("TeamA_Player1", None)
    p2, _ = room_service.create_or_restore_player("TeamA_Player2", None)
    p3, _ = room_service.create_or_restore_player("TeamB_Player1", None)
    p4, _ = room_service.create_or_restore_player("TeamB_Player2", None)

    room, _ = room_service.create_room(p1, "TEAM", 4)
    room_service.join_room(p2, room.join_code)
    room_service.join_room(p3, room.join_code)
    room_service.join_room(p4, room.join_code)

    # Assign teams
    room_service.assign_team(room, p1, p1.id, "A")
    room_service.assign_team(room, p1, p2.id, "A")
    room_service.assign_team(room, p1, p3.id, "B")
    room_service.assign_team(room, p1, p4.id, "B")

    # 2. Teammates must be authorized by default
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is True
    assert room_service.is_voice_signal_authorized(room, p2.id, p1.id) is True
    assert room_service.is_voice_signal_authorized(room, p3.id, p4.id) is True
    assert room_service.is_voice_signal_authorized(room, p4.id, p3.id) is True

    # 3. Opponents must be BLOCKED by default
    assert room_service.is_voice_signal_authorized(room, p1.id, p3.id) is False
    assert room_service.is_voice_signal_authorized(room, p3.id, p1.id) is False
    assert room_service.is_voice_signal_authorized(room, p1.id, p4.id) is False

    # 4. Unknown/outsider player must be BLOCKED
    assert room_service.is_voice_signal_authorized(room, p1.id, "non_existent_player") is False

    # 5. Cross-team voice request
    req, _ = room_service.request_cross_team_voice(room, p1, p3.id)
    assert req["from_player_id"] == p1.id
    assert req["to_player_id"] == p3.id

    # Still unauthorized until accepted!
    assert room_service.is_voice_signal_authorized(room, p1.id, p3.id) is False

    # 6. Accept request -> Mutual Consent established
    accepted, _ = room_service.respond_cross_team_voice(room, p3, p1.id, accept=True)
    assert accepted is True

    # Now both directions are authorized!
    assert room_service.is_voice_signal_authorized(room, p1.id, p3.id) is True
    assert room_service.is_voice_signal_authorized(room, p3.id, p1.id) is True

    # But p1 and p4 remain unauthorized!
    assert room_service.is_voice_signal_authorized(room, p1.id, p4.id) is False

    # 7. Revoke voice permission
    room_service.revoke_cross_team_voice(room, p1, p3.id)
    assert room_service.is_voice_signal_authorized(room, p1.id, p3.id) is False
    assert room_service.is_voice_signal_authorized(room, p3.id, p1.id) is False


def test_cross_team_voice_decline_and_cleanup():
    """Verify declining cross-team requests and cleanup on disconnect/team change."""
    p1, _ = room_service.create_or_restore_player("UserA", None)
    p2, _ = room_service.create_or_restore_player("UserB", None)
    room, _ = room_service.create_room(p1, "TEAM", 2)
    room_service.join_room(p2, room.join_code)
    room_service.assign_team(room, p1, p1.id, "A")
    room_service.assign_team(room, p1, p2.id, "B")

    # Request and decline
    room_service.request_cross_team_voice(room, p1, p2.id)
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is False

    declined, _ = room_service.respond_cross_team_voice(room, p2, p1.id, accept=False)
    assert declined is False
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is False

    # Re-request and accept, then test cleanup
    room_service.request_cross_team_voice(room, p1, p2.id)
    room_service.respond_cross_team_voice(room, p2, p1.id, accept=True)
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is True

    # Cleanup player voice (simulating disconnect or team swap)
    room_service.cleanup_player_voice(room.id, p1.id)
    assert room_service.is_voice_signal_authorized(room, p1.id, p2.id) is False
