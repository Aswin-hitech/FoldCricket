"""
Room and Match service layer.
Orchestrates domain models, repositories, and rules.
"""

from __future__ import annotations

import copy
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Optional

from ..domain.models import (
    ConnectionState,
    Delivery,
    DeliveryResult,
    GameMode,
    InningsPhase,
    Match,
    Membership,
    Player,
    PlayerRole,
    ReadinessState,
    Room,
    RoomStatus,
)
from ..domain.rules import GameRules
from ..repositories import memory as repo
from ..security.utils import (
    generate_join_code,
    generate_session_token,
    validate_display_name,
)

DELIVERY_TIMEOUT_SECONDS = 25
RECONNECT_GRACE_SECONDS = 120


# ---------------------------------------------------------------------------
# Player service
# ---------------------------------------------------------------------------

def create_or_restore_player(
    display_name: str,
    session_token: Optional[str] = None,
) -> tuple[Player, bool]:
    """
    Returns (player, is_new).
    If a valid session_token is provided and matches an existing player, restore.
    """
    if session_token:
        existing = repo.get_player_by_session(session_token)
        if existing:
            return existing, False

    ok, reason = validate_display_name(display_name)
    if not ok:
        raise ValueError(reason)

    player = Player(
        display_name=display_name.strip(),
        session_token=session_token or generate_session_token(),
    )
    repo.save_player(player)
    return player, True


# ---------------------------------------------------------------------------
# Room service
# ---------------------------------------------------------------------------

def create_room(host: Player, mode: str, overs: int, wickets: Optional[int] = None) -> tuple[Room, Membership]:
    overs = int(overs)
    if not (1 <= overs <= 10):
        raise ValueError(f"overs_not_allowed: {overs}")

    game_mode = GameMode(mode.upper())
    max_wickets = 5 if game_mode == GameMode.SOLO else 10

    if wickets is not None:
        wickets_val = int(wickets)
        if not (1 <= wickets_val <= max_wickets):
            raise ValueError(f"wickets_must_be_between_1_and_{max_wickets}")
    else:
        wickets_val = 1 if game_mode == GameMode.SOLO else 5

    host_name = (host.display_name or "").strip() or "Host"
    team_a_default = f"{host_name}'s Team"

    room = Room(
        join_code=generate_join_code(),
        host_id=host.id,
        mode=game_mode,
        overs=overs,
        wickets=wickets_val,
        status=RoomStatus.WAITING_FOR_PLAYERS,
        team_a_name=team_a_default,
        team_b_name="Opponent's Team",
    )
    repo.save_room(room)

    membership = Membership(
        room_id=room.id,
        player_id=host.id,
        team="A",
        is_captain=True,
        is_host=True,
    )
    repo.save_membership(membership)
    return room, membership


def join_room(player: Player, join_code: str) -> tuple[Room, Membership]:
    room = repo.get_room_by_code(join_code)
    if not room:
        raise ValueError("room_not_found")
    if room.status == RoomStatus.MATCH_COMPLETE:
        raise ValueError("room_closed")

    members = repo.get_room_members(room.id)
    existing = next((m for m in members if m.player_id == player.id), None)
    if existing:
        return room, existing  # Rejoin

    if len(members) >= room.capacity:
        raise ValueError("room_full")

    # Assign to team B by default if host is on A
    team = "B" if any(m.team == "A" for m in members) else "A"
    membership = Membership(
        room_id=room.id,
        player_id=player.id,
        team=team,
    )
    repo.save_membership(membership)

    # Dynamic default team B name based on player name
    if team == "B" and getattr(room, "team_b_name", "") in ("", "Team B", "Opponent's Team", "Challenger's Team"):
        guest_name = (player.display_name or "").strip() or "Opponent"
        room.team_b_name = f"{guest_name}'s Team"
        repo.save_room(room)

    # If we now have 2+ players, move to LOBBY_READY
    all_members = repo.get_room_members(room.id)
    if len(all_members) >= 2 and room.status == RoomStatus.WAITING_FOR_PLAYERS:
        room.status = RoomStatus.LOBBY_READY
        repo.save_room(room)

    return room, membership


