"""
Tests for Team Match Rules, Captain Authority, Batting Order, and All Out conditions.
"""

import pytest
from app.domain.models import GameMode, InningsPhase, PlayerRole, RoomStatus
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


def test_team_batting_order_captain_selection_and_all_out():
    # Setup 4 players (2 vs 2)
    p1, _ = room_service.create_or_restore_player("CaptainA", None)
    p2, _ = room_service.create_or_restore_player("BatterA2", None)
    p3, _ = room_service.create_or_restore_player("CaptainB", None)
    p4, _ = room_service.create_or_restore_player("BowlerB2", None)

    # Create TEAM room
    room, _ = room_service.create_room(p1, "TEAM", overs=2, wickets=2)

    room_service.join_room(p2, room.join_code)
    room_service.join_room(p3, room.join_code)
    room_service.join_room(p4, room.join_code)

    # Assign teams: p1, p2 -> Team A; p3, p4 -> Team B
    room_service.assign_team(room, p1, p1.id, "A")
    room_service.assign_team(room, p1, p2.id, "A")
    room_service.assign_team(room, p1, p3.id, "B")
    room_service.assign_team(room, p1, p4.id, "B")

    # Set captains
    mem1 = repo.get_membership(room.id, p1.id)
    mem1.is_captain = True
    repo.save_membership(mem1)

    mem3 = repo.get_membership(room.id, p3.id)
    mem3.is_captain = True
    repo.save_membership(mem3)

    # Ready up all
    for p in [p1, p2, p3, p4]:
        room_service.ack_rules(room, p)
        room_service.set_ready(room, p, True)

    # Toss: opponent p3 calls toss
    room_service.start_toss(room, p1)
    room_service.call_toss(room, p3, "HEADS")
    winner = p1 if room.toss["winner_id"] == p1.id else p3
    match = room_service.decide_toss(room, winner, "BAT")

    # Ensure match started
    assert room.status == RoomStatus.INNINGS_ACTIVE
    batting_team = match.batting_team
    captain_bat = p1 if batting_team == "A" else p3
    captain_bowl = p3 if batting_team == "A" else p1
    other_bat = p2 if batting_team == "A" else p4
    other_bowl = p4 if batting_team == "A" else p2

    # Bowling captain selects opening bowler
    room_service.select_bowler(room, captain_bowl, captain_bowl.id)
    assert match.active_bowler_id == captain_bowl.id

    # Batter 1 gets OUT on delivery 1 (both pick 4)
    active_b1_id = match.active_batter_id
    b1_player = p1 if active_b1_id == p1.id else p2 if active_b1_id == p2.id else p3 if active_b1_id == p3.id else p4
    b2_player = other_bat if b1_player.id == captain_bat.id else captain_bat

    match, res1 = room_service.submit_pick(room, b1_player, 4)
    match, res1 = room_service.submit_pick(room, captain_bowl, 4)

    assert res1.result.value == "OUT"
    assert match.batting_wickets == 1
    # Batter 1 is in dismissed list
    dismissed = match.dismissed_batters_a if batting_team == "A" else match.dismissed_batters_b
    assert b1_player.id in dismissed

    # In team match, captain must select next batter from remaining eligible players!
    assert match.active_batter_id is None

    # Non-captain cannot select next batter
    with pytest.raises(PermissionError):
        room_service.select_batter(room, other_bat, b2_player.id)

    # Captain cannot select already dismissed batter
    with pytest.raises(ValueError, match="player_already_dismissed"):
        room_service.select_batter(room, captain_bat, b1_player.id)

    # Captain cannot select opponent
    with pytest.raises(ValueError, match="batter_not_on_batting_team"):
        room_service.select_batter(room, captain_bat, captain_bowl.id)

    # Captain selects eligible batter 2
    room_service.select_batter(room, captain_bat, b2_player.id)
    assert match.active_batter_id == b2_player.id

    # Delivery 2: Batter 2 also gets OUT (picks 2, bowler picks 2) -> ALL OUT!
    match, res2 = room_service.submit_pick(room, b2_player, 2)
    match, res2 = room_service.submit_pick(room, captain_bowl, 2)

    assert res2.result.value == "OUT"
    assert (match.is_all_out_a if batting_team == "A" else match.is_all_out_b) is True
    # All out declared and 1st innings ended
    assert match.phase == InningsPhase.SECOND
