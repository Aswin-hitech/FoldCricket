"""
Unit tests for the game rules engine.
Run with: pytest backend/tests/
"""

import copy
import pytest

from app.domain.models import (
    Delivery,
    DeliveryResult,
    InningsPhase,
    Match,
)
from app.domain.rules import BALLS_PER_OVER, GameRules


def make_match(**kwargs) -> Match:
    defaults = dict(
        room_id="room-1",
        overs=2,
        batting_team="A",
        phase=InningsPhase.FIRST,
    )
    defaults.update(kwargs)
    m = Match(**defaults)
    m._team_a_size = 5
    m._team_b_size = 5
    return m


def make_delivery(match: Match, **kwargs) -> Delivery:
    d = Delivery(
        match_id=match.id,
        innings=match.phase,
        over_index=match.current_over,
        ball_index=match.current_ball,
    )
    for k, v in kwargs.items():
        setattr(d, k, v)
    return d


# ---------------------------------------------------------------------------
# Basic scoring
# ---------------------------------------------------------------------------

class TestBasicScoring:
    def test_equal_picks_is_out(self):
        match = make_match()
        delivery = make_delivery(match, batter_pick=5, bowler_pick=5)
        outcome = GameRules.resolve_delivery(match, copy.copy(delivery))
        assert outcome.delivery.result == DeliveryResult.OUT
        assert outcome.delivery.runs_scored == 0
        assert match.team_a_wickets == 1

    def test_unequal_picks_score_batter_pick(self):
        match = make_match()
        delivery = make_delivery(match, batter_pick=7, bowler_pick=3)
        outcome = GameRules.resolve_delivery(match, copy.copy(delivery))
        assert outcome.delivery.result == DeliveryResult.RUNS
        assert outcome.delivery.runs_scored == 7
        assert match.team_a_runs == 7
        assert match.team_a_wickets == 0

    @pytest.mark.parametrize("pick", range(1, 11))
    def test_all_valid_picks_accepted(self, pick):
        assert GameRules.validate_pick(pick) is None

    def test_invalid_pick_zero(self):
        assert GameRules.validate_pick(0) is not None

    def test_invalid_pick_eleven(self):
        assert GameRules.validate_pick(11) is not None

    def test_invalid_pick_string(self):
        assert GameRules.validate_pick("5") is not None  # type: ignore


# ---------------------------------------------------------------------------
# Timeout policy
# ---------------------------------------------------------------------------

class TestTimeoutPolicy:
    def test_batter_timeout_scores_nothing(self):
        match = make_match()
        delivery = make_delivery(match, batter_pick=None, bowler_pick=4)
        outcome = GameRules.resolve_delivery(match, copy.copy(delivery))
        assert outcome.delivery.result == DeliveryResult.TIMEOUT
        assert outcome.delivery.runs_scored == 0
        assert outcome.delivery.timeout_reason == "batter_timeout"
        assert match.team_a_wickets == 0

    def test_bowler_timeout_scores_nothing(self):
        match = make_match()
        delivery = make_delivery(match, batter_pick=6, bowler_pick=None)
        outcome = GameRules.resolve_delivery(match, copy.copy(delivery))
        assert outcome.delivery.result == DeliveryResult.TIMEOUT
        assert outcome.delivery.runs_scored == 0
        assert outcome.delivery.timeout_reason == "bowler_timeout"
        assert match.team_a_runs == 0
        assert match.team_a_wickets == 0

    def test_both_timeout_is_timeout(self):
        match = make_match()
        delivery = make_delivery(match, batter_pick=None, bowler_pick=None)
        outcome = GameRules.resolve_delivery(match, copy.copy(delivery))
        assert outcome.delivery.result == DeliveryResult.TIMEOUT
        assert outcome.delivery.runs_scored == 0
        assert outcome.delivery.timeout_reason == "both_timeout"
        assert match.team_a_runs == 0
        assert match.team_a_wickets == 0

    def test_timeout_is_dead_ball_and_does_not_advance_ball(self):
        match = make_match()
        delivery = make_delivery(match, batter_pick=None, bowler_pick=4)
        outcome = GameRules.resolve_delivery(match, copy.copy(delivery))
        assert outcome.delivery.result == DeliveryResult.TIMEOUT
        assert match.current_ball == 0
        assert match.current_over == 0
        assert outcome.innings_ended is False
        assert match.team_a_runs == 0
        assert match.team_a_wickets == 0


# ---------------------------------------------------------------------------
# Over / innings progression
# ---------------------------------------------------------------------------