def assign_team(room: Room, captain: Player, target_player_id: str, team: str) -> Membership:
    """Host/captain assigns a player to a team."""
    captain_mem = repo.get_membership(room.id, captain.id)
    if not captain_mem or not captain_mem.is_host:
        raise PermissionError("not_host")
    if room.status not in (RoomStatus.LOBBY_READY, RoomStatus.RULEBOOK_REQUIRED):
        raise ValueError("cannot_assign_now")
    if team not in ("A", "B"):
        raise ValueError("invalid_team")

    target_mem = repo.get_membership(room.id, target_player_id)
    if not target_mem:
        raise ValueError("player_not_in_room")

    target_mem.team = team
    repo.save_membership(target_mem)
    return target_mem


def ack_rules(room: Room, player: Player) -> None:
    mem = repo.get_membership(room.id, player.id)
    if not mem:
        raise ValueError("not_in_room")
    mem.rules_acked_version = room.rules_version
    repo.save_membership(mem)
    # Check if all members have acked
    members = repo.get_room_members(room.id)
    if all(m.rules_acked_version == room.rules_version for m in members):
        if room.status == RoomStatus.RULEBOOK_REQUIRED:
            room.status = RoomStatus.LOBBY_READY
            repo.save_room(room)


def set_ready(room: Room, player: Player, ready: bool) -> Membership:
    mem = repo.get_membership(room.id, player.id)
    if not mem:
        raise ValueError("not_in_room")
    mem.readiness = ReadinessState.READY if ready else ReadinessState.NOT_READY
    repo.save_membership(mem)
    return mem


# Match & Toss service
# ---------------------------------------------------------------------------

def start_toss(room: Room, host: Player) -> dict:
    host_mem = repo.get_membership(room.id, host.id)
    if not host_mem or not host_mem.is_host:
        raise PermissionError("not_host")
    if room.status not in (RoomStatus.LOBBY_READY,):
        raise ValueError("room_not_ready")

    members = repo.get_room_members(room.id)
    team_a = [m for m in members if m.team == "A"]
    team_b = [m for m in members if m.team == "B"]
    if not team_a or not team_b:
        raise ValueError("teams_incomplete")

    # Toss is called by the opponent (visiting team/player)
    host_team = host_mem.team or "A"
    opp_team = "B" if host_team == "A" else "A"
    opp_mems = [m for m in members if m.team == opp_team]
    if not opp_mems:
        opp_mems = [m for m in members if m.player_id != host.id]

    opp_captain_mem = next((m for m in opp_mems if m.is_captain), opp_mems[0])
    opp_player = repo.get_player(opp_captain_mem.player_id)
    if not opp_player:
        opp_player = host
        opp_captain_mem = host_mem

    room.status = RoomStatus.TOSS
    room.toss = {
        "state": "CALLING",
        "caller_id": opp_player.id,
        "caller_name": opp_player.display_name,
        "caller_team": opp_captain_mem.team or opp_team,
        "called_choice": None,
        "coin_result": None,
        "winner_id": None,
        "winner_name": None,
        "winner_team": None,
        "elected_choice": None,
    }
    repo.save_room(room)
    return room.toss


def call_toss(room: Room, player: Player, choice: str) -> dict:
    if room.status != RoomStatus.TOSS or not room.toss:
        raise ValueError("not_in_toss")
    if player.id != room.toss.get("caller_id"):
        raise PermissionError("not_toss_caller")

    choice = choice.strip().upper()
    if choice not in ("HEADS", "TAILS"):
        raise ValueError("invalid_toss_choice")

    coin_result = secrets.choice(["HEADS", "TAILS"])
    members = repo.get_room_members(room.id)
    caller_mem = repo.get_membership(room.id, player.id)
    other_mems = [m for m in members if m.team != caller_mem.team]
    if not other_mems:
        raise ValueError("opponent_not_found")
    other_captain = next((m for m in other_mems if m.is_captain), other_mems[0])
    other_player = repo.get_player(other_captain.player_id)

    if choice == coin_result:
        winner_id = player.id
        winner_name = player.display_name
        winner_team = caller_mem.team
    else:
        winner_id = other_player.id
        winner_name = other_player.display_name
        winner_team = other_captain.team

    room.toss.update({
        "state": "DECIDING",
        "called_choice": choice,
        "coin_result": coin_result,
        "winner_id": winner_id,
        "winner_name": winner_name,
        "winner_team": winner_team,
    })
    repo.save_room(room)
    return room.toss


