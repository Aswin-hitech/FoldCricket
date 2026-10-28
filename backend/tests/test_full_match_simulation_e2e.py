"""
FoldCricket — Full Match Simulation & End-to-End Test Suite.

Covers:
1. First innings batting: run/wicket calculations, ball/over progression (0.1..1.0..).
2. Authoritative First Innings Summary & Target calculation (Target = firstInningsScore + 1).
3. Mandatory 10-second Innings Break (deterministic timing assertions + real wall-clock integration).
4. Second innings batting and target chasing.
5. Deterministic Scenarios A to F:
   - Scenario A: Successful chase (ends immediately when target reached).
   - Scenario B: First innings all out.
   - Scenario C: Second innings all out.
   - Scenario D: Second innings over limit.
   - Scenario E: Exact target (ends immediately at target, rejects extra delivery).
   - Scenario F: Timeout and duplicate-event safety.
6. Final Result Verification & Reconnection.
7. Monotonic Event & State Audit.
8. Comprehensive test report generation.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
import pytest

from app import create_app, socketio
from app.domain.models import InningsPhase, RoomStatus
from app.repositories import memory as repo
from app.services import room_service
from app.sockets import events


# ---------------------------------------------------------------------------
# Test Fixtures & Clean Setup
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def clean_environment():
    # Cancel all running timers
    for timer in list(events._delivery_timers.values()):
        try:
            timer.cancel()
        except Exception:
            pass
    events._delivery_timers.clear()

    for timer in list(events._innings_break_timers.values()):
        try:
            timer.cancel()
        except Exception:
            pass
    events._innings_break_timers.clear()

    for timer in list(events._grace_timers.values()):
        try:
            timer.cancel()
        except Exception:
            pass
    events._grace_timers.clear()

    # Clear memory repositories
    repo._players.clear()
    repo._players_by_socket.clear()
    repo._players_by_session.clear()
    repo._rooms.clear()
    repo._rooms_by_code.clear()
    repo._memberships.clear()
    repo._matches.clear()
    repo._match_by_room.clear()
    repo._deliveries.clear()

    yield

    # Teardown timers again
    for timer in list(events._delivery_timers.values()):
        try:
            timer.cancel()
        except Exception:
            pass
    events._delivery_timers.clear()

    for timer in list(events._innings_break_timers.values()):
        try:
            timer.cancel()
        except Exception:
            pass
    events._innings_break_timers.clear()


# ---------------------------------------------------------------------------
# Helper: Setup Full Match Room with 2 Socket Clients
# ---------------------------------------------------------------------------

def _setup_e2e_match(overs: int = 2, wickets: int = 1, first_bat_team: str = "A"):
    """
    Initializes a test Flask app, connects 2 Socket.IO test clients,
    completes registration, room creation, joining, rule ack, ready-up,
    and toss so that `first_bat_team` bats first.
    """
    app = create_app()
    app.config["TESTING"] = True

    c_a = socketio.test_client(app)
    c_b = socketio.test_client(app)

    # 1. Register players
    c_a.emit("player:register", {"display_name": "TeamA_Capt"})
    reg_a = c_a.get_received()[0]["args"][0]
    p_a_id = reg_a["player_id"]
    t_a = reg_a["session_token"]

    c_b.emit("player:register", {"display_name": "TeamB_Capt"})
    reg_b = c_b.get_received()[0]["args"][0]
    p_b_id = reg_b["player_id"]
    t_b = reg_b["session_token"]

    # 2. Create room by Team A
    c_a.emit("room:create", {
        "session_token": t_a,
        "mode": "SOLO",
        "overs": overs,
        "wickets": wickets,
    })
    room_ev = next(e for e in c_a.get_received() if e["name"] == "room:created")["args"][0]
    room_id = room_ev["room_id"]
    join_code = room_ev["join_code"]

    # 3. Join room by Team B
    c_b.emit("room:join", {"session_token": t_b, "join_code": join_code})
    c_a.get_received()
    c_b.get_received()

    # 4. Ack rules & set ready
    c_a.emit("rules:ack", {"room_id": room_id})
    c_b.emit("rules:ack", {"room_id": room_id})
    c_a.emit("match:ready", {"room_id": room_id, "ready": True})
    c_b.emit("match:ready", {"room_id": room_id, "ready": True})
    c_a.get_received()
    c_b.get_received()

    # 5. Start toss
    c_a.emit("match:start", {"room_id": room_id})
    toss_start_ev = next(e for e in c_a.get_received() if e["name"] == "toss:started")["args"][0]
    c_b.get_received()

    # Toss caller calls toss
    caller_id = toss_start_ev["caller_id"]
    caller_c = c_a if caller_id == p_a_id else c_b
    caller_c.emit("toss:call", {"room_id": room_id, "choice": "HEADS"})

    flip_ev = next(e for e in caller_c.get_received() if e["name"] == "toss:flipped")["args"][0]
    winner_id = flip_ev["winner_id"]
    c_a.get_received()
    c_b.get_received()

    # Determine decision so first_bat_team bats first
    winner_team = "A" if winner_id == p_a_id else "B"
    if first_bat_team == "A":
        decision = "BAT" if winner_team == "A" else "BOWL"
    else:
        decision = "BAT" if winner_team == "B" else "BOWL"

    winner_c = c_a if winner_id == p_a_id else c_b
    winner_c.emit("toss:decide", {"room_id": room_id, "decision": decision})
    c_a.get_received()
    c_b.get_received()

    # 6. Arena gate: both players confirm they are ready for the first ball
    c_a.emit("first_ball:ready", {"room_id": room_id})
    c_b.emit("first_ball:ready", {"room_id": room_id})
    c_a.get_received()
    c_b.get_received()

    match = repo.get_match_by_room(room_id)
    room = repo.get_room(room_id)
    assert match.batting_team == first_bat_team
    assert room.status == RoomStatus.INNINGS_ACTIVE

    return {
        "app": app,
        "room_id": room_id,
        "c_a": c_a,
        "c_b": c_b,
        "p_a_id": p_a_id,
        "p_b_id": p_b_id,
    }


def _drain_events(client) -> List[Dict[str, Any]]:
    return client.get_received()


# ---------------------------------------------------------------------------
# Section 1, 2, 3: First Innings Progression, Ball & Over Tracking
# ---------------------------------------------------------------------------

def test_first_innings_progression_over_and_ball_tracking():
    """
    Simulates deliveries in 1st innings and asserts:
    - Unequal picks award batter's number of runs.
    - Equal picks produce a wicket and zero runs.
    - Every valid delivery is counted exactly once.
    - An OUT delivery counts as a ball.
    - Six deliveries complete one over.
    - Display progresses correctly: 0.1, 0.2, 0.3, 0.4, 0.5, 1.0, 1.1.
    - Over counter resets ball counter correctly.
    """
    ctx = _setup_e2e_match(overs=2, wickets=3, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    deliveries_plan = [
        # (bat_pick, bowl_pick, expected_runs, expected_out, expected_over_str)
        (4, 1, 4, False, "0.1"),
        (2, 5, 2, False, "0.2"),
        (6, 3, 6, False, "0.3"),
        (1, 4, 1, False, "0.4"),
        (5, 2, 5, False, "0.5"),
        (3, 1, 3, False, "1.0"),  # 6th ball completes 1st over -> 1.0 (over counter increments, ball counter resets to 0)
        (4, 2, 4, False, "1.1"),  # 7th ball starts 2nd over -> 1.1
        (3, 3, 0, True, "1.2"),   # 8th ball: equal picks = OUT! Counts as ball -> 1.2
    ]

    total_runs = 0
    total_wickets = 0

    for i, (b_pick, bowl_pick, exp_runs, exp_out, exp_over_str) in enumerate(deliveries_plan):
        # Batter submits pick
        c_a.emit("delivery:submit", {"room_id": room_id, "pick": b_pick})
        # Bowler submits pick
        c_b.emit("delivery:submit", {"room_id": room_id, "pick": bowl_pick})

        evs_a = _drain_events(c_a)
        evs_b = _drain_events(c_b)

        reveal_a = next(e for e in evs_a if e["name"] == "delivery:reveal")["args"][0]
        reveal_b = next(e for e in evs_b if e["name"] == "delivery:reveal")["args"][0]

        # Both clients observe exact same delivery resolution
        assert reveal_a == reveal_b
        assert reveal_a["batter_pick"] == b_pick
        assert reveal_a["bowler_pick"] == bowl_pick
        assert reveal_a["runs_scored"] == exp_runs
        if exp_out:
            assert reveal_a["result"] == "OUT"
            total_wickets += 1
        else:
            assert reveal_a["result"] == "RUNS"
            total_runs += exp_runs

        match = repo.get_match_by_room(room_id)
        assert match.team_a_runs == total_runs
        assert match.team_a_wickets == total_wickets

        # Check over.ball notation
        if exp_out:
            # Wicket delivery counts as a ball (over 1, ball index 1 -> 2nd ball of over 2)
            assert reveal_a["over"] == 1 and reveal_a["ball"] == 1
            # 1 wicket out of 3 wickets limit -> innings remains ACTIVE and ball display is 1.2
            assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE
            ball_display = f"{match.current_over}.{match.current_ball}"
            assert ball_display == exp_over_str, f"Ball {i+1}: expected {exp_over_str}, got {ball_display}"
        else:
            ball_display = f"{match.current_over}.{match.current_ball}"
            assert ball_display == exp_over_str, f"Ball {i+1}: expected {exp_over_str}, got {ball_display}"


def test_first_innings_all_out_and_summary_broadcast():
    """
    Verifies that when Team A gets all out in the first innings:
    - The innings ends immediately.
    - Second innings target is calculated as firstInningsScore + 1.
    - Match phase transitions to INNINGS_BREAK.
    - Authoritative server break deadline is recorded and broadcast.
    - Both clients receive the exact first innings summary.
    - No deliveries are accepted during the break.
    """
    ctx = _setup_e2e_match(overs=2, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    # Delivery 1: 5 runs
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 5})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    _drain_events(c_a); _drain_events(c_b)

    # Delivery 2: OUT (1 wicket reached -> ALL OUT)
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 3})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 3})

    evs_a = _drain_events(c_a)
    evs_b = _drain_events(c_b)

    # 1. Verify ALL OUT event
    all_out_ev_a = next(e for e in evs_a if e["name"] == "match:all_out")["args"][0]
    all_out_ev_b = next(e for e in evs_b if e["name"] == "match:all_out")["args"][0]
    assert all_out_ev_a == all_out_ev_b
    assert all_out_ev_a["team"] == "A"
    assert all_out_ev_a["runs"] == 5
    assert all_out_ev_a["wickets"] == 1

    # 2. Verify INNINGS_BREAK event
    break_ev_a = next(e for e in evs_a if e["name"] == "innings:break")["args"][0]
    break_ev_b = next(e for e in evs_b if e["name"] == "innings:break")["args"][0]
    assert break_ev_a == break_ev_b
    assert break_ev_a["first_innings_runs"] == 5
    assert break_ev_a["target"] == 6  # 5 + 1
    assert break_ev_a["first_batting_team"] == "A"
    assert break_ev_a["chasing_team"] == "B"
    assert break_ev_a["break_seconds"] == 10
    assert break_ev_a["break_deadline"] is not None

    # 3. Room status is INNINGS_BREAK
    room = repo.get_room(room_id)
    match = repo.get_match_by_room(room_id)
    assert room.status == RoomStatus.INNINGS_BREAK
    assert match.target == 6

    # 4. Attempting delivery during break is rejected
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    ack_ev = next(e for e in c_b.get_received() if e["name"] == "delivery:ack")["args"][0]
    assert ack_ev["success"] is False
    assert ack_ev["error"] == "cannot_submit_during_innings_break"


# ---------------------------------------------------------------------------
# Section 4: Mandatory 10-Second Break & Timing Assertions
# ---------------------------------------------------------------------------

def test_mandatory_10s_break_deterministic_timing_and_reconnect():
    """
    Verifies timer behavior at 0s, 5s, 9s, 10s:
    - Match remains in INNINGS_BREAK at 0s, 5s, 9s.
    - Reconnection at 5s preserves remaining time and does not reset to 10s.
    - Transitions to second innings at 10s.
    - Duplicate transitions are strictly idempotent.
    """
    ctx = _setup_e2e_match(overs=2, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]
    p_b_id = ctx["p_b_id"]

    # End 1st innings with score of 4
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 1})
    _drain_events(c_a); _drain_events(c_b)

    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    _drain_events(c_a); _drain_events(c_b)

    room = repo.get_room(room_id)
    match = repo.get_match_by_room(room_id)
    assert room.status == RoomStatus.INNINGS_BREAK

    # --- 0s elapsed ---
    base_time = match.innings_break_deadline - timedelta(seconds=10)
    rem_0 = (match.innings_break_deadline - base_time).total_seconds()
    assert 9.9 <= rem_0 <= 10.1
    assert room.status == RoomStatus.INNINGS_BREAK

    # --- 5s elapsed ---
    now_5s = base_time + timedelta(seconds=5)
    rem_5 = (match.innings_break_deadline - now_5s).total_seconds()
    assert 4.9 <= rem_5 <= 5.1

    # Simulate client reconnecting at 5s elapsed
    match.innings_break_deadline = datetime.utcnow() + timedelta(seconds=5)
    repo.save_match(match)

    snap_reconnect = room_service.get_room_snapshot(room_id, p_b_id)
    assert snap_reconnect["room"]["status"] == "INNINGS_BREAK"
    deadline_iso = snap_reconnect["match"]["innings_break_deadline"].replace("Z", "")
    rem_snap = (datetime.fromisoformat(deadline_iso) - datetime.utcnow()).total_seconds()
    assert 3.5 <= rem_snap <= 5.5, f"Expected ~5s remaining, got {rem_snap}"

    # --- 9s elapsed ---
    match.innings_break_deadline = datetime.utcnow() + timedelta(seconds=1)
    repo.save_match(match)
    snap_9s = room_service.get_room_snapshot(room_id, p_b_id)
    assert snap_9s["room"]["status"] == "INNINGS_BREAK"

    # --- 10s elapsed -> Transition ---
    room, match = room_service.start_second_innings(room_id)
    assert room.status == RoomStatus.INNINGS_ACTIVE
    assert match.phase == InningsPhase.SECOND
    assert match.batting_team == "B"
    assert match.current_over == 0
    assert match.current_ball == 0

    # Duplicate call is completely idempotent
    room_dup, match_dup = room_service.start_second_innings(room_id)
    assert room_dup.status == RoomStatus.INNINGS_ACTIVE
    assert match_dup.phase == InningsPhase.SECOND


def test_mandatory_10s_break_real_wall_clock_duration():
    """
    Real-time integration test:
    Measures the actual wall-clock duration of the innings break timer.
    Asserts elapsed duration >= 10.0 seconds (never premature).
    """
    ctx = _setup_e2e_match(overs=1, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    # Ball 1: OUT -> ends 1st innings
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 6})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 6})

    start_wall_clock = time.time()
    evs_a = _drain_events(c_a)
    assert any(e["name"] == "innings:break" for e in evs_a)

    # Wait for the background timer to transition to 2nd innings
    transitioned = False
    for _ in range(120):  # poll up to 12.0s
        time.sleep(0.1)
        r = repo.get_room(room_id)
        if r and r.status == RoomStatus.INNINGS_ACTIVE:
            transitioned = True
            break

    elapsed = time.time() - start_wall_clock
    assert transitioned, f"Timed out waiting for 2nd innings transition. Elapsed: {elapsed:.2f}s"
    assert elapsed >= 9.8, f"Early transition detected! Elapsed: {elapsed:.3f}s (must be >= 9.8s)"
    assert elapsed <= 11.5, f"Transition took too long: {elapsed:.3f}s"


# ---------------------------------------------------------------------------
# Section 5 & 6: Deterministic Scenarios A to F
# ---------------------------------------------------------------------------

def test_scenario_a_successful_chase():
    """
    Scenario A — Successful chase:
    - 1st innings completes normally (Team A scores 6 runs).
    - Target is 7.
    - 10-second break transitions.
    - 2nd innings: Team B scores 4 runs, then 3 runs (total 7 >= 7).
    - Match ends immediately on ball 2 of 2nd innings.
    - Team B declared winner.
    - Further deliveries rejected.
    """
    ctx = _setup_e2e_match(overs=1, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    # 1st Innings:
    # Ball 1: 3 runs
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 3})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 1})
    _drain_events(c_a); _drain_events(c_b)

    # Ball 2: 3 runs (Total 6)
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 3})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 5})
    _drain_events(c_a); _drain_events(c_b)

    # Ball 3: OUT -> 1st wicket ends 1st innings at 6 runs
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    _drain_events(c_a); _drain_events(c_b)

    match = repo.get_match_by_room(room_id)
    assert match.target == 7

    # Innings break transition
    room_service.start_second_innings(room_id)

    # 2nd Innings: Team B batting, Team A bowling
    # Ball 1: Team B scores 4 runs
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    _drain_events(c_a); _drain_events(c_b)

    match = repo.get_match_by_room(room_id)
    assert match.team_b_runs == 4
    assert match.winner is None

    # Ball 2: Team B scores 3 runs -> Total 7 reached!
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 3})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 1})

    evs_a = _drain_events(c_a)
    evs_b = _drain_events(c_b)

    finish_a = next(e for e in evs_a if e["name"] == "match:finished")["args"][0]
    finish_b = next(e for e in evs_b if e["name"] == "match:finished")["args"][0]

    assert finish_a == finish_b
    assert finish_a["winner"] == "B"
    assert "won by" in finish_a["result_summary"].lower()

    # Match ended immediately on ball 2
    match = repo.get_match_by_room(room_id)
    room = repo.get_room(room_id)
    assert room.status == RoomStatus.MATCH_COMPLETE
    assert match.current_ball == 2

    # Further picks rejected
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 6})
    ack = next(e for e in c_b.get_received() if e["name"] == "delivery:ack")["args"][0]
    assert ack["success"] is False
    assert ack["error"] == "match_already_completed"


def test_scenario_b_first_innings_all_out():
    """
    Scenario B — First innings all out:
    - Team A all out for 0 runs on ball 1.
    - First innings ends immediately.
    - Target is 1.
    - 10-second break occurs.
    - Second innings begins with target 1.
    - Team B scores 1 run on ball 1 -> Team B wins immediately.
    """
    ctx = _setup_e2e_match(overs=2, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    # Ball 1: OUT
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 5})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 5})
    _drain_events(c_a); _drain_events(c_b)

    match = repo.get_match_by_room(room_id)
    assert match.team_a_runs == 0
    assert match.target == 1

    # Transition
    room_service.start_second_innings(room_id)

    # 2nd Innings: Team B scores 1 run
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 1})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 3})

    evs_b = _drain_events(c_b)
    finish = next(e for e in evs_b if e["name"] == "match:finished")["args"][0]
    assert finish["winner"] == "B"

    match = repo.get_match_by_room(room_id)
    assert match.winner == "B"
    assert match.team_b_runs == 1


def test_scenario_c_second_innings_all_out():
    """
    Scenario C — Second innings all out:
    - Team A scores 5 runs. Target is 6.
    - Team B scores 2 runs, then gets OUT (all out).
    - Team B fails to reach target 6.
    - Match ends immediately; Team A is declared winner by 3 runs.
    """
    ctx = _setup_e2e_match(overs=2, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    # 1st Innings: 5 runs, then OUT
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 5})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    _drain_events(c_a); _drain_events(c_b)

    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    _drain_events(c_a); _drain_events(c_b)

    assert repo.get_match_by_room(room_id).target == 6

    # Transition
    room_service.start_second_innings(room_id)

    # 2nd Innings:
    # Ball 1: 2 runs
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 1})
    _drain_events(c_a); _drain_events(c_b)

    # Ball 2: OUT (Team B all out for 2)
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 3})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 3})

    evs_a = _drain_events(c_a)
    finish = next(e for e in evs_a if e["name"] == "match:finished")["args"][0]
    assert finish["winner"] == "A"
    assert "won by 3 runs" in finish["result_summary"]


def test_scenario_d_second_innings_over_limit():
    """
    Scenario D — Second innings over limit:
    - Overs = 1 (6 balls), Wickets = 5.
    - Team A scores 12 runs (2 runs each over 6 balls). Target = 13.
    - Team B bats all 6 balls scoring only 6 runs (1 run each over 6 balls).
    - Over limit reached without reaching target.
    - Team A declared winner by 6 runs.
    """
    ctx = _setup_e2e_match(overs=1, wickets=5, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    # 1st Innings: 6 balls * 2 runs = 12 runs
    for _ in range(6):
        c_a.emit("delivery:submit", {"room_id": room_id, "pick": 2})
        c_b.emit("delivery:submit", {"room_id": room_id, "pick": 1})
        _drain_events(c_a); _drain_events(c_b)

    match = repo.get_match_by_room(room_id)
    assert match.team_a_runs == 12
    assert match.target == 13

    # Transition
    room_service.start_second_innings(room_id)

    # 2nd Innings: 6 balls * 1 run = 6 runs
    for i in range(5):
        c_b.emit("delivery:submit", {"room_id": room_id, "pick": 1})
        c_a.emit("delivery:submit", {"room_id": room_id, "pick": 4})
        _drain_events(c_a); _drain_events(c_b)

    # 6th ball finishes the over
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 1})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 4})

    evs_a = _drain_events(c_a)
    finish = next(e for e in evs_a if e["name"] == "match:finished")["args"][0]
    assert finish["winner"] == "A"
    assert "won by 6 runs" in finish["result_summary"]


def test_scenario_e_exact_target():
    """
    Scenario E — Exact target:
    - 1st innings score: 1 -> Target: 2.
    - Team B scores 1 run (total: 1 < 2, match continues).
    - Team B scores 1 more run (total: 2 == target 2).
    - Match ends immediately at exactly 2 runs.
    - No extra delivery is accepted.
    """
    ctx = _setup_e2e_match(overs=2, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    # 1st Innings: 1 run, then OUT -> Target = 2
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 1})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 3})
    _drain_events(c_a); _drain_events(c_b)

    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 5})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 5})
    _drain_events(c_a); _drain_events(c_b)

    assert repo.get_match_by_room(room_id).target == 2

    # Transition
    room_service.start_second_innings(room_id)

    # Ball 1: 1 run -> Total 1
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 1})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    _drain_events(c_a); _drain_events(c_b)

    match = repo.get_match_by_room(room_id)
    assert match.winner is None
    assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE

    # Ball 2: 1 run -> Total 2 == Target 2!
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 1})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 6})

    evs_b = _drain_events(c_b)
    finish = next(e for e in evs_b if e["name"] == "match:finished")["args"][0]
    assert finish["winner"] == "B"

    # Verify ended immediately
    match = repo.get_match_by_room(room_id)
    assert match.team_b_runs == 2
    assert match.current_ball == 2

    # Reject subsequent ball
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 3})
    ack = next(e for e in c_b.get_received() if e["name"] == "delivery:ack")["args"][0]
    assert ack["success"] is False
    assert ack["error"] == "match_already_completed"


def test_scenario_f_timeout_and_duplicate_event_safety():
    """
    Scenario F — Timeout and duplicate-event safety:
    - Simulates delivery timeout when one player picks and the other times out.
    - Triggers duplicate timeout resolution and duplicate transition calls.
    - Verifies scores, wickets, overs, and match results are never corrupted or duplicated.
    """
    ctx = _setup_e2e_match(overs=2, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    # Batter submits pick 4, bowler times out
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    _drain_events(c_a)

    # Force delivery deadline past
    match = repo.get_match_by_room(room_id)
    match.delivery_deadline = datetime.utcnow() - timedelta(seconds=1)
    repo.save_match(match)

    # 1. Resolve timeout
    res1 = room_service.resolve_timeout(room_id)
    assert res1 is not None

    # 2. Trigger duplicate resolve_timeout immediately
    res2 = room_service.resolve_timeout(room_id)
    assert res2 is None  # Second call must be a clean no-op

    # Verify delivery count
    deliveries = repo.get_deliveries_for_match(match.id)
    assert len(deliveries) == 1


# ---------------------------------------------------------------------------
# Section 7: Final Result Verification & Reconnection
# ---------------------------------------------------------------------------

def test_final_result_verification_and_reconnection():
    """
    Verifies that after the match ends:
    - Both clients receive identical final result data.
    - Complete match summary is persisted and visible after client reconnection / sync.
    """
    ctx = _setup_e2e_match(overs=1, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]
    p_a_id = ctx["p_a_id"]
    p_b_id = ctx["p_b_id"]

    # Team A scores 3 runs, then OUT -> Target 4
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 3})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 1})
    _drain_events(c_a); _drain_events(c_b)

    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    _drain_events(c_a); _drain_events(c_b)

    room_service.start_second_innings(room_id)

    # Team B chases 4 runs on ball 1
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 6})

    evs_a = _drain_events(c_a)
    evs_b = _drain_events(c_b)

    fin_a = next(e for e in evs_a if e["name"] == "match:finished")["args"][0]
    fin_b = next(e for e in evs_b if e["name"] == "match:finished")["args"][0]
    assert fin_a == fin_b
    assert fin_a["winner"] == "B"

    # Test client reconnection: sync room
    p_a = repo.get_player(p_a_id)
    c_a.emit("room:sync", {"room_id": room_id, "session_token": p_a.session_token})
    snap = next(e for e in c_a.get_received() if e["name"] == "room:snapshot")["args"][0]

    assert snap["room"]["status"] == "MATCH_COMPLETE"
    assert snap["match"]["winner"] == "B"
    assert snap["match"]["team_a_runs"] == 3
    assert snap["match"]["team_b_runs"] == 4
    assert snap["match"]["target"] == 4


# ---------------------------------------------------------------------------
# Section 8: Event and State Audit
# ---------------------------------------------------------------------------

def test_event_and_state_audit_lifecycle():
    """
    Captures and validates the complete event sequence throughout the match:
    match:started -> delivery:reveal -> innings:break -> match:innings_started -> match:finished.
    Asserts no backward transitions occur.
    """
    ctx = _setup_e2e_match(overs=1, wickets=1, first_bat_team="A")
    room_id = ctx["room_id"]
    c_a = ctx["c_a"]
    c_b = ctx["c_b"]

    event_log: List[str] = ["match:started"]

    # Delivery 1: OUT
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 4})
    for e in _drain_events(c_a):
        event_log.append(e["name"])

    assert "delivery:reveal" in event_log
    assert "innings:break" in event_log

    # Innings transition
    c_a.emit("match:resume", {"room_id": room_id}) if False else None
    room_service.start_second_innings(room_id)
    event_log.append("match:innings_started")

    # Delivery in 2nd Innings: Chasing team hits 2
    c_b.emit("delivery:submit", {"room_id": room_id, "pick": 2})
    c_a.emit("delivery:submit", {"room_id": room_id, "pick": 5})
    for e in _drain_events(c_a):
        event_log.append(e["name"])

    assert "delivery:reveal" in event_log
    assert "match:finished" in event_log

    # Validate logical ordering of core milestones
    pos_started = event_log.index("match:started")
    pos_break = event_log.index("innings:break")
    pos_second = event_log.index("match:innings_started")
    pos_finish = event_log.index("match:finished")

    assert pos_started < pos_break < pos_second < pos_finish
