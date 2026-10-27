import pytest
from app.domain.models import Player, Delivery, DeliveryResult, InningsPhase
from app.domain.rules import GameRules
from app.services import room_service
from app.repositories import memory as repo


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


def test_all_out_occurs_once_and_does_not_leak_into_second_innings():
    p1 = Player(display_name="BatterA")
    p2 = Player(display_name="BowlerB")
    repo.save_player(p1)
    repo.save_player(p2)

    room, _ = room_service.create_room(p1, "SOLO", overs=2, wickets=1)
    room_service.join_room(p2, room.join_code)

    room_service.start_toss(room, p1)
    room.toss["winner_id"] = p1.id
    room.toss["winner_team"] = "A"
    match = room_service.decide_toss(room, p1, "BAT")

    assert match.phase == InningsPhase.FIRST
    assert match.batting_team == "A"
    assert match.is_all_out is False
    assert match.is_all_out_a is False
    assert match.is_all_out_b is False

    # Ball 1 of Innings 1: OUT (wickets limit is 1) -> ALL OUT for Team A!
    d1 = Delivery(match_id=match.id, batter_id=p1.id, bowler_id=p2.id, batter_pick=3, bowler_pick=3)
    outcome1 = GameRules.resolve_delivery(match, d1)

    assert outcome1.delivery.result == DeliveryResult.OUT
    assert outcome1.is_all_out is True
    assert outcome1.all_out_team == "A"
    assert match.is_all_out_a is True
    assert match.is_all_out_b is False
    assert match.phase == InningsPhase.SECOND
    assert match.is_all_out is False  # Reset for the live 2nd innings!
    assert match.batting_team == "B"

    # Ball 1 of Innings 2: Team B scores 2 runs
    d2 = Delivery(match_id=match.id, batter_id=p2.id, bowler_id=p1.id, batter_pick=2, bowler_pick=4)
    outcome2 = GameRules.resolve_delivery(match, d2)

    assert outcome2.delivery.result == DeliveryResult.RUNS
    assert outcome2.is_all_out is False  # Must NOT be all out!
    assert outcome2.all_out_team is None
    assert match.is_all_out is False
    assert match.is_all_out_a is True   # Team A's card maintains ALL OUT badge
    assert match.is_all_out_b is False  # Team B is batting normally!

    # Ball 2 of Innings 2: Team B scores 4 runs
    d3 = Delivery(match_id=match.id, batter_id=p2.id, bowler_id=p1.id, batter_pick=4, bowler_pick=1)
    outcome3 = GameRules.resolve_delivery(match, d3)

    assert outcome3.delivery.result == DeliveryResult.RUNS
    assert outcome3.is_all_out is False  # Must NOT be all out!
    assert match.is_all_out is False
