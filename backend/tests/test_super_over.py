import pytest
from app.domain.models import GameMode, Player, Room, Match, InningsPhase, Delivery, DeliveryResult
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


def test_super_over_triggered_on_tie():
    p1 = Player(display_name="Rohit")
    p2 = Player(display_name="Virat")
    repo.save_player(p1)
    repo.save_player(p2)

    # 1 over match, 1 wicket
    room, _ = room_service.create_room(p1, "SOLO", overs=1, wickets=1)
    room_service.join_room(p2, room.join_code)

    # Start match with toss won by p1
    room_service.start_toss(room, p1)
    room.toss["winner_id"] = p1.id
    room.toss["winner_team"] = "A"
    match = room_service.decide_toss(room, p1, "BAT")
    assert match.phase == InningsPhase.FIRST
    assert match.batting_team == "A"
    assert match.first_batting_team == "A"

    # Team A bats 1 over, scores 6 runs on ball 1, then dots (or 1 ball remaining)
    # Ball 1: 6 runs
    d1 = Delivery(match_id=match.id, batter_id=p1.id, bowler_id=p2.id, batter_pick=6, bowler_pick=1)
    outcome = GameRules.resolve_delivery(match, d1)
    assert match.team_a_runs == 6

    # Fast forward remaining balls of over 0
    match.current_over = 1
    match.current_ball = 0
    # End first innings
    ended = GameRules._advance_innings_or_end(match)
    assert not ended
    assert match.phase == InningsPhase.SECOND
    assert match.batting_team == "B"
    assert match.target == 7

    # Team B bats in 2nd innings. Scores 6 runs (TIE!)
    match.team_b_runs = 6
    match.current_over = 1
    match.current_ball = 0

    # Advance innings or end: Should trigger Super Over!
    match_ended = GameRules._advance_innings_or_end(match)
    assert not match_ended
    assert match.is_super_over is True
    assert match.phase == InningsPhase.SUPER_OVER_FIRST
    assert match.overs == 1
    assert match.wickets == 2
    assert match.wicket_limit("A") == 2
    assert match.wicket_limit("B") == 2

    # Batting Priority: The team that batted second in main match (Team B) must bat first in Super Over!
    assert match.batting_team == "B"

    # Super Over 1st innings: Team B scores 8 runs in 1 over
    match.team_b_runs = 8
    match.current_over = 1
    match.current_ball = 0

    # End Super Over 1st innings -> transition to Super Over 2nd innings
    ended_so1 = GameRules._advance_innings_or_end(match)
    assert not ended_so1
    assert match.phase == InningsPhase.SUPER_OVER_SECOND
    assert match.batting_team == "A"
    assert match.target == 9

    # Super Over 2nd innings: Team A scores 10 runs -> wins Super Over
    match.team_a_runs = 10
    match_ended_so2 = GameRules._advance_innings_or_end(match)
    assert match_ended_so2 is True
    assert match.winner == "A"
    assert "won the Super Over" in match.result_summary