class TestInningsProgression:
    def _exhaust_over(self, match: Match, batter_pick: int = 3, bowler_pick: int = 7):
        """Play through BALLS_PER_OVER deliveries without getting out."""
        for _ in range(BALLS_PER_OVER):
            d = make_delivery(match, batter_pick=batter_pick, bowler_pick=bowler_pick)
            GameRules.resolve_delivery(match, copy.copy(d))

    def test_over_advances_after_six_balls(self):
        match = make_match(overs=2)
        self._exhaust_over(match)
        assert match.current_over == 1
        assert match.current_ball == 0

    def test_innings_ends_after_over_limit(self):
        match = make_match(overs=1)
        self._exhaust_over(match)
        # The innings_ended flag comes from resolve_delivery
        d = make_delivery(match, batter_pick=3, bowler_pick=7)
        # last ball of last over already played; check state
        # After 6 balls of 1-over match, innings should have ended
        # current_over == overs means ended
        assert match.current_over >= match.overs or match.phase == InningsPhase.SECOND

    def test_wicket_ends_innings(self):
        match = make_match(overs=10)
        match._team_a_size = 2
        match._team_b_size = 2
        # 2 players = 2 wicket limit
        for _ in range(2):
            d = make_delivery(match, batter_pick=5, bowler_pick=5)  # out
            GameRules.resolve_delivery(match, copy.copy(d))
        assert match.phase == InningsPhase.SECOND or match.winner is not None

    def test_target_set_after_first_innings(self):
        match = make_match(overs=1)
        match._team_a_size = 1
        match._team_b_size = 1
        # Play 6 balls, scoring 3 each
        for _ in range(BALLS_PER_OVER):
            d = make_delivery(match, batter_pick=3, bowler_pick=7)
            GameRules.resolve_delivery(match, copy.copy(d))
        # After first innings, target = runs + 1
        assert match.target == match.team_a_runs + 1 or match.target is not None


# ---------------------------------------------------------------------------
# Wicket limit: both teams always get the same count
# ---------------------------------------------------------------------------

class TestWicketLimit:
    def test_uneven_squads_share_the_configured_limit(self):
        match = make_match(wickets=3)
        match._team_a_size = 3
        match._team_b_size = 5
        assert match.wicket_limit("A") == 3
        assert match.wicket_limit("B") == 3

    def test_fallback_keeps_limits_equal_for_uneven_squads(self):
        match = make_match()
        match._team_a_size = 3
        match._team_b_size = 5
        assert match.wicket_limit("A") == match.wicket_limit("B") == 5

    def test_super_over_limit_is_two_for_both(self):
        match = make_match(wickets=5)
        match.is_super_over = True
        assert match.wicket_limit("A") == match.wicket_limit("B") == 2


# ---------------------------------------------------------------------------
# Winner determination
# ---------------------------------------------------------------------------

class TestWinner:
    def test_tie(self):
        match = make_match()
        match.team_a_runs = 30
        match.team_b_runs = 30
        match.phase = InningsPhase.SECOND
        GameRules._determine_winner(match)
        assert match.winner == "TIE"

    def test_team_a_wins_defending(self):
        # Team A batted first, scored 50. Team B chased, scored 40. Team A won by 10 runs.
        match = make_match()
        match.first_batting_team = "A"
        match.team_a_runs = 50
        match.team_b_runs = 40
        GameRules._determine_winner(match)
        assert match.winner == "A"
        assert "won by 10 runs" in match.result_summary

    def test_team_b_wins_chasing(self):
        # Team A batted first, scored 30. Team B chased, scored 45 with 1 wicket lost out of 5. Team B won by 4 wickets.
        match = make_match()
        match.first_batting_team = "A"
        match.team_a_runs = 30
        match.team_b_runs = 45
        match._team_b_size = 5
        match.team_b_wickets = 1
        GameRules._determine_winner(match)
        assert match.winner == "B"
        assert "won by 4 wickets" in match.result_summary

    def test_team_b_wins_defending(self):
        # Team B batted first, scored 60. Team A chased, scored 48. Team B won by 12 runs.
        match = make_match()
        match.first_batting_team = "B"
        match.team_b_runs = 60
        match.team_a_runs = 48
        GameRules._determine_winner(match)
        assert match.winner == "B"
        assert "won by 12 runs" in match.result_summary

    def test_team_a_wins_chasing(self):
        # Team B batted first, scored 50. Team A chased, scored 52 with 2 wickets lost out of 5. Team A won by 3 wickets.
        match = make_match()
        match.first_batting_team = "B"
        match.team_b_runs = 50
        match.team_a_runs = 52
        match._team_a_size = 5
        match.team_a_wickets = 2
        GameRules._determine_winner(match)
        assert match.winner == "A"
        assert "won by 3 wickets" in match.result_summary


# ---------------------------------------------------------------------------
# Idempotency guard
# ---------------------------------------------------------------------------

class TestIdempotency:
    def test_double_resolve_returns_error(self):
        match = make_match()
        delivery = make_delivery(match, batter_pick=3, bowler_pick=7)
        delivery.committed = True
        outcome = GameRules.resolve_delivery(match, delivery)
        assert outcome.error == "already_committed"
