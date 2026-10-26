"""
HandCricket Live – Game Rules Engine
Pure Python. No Flask / Socket.IO dependencies.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .models import (
    Delivery,
    DeliveryResult,
    InningsPhase,
    Match,
)

RULES_VERSION = "1.0"
BALLS_PER_OVER = 6
VALID_PICKS = set(range(1, 11))  # 1..10


# ---------------------------------------------------------------------------
# Command results
# ---------------------------------------------------------------------------

@dataclass
class DeliveryOutcome:
    delivery: Delivery
    match: Match
    innings_ended: bool = False
    match_ended: bool = False
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Core rule engine
# ---------------------------------------------------------------------------

class GameRules:
    """
    All methods are pure functions that accept the current state and return
    a new state. The caller (service layer) is responsible for persistence.
    """

    @staticmethod
    def resolve_delivery(
        match: Match,
        delivery: Delivery,
    ) -> DeliveryOutcome:
        """
        Apply the core hand-cricket resolution rule:
          - equal picks  → out (batter scores 0)
          - unequal picks → batter scores batter_pick runs
          - timeout (either pick None) → handled by timeout policy
        Mutates and returns the passed-in objects (they are already copies).
        """
        if delivery.committed:
            return DeliveryOutcome(delivery=delivery, match=match, error="already_committed")

        bp = delivery.batter_pick
        bwp = delivery.bowler_pick

        # --- Timeout handling ---
        if bp is None or bwp is None:
            # Apply timeout policy: the non-responsive side forfeits the delivery
            if bp is None and bwp is None:
                delivery.result = DeliveryResult.TIMEOUT
                delivery.runs_scored = 0
                delivery.timeout_reason = "both_timeout"
            elif bp is None:
                delivery.result = DeliveryResult.OUT
                delivery.runs_scored = 0
                delivery.timeout_reason = "batter_timeout"
            else:  # bowler timeout
                # Bowler timeout: batter scores their pick
                delivery.result = DeliveryResult.RUNS
                delivery.runs_scored = bp
                delivery.timeout_reason = "bowler_timeout"
        elif bp == bwp:
            delivery.result = DeliveryResult.OUT
            delivery.runs_scored = 0
        else:
            delivery.result = DeliveryResult.RUNS
            delivery.runs_scored = bp

        delivery.committed = True

        # --- Apply to match state ---
        GameRules._apply_delivery_to_match(match, delivery)

        innings_ended = GameRules._check_innings_end(match)
        match_ended = False

        if innings_ended:
            match_ended = GameRules._advance_innings_or_end(match)

        match.version += 1
        return DeliveryOutcome(
            delivery=delivery,
            match=match,
            innings_ended=innings_ended,
            match_ended=match_ended,
        )

    @staticmethod
    def _apply_delivery_to_match(match: Match, delivery: Delivery) -> None:
        if delivery.result == DeliveryResult.OUT:
            if match.batting_team == "A":
                match.team_a_wickets += 1
            else:
                match.team_b_wickets += 1
        elif delivery.result == DeliveryResult.RUNS:
            if match.batting_team == "A":
                match.team_a_runs += delivery.runs_scored
            else:
                match.team_b_runs += delivery.runs_scored

        # Advance ball/over
        match.current_ball += 1
        if match.current_ball >= BALLS_PER_OVER:
            match.current_ball = 0
            match.current_over += 1

    @staticmethod
    def _check_innings_end(match: Match) -> bool:
        """Returns True if the current innings is over."""
        # Over limit reached
        if match.current_over >= match.overs and match.current_ball == 0:
            return True

        # Wicket limit reached
        wlimit = match.wicket_limit(match.batting_team)
        wickets = match.team_a_wickets if match.batting_team == "A" else match.team_b_wickets
        if wickets >= wlimit:
            return True

        # Target chased (second innings)
        if match.phase == InningsPhase.SECOND and match.target is not None:
            runs = match.team_b_runs if match.batting_team == "B" else match.team_a_runs
            if runs >= match.target:
                return True

        return False

    @staticmethod
    def _advance_innings_or_end(match: Match) -> bool:
        """
        Move to second innings or end the match.
        Returns True if match is over.
        """
        if match.phase == InningsPhase.FIRST:
            # Set target
            first_innings_runs = match.team_a_runs if match.batting_team == "A" else match.team_b_runs
            match.target = first_innings_runs + 1

            # Swap batting/bowling
            match.batting_team = "B" if match.batting_team == "A" else "A"
            match.phase = InningsPhase.SECOND
            match.current_over = 0
            match.current_ball = 0
            match.active_batter_id = None
            match.active_bowler_id = None
            return False
        else:
            # Second innings ended → determine winner
            GameRules._determine_winner(match)
            return True

    @staticmethod
    def _determine_winner(match: Match) -> None:
        if match.team_a_runs > match.team_b_runs:
            match.winner = "A"
            diff = match.team_a_runs - match.team_b_runs
            match.result_summary = f"Team A wins by {diff} run{'s' if diff != 1 else ''}"
        elif match.team_b_runs > match.team_a_runs:
            match.winner = "B"
            # Calculate wickets in hand
            wlimit_b = match.wicket_limit("B")
            wickets_remaining = wlimit_b - match.team_b_wickets
            match.result_summary = (
                f"Team B wins by {wickets_remaining} wicket{'s' if wickets_remaining != 1 else ''}"
            )
        else:
            match.winner = "TIE"
            match.result_summary = "Match tied!"

    # ---------------------------------------------------------------------------
    # Validation helpers
    # ---------------------------------------------------------------------------

    @staticmethod
    def validate_pick(value: int) -> Optional[str]:
        """Returns error string or None."""
        if not isinstance(value, int):
            return "pick_must_be_integer"
        if value not in VALID_PICKS:
            return "pick_out_of_range"
        return None

    @staticmethod
    def compute_extra_wickets(team_a_size: int, team_b_size: int) -> tuple[int, int]:
        """
        The smaller team receives one additional wicket allowance.
        Returns (team_a_extra, team_b_extra).
        """
        if team_a_size < team_b_size:
            return 1, 0
        elif team_b_size < team_a_size:
            return 0, 1
        return 0, 0
