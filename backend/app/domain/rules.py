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
    is_all_out: bool = False
    all_out_team: Optional[str] = None
    all_out_runs: int = 0
    all_out_wickets: int = 0
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
        # A timed-out delivery is dead: 0 runs, no wicket, regardless of whose
        # pick was missing.
        if bp is None or bwp is None:
            delivery.result = DeliveryResult.TIMEOUT
            delivery.runs_scored = 0
            if bp is None and bwp is None:
                delivery.timeout_reason = "both_timeout"
            elif bp is None:
                delivery.timeout_reason = "batter_timeout"
            else:
                delivery.timeout_reason = "bowler_timeout"
        elif bp == bwp:
            delivery.result = DeliveryResult.OUT
            delivery.runs_scored = 0
        else:
            delivery.result = DeliveryResult.RUNS
            delivery.runs_scored = bp

        delivery.committed = True

        # --- Apply to match state ---
        current_batting_team = match.batting_team
        GameRules._apply_delivery_to_match(match, delivery)

        # Check if ALL OUT occurred on this specific delivery
        wlimit = match.wicket_limit(current_batting_team)
        wickets = match.team_a_wickets if current_batting_team == "A" else match.team_b_wickets
        is_delivery_all_out = False
        all_out_runs = 0
        all_out_wkts = 0

        if delivery.result == DeliveryResult.OUT and wickets >= wlimit:
            is_delivery_all_out = True
            all_out_runs = match.team_a_runs if current_batting_team == "A" else match.team_b_runs
            all_out_wkts = wickets
            match.is_all_out = True
            match.all_out_team = current_batting_team
            if current_batting_team == "A":
                match.is_all_out_a = True
            else:
                match.is_all_out_b = True

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
            is_all_out=is_delivery_all_out,
            all_out_team=current_batting_team if is_delivery_all_out else None,
            all_out_runs=all_out_runs,
            all_out_wickets=all_out_wkts,
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

        # Wicket limit reached -> ALL OUT
        wlimit = match.wicket_limit(match.batting_team)
        wickets = match.team_a_wickets if match.batting_team == "A" else match.team_b_wickets
        if wickets >= wlimit:
            match.is_all_out = True
            match.all_out_team = match.batting_team
            return True

        # Target chased (second innings or super over second innings)
        if match.phase in (InningsPhase.SECOND, InningsPhase.SUPER_OVER_SECOND) and match.target is not None:
            runs = match.team_b_runs if match.batting_team == "B" else match.team_a_runs
            if runs >= match.target:
                return True

        return False

    @staticmethod
    def _advance_innings_or_end(match: Match) -> bool:
        """
        Move to second innings, super over, or end the match.
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
            match.is_all_out = False
            match.all_out_team = None
            return False
        elif match.phase == InningsPhase.SECOND:
            # Check if tied -> Enter Super Over
            if match.team_a_runs == match.team_b_runs:
                match.is_super_over = True
                match.phase = InningsPhase.SUPER_OVER_FIRST

                # Store main match final scores
                match.main_match_team_a_runs = match.team_a_runs
                match.main_match_team_b_runs = match.team_b_runs
                match.main_match_team_a_wickets = match.team_a_wickets
                match.main_match_team_b_wickets = match.team_b_wickets

                # Batting Priority: The team that batted second in main match must bat first in Super Over
                first_batting = getattr(match, "first_batting_team", "A") or "A"
                second_batting = "B" if first_batting == "A" else "A"
                match.batting_team = second_batting

                # Super Over specifications: 1-over per side, maximum 2 wickets
                match.overs = 1
                match.wickets = 2
                match.team_a_runs = 0
                match.team_b_runs = 0
                match.team_a_wickets = 0
                match.team_b_wickets = 0
                match.target = None
                match.current_over = 0
                match.current_ball = 0
                match.active_batter_id = None
                match.active_bowler_id = None
                match.dismissed_batters_a = []
                match.dismissed_batters_b = []
                match.is_all_out = False
                match.all_out_team = None
                match.all_out_announced_a = False
                match.all_out_announced_b = False
                match.winner = None
                match.result_summary = None
                return False
            else:
                GameRules._determine_winner(match)
                return True
        elif match.phase == InningsPhase.SUPER_OVER_FIRST:
            # 1st innings of Super Over ended -> set target for 2nd innings of Super Over
            first_super_runs = match.team_a_runs if match.batting_team == "A" else match.team_b_runs
            match.target = first_super_runs + 1

            # Swap batting/bowling for 2nd Super Over innings
            match.batting_team = "B" if match.batting_team == "A" else "A"
            match.phase = InningsPhase.SUPER_OVER_SECOND
            match.current_over = 0
            match.current_ball = 0
            match.active_batter_id = None
            match.active_bowler_id = None
            match.is_all_out = False
            match.all_out_team = None
            return False
        elif match.phase == InningsPhase.SUPER_OVER_SECOND:
            # Super Over completed -> determine Super Over winner
            GameRules._determine_super_over_winner(match)
            return True
        return True

    @staticmethod
    def _determine_super_over_winner(match: Match) -> None:
        name_a = getattr(match, "team_a_name", "Team A") or "Team A"
        name_b = getattr(match, "team_b_name", "Team B") or "Team B"

        if match.team_a_runs > match.team_b_runs:
            match.winner = "A"
            winning_name = name_a
        elif match.team_b_runs > match.team_a_runs:
            match.winner = "B"
            winning_name = name_b
        else:
            # Policy for tied Super Over: Declared historic draw/tie to prevent infinite loops
            match.winner = "TIE"
            match.result_summary = "Super Over tied! Match drawn after Super Over."
            return

        first_batting = getattr(match, "first_batting_team", "A") or "A"
        # Super over first batting was the team that batted second in main match
        super_over_first_batting = "B" if first_batting == "A" else "A"

        if match.winner == super_over_first_batting:
            diff = abs(match.team_a_runs - match.team_b_runs)
            match.result_summary = f"{winning_name} won the Super Over by {diff} run{'s' if diff != 1 else ''}"
        else:
            wlimit = 2
            lost_wickets = match.team_a_wickets if match.winner == "A" else match.team_b_wickets
            wickets_remaining = max(1, wlimit - lost_wickets)
            match.result_summary = (
                f"{winning_name} won the Super Over by {wickets_remaining} wicket{'s' if wickets_remaining != 1 else ''}"
            )

    @staticmethod
    def _determine_winner(match: Match) -> None:
        name_a = getattr(match, "team_a_name", "Team A") or "Team A"
        name_b = getattr(match, "team_b_name", "Team B") or "Team B"

        if match.team_a_runs > match.team_b_runs:
            match.winner = "A"
        elif match.team_b_runs > match.team_a_runs:
            match.winner = "B"
        else:
            match.winner = "TIE"
            match.result_summary = "Match tied!"
            return

        first_batting = getattr(match, "first_batting_team", "A") or "A"
        winning_name = name_a if match.winner == "A" else name_b

        # If first batting team wins the match -> win by runs; else win by wickets
        if match.winner == first_batting:
            diff = abs(match.team_a_runs - match.team_b_runs)
            match.result_summary = f"{winning_name} won by {diff} run{'s' if diff != 1 else ''}"
        else:
            wlimit = match.wicket_limit(match.winner)
            lost_wickets = match.team_a_wickets if match.winner == "A" else match.team_b_wickets
            wickets_remaining = max(1, wlimit - lost_wickets)
            match.result_summary = (
                f"{winning_name} won by {wickets_remaining} wicket{'s' if wickets_remaining != 1 else ''}"
            )

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
