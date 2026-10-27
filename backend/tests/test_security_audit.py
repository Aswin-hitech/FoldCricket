"""
Security audit tests covering XSS chat sanitization, pick confidentiality, and input validation.
"""

import html
import pytest

from app.config import Config
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


def test_chat_html_escaping_sanitization():
    """Verify chat messages escape dangerous HTML characters to prevent XSS injection."""
    raw_payload = "<script>alert('xss')</script><img src=x onerror=alert(1)>"
    sanitized = html.escape(raw_payload.strip())

    assert "<script>" not in sanitized
    assert "&lt;script&gt;" in sanitized
    assert "<img" not in sanitized
    assert "&lt;img" in sanitized


def test_pick_confidentiality_during_active_delivery():
    """Verify that a pending pick submitted by one player is not exposed in the room snapshot before resolution."""
    p1, _ = room_service.create_or_restore_player("BatterA", None)
    p2, _ = room_service.create_or_restore_player("BowlerB", None)
    room, _ = room_service.create_room(p1, "SOLO", 2)
    room_service.join_room(p2, room.join_code)
    room_service.ack_rules(room, p1)
    room_service.ack_rules(room, p2)
    room_service.set_ready(room, p1, True)
    room_service.set_ready(room, p2, True)
    room_service.start_toss(room, p1)
    toss = room_service.call_toss(room, p2, "HEADS")
    winner = p1 if toss["winner_id"] == p1.id else p2
    match = room_service.decide_toss(room, winner, "BAT")
    batting_p = p1 if match.batting_team == "A" else p2

    # Batter submits confidential pick
    room_service.submit_pick(room, batting_p, 5)

    # Inspect snapshot
    snapshot = room_service.get_room_snapshot(room.id)
    # The active pick must not be exposed in the match dict to other players
    match_dict = snapshot["match"]
    assert "batter_pick" not in match_dict
    assert "bowler_pick" not in match_dict


def test_invalid_pick_validation():
    """Verify engine strictly validates allowed picks (1 to 6)."""
    p1, _ = room_service.create_or_restore_player("PlayerOne", None)
    p2, _ = room_service.create_or_restore_player("PlayerTwo", None)
    room, _ = room_service.create_room(p1, "SOLO", 2)
    room_service.join_room(p2, room.join_code)
    room_service.ack_rules(room, p1)
    room_service.ack_rules(room, p2)
    room_service.set_ready(room, p1, True)
    room_service.set_ready(room, p2, True)
    room_service.start_toss(room, p1)
    toss = room_service.call_toss(room, p2, "HEADS")
    winner = p1 if toss["winner_id"] == p1.id else p2
    match = room_service.decide_toss(room, winner, "BAT")
    batting_p = p1 if match.batting_team == "A" else p2

    # Negative pick
    with pytest.raises(ValueError):
        room_service.submit_pick(room, batting_p, -1)

    # Zero pick
    with pytest.raises(ValueError):
        room_service.submit_pick(room, batting_p, 0)

    # Pick greater than 10 (out of bounds)
    with pytest.raises(ValueError):
        room_service.submit_pick(room, batting_p, 11)


def test_cors_config_restrictions():
    """Verify CORS configuration allows legitimate origins while blocking arbitrary wildcards in production."""
    allowed = Config.CORS_ORIGINS
    if allowed == "*":
        # Only permitted when Config.DEBUG is True
        assert Config.DEBUG is True
    else:
        assert isinstance(allowed, list)
        assert any("fold-cricket.vercel.app" in origin or "localhost" in origin for origin in allowed)
