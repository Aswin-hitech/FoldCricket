"""
Room and Match service layer.
Orchestrates domain models, repositories, and rules.
"""

from __future__ import annotations

import copy
import secrets
import threading
import uuid
from datetime import datetime, timedelta
from typing import Optional

from ..config import Config
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
from . import accounts_service

DELIVERY_TIMEOUT_SECONDS = Config.DELIVERY_TIMEOUT_SECONDS
FIRST_BALL_TIMEOUT_SECONDS = 30
INNINGS_BREAK_SECONDS = getattr(Config, "INNINGS_BREAK_SECONDS", 10)
RECONNECT_GRACE_SECONDS = Config.RECONNECT_GRACE_SECONDS


def get_delivery_timeout_seconds(match: Match) -> int:
    """
    Authoritative delivery timer rule:
    First ball of the first innings and second innings is 30 seconds;
    all other balls are 20 seconds.
    """
    if (
        match.current_over == 0
        and match.current_ball == 0
        and match.phase in (InningsPhase.FIRST, InningsPhase.SECOND)
    ):
        return FIRST_BALL_TIMEOUT_SECONDS
    return DELIVERY_TIMEOUT_SECONDS

_match_lock = threading.RLock()


# ---------------------------------------------------------------------------
# Player service
# ---------------------------------------------------------------------------

