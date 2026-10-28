import pytest
from datetime import datetime, timedelta
from app.domain.models import Delivery, DeliveryResult, GameMode, InningsPhase, Match, Player, Room, RoomStatus
from app.repositories import memory as repo
from app.services import room_service

def test_wickets_limit_multi_dismissal():
    """Verify that configured wickets (e.g. 3 wickets) comes into play and doesn't exit after 1 wicket."""
    repo.clear_all()
    p1 = Player(id="p1", display_name="Batter", session_token="s1")
    p2 = Player(id="p2", display_name="Bowler", session_token="s2")
    repo.save_player(p1)
    repo.save_player(p2)

    room, _ = room_service.create_room(
        host=p1,
        mode="SOLO",
        overs=5,
        wickets=3,
    )
    room_service.join_room(p2, room.join_code)
    room = repo.get_room(room.id)
    room_service.assign_team(room, p1, "p2", "B")
    room_service.ack_rules(room, p1)
    room_service.ack_rules(room, p2)
    room_service.set_ready(room, p1, True)
    room_service.set_ready(room, p2, True)
    toss_data = room_service.start_toss(room, p1)
    caller = p1 if toss_data["caller_id"] == "p1" else p2
    toss_result = room_service.call_toss(room, caller, "HEADS")
    winner = p1 if toss_result["winner_id"] == "p1" else p2
    # Ensure team A bats first
    decision = "BAT" if winner.id == "p1" else "BOWL"
    room_service.decide_toss(room, winner, decision)
    room = repo.get_room(room.id)
    for m in repo.get_room_members(room.id):
        room, _, _ = room_service.confirm_first_ball_ready(
            room, repo.get_player(m.player_id)
        )

    match = repo.get_match_by_room(room.id)
    assert match is not None
    assert match.wickets == 3
    assert match.batting_team == "A"
    assert repo.get_room(room.id).status == RoomStatus.INNINGS_ACTIVE

    # Delivery 1: OUT (1st wicket)
    room = repo.get_room(room.id)
    match, deliv1 = room_service.submit_pick(room, p1, 3)
    assert deliv1 is None
    match, deliv1 = room_service.submit_pick(room, p2, 3)
    assert deliv1 is not None
    assert deliv1.result == DeliveryResult.OUT
    assert match.team_a_wickets == 1
    # MUST NOT exit after 1 wicket!
    assert not match.is_all_out
    assert repo.get_room(room.id).status == RoomStatus.INNINGS_ACTIVE

    # Delivery 2: RUNS (4 runs)
    room = repo.get_room(room.id)
    match, deliv2 = room_service.submit_pick(room, p1, 4)
    assert deliv2 is None
    match, deliv2 = room_service.submit_pick(room, p2, 2)
    assert deliv2 is not None
    assert deliv2.result == DeliveryResult.RUNS
    assert match.team_a_runs == 4
    assert match.team_a_wickets == 1
    assert repo.get_room(room.id).status == RoomStatus.INNINGS_ACTIVE

    # Delivery 3: OUT (2nd wicket)
    room = repo.get_room(room.id)
    match, deliv3 = room_service.submit_pick(room, p1, 5)
    assert deliv3 is None
    match, deliv3 = room_service.submit_pick(room, p2, 5)
    assert deliv3 is not None
    assert deliv3.result == DeliveryResult.OUT
    assert match.team_a_wickets == 2
    # STILL MUST NOT exit after 2 wickets!
    assert not match.is_all_out
    assert repo.get_room(room.id).status == RoomStatus.INNINGS_ACTIVE

    # Delivery 4: OUT (3rd wicket - REACHES WICKET LIMIT 3)
    room = repo.get_room(room.id)
    match, deliv4 = room_service.submit_pick(room, p1, 1)
    assert deliv4 is None
    match, deliv4 = room_service.submit_pick(room, p2, 1)
    assert deliv4 is not None
    assert deliv4.result == DeliveryResult.OUT
    assert match.team_a_wickets == 3
    # Now ALL OUT triggers
    assert match.is_all_out
    assert repo.get_room(room.id).status == RoomStatus.INNINGS_BREAK

def test_purge_stale_data_older_than_one_hour():
    """Verify that residual rooms/matches/deliveries created >1 hour ago are purged cleanly."""
    repo.clear_all()
    # Create an old player and old room
    old_player = Player(
        id="old_p",
        display_name="Old",
        session_token="old_s",
        created_at=datetime.utcnow() - timedelta(seconds=4000)
    )
    repo.save_player(old_player)

    old_room = Room(
        id="old_r",
        join_code="OLD99",
        host_id="old_p",
        mode=GameMode.SOLO,
        status=RoomStatus.MATCH_COMPLETE,
        capacity=2,
        overs=2,
        wickets=2,
        created_at=datetime.utcnow() - timedelta(seconds=4000)
    )
    repo.save_room(old_room)

    # Create fresh player and fresh room
    fresh_player = Player(id="new_p", display_name="New", session_token="new_s")
    repo.save_player(fresh_player)
    fresh_room = Room(
        id="new_r",
        join_code="NEW11",
        host_id="new_p",
        mode=GameMode.SOLO,
        status=RoomStatus.WAITING_FOR_PLAYERS,
        capacity=2,
        overs=2,
        wickets=2,
        created_at=datetime.utcnow()
    )
    repo.save_room(fresh_room)

    # Purge stale data (> 3600 seconds)
    purged_count = repo.purge_stale_data(max_age_seconds=3600)
    assert purged_count == 1
    assert repo.get_room("old_r") is None
    assert repo.get_room("new_r") is not None