def decide_toss(room: Room, player: Player, decision: str) -> Match:
    if room.status != RoomStatus.TOSS or not room.toss:
        raise ValueError("not_in_toss")
    if player.id != room.toss.get("winner_id"):
        raise PermissionError("not_toss_winner")

    decision = decision.strip().upper()
    if decision not in ("BAT", "BOWL"):
        raise ValueError("invalid_toss_decision")

    room.toss["elected_choice"] = decision
    room.toss["state"] = "COMPLETED"

    # Batting team based on toss decision
    winner_team = room.toss["winner_team"]
    if decision == "BAT":
        batting_team = winner_team
    else:
        batting_team = "B" if winner_team == "A" else "A"

    members = repo.get_room_members(room.id)
    team_a = [m for m in members if m.team == "A"]
    team_b = [m for m in members if m.team == "B"]
    extra_a, extra_b = GameRules.compute_extra_wickets(len(team_a), len(team_b))

    p_a = repo.get_player(team_a[0].player_id) if team_a else None
    p_b = repo.get_player(team_b[0].player_id) if team_b else None

    default_a = f"{(p_a.display_name or '').strip() or 'Host'}'s Team" if p_a else "Team A"
    default_b = f"{(p_b.display_name or '').strip() or 'Guest'}'s Team" if p_b else "Team B"

    cur_a = getattr(room, "team_a_name", "")
    cur_b = getattr(room, "team_b_name", "")

    final_team_a = cur_a if cur_a and cur_a not in ("Team A", "Host's Team") else default_a
    final_team_b = cur_b if cur_b and cur_b not in ("Team B", "Guest's Team", "Opponent's Team", "Challenger's Team") else default_b

    room.team_a_name = final_team_a
    room.team_b_name = final_team_b
    repo.save_room(room)

    match = Match(
        room_id=room.id,
        overs=room.overs,
        wickets=getattr(room, "wickets", 1 if room.mode == GameMode.SOLO else 5),
        team_a_extra_wickets=extra_a,
        team_b_extra_wickets=extra_b,
        batting_team=batting_team,
        first_batting_team=batting_team,
        phase=InningsPhase.FIRST,
        team_a_name=final_team_a,
        team_b_name=final_team_b,
    )
    match._team_a_size = len(team_a)
    match._team_b_size = len(team_b)

    batting_mems = team_a if batting_team == "A" else team_b
    bowling_mems = team_b if batting_team == "A" else team_a
    match.active_batter_id = batting_mems[0].player_id if batting_mems else None

    # In SOLO mode or 1v1, auto-assign the lone bowler so players never get stuck
    if room.mode == GameMode.SOLO or len(bowling_mems) == 1:
        match.active_bowler_id = bowling_mems[0].player_id if bowling_mems else None
        match.delivery_deadline = datetime.utcnow() + timedelta(seconds=DELIVERY_TIMEOUT_SECONDS)

    for m in members:
        if m.team == batting_team and m.player_id == match.active_batter_id:
            m.role = PlayerRole.BATTER
        elif m.team == match.bowling_team and m.player_id == match.active_bowler_id:
            m.role = PlayerRole.BOWLER
        else:
            m.role = PlayerRole.SPECTATOR
        repo.save_membership(m)

    room.status = RoomStatus.INNINGS_ACTIVE
    repo.save_room(room)
    repo.save_match(match)
    return match


def start_match(room: Room, host: Player) -> Match:
    """Legacy start match – falls back to starting with toss if in lobby."""
    start_toss(room, host)
    return decide_toss(room, host, "BAT")


