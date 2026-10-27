"""
Integration tests for complete gameplay flow, delivery progression, and pause/resume.
"""

from datetime import datetime
import pytest

from app.domain.models import (
    GameMode,
    InningsPhase,
    Player,
    PlayerRole,
    RoomStatus,
)
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


def test_solo_gameplay_progression_and_innings_transition():
    # 1. Register players
    p1, _ = room_service.create_or_restore_player("Sachin", None)
    p2, _ = room_service.create_or_restore_player("Warne", None)

    # 2. Create and join solo room
    room, _ = room_service.create_room(p1, "SOLO", 2)
    room_service.join_room(p2, room.join_code)

    # 3. Ready up
    room_service.ack_rules(room, p1)
    room_service.ack_rules(room, p2)
    room_service.set_ready(room, p1, True)
    room_service.set_ready(room, p2, True)

    # 4. Toss - Opponent p2 calls the toss
    room_service.start_toss(room, p1)
    assert room.toss["caller_id"] == p2.id
    with pytest.raises(PermissionError):
        room_service.call_toss(room, p1, "HEADS")  # Host cannot call toss
    toss = room_service.call_toss(room, p2, "HEADS")  # Opponent calls toss
    winner = p1 if toss["winner_id"] == p1.id else p2
    match = room_service.decide_toss(room, winner, "BAT")

    assert room.status == RoomStatus.INNINGS_ACTIVE
    batting_p = p1 if match.batting_team == "A" else p2
    bowling_p = p2 if match.batting_team == "A" else p1
    assert match.active_batter_id == batting_p.id
    # Bowler should be auto-assigned in solo mode!
    assert match.active_bowler_id == bowling_p.id
    assert match.delivery_deadline is not None

    # 5. Delivery 1: batter picks 4, bowler picks 6 -> 4 runs scored
    match, res1 = room_service.submit_pick(room, batting_p, 4)
    assert res1 is None  # waiting for bowler
    match, res1 = room_service.submit_pick(room, bowling_p, 6)
    assert res1 is not None
    assert res1.runs_scored == 4
    first_inns_runs = match.team_a_runs if match.batting_team == "A" else match.team_b_runs
    assert first_inns_runs == 4
    assert match.current_ball == 1
    assert match.active_batter_id == batting_p.id
    assert match.active_bowler_id == bowling_p.id
    # Deadline should be refreshed for ball 2!
    assert match.delivery_deadline is not None
    assert match.delivery_deadline > datetime.utcnow()

    # 6. Delivery 2: batter picks 3, bowler picks 3 -> OUT!
    # In solo mode, 1 wicket ends 1st innings and starts 2nd innings!
    match, res2 = room_service.submit_pick(room, batting_p, 3)
    assert res2 is None
    match, res2 = room_service.submit_pick(room, bowling_p, 3)
    assert res2 is not None
    assert res2.result.value == "OUT"

    # Innings transition: target is set (4 + 1 = 5), phase is SECOND, status is INNINGS_BREAK
    assert match.phase == InningsPhase.SECOND
    assert match.target == 5
    assert room.status == RoomStatus.INNINGS_BREAK
    assert match.innings_break_deadline is not None

    # Transition to 2nd innings after break
    room, match = room_service.start_second_innings(room)
    assert room.status == RoomStatus.INNINGS_ACTIVE
    assert match.active_batter_id == bowling_p.id
    assert match.active_bowler_id == batting_p.id
    assert match.delivery_deadline is not None

    # 7. Delivery in 2nd Innings: new batter picks 6, new bowler picks 2 -> 6 runs scored
    match, res3 = room_service.submit_pick(room, bowling_p, 6)
    assert res3 is None
    match, res3 = room_service.submit_pick(room, batting_p, 2)
    assert res3 is not None
    assert res3.runs_scored == 6

    # Target chased! Match should be complete!
    assert match.winner is not None
    assert room.status == RoomStatus.MATCH_COMPLETE


def test_custom_wickets_setting_and_match_limit():
    p1, _ = room_service.create_or_restore_player("Dhoni", None)
    # Solo match with 3 wickets per team (max 5)
    room, _ = room_service.create_room(p1, "SOLO", 2, wickets=3)
    assert room.wickets == 3

    p2, _ = room_service.create_or_restore_player("Kohli", None)
    room_service.join_room(p2, room.join_code)
    room_service.ack_rules(room, p1)
    room_service.ack_rules(room, p2)
    room_service.set_ready(room, p1, True)
    room_service.set_ready(room, p2, True)

    room_service.start_toss(room, p1)
    toss = room_service.call_toss(room, p2, "HEADS")
    winner = p1 if toss["winner_id"] == p1.id else p2
    match = room_service.decide_toss(room, winner, "BAT")

    assert match.wickets == 3
    assert match.wicket_limit("A") == 3
    assert match.wicket_limit("B") == 3
