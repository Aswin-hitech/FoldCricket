"""
Concurrency and thread-safety tests for match delivery resolution and timeout races.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
import time
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


def _setup_active_match():
    p1, _ = room_service.create_or_restore_player("BatterPlayer", None)
    p2, _ = room_service.create_or_restore_player("BowlerPlayer", None)
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
    bowling_p = p2 if match.batting_team == "A" else p1
    return room, match, batting_p, bowling_p


def test_concurrent_pick_submissions():
    """Verify concurrent pick submissions from batter and bowler resolve safely without race conditions."""
    room, match, batting_p, bowling_p = _setup_active_match()

    results = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(room_service.submit_pick, room, batting_p, 4)
        f2 = executor.submit(room_service.submit_pick, room, bowling_p, 6)
        for f in as_completed([f1, f2]):
            results.append(f.result())

    # Exactly one result must be None (the first submission) and one must be the resolved delivery
    resolved_deliveries = [res for _, res in results if res is not None]
    assert len(resolved_deliveries) == 1
    delivery = resolved_deliveries[0]
    assert delivery.runs_scored == 4
    assert delivery.batter_pick == 4
    assert delivery.bowler_pick == 6

    # Verify authoritative match state: exactly 1 ball bowled, exactly 4 runs scored
    updated_match = repo.get_match_for_room(room.id)
    assert updated_match.current_ball == 1
    total_runs = updated_match.team_a_runs if updated_match.batting_team == "A" else updated_match.team_b_runs
    assert total_runs == 4


def test_concurrent_duplicate_pick_prevention():
    """Verify rapid repeated pick submissions from the same player cannot be double-processed."""
    room, match, batting_p, bowling_p = _setup_active_match()

    # Pre-submit bowler pick
    room_service.submit_pick(room, bowling_p, 3)

    # Now fire 10 simultaneous batter pick submissions from multiple threads
    outcomes = []
    errors = []

    def try_submit():
        try:
            return room_service.submit_pick(room, batting_p, 5)
        except Exception as e:
            return e

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(try_submit) for _ in range(10)]
        for f in as_completed(futures):
            res = f.result()
            if isinstance(res, Exception):
                errors.append(res)
            else:
                outcomes.append(res)

    # Authoritative ball count must be exactly 1
    updated_match = repo.get_match_for_room(room.id)
    assert updated_match.current_ball == 1

    # Exactly one submission successfully resolved the ball
    resolved = [d for _, d in outcomes if d is not None and d.runs_scored == 5]
    assert len(resolved) == 1


def test_race_between_pick_and_timeout_resolution():
    """Verify that if a timeout resolution races with an incoming pick, only one succeeds atomically."""
    room, match, batting_p, bowling_p = _setup_active_match()

    # Batter submits pick
    room_service.submit_pick(room, batting_p, 4)

    # Force expiration of deadline
    from datetime import datetime, timedelta
    match.delivery_deadline = datetime.utcnow() - timedelta(seconds=1)
    repo.save_match(match)

    # Race bowler submitting pick vs timeout resolution executing
    def do_submit():
        return ("pick", room_service.submit_pick(room, bowling_p, 4))

    def do_timeout():
        return ("timeout", room_service.resolve_timeout(room))

    results = []
    with ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(do_submit)
        f2 = executor.submit(do_timeout)
        for f in as_completed([f1, f2]):
            try:
                results.append(f.result())
            except Exception as e:
                results.append(("error", e))

    updated_match = repo.get_match_for_room(room.id)
    # The ball must have advanced by exactly 1, never 2
    assert updated_match.current_ball in (0, 1)  # if wicket (4 vs 4), ball count might reset on over/innings
    deliveries = repo.get_deliveries_for_match(match.id)
    assert len(deliveries) == 1