def select_batter(room: Room, captain: Player, batter_player_id: str) -> Match:
    match = repo.get_match_by_room(room.id)
    if not match:
        raise ValueError("no_active_match")
    if room.status != RoomStatus.INNINGS_ACTIVE:
        raise ValueError("not_in_active_innings")

    captain_mem = repo.get_membership(room.id, captain.id)
    if not captain_mem:
        raise PermissionError("not_in_room")

    # Captain must be on the batting team
    if captain_mem.team != match.batting_team:
        raise PermissionError("must_be_batting_team_captain")

    batting_mems = [m for m in repo.get_room_members(room.id) if m.team == match.batting_team]
    has_explicit_captain = any(m.is_captain for m in batting_mems)
    if has_explicit_captain and not (captain_mem.is_captain or captain_mem.is_host):
        raise PermissionError("not_captain")

    batter_mem = repo.get_membership(room.id, batter_player_id)
    if not batter_mem or batter_mem.team != match.batting_team:
        raise ValueError("batter_not_on_batting_team")

    # Ensure player has not already been dismissed in this innings
    dismissed = (
        getattr(match, "dismissed_batters_a", [])
        if match.batting_team == "A"
        else getattr(match, "dismissed_batters_b", [])
    )
    if batter_player_id in dismissed:
        raise ValueError("player_already_dismissed")

    # Update roles
    members = repo.get_room_members(room.id)
    for m in members:
        if m.team == match.batting_team:
            m.role = PlayerRole.BATTER if m.player_id == batter_player_id else PlayerRole.SPECTATOR
            repo.save_membership(m)

    match.active_batter_id = batter_player_id
    # If bowler is also active, start delivery countdown!
    if match.active_bowler_id:
        match.delivery_deadline = datetime.utcnow() + timedelta(seconds=DELIVERY_TIMEOUT_SECONDS)
    repo.save_match(match)
    return match


def select_bowler(room: Room, captain: Player, bowler_player_id: str) -> Match:
    match = repo.get_match_by_room(room.id)
    if not match:
        raise ValueError("no_active_match")
    if room.status != RoomStatus.INNINGS_ACTIVE:
        raise ValueError("not_in_active_innings")

    captain_mem = repo.get_membership(room.id, captain.id)
    if not captain_mem:
        raise PermissionError("not_in_room")

    # Captain must be on the bowling team
    if captain_mem.team != match.bowling_team:
        raise PermissionError("wrong_team")

    bowling_mems = [m for m in repo.get_room_members(room.id) if m.team == match.bowling_team]
    has_explicit_captain = any(m.is_captain for m in bowling_mems)
    if has_explicit_captain and not (captain_mem.is_captain or captain_mem.is_host):
        raise PermissionError("not_captain")

    bowler_mem = repo.get_membership(room.id, bowler_player_id)
    if not bowler_mem or bowler_mem.team != match.bowling_team:
        raise ValueError("bowler_not_on_bowling_team")

    # Update roles
    members = repo.get_room_members(room.id)
    for m in members:
        if m.team == match.bowling_team:
            m.role = PlayerRole.BOWLER if m.player_id == bowler_player_id else PlayerRole.SPECTATOR
            repo.save_membership(m)

    match.active_bowler_id = bowler_player_id
    match.delivery_deadline = datetime.utcnow() + timedelta(seconds=DELIVERY_TIMEOUT_SECONDS)
    repo.save_match(match)
    return match


