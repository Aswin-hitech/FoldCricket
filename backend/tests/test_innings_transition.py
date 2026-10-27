"""
Automated test suite verifying Innings Transitions, Target Calculation,
Authoritative Countdowns, and Match Completion Logic in FoldCricket.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
import pytest

from app.domain.models import InningsPhase, RoomStatus
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


def _setup_match(overs=2, wickets=1):
    p1, _ = room_service.create_or_restore_player("TeamA_Player", None)
    p2, _ = room_service.create_or_restore_player("TeamB_Player", None)
    room, _ = room_service.create_room(p1, "SOLO", overs=overs, wickets=wickets)
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
    bowling_p = p2 if match.batting_team == "A" else p1
    return room, match, batting_p, bowling_p


def test_first_innings_score_of_1_produces_target_2():
    """1. First innings score of 1 produces target 2."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # Ball 1: 1 run scored
    room_service.submit_pick(room, batting_p, 1)
    match, res1 = room_service.submit_pick(room, bowling_p, 2)
    assert res1.runs_scored == 1

    # Ball 2: OUT (1st wicket ends 1st innings)
    room_service.submit_pick(room, batting_p, 3)
    match, res2 = room_service.submit_pick(room, bowling_p, 3)
    assert res2.result.value == "OUT"

    # Verify target calculation
    assert match.target == 2
    assert room.status == RoomStatus.INNINGS_BREAK
    assert match.innings_break_deadline is not None


def test_first_innings_score_of_10_produces_target_11():
    """2. First innings score of 10 produces target 11."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # Ball 1: 6 runs
    room_service.submit_pick(room, batting_p, 6)
    room_service.submit_pick(room, bowling_p, 1)

    # Ball 2: 4 runs (total 10)
    room_service.submit_pick(room, batting_p, 4)
    room_service.submit_pick(room, bowling_p, 2)

    # Ball 3: OUT (wicket limit reached)
    room_service.submit_pick(room, batting_p, 5)
    match, res = room_service.submit_pick(room, bowling_p, 5)

    assert match.target == 11
    assert room.status == RoomStatus.INNINGS_BREAK


def test_reaching_target_ends_match_immediately():
    """3. Reaching the target ends the match immediately."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # 1st innings: 1 run, then OUT -> Target is 2
    room_service.submit_pick(room, batting_p, 1)
    room_service.submit_pick(room, bowling_p, 2)
    room_service.submit_pick(room, batting_p, 3)
    match, _ = room_service.submit_pick(room, bowling_p, 3)
    assert match.target == 2

    # Start 2nd innings
    room, match = room_service.start_second_innings(room)
    assert room.status == RoomStatus.INNINGS_ACTIVE
    new_bat = bowling_p
    new_bowl = batting_p

    # Ball 1 of 2nd innings: Chasing batter scores 2 runs!
    room_service.submit_pick(room, new_bat, 2)
    match, res = room_service.submit_pick(room, new_bowl, 5)

    # Chasing team reached target (2 >= 2) -> Match must end immediately on Ball 1!
    assert res.runs_scored == 2
    assert match.winner == match.batting_team
    assert room.status == RoomStatus.MATCH_COMPLETE
    assert match.delivery_deadline is None
    assert match.current_ball == 1


def test_score_equal_to_target_is_a_win():
    """4. A score equal to the target is a win."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # 1st innings scores 3 -> Target is 4
    room_service.submit_pick(room, batting_p, 3)
    room_service.submit_pick(room, bowling_p, 1)
    room_service.submit_pick(room, batting_p, 4)
    match, _ = room_service.submit_pick(room, bowling_p, 4)
    assert match.target == 4

    # Start 2nd innings
    room, match = room_service.start_second_innings(room)
    new_bat = bowling_p
    new_bowl = batting_p

    # Ball 1: 2 runs
    room_service.submit_pick(room, new_bat, 2)
    room_service.submit_pick(room, new_bowl, 5)

    # Ball 2: 2 runs -> Total is 4, exactly equal to target 4!
    room_service.submit_pick(room, new_bat, 2)
    match, _ = room_service.submit_pick(room, new_bowl, 6)

    assert match.winner == match.batting_team
    assert room.status == RoomStatus.MATCH_COMPLETE


def test_score_greater_than_target_cannot_be_processed_after_match_ends():
    """5. A score greater than the target cannot be processed after the match ends."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # 1st innings scores 1 -> Target 2
    room_service.submit_pick(room, batting_p, 1)
    room_service.submit_pick(room, bowling_p, 3)
    room_service.submit_pick(room, batting_p, 5)
    match, _ = room_service.submit_pick(room, bowling_p, 5)
    assert match.target == 2

    # Start 2nd innings
    room, match = room_service.start_second_innings(room)
    new_bat = bowling_p
    new_bowl = batting_p

    # Ball 1: Chasing batter hits 2 -> Wins match immediately at 2
    room_service.submit_pick(room, new_bat, 2)
    match, _ = room_service.submit_pick(room, new_bowl, 4)
    assert room.status == RoomStatus.MATCH_COMPLETE
    assert match.winner is not None

    # Attempting to submit a ball after the match has ended must be rejected
    with pytest.raises(ValueError, match="match_already_completed"):
        room_service.submit_pick(room, new_bat, 6)