def create_or_restore_player(
    display_name: str,
    session_token: Optional[str] = None,
    user_id: Optional[str] = None,
) -> tuple[Player, bool]:
    """
    Returns (player, is_new).
    If a valid session_token is provided and matches an existing player, restore.
    A logged-in account links its profile to the game identity so finished
    matches can be credited to that account.
    """
    if session_token:
        existing = repo.get_player_by_session(session_token)
        if existing:
            if user_id and existing.user_id != user_id:
                existing.user_id = user_id
                repo.save_player(existing)
            return existing, False

    ok, reason = validate_display_name(display_name)
    if not ok:
        raise ValueError(reason)

    player = Player(
        display_name=display_name.strip(),
        session_token=session_token or generate_session_token(),
        user_id=user_id,
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


def join_room(
    player: Player, join_code: str, as_spectator: bool = False
) -> tuple[Room, Membership]:
    room = repo.get_room_by_code(join_code)
    if not room:
        raise ValueError("room_not_found")

    members = repo.get_room_members(room.id)
    existing = next((m for m in members if m.player_id == player.id), None)
    if existing:
        return room, existing  # Rejoin (allowed even after the match ended)

    if room.status == RoomStatus.MATCH_COMPLETE:
        raise ValueError("room_closed")

    if len(members) >= room.capacity:
        raise ValueError("room_full")

    if as_spectator:
        # Spectators may join at any stage, including mid-innings. They never
        # gate readiness, the toss, quorum or forfeits: team=None says so.
        membership = Membership(
            room_id=room.id,
            player_id=player.id,
            team=None,
            role=PlayerRole.SPECTATOR,
        )
        repo.save_membership(membership)
        return room, membership

    if room.status in (
        RoomStatus.TOSS,
        RoomStatus.AWAITING_FIRST_BALL,
        RoomStatus.INNINGS_ACTIVE,
        RoomStatus.INNINGS_BREAK,
        RoomStatus.PAUSED,
    ):
        raise ValueError("game_in_progress")

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

    # If we now have 2+ players, move to LOBBY_READY. Spectators never count.
    all_members = repo.get_room_members(room.id)
    player_count = sum(1 for m in all_members if not m.is_spectator)
    if player_count >= 2 and room.status == RoomStatus.WAITING_FOR_PLAYERS:
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


def _reconcile_lobby_after_departure(room: Room, departed: Membership) -> Optional[Room]:
    """
    Restore lobby invariants after someone leaves: a room always keeps a host,
    every populated team keeps a captain, and a one-player room is not 'ready'.
    Returns None when the room became empty and was deleted.
    """
    members = repo.get_room_members(room.id)
    if not members:
        repo.delete_room(room.id)
        return None

    players = [m for m in members if not m.is_spectator]

    if departed.is_host or not any(m.is_host for m in members):
        # Hosting only makes sense for someone who can actually start a match.
        new_host = players[0] if players else members[0]
        new_host.is_host = True
        room.host_id = new_host.player_id
        if new_host.team and not any(
            m.is_captain and m.team == new_host.team for m in members
        ):
            new_host.is_captain = True
        repo.save_membership(new_host)

    if departed.is_captain and departed.team:
        teammates = [m for m in members if m.team == departed.team]
        if teammates and not any(m.is_captain for m in teammates):
            teammates[0].is_captain = True
            repo.save_membership(teammates[0])

    if len(players) < 2:
        room.status = RoomStatus.WAITING_FOR_PLAYERS
    elif room.status == RoomStatus.WAITING_FOR_PLAYERS:
        room.status = RoomStatus.LOBBY_READY
    room.toss = None
    repo.save_room(room)
    return room


_LOBBY_STATUSES = (
    RoomStatus.WAITING_FOR_PLAYERS,
    RoomStatus.LOBBY_READY,
    RoomStatus.RULEBOOK_REQUIRED,
)


def leave_lobby(room: Room, player: Player) -> Optional[Room]:
    """
    A member voluntarily exits. Players only leave from the lobby; spectators
    may stop watching at any time and never disturb the live match.
    Returns None if the room is now empty.
    """
    with _match_lock:
        room = repo.get_room(room.id) or room
        mem = repo.get_membership(room.id, player.id)
        if not mem:
            raise ValueError("not_in_room")

        if mem.is_spectator:
            repo.remove_membership(room.id, player.id)
            cleanup_player_voice(room.id, player.id)
            if room.status in _LOBBY_STATUSES:
                return _reconcile_lobby_after_departure(room, mem)
            return room

        if room.status not in _LOBBY_STATUSES:
            raise ValueError("cannot_leave_now")

        repo.remove_membership(room.id, player.id)
        cleanup_player_voice(room.id, player.id)
        return _reconcile_lobby_after_departure(room, mem)


def remove_player_from_lobby(room: Room, actor: Player, target_id: str) -> Optional[Room]:
    """
    A team captain (or the host) removes another player from the lobby.
    Hosts remove anyone; other captains only their own team. Nobody removes
    themselves through this path.
    """
    with _match_lock:
        room = repo.get_room(room.id) or room
        if room.status not in _LOBBY_STATUSES:
            raise ValueError("cannot_remove_now")
        actor_mem = repo.get_membership(room.id, actor.id)
        if not actor_mem:
            raise PermissionError("not_in_room")
        if target_id == actor.id:
            raise ValueError("cannot_remove_self")
        target_mem = repo.get_membership(room.id, target_id)
        if not target_mem:
            raise ValueError("player_not_in_room")
        if target_mem.is_host:
            raise PermissionError("cannot_remove_host")

        can_remove = actor_mem.is_host or (
            actor_mem.is_captain and actor_mem.team is not None and actor_mem.team == target_mem.team
        )
        if not can_remove:
            raise PermissionError("not_allowed")

        repo.remove_membership(room.id, target_id)
        cleanup_player_voice(room.id, target_id)
        return _reconcile_lobby_after_departure(room, target_mem)


def ack_rules(room: Room, player: Player) -> None:
    mem = repo.get_membership(room.id, player.id)
    if not mem:
        raise ValueError("not_in_room")
    mem.rules_acked_version = room.rules_version
    repo.save_membership(mem)
    # Only players gate the rulebook; spectators are just watching.
    members = [m for m in repo.get_room_members(room.id) if not m.is_spectator]
    if members and all(m.rules_acked_version == room.rules_version for m in members):
        if room.status == RoomStatus.RULEBOOK_REQUIRED:
            room.status = RoomStatus.LOBBY_READY
            repo.save_room(room)


def set_ready(room: Room, player: Player, ready: bool) -> Membership:
    mem = repo.get_membership(room.id, player.id)
    if not mem:
        raise ValueError("not_in_room")
    if mem.is_spectator:
        raise ValueError("spectator_not_playing")
    mem.readiness = ReadinessState.READY if ready else ReadinessState.NOT_READY
    repo.save_membership(mem)
    return mem


def reset_room_for_rematch(room: Room, player: Player) -> Room:
    """Return a finished room to the lobby so the same players can play again."""
    with _match_lock:
        room = repo.get_room(room.id) or room
        if room.status != RoomStatus.MATCH_COMPLETE:
            raise ValueError("match_not_complete")
        starter = repo.get_membership(room.id, player.id)
        if not starter:
            raise PermissionError("not_in_room")
        if starter.is_spectator:
            raise PermissionError("spectator_cannot_rematch")

        members = repo.get_room_members(room.id)
        players = [m for m in members if not m.is_spectator]
        room.toss = None
        room.status = (
            RoomStatus.LOBBY_READY if len(players) >= 2 else RoomStatus.WAITING_FOR_PLAYERS
        )
        repo.save_room(room)

        # Everyone must re-confirm readiness for the new match; spectators stay
        # spectators and are never asked to ready up.
        for m in members:
            m.readiness = ReadinessState.NOT_READY
            m.role = PlayerRole.SPECTATOR
            repo.save_membership(m)
        return room


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
    # Atomic: a retried call must not flip the coin a second time.
    with _match_lock:
        room = repo.get_room(room.id) or room
        if room.status != RoomStatus.TOSS or not room.toss:
            raise ValueError("not_in_toss")
        if room.toss.get("state") != "CALLING":
            raise ValueError("toss_already_called")
        if player.id != room.toss.get("caller_id"):
            raise PermissionError("not_toss_caller")

        choice = choice.strip().upper()
        if choice not in ("HEADS", "TAILS"):
            raise ValueError("invalid_toss_choice")

        coin_result = secrets.choice(["HEADS", "TAILS"])
        members = repo.get_room_members(room.id)
        caller_mem = repo.get_membership(room.id, player.id)
        other_mems = [
            m for m in members if not m.is_spectator and m.team != caller_mem.team
        ]
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
    # Atomic: a duplicated/retried toss decision must never create a second
    # match row for the same room.
    with _match_lock:
        room = repo.get_room(room.id) or room
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

        for m in members:
            if m.team == batting_team and m.player_id == match.active_batter_id:
                m.role = PlayerRole.BATTER
            elif m.team == match.bowling_team and m.player_id == match.active_bowler_id:
                m.role = PlayerRole.BOWLER
            else:
                m.role = PlayerRole.SPECTATOR
            # Everyone must explicitly confirm they are ready for the first ball
            # once they are inside the arena.
            m.readiness = ReadinessState.NOT_READY
            repo.save_membership(m)

        # Match setup is complete, but the clock does not start until every
        # connected member confirms they are ready for the first ball.
        room.status = RoomStatus.AWAITING_FIRST_BALL
        repo.save_room(room)
        repo.save_match(match)
        return match


def confirm_first_ball_ready(room: Room, player: Player) -> tuple[Room, Optional[Match], bool]:
    """
    Arena entry gate. A player confirms they are ready for the first ball.

    The innings (and the first delivery timer) only starts once every member
    is currently connected and has confirmed readiness. Returns
    (room, match, activated).
    """
    with _match_lock:
        room = repo.get_room(room.id) or room
        if room.status != RoomStatus.AWAITING_FIRST_BALL:
            raise ValueError("not_awaiting_first_ball")

        mem = repo.get_membership(room.id, player.id)
        if not mem:
            raise PermissionError("not_in_room")
        if mem.is_spectator:
            raise ValueError("spectator_not_playing")

        current = repo.get_player(player.id) or player
        if current.connection_state != ConnectionState.CONNECTED:
            raise ValueError("player_not_connected")

        mem.readiness = ReadinessState.READY
        repo.save_membership(mem)

        match = repo.get_match_by_room(room.id)
        if not match:
            raise ValueError("no_active_match")

        members = [m for m in repo.get_room_members(room.id) if not m.is_spectator]
        everyone_connected = bool(members)
        everyone_ready = bool(members)
        for m in members:
            member_player = repo.get_player(m.player_id)
            if not member_player or member_player.connection_state != ConnectionState.CONNECTED:
                everyone_connected = False
            if m.readiness != ReadinessState.READY:
                everyone_ready = False

        if not (everyone_connected and everyone_ready):
            return room, match, False

        room.status = RoomStatus.INNINGS_ACTIVE
        # In team matches the bowling captain still has to pick a bowler; the
        # clock starts when that selection happens (see select_bowler).
        if match.active_bowler_id:
            match.delivery_deadline = datetime.utcnow() + timedelta(
                seconds=get_delivery_timeout_seconds(match)
            )
        else:
            match.delivery_deadline = None
        match.version += 1
        repo.save_room(room)
        repo.save_match(match)
        return room, match, True


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
        match.delivery_deadline = datetime.utcnow() + timedelta(seconds=get_delivery_timeout_seconds(match))
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
    match.delivery_deadline = datetime.utcnow() + timedelta(seconds=get_delivery_timeout_seconds(match))
    repo.save_match(match)
    return match


def _advance_gameplay_state(room: Room, match: Match, outcome) -> tuple[Match, Delivery]:
    """
    Seamlessly updates delivery, match score, innings changeover, next batter,
    and resets the delivery deadline for the next ball.
    """
    repo.save_delivery(outcome.delivery)

    # Dead ball (timeout / one or both players missed the pick): the delivery is
    # nullified and the same batter faces the same ball again. Nothing advances.
    if outcome.delivery.result == DeliveryResult.TIMEOUT:
        match.delivery_deadline = datetime.utcnow() + timedelta(seconds=get_delivery_timeout_seconds(match))
        repo.save_match(match)
        return match, outcome.delivery

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
        accounts_service.record_match_stats(room, match)
        return match, outcome.delivery

    members = repo.get_room_members(room.id)
    team_a = [m for m in members if m.team == "A"]
    team_b = [m for m in members if m.team == "B"]

    if outcome.innings_ended:
        # First innings completed -> enter authoritative 10-second INNINGS_BREAK
        if getattr(outcome, "is_all_out", False):
            match.is_all_out = True
            match.all_out_team = outcome.all_out_team
        room.status = RoomStatus.INNINGS_BREAK
        match.delivery_deadline = None
        match.active_batter_id = None
        match.active_bowler_id = None
        match.innings_break_deadline = datetime.utcnow() + timedelta(seconds=INNINGS_BREAK_SECONDS)
        repo.save_room(room)
        repo.save_match(match)
        return match, outcome.delivery

    # Normal delivery within the same innings
    # 1. Did a wicket fall? Record dismissed batter and check ALL OUT / Captain batter selection
    if outcome.delivery.result == DeliveryResult.OUT:
        dismissed_id = outcome.delivery.batter_id or match.active_batter_id
        batting_mems = team_a if match.batting_team == "A" else team_b
        is_team_multiplayer = len(batting_mems) > 1 and room.mode == GameMode.TEAM

        if is_team_multiplayer:
            if match.batting_team == "A":
                if dismissed_id and dismissed_id not in match.dismissed_batters_a:
                    match.dismissed_batters_a.append(dismissed_id)
                # If all team members have batted but team still has wickets remaining, recycle
                if len(match.dismissed_batters_a) >= len(batting_mems):
                    match.dismissed_batters_a.clear()
            else:
                if dismissed_id and dismissed_id not in match.dismissed_batters_b:
                    match.dismissed_batters_b.append(dismissed_id)
                # If all team members have batted but team still has wickets remaining, recycle
                if len(match.dismissed_batters_b) >= len(batting_mems):
                    match.dismissed_batters_b.clear()

        wlimit = match.wicket_limit(match.batting_team)
        wickets = match.batting_wickets

        # All out strictly occurs when total wickets lost reaches configured wlimit
        if wickets >= wlimit:
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
                    accounts_service.record_match_stats(room, match)
                    return match, outcome.delivery
                else:
                    # First innings completed via all out -> enter INNINGS_BREAK
                    room.status = RoomStatus.INNINGS_BREAK
                    match.delivery_deadline = None
                    match.active_batter_id = None
                    match.active_bowler_id = None
                    match.innings_break_deadline = datetime.utcnow() + timedelta(seconds=INNINGS_BREAK_SECONDS)
                    repo.save_room(room)
                    repo.save_match(match)
                    return match, outcome.delivery
        else:
            # Wickets remain: continue innings with the next wicket
            if is_team_multiplayer:
                # In team matches, captain selects the next batter
                match.active_batter_id = None
                match.delivery_deadline = None
            elif batting_mems:
                # In 1v1 / solo matches, same batter continues for their remaining wickets
                match.active_batter_id = batting_mems[0].player_id

    # 2. Did the over complete?
    over_completed = (match.current_ball == 0)
    if over_completed:
        bowling_mems = team_b if match.batting_team == "A" else team_a
        if room.mode == GameMode.SOLO or len(bowling_mems) == 1:
            match.active_bowler_id = bowling_mems[0].player_id if bowling_mems else None
            match.delivery_deadline = datetime.utcnow() + timedelta(seconds=get_delivery_timeout_seconds(match))
        else:
            # Captain needs to choose new bowler for next over
            match.active_bowler_id = None
            match.delivery_deadline = None
    else:
        # Continuing over with same bowler
        match.delivery_deadline = datetime.utcnow() + timedelta(seconds=get_delivery_timeout_seconds(match))

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


def start_second_innings(room_id: str | Any) -> tuple[Room, Match]:
    """
    Authoritative server-side transition from INNINGS_BREAK to second innings INNINGS_ACTIVE.
    Thread-safe and idempotent under _match_lock.
    """
    with _match_lock:
        if hasattr(room_id, "id"):
            room_id = room_id.id
        room = repo.get_room(room_id)
        if not room:
            raise ValueError("room_not_found")
        match = repo.get_match_by_room(room_id)
        if not match:
            raise ValueError("match_not_found")

        # Idempotency: if already active or completed, return existing
        if room.status != RoomStatus.INNINGS_BREAK:
            return room, match

        room.status = RoomStatus.INNINGS_ACTIVE
        match.innings_break_deadline = None
        match.is_all_out = False
        match.all_out_team = None
        match.version += 1

        members = repo.get_room_members(room.id)
        team_a = [m for m in members if m.team == "A"]
        team_b = [m for m in members if m.team == "B"]
        batting_mems = team_a if match.batting_team == "A" else team_b
        bowling_mems = team_b if match.batting_team == "A" else team_a

        match.active_batter_id = batting_mems[0].player_id if batting_mems else None

        if room.mode == GameMode.SOLO or len(bowling_mems) == 1:
            match.active_bowler_id = bowling_mems[0].player_id if bowling_mems else None
            match.delivery_deadline = datetime.utcnow() + timedelta(seconds=get_delivery_timeout_seconds(match))
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

        repo.save_room(room)
        repo.save_match(match)
        return room, match


def submit_pick(
    room: Room,
    player: Player,
    pick: int,
    over: Optional[int] = None,
    ball: Optional[int] = None,
    phase: Optional[str] = None,
) -> tuple[Match, Optional[Delivery]]:
    """
    Submit a batter or bowler pick.
    Returns (match, resolved_delivery) – delivery is None if waiting for other player.

    `over`/`ball`/`phase` are the ball the client believed it was picking for.
    A pick buffered by the transport (socket.io replays the send buffer after a
    reconnect) or tapped twice must never land on a later ball, so a mismatch is
    rejected with `ball_changed` instead of being applied to the current ball.

    Re-sending the *same* pick for the same ball is a no-op success: acks can be
    lost on a flaky link and the client may retry, but that must not look like a
    rejection to the player.

    Thread-safe & atomic under _match_lock.
    """
    with _match_lock:
        match = repo.get_match_by_room(room.id)
        if not match:
            raise ValueError("no_active_match")

        if match.winner is not None or room.status == RoomStatus.MATCH_COMPLETE:
            raise ValueError("match_already_completed")

        if room.status == RoomStatus.INNINGS_BREAK:
            raise ValueError("cannot_submit_during_innings_break")

        if room.status != RoomStatus.INNINGS_ACTIVE:
            raise ValueError("match_not_active")

        mem = repo.get_membership(room.id, player.id)
        if not mem:
            raise PermissionError("not_in_room")

        # Validate pick
        err = GameRules.validate_pick(pick)
        if err:
            raise ValueError(err)

        # Stale-ball guard: the pick must belong to the ball that is live now.
        live_phase = match.phase.value if hasattr(match.phase, "value") else str(match.phase)
        if (
            (over is not None and int(over) != match.current_over)
            or (ball is not None and int(ball) != match.current_ball)
            or (phase is not None and str(phase) != live_phase)
        ):
            raise ValueError("ball_changed")

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
                if delivery.batter_pick == pick:
                    return match, None  # idempotent retry of the same pick
                raise ValueError("already_submitted")
            delivery.batter_pick = pick
        elif is_bowler:
            if delivery.bowler_pick is not None:
                if delivery.bowler_pick == pick:
                    return match, None  # idempotent retry of the same pick
                raise ValueError("already_submitted")
            delivery.bowler_pick = pick
        else:
            raise PermissionError("not_active_player")

        repo.save_delivery(delivery)

        # If both have submitted, resolve immediately
        if delivery.batter_pick is not None and delivery.bowler_pick is not None:
            outcome = GameRules.resolve_delivery(match, delivery)
            return _advance_gameplay_state(room, match, outcome)

        return match, None


def resolve_timeout(room_id: str) -> Optional[tuple[Match, Delivery]]:
    """Called by the server timer when the delivery deadline expires."""
    with _match_lock:
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

        outcome = GameRules.resolve_delivery(match, delivery)
        return _advance_gameplay_state(room, match, outcome)


def get_room_snapshot(room_id: str, requesting_player_id: str = "") -> dict:
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
    if room.status == RoomStatus.INNINGS_BREAK and match and getattr(match, "innings_break_deadline", None):
        if datetime.utcnow() >= match.innings_break_deadline:
            room, match = start_second_innings(room.id)

    # A finished match row survives a rematch. Before the next toss is decided
    # the lobby must not be handed that old match, or clients rebuild the last
    # game's arena/result from it.
    if room.status in (
        RoomStatus.WAITING_FOR_PLAYERS,
        RoomStatus.LOBBY_READY,
        RoomStatus.RULEBOOK_REQUIRED,
        RoomStatus.TOSS,
    ):
        match = None

    match_data = None
    current_delivery = None

    if match:
        match_data = {
            "id": match.id,
            "version": getattr(match, "version", 0),
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
            "innings_break_deadline": (
                (match.innings_break_deadline.isoformat() + "Z") if getattr(match, "innings_break_deadline", None) else None
            ),
            "break_seconds": INNINGS_BREAK_SECONDS,
            "winner": match.winner,
            "result_summary": match.result_summary,
            "first_batting_team": getattr(match, "first_batting_team", "A"),
            "wickets": getattr(match, "wickets", getattr(room, "wickets", 1)),
            # Per-team limits mirror the engine so the arena can show "wickets left".
            "team_a_wicket_limit": match.wicket_limit("A"),
            "team_b_wicket_limit": match.wicket_limit("B"),
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
        "server_time": datetime.utcnow().isoformat() + "Z",
        "room": room.to_public_dict(),
        "members": [
            {
                "player": players_map[m.player_id].to_public_dict() if players_map.get(m.player_id) else {},
                "team": m.team,
                "is_captain": m.is_captain,
                "is_host": m.is_host,
                "role": m.role.value,
                "readiness": m.readiness.value,
                "is_spectator": m.is_spectator,
                "voice_mode": getattr(m, "voice_mode", "EVERYONE"),
                "allowed_recipients": getattr(m, "allowed_recipients", []),
            }
            for m in members
        ],
        "match": match_data,
        "current_delivery": current_delivery,
        "recent_deliveries": recent_deliveries,
        "voice_permissions": [
            {"sender_id": k[0], "receiver_id": k[1], "status": v}
            for k, v in repo.get_room_voice_permissions(room_id).items()
        ],
    }


# ---------------------------------------------------------------------------
# Selective Voice Communication & Cross-Team Mutual Consent Engine
# ---------------------------------------------------------------------------

def is_voice_signal_authorized(room_id: str | Any, sender_id: str, target_id: str) -> bool:
    """
    Authoritative server-side validation of WebRTC signaling.
    Rules:
    1. Both sender and target must be active members in room_id.
    2. In SOLO mode: 1v1 communication is always authorized between the two players.
    3. In TEAM mode:
       - If sender and target belong to the SAME team:
         Authorized (private team communication) unless sender explicitly blocked target in allowed_recipients.
       - If sender and target belong to DIFFERENT teams:
         Authorized ONLY if mutual cross-team consent has been requested and accepted ('MUTUAL_ACCEPTED').
    """
    if hasattr(room_id, "id"):
        room_id = room_id.id

    if sender_id == target_id:
        return False

    room = repo.get_room(room_id)
    if not room:
        return False

    sender_mem = repo.get_membership(room_id, sender_id)
    target_mem = repo.get_membership(room_id, target_id)
    if not sender_mem or not target_mem:
        return False

    # In SOLO mode, bidirectional communication is fully open between the 2 players
    if room.mode == GameMode.SOLO:
        return True

    # In TEAM mode:
    # A. Same team communication (Private Team Audio)
    if sender_mem.team and sender_mem.team == target_mem.team:
        mode = getattr(sender_mem, "voice_mode", "EVERYONE")
        if mode == "MUTED":
            return False
        if mode == "SELECTED_PLAYERS":
            allowed = getattr(sender_mem, "allowed_recipients", [])
            if target_id not in allowed:
                return False
        return True

    # B. Cross-team communication (Opponents): Requires verified mutual consent
    status = repo.get_voice_permission(room_id, sender_id, target_id)
    if status == "MUTUAL_ACCEPTED":
        return True

    return False


def request_cross_team_voice(room_id: str | Any, sender: Player, target_id: str) -> tuple[dict, str]:
    """Sender requests private voice communication with an opponent."""
    if hasattr(room_id, "id"):
        room_id = room_id.id
    room = repo.get_room(room_id)
    if not room:
        raise ValueError("room_not_found")

    sender_mem = repo.get_membership(room_id, sender.id)
    target_mem = repo.get_membership(room_id, target_id)
    target_player = repo.get_player(target_id)
    if not sender_mem or not target_mem or not target_player:
        raise ValueError("player_not_in_room")

    if sender_mem.team is not None and sender_mem.team == target_mem.team:
        raise ValueError("already_teammate")

    # Record pending request
    repo.set_voice_permission(room_id, sender.id, target_id, "PENDING_REQUEST")
    req_payload = {
        "room_id": room_id,
        "from_player_id": sender.id,
        "from_player_name": sender.display_name,
        "from_team": sender_mem.team,
        "to_player_id": target_id,
    }
    return req_payload, target_player.socket_id or ""


def respond_cross_team_voice(room_id: str | Any, responder: Player, sender_id: str, accept: bool) -> tuple[bool, str]:
    """Target player accepts or declines private voice talk with the requesting opponent."""
    if hasattr(room_id, "id"):
        room_id = room_id.id
    room = repo.get_room(room_id)
    if not room:
        raise ValueError("room_not_found")

    responder_mem = repo.get_membership(room_id, responder.id)
    sender_mem = repo.get_membership(room_id, sender_id)
    sender_player = repo.get_player(sender_id)
    if not responder_mem or not sender_mem or not sender_player:
        raise ValueError("player_not_in_room")

    if accept:
        # Mutual consent established bidirectionally
        repo.set_voice_permission(room_id, sender_id, responder.id, "MUTUAL_ACCEPTED")
        repo.set_voice_permission(room_id, responder.id, sender_id, "MUTUAL_ACCEPTED")
        return True, sender_player.socket_id or ""
    else:
        # Declined: remove any pending request
        repo.delete_voice_permission(room_id, sender_id, responder.id)
        return False, sender_player.socket_id or ""


def revoke_cross_team_voice(room_id: str | Any, player: Player, target_id: str) -> Optional[str]:
    """Either player revokes cross-team voice communication."""
    if hasattr(room_id, "id"):
        room_id = room_id.id
    repo.delete_voice_permission(room_id, player.id, target_id)
    target_player = repo.get_player(target_id)
    return target_player.socket_id if target_player else None


def cleanup_player_voice(room_id: str | Any, player_id: str) -> None:
    """Clean up all voice routing permissions when a player changes team, disconnects, or leaves."""
    if hasattr(room_id, "id"):
        room_id = room_id.id
    repo.cleanup_player_voice_permissions(room_id, player_id)


# ---------------------------------------------------------------------------
# 1:1 Video call signalling (beta)
#
# Video media itself never touches the server: it is carried by the same
# WebRTC peer connection used for voice (and therefore inherits the exact
# same authorization rules). These functions only track call intent so the
# callee can be asked before any camera frames are sent.
# ---------------------------------------------------------------------------

VIDEO_CALL_PENDING_TTL_SECONDS = 45
_pending_video_calls: dict[tuple[str, str, str], datetime] = {}


def _prune_pending_video_calls(now: Optional[datetime] = None) -> None:
    now = now or datetime.utcnow()
    for key, created in list(_pending_video_calls.items()):
        if (now - created).total_seconds() > VIDEO_CALL_PENDING_TTL_SECONDS:
            _pending_video_calls.pop(key, None)


def request_video_call(room_id: str | Any, caller: Player, target_id: str) -> tuple[dict, str]:
    """Record a pending 1:1 video call and return (payload for callee, callee socket)."""
    if hasattr(room_id, "id"):
        room_id = room_id.id

    room = repo.get_room(room_id)
    if not room:
        raise ValueError("room_not_found")
    if not target_id or target_id == caller.id:
        raise ValueError("invalid_target")

    caller_mem = repo.get_membership(room_id, caller.id)
    target_mem = repo.get_membership(room_id, target_id)
    target_player = repo.get_player(target_id)
    if not caller_mem or not target_mem or not target_player:
        raise ValueError("player_not_in_room")

    _prune_pending_video_calls()
    # One outstanding call per direction; a retry simply refreshes the request.
    _pending_video_calls[(room_id, caller.id, target_id)] = datetime.utcnow()

    payload = {
        "room_id": room_id,
        "from_player_id": caller.id,
        "from_player_name": caller.display_name,
        "from_team": caller_mem.team,
        "to_player_id": target_id,
    }
    return payload, target_player.socket_id or ""


def respond_video_call(
    room_id: str | Any, responder: Player, caller_id: str, accept: bool
) -> tuple[bool, str]:
    """Accept/decline a pending call. Accepting a cross-team call also grants the
    mutual media consent that the WebRTC signalling layer requires."""
    if hasattr(room_id, "id"):
        room_id = room_id.id

    _prune_pending_video_calls()
    key = (room_id, caller_id, responder.id)
    if key not in _pending_video_calls:
        raise ValueError("no_pending_call")
    _pending_video_calls.pop(key, None)

    caller_player = repo.get_player(caller_id)
    responder_mem = repo.get_membership(room_id, responder.id)
    caller_mem = repo.get_membership(room_id, caller_id)
    if not caller_player or not responder_mem or not caller_mem:
        raise ValueError("player_not_in_room")

    if accept and responder_mem.team != caller_mem.team:
        repo.set_voice_permission(room_id, caller_id, responder.id, "MUTUAL_ACCEPTED")
        repo.set_voice_permission(room_id, responder.id, caller_id, "MUTUAL_ACCEPTED")

    return bool(accept), caller_player.socket_id or ""


def end_video_call(room_id: str | Any, player: Player, peer_id: str) -> Optional[str]:
    """Clear any pending/active call with peer_id and return the peer's socket."""
    if hasattr(room_id, "id"):
        room_id = room_id.id
    _pending_video_calls.pop((room_id, player.id, peer_id), None)
    _pending_video_calls.pop((room_id, peer_id, player.id), None)
    peer = repo.get_player(peer_id)
    return peer.socket_id if peer else None


def has_pending_video_call(room_id: str | Any, caller_id: str, target_id: str) -> bool:
    if hasattr(room_id, "id"):
        room_id = room_id.id
    _prune_pending_video_calls()
    return (room_id, caller_id, target_id) in _pending_video_calls


def cleanup_player_video_calls(room_id: str | Any, player_id: str) -> list[str]:
    """Drop calls involving player_id; return the peers that must be notified."""
    if hasattr(room_id, "id"):
        room_id = room_id.id
    _prune_pending_video_calls()
    peers: set[str] = set()
    for key in list(_pending_video_calls):
        if key[0] != room_id:
            continue
        if player_id in (key[1], key[2]):
            _pending_video_calls.pop(key, None)
            peers.add(key[1] if key[1] != player_id else key[2])
    return [peer_id for peer_id in peers if peer_id]