def _advance_gameplay_state(room: Room, match: Match, outcome) -> tuple[Match, Delivery]:
    """
    Seamlessly updates delivery, match score, innings changeover, next batter,
    and resets the delivery deadline for the next ball.
    """
    repo.save_delivery(outcome.delivery)

    if outcome.delivery.result == DeliveryResult.OUT:
        dismissed_id = outcome.delivery.batter_id or match.active_batter_id
        dismissed_team = match.all_out_team or (match.bowling_team if outcome.innings_ended else match.batting_team)
        if dismissed_team == "A":
            if dismissed_id and dismissed_id not in match.dismissed_batters_a:
                match.dismissed_batters_a.append(dismissed_id)
        else:
            if dismissed_id and dismissed_id not in match.dismissed_batters_b:
                match.dismissed_batters_b.append(dismissed_id)

    if outcome.match_ended:
        room.status = RoomStatus.MATCH_COMPLETE
        match.delivery_deadline = None
        repo.save_room(room)
        repo.save_match(match)
        return match, outcome.delivery

    members = repo.get_room_members(room.id)
    team_a = [m for m in members if m.team == "A"]
    team_b = [m for m in members if m.team == "B"]

    if outcome.innings_ended:
        # First innings completed -> start 2nd innings immediately without locking
        room.status = RoomStatus.INNINGS_ACTIVE
        repo.save_room(room)

        batting_mems = team_a if match.batting_team == "A" else team_b
        bowling_mems = team_b if match.batting_team == "A" else team_a

        match.active_batter_id = batting_mems[0].player_id if batting_mems else None

        if room.mode == GameMode.SOLO or len(bowling_mems) == 1:
            match.active_bowler_id = bowling_mems[0].player_id if bowling_mems else None
            match.delivery_deadline = datetime.utcnow() + timedelta(seconds=DELIVERY_TIMEOUT_SECONDS)
        else:
            match.active_bowler_id = None
            match.delivery_deadline = None

        for m in members:
            if m.team == match.batting_team and m.player_id == match.active_batter_id:
                m.role = PlayerRole.BATTER
            elif m.team == match.bowling_team and m.player_id == match.active_bowler_id:
                m.role = PlayerRole.BOWLER
            else:
                m.role = PlayerRole.SPECTATOR
            repo.save_membership(m)

        repo.save_match(match)
        return match, outcome.delivery

    # Normal delivery within the same innings
    # 1. Did a wicket fall? Record dismissed batter and check ALL OUT / Captain batter selection
    if outcome.delivery.result == DeliveryResult.OUT:
        dismissed_id = outcome.delivery.batter_id or match.active_batter_id
        if match.batting_team == "A":
            if dismissed_id and dismissed_id not in match.dismissed_batters_a:
                match.dismissed_batters_a.append(dismissed_id)
        else:
            if dismissed_id and dismissed_id not in match.dismissed_batters_b:
                match.dismissed_batters_b.append(dismissed_id)

        batting_mems = team_a if match.batting_team == "A" else team_b
        dismissed = (
            match.dismissed_batters_a
            if match.batting_team == "A"
            else match.dismissed_batters_b
        )
        eligible = [m for m in batting_mems if m.player_id not in dismissed]
        wlimit = match.wicket_limit(match.batting_team)
        wickets = match.batting_wickets

        if wickets >= wlimit or len(eligible) == 0:
            outcome.is_all_out = True
            outcome.all_out_team = match.batting_team
            outcome.all_out_runs = match.team_a_runs if match.batting_team == "A" else match.team_b_runs
            outcome.all_out_wickets = wickets
            if match.batting_team == "A":
                match.is_all_out_a = True
            else:
                match.is_all_out_b = True
            match.is_all_out = True
            match.all_out_team = match.batting_team
            match.active_batter_id = None
            match.delivery_deadline = None
            if not outcome.innings_ended:
                outcome.innings_ended = True
                outcome.match_ended = GameRules._advance_innings_or_end(match)
                if outcome.match_ended:
                    room.status = RoomStatus.MATCH_COMPLETE
                    repo.save_room(room)
                    repo.save_match(match)
                    return match, outcome.delivery
        else:
            if len(batting_mems) > 1 and room.mode == GameMode.TEAM:
                # In team matches, captain selects the next batter
                match.active_batter_id = None
                match.delivery_deadline = None
            elif batting_mems:
                match.active_batter_id = batting_mems[0].player_id

    # 2. Did the over complete?
    over_completed = (match.current_ball == 0)
    if over_completed:
        bowling_mems = team_b if match.batting_team == "A" else team_a
        if room.mode == GameMode.SOLO or len(bowling_mems) == 1:
            match.active_bowler_id = bowling_mems[0].player_id if bowling_mems else None
            match.delivery_deadline = datetime.utcnow() + timedelta(seconds=DELIVERY_TIMEOUT_SECONDS)
        else:
            # Captain needs to choose new bowler for next over
            match.active_bowler_id = None
            match.delivery_deadline = None
    else:
        # Continuing over with same bowler -> start fresh 25-second countdown
        match.delivery_deadline = datetime.utcnow() + timedelta(seconds=DELIVERY_TIMEOUT_SECONDS)

    # Sync player roles
    for m in members:
        if m.team == match.batting_team and m.player_id == match.active_batter_id:
            m.role = PlayerRole.BATTER
        elif m.team == match.bowling_team and m.player_id == match.active_bowler_id:
            m.role = PlayerRole.BOWLER
        else:
            m.role = PlayerRole.SPECTATOR
        repo.save_membership(m)

    repo.save_match(match)
    return match, outcome.delivery