def test_innings_break_countdown_server_deadline():
    """6. The innings-break countdown lasts 10 seconds according to the server deadline."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # End 1st innings
    room_service.submit_pick(room, batting_p, 4)
    match, _ = room_service.submit_pick(room, bowling_p, 4)

    assert room.status == RoomStatus.INNINGS_BREAK
    assert match.innings_break_deadline is not None

    remaining = (match.innings_break_deadline - datetime.utcnow()).total_seconds()
    assert 8.0 <= remaining <= 10.5


def test_all_clients_see_the_same_transition():
    """7. All clients see the same transition and deadline."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # End 1st innings
    room_service.submit_pick(room, batting_p, 2)
    match, _ = room_service.submit_pick(room, bowling_p, 2)

    snap1 = room_service.get_room_snapshot(room.id, batting_p.id)
    snap2 = room_service.get_room_snapshot(room.id, bowling_p.id)

    assert snap1["room"]["status"] == "INNINGS_BREAK"
    assert snap2["room"]["status"] == "INNINGS_BREAK"
    assert snap1["match"]["target"] == snap2["match"]["target"]
    assert snap1["match"]["innings_break_deadline"] == snap2["match"]["innings_break_deadline"]
    assert snap1["match"]["innings_break_deadline"] is not None


def test_reconnecting_clients_receive_correct_remaining_countdown():
    """8. Reconnecting clients receive the correct remaining countdown."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # End 1st innings
    room_service.submit_pick(room, batting_p, 2)
    match, _ = room_service.submit_pick(room, bowling_p, 2)

    # Simulate 4 seconds elapsed in break
    match.innings_break_deadline = datetime.utcnow() + timedelta(seconds=6)
    repo.save_match(match)

    snap = room_service.get_room_snapshot(room.id, bowling_p.id)
    assert snap["room"]["status"] == "INNINGS_BREAK"

    deadline_str = snap["match"]["innings_break_deadline"].replace("Z", "")
    deadline_dt = datetime.fromisoformat(deadline_str)
    rem = (deadline_dt - datetime.utcnow()).total_seconds()
    assert 4.0 <= rem <= 6.5


def test_duplicate_timeout_events_cannot_start_second_innings_twice():
    """9. Duplicate timeout events cannot start the second innings twice."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # End 1st innings
    room_service.submit_pick(room, batting_p, 3)
    match, _ = room_service.submit_pick(room, bowling_p, 3)
    assert room.status == RoomStatus.INNINGS_BREAK

    # Concurrently attempt starting 2nd innings from 5 worker threads
    results = []
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(room_service.start_second_innings, room.id) for _ in range(5)]
        for f in as_completed(futures):
            results.append(f.result())

    # All returned valid instances, room is INNINGS_ACTIVE, no corruption
    for r, m in results:
        assert r.status == RoomStatus.INNINGS_ACTIVE
        assert m.phase == InningsPhase.SECOND

    final_room = repo.get_room(room.id)
    assert final_room.status == RoomStatus.INNINGS_ACTIVE


def test_chasing_team_fails_to_reach_target_loses():
    """10. A chasing team that fails to reach the target loses when its innings ends."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # 1st innings: 5 runs, then OUT -> Target is 6
    room_service.submit_pick(room, batting_p, 5)
    room_service.submit_pick(room, bowling_p, 2)
    room_service.submit_pick(room, batting_p, 4)
    match, _ = room_service.submit_pick(room, bowling_p, 4)
    assert match.target == 6

    # Start 2nd innings
    room, match = room_service.start_second_innings(room)
    new_bat = bowling_p
    new_bowl = batting_p

    # Chasing batter scores 2 runs, then gets OUT (target 6 not reached)
    room_service.submit_pick(room, new_bat, 2)
    room_service.submit_pick(room, new_bowl, 1)

    room_service.submit_pick(room, new_bat, 3)
    match, _ = room_service.submit_pick(room, new_bowl, 3)

    # Match ended, 1st innings team wins!
    assert room.status == RoomStatus.MATCH_COMPLETE
    assert match.winner == match.first_batting_team
    assert "won by 3 runs" in match.result_summary


def test_no_deliveries_accepted_during_innings_break():
    """11. No deliveries are accepted during the innings break."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # End 1st innings -> INNINGS_BREAK
    room_service.submit_pick(room, batting_p, 4)
    match, _ = room_service.submit_pick(room, bowling_p, 4)
    assert room.status == RoomStatus.INNINGS_BREAK

    with pytest.raises(ValueError, match="cannot_submit_during_innings_break"):
        room_service.submit_pick(room, bowling_p, 3)


def test_no_deliveries_accepted_after_match_finishes():
    """12. No deliveries are accepted after the match finishes."""
    room, match, batting_p, bowling_p = _setup_match(overs=2, wickets=1)

    # 1st innings: OUT with 0 runs -> Target 1
    room_service.submit_pick(room, batting_p, 3)
    match, _ = room_service.submit_pick(room, bowling_p, 3)
    assert match.target == 1

    # Start 2nd innings
    room, match = room_service.start_second_innings(room)

    # Chasing team scores 1 -> Wins match immediately
    room_service.submit_pick(room, bowling_p, 1)
    match, _ = room_service.submit_pick(room, batting_p, 4)
    assert room.status == RoomStatus.MATCH_COMPLETE

    with pytest.raises(ValueError, match="match_already_completed"):
        room_service.submit_pick(room, bowling_p, 1)