def submit_pick(room: Room, player: Player, pick: int) -> tuple[Match, Optional[Delivery]]:
    """
    Submit a batter or bowler pick.
    Returns (match, resolved_delivery) – delivery is None if waiting for other player.
    """
    match = repo.get_match_by_room(room.id)
    if not match:
        raise ValueError("no_active_match")

    mem = repo.get_membership(room.id, player.id)
    if not mem:
        raise PermissionError("not_in_room")

    # Validate pick
    err = GameRules.validate_pick(pick)
    if err:
        raise ValueError(err)

    # Check deadline with 2.5s network skew tolerance
    if match.delivery_deadline and (datetime.utcnow() - match.delivery_deadline).total_seconds() > 2.5:
        raise ValueError("deadline_expired")

    # Get or create current delivery
    delivery = repo.get_current_delivery(match.id)
    if delivery is None:
        delivery = Delivery(
            match_id=match.id,
            innings=match.phase,
            over_index=match.current_over,
            ball_index=match.current_ball,
            batter_id=match.active_batter_id,
            bowler_id=match.active_bowler_id,
        )
        repo.save_delivery(delivery)

    if delivery.committed:
        raise ValueError("delivery_already_resolved")

    # Assign pick to correct role
    is_batter = player.id == match.active_batter_id
    is_bowler = player.id == match.active_bowler_id

    if is_batter:
        if delivery.batter_pick is not None:
            raise ValueError("already_submitted")
        delivery.batter_pick = pick
    elif is_bowler:
        if delivery.bowler_pick is not None:
            raise ValueError("already_submitted")
        delivery.bowler_pick = pick
    else:
        raise PermissionError("not_active_player")

    repo.save_delivery(delivery)

    # If both have submitted, resolve immediately
    if delivery.batter_pick is not None and delivery.bowler_pick is not None:
        outcome = GameRules.resolve_delivery(match, copy.copy(delivery))
        return _advance_gameplay_state(room, match, outcome)

    return match, None


def resolve_timeout(room_id: str) -> Optional[tuple[Match, Delivery]]:
    """Called by the server timer when the delivery deadline expires."""
    room = repo.get_room(room_id)
    if not room or room.status != RoomStatus.INNINGS_ACTIVE:
        return None

    match = repo.get_match_by_room(room_id)
    if not match or not match.delivery_deadline:
        return None

    if datetime.utcnow() < match.delivery_deadline:
        return None  # Not yet expired

    delivery = repo.get_current_delivery(match.id)
    if delivery is None:
        delivery = Delivery(
            match_id=match.id,
            innings=match.phase,
            over_index=match.current_over,
            ball_index=match.current_ball,
            batter_id=match.active_batter_id,
            bowler_id=match.active_bowler_id,
        )

    if delivery.committed:
        return None

    outcome = GameRules.resolve_delivery(match, copy.copy(delivery))
    return _advance_gameplay_state(room, match, outcome)


def get_room_snapshot(room_id: str, requesting_player_id: str) -> dict:
    """
    Build a complete sanitised state snapshot for a player.
    Secret picks are never included until revealed.
    """
    room = repo.get_room(room_id)
    if not room:
        return {"error": "room_not_found"}

    members = repo.get_room_members(room_id)
    players_map = {m.player_id: repo.get_player(m.player_id) for m in members}

    match = repo.get_match_by_room(room_id)
    match_data = None
    current_delivery = None

    if match:
        match_data = {
            "id": match.id,
            "phase": match.phase.value,
            "overs": match.overs,
            "team_a_runs": match.team_a_runs,
            "team_a_wickets": match.team_a_wickets,
            "team_b_runs": match.team_b_runs,
            "team_b_wickets": match.team_b_wickets,
            "target": match.target,
            "current_over": match.current_over,
            "current_ball": match.current_ball,
            "batting_team": match.batting_team,
            "active_batter_id": match.active_batter_id,
            "active_bowler_id": match.active_bowler_id,
            "delivery_deadline": (
                (match.delivery_deadline.isoformat() + "Z") if match.delivery_deadline else None
            ),
            "winner": match.winner,
            "result_summary": match.result_summary,
            "first_batting_team": getattr(match, "first_batting_team", "A"),
            "wickets": getattr(match, "wickets", getattr(room, "wickets", 1)),
            "team_a_name": getattr(match, "team_a_name", getattr(room, "team_a_name", "Team A")),
            "team_b_name": getattr(match, "team_b_name", getattr(room, "team_b_name", "Team B")),
            "dismissed_batters_a": getattr(match, "dismissed_batters_a", []),
            "dismissed_batters_b": getattr(match, "dismissed_batters_b", []),
            "is_all_out": getattr(match, "is_all_out", False),
            "all_out_team": getattr(match, "all_out_team", None),
            "is_all_out_a": getattr(match, "is_all_out_a", False),
            "is_all_out_b": getattr(match, "is_all_out_b", False),
            "is_super_over": getattr(match, "is_super_over", False),
            "main_match_team_a_runs": getattr(match, "main_match_team_a_runs", None),
            "main_match_team_b_runs": getattr(match, "main_match_team_b_runs", None),
            "main_match_team_a_wickets": getattr(match, "main_match_team_a_wickets", None),
            "main_match_team_b_wickets": getattr(match, "main_match_team_b_wickets", None),
        }

        raw_delivery = repo.get_current_delivery(match.id)
        if raw_delivery and not raw_delivery.committed:
            current_delivery = {
                "id": raw_delivery.id,
                "batter_submitted": raw_delivery.batter_pick is not None,
                "bowler_submitted": raw_delivery.bowler_pick is not None,
                # Own pick shown, opponent's pick hidden
                "my_pick": (
                    raw_delivery.batter_pick
                    if requesting_player_id == match.active_batter_id
                    else raw_delivery.bowler_pick
                    if requesting_player_id == match.active_bowler_id
                    else None
                ),
            }

        all_delivs = repo.get_deliveries(match.id)
        recent_deliveries = [
            {
                "id": d.id,
                "over": d.over_index,
                "ball": d.ball_index,
                "result": d.result.value if d.result else "DOT",
                "runs_scored": d.runs_scored,
                "batter_pick": d.batter_pick,
                "bowler_pick": d.bowler_pick,
                "batter_id": getattr(d, "batter_id", None),
                "bowler_id": getattr(d, "bowler_id", None),
                "innings": d.innings.value if hasattr(d.innings, "value") else str(d.innings),
            }
            for d in all_delivs
            if d.committed
        ]
    else:
        recent_deliveries = []

    return {
        "room": room.to_public_dict(),
        "members": [
            {
                "player": players_map[m.player_id].to_public_dict() if players_map.get(m.player_id) else {},
                "team": m.team,
                "is_captain": m.is_captain,
                "is_host": m.is_host,
                "role": m.role.value,
                "readiness": m.readiness.value,
                "voice_mode": getattr(m, "voice_mode", "EVERYONE"),
                "allowed_recipients": getattr(m, "allowed_recipients", []),
            }
            for m in members
        ],
        "match": match_data,
        "current_delivery": current_delivery,
        "recent_deliveries": recent_deliveries,
    }
