"""
Socket.IO event handlers for HandCricket Live.
All game logic is delegated to the service layer.
"""

from __future__ import annotations

import html
import json
import logging
import threading
import time
import uuid
from datetime import datetime, timedelta

from flask import request
from flask_socketio import emit, join_room, leave_room

logger = logging.getLogger(__name__)

from ..domain.models import ConnectionState, GameMode, ReadinessState, RoomStatus
from ..extensions import socketio
from ..repositories import memory as repo
from ..security.utils import (
    chat_rate_limiter,
    create_rate_limiter,
    feedback_rate_limiter,
    join_rate_limiter,
    register_rate_limiter,
    sanitize_text,
    validate_chat_message,
    validate_display_name,
    video_call_rate_limiter,
    voice_request_rate_limiter,
    voice_signal_rate_limiter,
)
from ..services import room_service
from ..services import accounts_service
from ..services.supabase_logger import get_client_ip, log_ip_event_async, log_feedback_to_supabase_async

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RULES_TEXT = """
**HandCricket Live – Rules v1.0**

1. Each player picks a number from **1 to 10** per delivery.
2. If both picks are **equal** → the batter is **OUT**.
3. If picks are **different** → the batter scores their chosen number.
4. The first ball of each innings has a **30-second** deadline, every other ball **20 seconds**.
5. If either player fails to pick in time, the delivery is a **dead ball**: **0 runs, no wicket**, and the same ball is **re-bowled**.
6. An innings ends when the over limit or wicket limit is reached.
7. The second innings target = first innings runs + 1.
8. Play starts only after every player confirms they are ready for the first ball.
9. A disconnect starts a **120-second** grace period.
10. Every team bats with the **same wicket limit**, however many players it has.
""".strip()


def _err(msg: str, **extra) -> dict:
    return {"success": False, "error": msg, **extra}


def _ok(data: dict | None = None) -> dict:
    return {"success": True, **(data or {})}


def _get_authenticated_player():
    """Extract and verify session token from the connection auth."""
    token = (request.args.get("token") or "").strip()
    if not token:
        return None
    return repo.get_player_by_session(token)


def _resolve_account(data: dict | None):
    """Optional account session passed alongside the guest player token."""
    token = ((data or {}).get("account_token") or "").strip()
    if not token:
        return None
    return accounts_service.resolve_session(token)


def _join_user_room(account: dict | None) -> None:
    """Subscribe this socket to account-scoped events (DMs, play invites)."""
    if account and account.get("id"):
        join_room(f"user:{account['id']}")


def _link_player_account(player, data: dict | None):
    """Attach a registered account to the game identity, if one is signed in."""
    account = _resolve_account(data)
    _join_user_room(account)
    if not player:
        return player
    if account and player.user_id != account["id"]:
        player.user_id = account["id"]
        repo.save_player(player)
    return player


def _broadcast_snapshot(room_id: str, requesting_player_id: str | None = None) -> None:
    """Emit a room:snapshot to every member of the room."""
    members = repo.get_room_members(room_id)
    for m in members:
        player = repo.get_player(m.player_id)
        if player and player.socket_id:
            snapshot = room_service.get_room_snapshot(room_id, m.player_id)
            socketio.emit("room:snapshot", snapshot, to=player.socket_id)
    _ensure_delivery_timer(room_id)


def _ensure_delivery_timer(room_id: str) -> None:
    """Safety net: if the innings is live with a deadline but no timer exists
    (e.g. after a process restart or a lost transition), restore it."""
    if f"delivery:{room_id}" in _delivery_timers:
        return
    room = repo.get_room(room_id)
    if not room or room.status != RoomStatus.INNINGS_ACTIVE:
        return
    match = repo.get_match_by_room(room_id)
    if not match or match.winner or not match.delivery_deadline or not match.active_bowler_id:
        return
    _schedule_delivery_timer(room_id, match.id)


def _emit_delivery_resolution(room_id: str, match, delivery) -> None:
    """
    Single broadcast path for a resolved delivery (whether it came from both
    picks being submitted or from a server timeout) so every room receives the
    same reveal, all-out, innings-break and match-finished sequence.
    """
    _cancel_delivery_timer(room_id)

    socketio.emit("delivery:reveal", delivery.to_reveal_dict(), room=room_id)
    _broadcast_snapshot(room_id)

    room = repo.get_room(room_id)

    if getattr(match, "is_all_out", False):
        all_out_team = getattr(match, "all_out_team", match.batting_team)
        already_announced = (
            getattr(match, "all_out_announced_a", False) if all_out_team == "A"
            else getattr(match, "all_out_announced_b", False)
        )
        if not already_announced:
            if all_out_team == "A":
                match.all_out_announced_a = True
            else:
                match.all_out_announced_b = True
            repo.save_match(match)

            team_name = (
                getattr(match, "team_a_name", "Team A")
                if all_out_team == "A"
                else getattr(match, "team_b_name", "Team B")
            )
            all_out_runs = match.team_a_runs if all_out_team == "A" else match.team_b_runs
            all_out_wkts = match.team_a_wickets if all_out_team == "A" else match.team_b_wickets

            socketio.emit(
                "match:all_out",
                {
                    "team": all_out_team,
                    "team_name": team_name,
                    "runs": all_out_runs,
                    "wickets": all_out_wkts,
                    "phase": match.phase.value if hasattr(match.phase, "value") else str(match.phase),
                },
                room=room_id,
            )
            socketio.emit(
                "chat:message",
                {
                    "id": str(uuid.uuid4()),
                    "sender_id": "system",
                    "sender_name": "FoldCricket Umpire",
                    "text": f"💥 ALL OUT! {team_name} is all out for {all_out_runs} runs ({all_out_wkts} wkts)!",
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                },
                room=room_id,
            )

    if match.winner:
        _cancel_delivery_timer(room_id)
        _cancel_innings_break_timer(room_id)
        socketio.emit(
            "match:finished",
            {"winner": match.winner, "result_summary": match.result_summary},
            room=room_id,
        )
        return

    if (
        getattr(match, "is_super_over", False)
        and match.phase.value == "SUPER_OVER_FIRST"
        and match.current_over == 0
        and match.current_ball == 0
        and match.target is None
    ):
        if match.id not in _super_over_announced_matches:
            _super_over_announced_matches.add(match.id)
            socketio.emit(
                "match:super_over",
                {
                    "message": "MATCH TIED: ENTERING SUPER OVER",
                    "batting_team": match.batting_team,
                    "overs": 1,
                    "wickets": 2,
                },
                room=room_id,
            )
            socketio.emit(
                "chat:message",
                {
                    "id": str(uuid.uuid4()),
                    "sender_id": "system",
                    "sender_name": "FoldCricket Umpire",
                    "text": "⚔️ MATCH TIED: ENTERING SUPER OVER! 1 Over • Max 2 Wickets per side.",
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                },
                room=room_id,
            )

    if room and room.status == RoomStatus.INNINGS_BREAK:
        _cancel_delivery_timer(room_id)
        first_runs = match.team_a_runs if match.batting_team == "B" else match.team_b_runs
        first_name = getattr(match, "team_a_name", "Team A") if match.batting_team == "B" else getattr(match, "team_b_name", "Team B")
        chasing_name = getattr(match, "team_b_name", "Team B") if match.batting_team == "B" else getattr(match, "team_a_name", "Team A")
        break_delay = (
            (match.innings_break_deadline - datetime.utcnow()).total_seconds()
            if match.innings_break_deadline
            else 10.0
        )
        socketio.emit(
            "innings:break",
            {
                "innings": match.phase.value if hasattr(match.phase, "value") else str(match.phase),
                "target": match.target,
                "first_batting_team": getattr(match, "first_batting_team", "A"),
                "first_batting_team_name": first_name,
                "first_innings_runs": first_runs,
                "chasing_team": match.batting_team,
                "chasing_team_name": chasing_name,
                "overs": match.overs,
                "break_seconds": max(1, int(round(break_delay))),
                "break_deadline": (match.innings_break_deadline.isoformat() + "Z") if match.innings_break_deadline else None,
            },
            room=room_id,
        )
        socketio.emit(
            "chat:message",
            {
                "id": str(uuid.uuid4()),
                "sender_id": "system",
                "sender_name": "FoldCricket Umpire",
                "text": f"⏳ FIRST INNINGS OVER! {first_name} scored {first_runs} runs. {chasing_name}'s target: {match.target} runs to win. 2nd innings starts in 10 seconds!",
                "timestamp": datetime.utcnow().isoformat() + "Z",
            },
            room=room_id,
        )
        _schedule_innings_break_timer(room_id, match.id, max(0.1, break_delay))
    elif room and room.status == RoomStatus.INNINGS_ACTIVE and match.active_bowler_id:
        _schedule_delivery_timer(room_id, match.id)


_cleanup_daemon_started = False

def _ensure_cleanup_daemon_running():
    global _cleanup_daemon_started
    if _cleanup_daemon_started:
        return
    _cleanup_daemon_started = True

    def _cleanup_loop():
        while True:
            time.sleep(600)  # Every 10 minutes
            try:
                repo.purge_stale_data(max_age_seconds=3600)
            except Exception as e:
                logger.debug("Background stale data purge error: %s", e)

    t = threading.Thread(target=_cleanup_loop, daemon=True)
    t.start()


# ---------------------------------------------------------------------------
# Connection lifecycle
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect(auth=None):
    _ensure_cleanup_daemon_running()
    headers = {k.lower(): v for k, v in request.headers.items()}
    client_ip = get_client_ip(headers, request.remote_addr)
    log_ip_event_async(ip=client_ip, action="socket_connect", headers=headers)

    token = (auth or {}).get("token") or request.args.get("token", "")
    account_token = (auth or {}).get("account_token") or request.args.get("account_token", "")
    account = accounts_service.resolve_session(account_token) if account_token else None
    # Account rooms must work even before a game identity exists, so a signed-in
    # player who is only browsing social pages still receives DMs and invites.
    _join_user_room(account)
    if not token and not account:
        # Allow connection; player must register/restore before acting
        return

    player = repo.get_player_by_session(token) if token else None
    recovered = False
    if not player and account:
        # The browser may have lost the guest token (login reset, storage
        # purge). A signed-in player still owns the game identity sitting in
        # the live room, so pick it back up instead of starting over.
        player = _recover_account_player(account)
        recovered = player is not None
    if not player:
        # Allow connection; player must register/restore before acting
        return

    _attach_player_to_socket(player)
    if recovered:
        emit(
            "player:restored",
            _ok({
                "player_id": player.id,
                "display_name": player.display_name,
                "session_token": player.session_token,
            }),
        )


def _all_memberships_for_player(player_id: str):
    """Scan all rooms for this player's memberships."""
    return repo.get_memberships_for_player(player_id)


def _attach_player_to_socket(player) -> None:
    """Bind a player to this socket and rejoin every live room it belongs to.

    Every identity entry point (connect, register, restore, room sync) funnels
    through here, so a signed-in client that re-registers on reconnect rejoins
    and resumes exactly like a guest that restores.
    """
    repo.update_player_socket(player.id, request.sid)
    player.connection_state = ConnectionState.CONNECTED
    repo.save_player(player)

    # Rejoin live rooms only. Completed rooms keep the player's membership
    # forever; joining them would replay old match events into whatever page
    # is open and let a stale room unpause itself.
    for mem in _all_memberships_for_player(player.id):
        mem_room = repo.get_room(mem.room_id)
        if not mem_room or mem_room.status == RoomStatus.MATCH_COMPLETE:
            continue
        join_room(mem.room_id)
        _handle_player_reconnected(mem.room_id, player.id)


def _recover_account_player(account, room_id: str | None = None, allow_takeover: bool = False):
    """Find the game identity an account already owns.

    Used when the guest token is missing or unknown. An identity that another
    live socket still owns is left alone unless ``allow_takeover`` is set, so a
    second tab/device cannot silently steal the player the first one is using.
    """
    if not account:
        return None
    player = repo.get_player_for_user(account["id"], room_id=room_id)
    if not player:
        return None
    if (
        not allow_takeover
        and player.connection_state == ConnectionState.CONNECTED
        and player.socket_id
        and player.socket_id != request.sid
    ):
        return None
    return player


def _cancel_delivery_timer(room_id: str) -> None:
    key = f"delivery:{room_id}"
    timer = _delivery_timers.pop(key, None)
    if timer:
        timer.cancel()


def _handle_player_reconnected(room_id: str, player_id: str) -> None:
    """Clear grace timer and unpause match if all players reconnected."""
    key = f"{room_id}:{player_id}"
    timer = _grace_timers.pop(key, None)
    if timer:
        timer.cancel()

    room = repo.get_room(room_id)
    if not room:
        return

    mem = repo.get_membership(room_id, player_id)
    if mem and mem.is_spectator:
        # A returning spectator never resumes, pauses or gates the match; just
        # let the room see them connected again.
        _broadcast_snapshot(room_id)
        return

    if room.status == RoomStatus.PAUSED:
        members = [m for m in repo.get_room_members(room_id) if not m.is_spectator]
        all_connected = bool(members) and all(
            (repo.get_player(m.player_id) and repo.get_player(m.player_id).connection_state == ConnectionState.CONNECTED)
            for m in members
        )
        if all_connected:
            # A room paused while the coin was still in the air has no match to
            # resume; send it back to the toss instead of a live innings.
            in_toss = bool(room.toss) and not room.toss.get("elected_choice")
            room.status = RoomStatus.TOSS if in_toss else RoomStatus.INNINGS_ACTIVE
            repo.save_room(room)
            match = repo.get_match_by_room(room_id)
            if match and match.active_bowler_id and not match.winner and not in_toss:
                match.delivery_deadline = datetime.utcnow() + timedelta(
                    seconds=room_service.get_delivery_timeout_seconds(match)
                )
                repo.save_match(match)
                _schedule_delivery_timer(room_id, match.id)
            socketio.emit("match:resumed", {"paused": False}, room=room_id)
            # The paused snapshot every client holds still says PAUSED and still
            # describes the returning player as disconnected. Without a fresh
            # snapshot the others stay stuck on the pause overlay while the match
            # runs on for the reconnected client.
            _broadcast_snapshot(room_id)
        else:
            # Still waiting on someone else: let the room see this player as
            # connected again without resuming the match.
            _broadcast_snapshot(room_id)
    elif room.status == RoomStatus.AWAITING_FIRST_BALL:
        # If the last missing player reconnects after everyone else already
        # confirmed, and they had also confirmed before dropping, start play.
        player = repo.get_player(player_id)
        mem = repo.get_membership(room_id, player_id)
        if player and mem and mem.readiness == ReadinessState.READY:
            try:
                room, match, activated = room_service.confirm_first_ball_ready(room, player)
            except (ValueError, PermissionError):
                activated = False
                match = None
            if activated and match:
                socketio.emit(
                    "match:first_ball",
                    _ok({"match_id": match.id, "message": "Let's play!"}),
                    room=room_id,
                )
                if match.active_bowler_id:
                    _schedule_delivery_timer(room_id, match.id)
                # Let the room see the gate lift; otherwise the other clients
                # keep rendering the first-ball gate that no longer applies.
                _broadcast_snapshot(room_id)
            else:
                # Back, but still has to confirm readiness: refresh the gate so
                # the others stop seeing them as disconnected.
                _broadcast_snapshot(room_id)


@socketio.on("disconnect")
def on_disconnect():
    player = repo.get_player_by_socket(request.sid)
    if not player:
        return

    player.connection_state = ConnectionState.DISCONNECTED
    repo.update_player_socket(player.id, None)
    repo.save_player(player)

    # Notify rooms, pause active gameplay, and start grace timers
    for mem in _all_memberships_for_player(player.id):
        room = repo.get_room(mem.room_id)
        if not room:
            continue
        # A spectator dropping out is not a reason to pause or forfeit anything.
        if mem.is_spectator:
            room_service.cleanup_player_voice(mem.room_id, player.id)
            _notify_video_call_peers(mem.room_id, player.id)
            _broadcast_snapshot(mem.room_id)
            continue
        # The toss has no running clock: pausing it would turn the room into
        # PAUSED and the reconnect path would then resume it straight into
        # INNINGS_ACTIVE before the match has even started.
        if room and room.status in (RoomStatus.INNINGS_ACTIVE, RoomStatus.PAUSED):
            # Pause room immediately
            room.status = RoomStatus.PAUSED
            repo.save_room(room)

            # Freeze delivery and innings break timers while paused
            _cancel_delivery_timer(mem.room_id)
            _cancel_innings_break_timer(mem.room_id)

            socketio.emit(
                "match:paused",
                {
                    "paused": True,
                    "reason": "player_disconnected",
                    "player_id": player.id,
                    "player_name": player.display_name,
                    "grace_seconds": room_service.RECONNECT_GRACE_SECONDS,
                },
                room=mem.room_id,
            )
            socketio.emit(
                "player:disconnect",
                {"player_id": player.id, "player_name": player.display_name, "grace_seconds": room_service.RECONNECT_GRACE_SECONDS},
                room=mem.room_id,
            )
            _start_grace_timer(player.id, mem.room_id)
            room_service.cleanup_player_voice(mem.room_id, player.id)
            _notify_video_call_peers(mem.room_id, player.id)
            _broadcast_snapshot(mem.room_id)
        elif room and room.status == RoomStatus.AWAITING_FIRST_BALL:
            # No clock is running yet, so there is nothing to pause/forfeit.
            # Invalidate their readiness so they re-confirm after reconnecting.
            mem.readiness = ReadinessState.NOT_READY
            repo.save_membership(mem)
            socketio.emit(
                "player:disconnect",
                {
                    "player_id": player.id,
                    "player_name": player.display_name,
                    "grace_seconds": room_service.RECONNECT_GRACE_SECONDS,
                },
                room=mem.room_id,
            )
            room_service.cleanup_player_voice(mem.room_id, player.id)
            _notify_video_call_peers(mem.room_id, player.id)
            _broadcast_snapshot(mem.room_id)


def _notify_video_call_peers(room_id: str, player_id: str) -> None:
    """A dropped player can no longer honour a pending video call."""
    for peer_id in room_service.cleanup_player_video_calls(room_id, player_id):
        peer = repo.get_player(peer_id)
        if peer and peer.socket_id:
            socketio.emit(
                "video:call_ended",
                {"room_id": room_id, "peer_id": player_id},
                to=peer.socket_id,
            )


_grace_timers: dict[str, threading.Timer] = {}


def _start_grace_timer(player_id: str, room_id: str) -> None:
    key = f"{room_id}:{player_id}"
    existing = _grace_timers.get(key)
    if existing:
        existing.cancel()

    def forfeit():
        _grace_timers.pop(key, None)
        player = repo.get_player(player_id)
        if player and player.connection_state == ConnectionState.DISCONNECTED:
            # Apply forfeit
            room = repo.get_room(room_id)
            if room and room.status in (RoomStatus.INNINGS_ACTIVE, RoomStatus.PAUSED):
                match = repo.get_match_by_room(room_id)
                if match:
                    mem = repo.get_membership(room_id, player_id)
                    if mem and not mem.is_spectator:
                        winning_team = "B" if mem.team == "A" else "A"
                        match.winner = winning_team
                        winning_name = getattr(match, "team_b_name", "Team B") if winning_team == "B" else getattr(match, "team_a_name", "Team A")
                        match.result_summary = f"{winning_name} wins by forfeit (opponent disconnected)"
                        repo.save_match(match)
                        room.status = RoomStatus.MATCH_COMPLETE
                        repo.save_room(room)
                        accounts_service.record_match_stats(room, match)
                        socketio.emit(
                            "match:finished",
                            {"winner": winning_team, "reason": "forfeit", "result_summary": match.result_summary},
                            room=room_id,
                        )

    timer = threading.Timer(room_service.RECONNECT_GRACE_SECONDS, forfeit)
    timer.daemon = True
    timer.start()
    _grace_timers[key] = timer


# ---------------------------------------------------------------------------
# Player registration
# ---------------------------------------------------------------------------

@socketio.on("player:register")
def on_register(data):
    if not register_rate_limiter.allow(request.sid):
        return emit("player:registered", _err("rate_limited"))
    data = data if isinstance(data, dict) else {}
    raw_name = data.get("display_name", "")
    display_name = raw_name.strip() if isinstance(raw_name, str) else ""
    raw_token = data.get("session_token", "")
    if not isinstance(raw_token, str) or len(raw_token) > 128:
        return emit("player:registered", _err("invalid_session_token"))
    session_token = raw_token.strip() or None
    account = _resolve_account(data)
    if not display_name and account:
        display_name = account["display_name"]

    try:
        player, is_new = room_service.create_or_restore_player(
            display_name,
            session_token,
            user_id=account["id"] if account else None,
            current_socket_id=request.sid,
        )
    except ValueError as e:
        return emit("player:registered", _err(str(e)))

    _join_user_room(account)
    _attach_player_to_socket(player)

    headers = {k.lower(): v for k, v in request.headers.items()}
    client_ip = get_client_ip(headers, request.remote_addr)
    log_ip_event_async(
        ip=client_ip,
        action="player_register",
        headers=headers,
        client_metadata={"player_id": player.id, "display_name": player.display_name},
    )

    emit("player:registered", _ok({
        "player_id": player.id,
        "session_token": player.session_token,
        "display_name": player.display_name,
        "is_new": is_new,
    }))


@socketio.on("player:restore")
def on_player_restore(data):
    """Restore an existing session on a fresh socket (page reload / reconnect)."""
    data = data if isinstance(data, dict) else {}
    token = (data.get("session_token") or "").strip()
    player = repo.get_player_by_session(token) if token else None
    if not player:
        # Same recovery as connect: a signed-in player whose guest token was
        # lost still gets the identity that belongs to their live room.
        player = _recover_account_player(_resolve_account(data))
    if not player:
        return emit("player:restored", _err("not_authenticated"))

    _link_player_account(player, data)
    _attach_player_to_socket(player)
    # Snapshots are pushed only for the room a page explicitly syncs. Echoing
    # every historical membership here leaks stale rooms (old tosses/matches)
    # into the page that is currently displayed.

    emit("player:restored", _ok({
        "player_id": player.id,
        "display_name": player.display_name,
        "session_token": player.session_token,
    }))


# ---------------------------------------------------------------------------
# Room: create / join
# ---------------------------------------------------------------------------

@socketio.on("room:create")
def on_room_create(data):
    if not create_rate_limiter.allow(request.sid):
        return emit("room:created", _err("rate_limited"))
    data = data if isinstance(data, dict) else {}

    player = _get_or_register_player(data)
    if not player:
        return emit("room:created", _err("not_authenticated"))

    mode = data.get("mode", "SOLO")
    if not isinstance(mode, str):
        mode = "SOLO"
    try:
        overs = int(data.get("overs", 2))
    except (TypeError, ValueError):
        return emit("room:created", _err("overs_not_allowed"))
    wickets = data.get("wickets")

    try:
        room, membership = room_service.create_room(player, mode, overs, wickets)
    except ValueError as e:
        return emit("room:created", _err(str(e)))

    join_room(room.id)
    emit("room:created", _ok({
        "room_id": room.id,
        "join_code": room.join_code,
        "mode": room.mode.value,
        "rules_text": RULES_TEXT,
    }))
    _broadcast_snapshot(room.id)


@socketio.on("room:join")
def on_room_join(data):
    if not join_rate_limiter.allow(request.sid):
        return emit("room:joined", _err("rate_limited"))
    data = data if isinstance(data, dict) else {}

    player = _get_or_register_player(data)
    if not player:
        return emit("room:joined", _err("not_authenticated"))

    raw_code = data.get("join_code")
    join_code = raw_code.strip().upper() if isinstance(raw_code, str) else ""
    as_spectator = bool(data.get("as_spectator", False))

    try:
        room, membership = room_service.join_room(player, join_code, as_spectator=as_spectator)
    except ValueError as e:
        return emit("room:joined", _err(str(e)))

    join_room(room.id)
    emit("room:joined", _ok({
        "room_id": room.id,
        "join_code": room.join_code,
        "rules_text": RULES_TEXT,
        "is_spectator": membership.is_spectator,
    }))
    _broadcast_snapshot(room.id)


@socketio.on("room:sync")
def on_room_sync(data):
    data = data if isinstance(data, dict) else {}
    raw_token = data.get("session_token")
    token = raw_token.strip() if isinstance(raw_token, str) else ""
    room_id = data.get("room_id", "")
    if not isinstance(room_id, str):
        return emit("room:error", _err("room_not_found"))

    player = repo.get_player_by_session(token) if token else _require_player()
    recovered = False
    if not player:
        # A signed-in client whose guest token is gone still owns whatever
        # identity this account holds in this exact room.
        player = _recover_account_player(
            _resolve_account(data), room_id=room_id, allow_takeover=True
        )
        recovered = player is not None
    if not player:
        return emit("room:error", _err("not_authenticated"))

    room = repo.get_room(room_id)
    if not room:
        return emit("room:error", _err("room_not_found"))

    # Snapshots and live room events are only for members. Without this check
    # any player could subscribe to a room and watch its chat/voice traffic.
    mem = repo.get_membership(room.id, player.id)
    if not mem:
        return emit("room:error", _err("not_in_room"))

    _link_player_account(player, data)
    _attach_player_to_socket(player)
    if recovered:
        # Hand the identity (and its guest token) back to the client so later
        # reconnects restore it without another lookup.
        emit("player:restored", _ok({
            "player_id": player.id,
            "display_name": player.display_name,
            "session_token": player.session_token,
        }))

    snapshot = room_service.get_room_snapshot(room.id, player.id)
    emit("room:snapshot", snapshot)


def _get_or_register_player(data: dict | None):
    """Get player from session token in data."""
    token = ((data or {}).get("session_token") or "").strip()
    if not token:
        return None
    return _link_player_account(repo.get_player_by_session(token), data)


# ---------------------------------------------------------------------------
# Room: team assignment, rules ack, readiness
# ---------------------------------------------------------------------------

@socketio.on("team:assign")
def on_team_assign(data):
    player = _require_player()
    if not player:
        return emit("team:assigned", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    target_id = (data or {}).get("player_id", "")
    team = (data or {}).get("team", "")

    room = repo.get_room(room_id)
    if not room:
        return emit("team:assigned", _err("room_not_found"))

    try:
        room_service.assign_team(room, player, target_id, team)
    except (ValueError, PermissionError) as e:
        return emit("team:assigned", _err(str(e)))

    room_service.cleanup_player_voice(room.id, target_id)
    emit("team:assigned", _ok())
    _broadcast_snapshot(room_id)


@socketio.on("lobby:leave")
def on_lobby_leave(data):
    player = _require_player()
    if not player:
        return emit("lobby:left", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("lobby:left", _ok())

    mem = repo.get_membership(room_id, player.id)
    was_spectator = bool(mem and mem.is_spectator)

    try:
        room = room_service.leave_lobby(room, player)
    except (ValueError, PermissionError) as e:
        return emit("lobby:left", _err(str(e)))

    leave_room(room_id)
    emit("lobby:left", _ok())
    if room:
        socketio.emit(
            "chat:message",
            {
                "id": str(uuid.uuid4()),
                "sender_id": "system",
                "sender_name": "FoldCricket Umpire",
                "text": (
                    f"👋 {player.display_name} stopped watching."
                    if was_spectator
                    else f"👋 {player.display_name} left the lobby."
                ),
                "timestamp": datetime.utcnow().isoformat() + "Z",
            },
            room=room_id,
        )
        _broadcast_snapshot(room_id)


@socketio.on("lobby:remove_player")
def on_lobby_remove_player(data):
    player = _require_player()
    if not player:
        return emit("lobby:remove_ack", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    target_id = (data or {}).get("player_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("lobby:remove_ack", _err("room_not_found"))

    target = repo.get_player(target_id)
    try:
        room = room_service.remove_player_from_lobby(room, player, target_id)
    except (ValueError, PermissionError) as e:
        return emit("lobby:remove_ack", _err(str(e)))

    emit("lobby:remove_ack", _ok())
    if target and target.socket_id:
        try:
            socketio.server.leave_room(target.socket_id, room_id, namespace="/")
        except Exception:
            pass
        socketio.emit(
            "lobby:removed",
            {
                "room_id": room_id,
                "reason": "removed_by_captain",
                "message": "The team captain removed you from the lobby.",
            },
            to=target.socket_id,
        )
    if room:
        socketio.emit(
            "chat:message",
            {
                "id": str(uuid.uuid4()),
                "sender_id": "system",
                "sender_name": "FoldCricket Umpire",
                "text": f"🚪 {target.display_name if target else 'A player'} was removed from the lobby.",
                "timestamp": datetime.utcnow().isoformat() + "Z",
            },
            room=room_id,
        )
        _broadcast_snapshot(room_id)


@socketio.on("rules:ack")
def on_rules_ack(data):
    player = _require_player()
    if not player:
        return

    room_id = (data or {}).get("room_id", "")
    room = repo.get_room(room_id)
    if not room:
        return

    try:
        room_service.ack_rules(room, player)
    except ValueError:
        pass

    _broadcast_snapshot(room_id)


@socketio.on("room:rematch")
def on_room_rematch(data):
    player = _require_player()
    if not player:
        return

    room_id = (data or {}).get("room_id", "")
    room = repo.get_room(room_id)
    if not room:
        return

    try:
        room_service.reset_room_for_rematch(room, player)
    except (ValueError, PermissionError):
        return

    _broadcast_snapshot(room_id)


@socketio.on("match:ready")
def on_ready(data):
    player = _require_player()
    if not player:
        return

    room_id = (data or {}).get("room_id", "")
    ready = bool((data or {}).get("ready", True))
    room = repo.get_room(room_id)
    if not room:
        return

    try:
        room_service.set_ready(room, player, ready)
    except ValueError:
        pass

    _broadcast_snapshot(room_id)


# ---------------------------------------------------------------------------
# Match: toss, start, bowler select, delivery
# ---------------------------------------------------------------------------

@socketio.on("match:start")
def on_match_start(data):
    player = _require_player()
    if not player:
        return emit("match:started", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("match:started", _err("room_not_found"))

    try:
        toss_data = room_service.start_toss(room, player)
    except (ValueError, PermissionError) as e:
        return emit("match:started", _err(str(e)))

    socketio.emit("toss:started", _ok(toss_data), room=room_id)
    _broadcast_snapshot(room_id)


@socketio.on("toss:call")
def on_toss_call(data):
    player = _require_player()
    if not player:
        return emit("toss:result", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    choice = (data or {}).get("choice", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("toss:result", _err("room_not_found"))

    try:
        toss_data = room_service.call_toss(room, player, choice)
    except (ValueError, PermissionError) as e:
        return emit("toss:result", _err(str(e)))

    socketio.emit("toss:flipped", _ok(toss_data), room=room_id)
    _broadcast_snapshot(room_id)


@socketio.on("toss:decide")
def on_toss_decide(data):
    player = _require_player()
    if not player:
        return emit("toss:decided", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    decision = (data or {}).get("decision", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("toss:decided", _err("room_not_found"))

    try:
        match = room_service.decide_toss(room, player, decision)
    except (ValueError, PermissionError) as e:
        return emit("toss:decided", _err(str(e)))

    socketio.emit(
        "toss:decided",
        _ok({
            "decision": decision,
            "batting_team": match.batting_team,
            "toss": room.toss,
        }),
        room=room_id,
    )
    socketio.emit("match:started", _ok({"match_id": match.id}), room=room_id)
    # The clock stays stopped until every connected player confirms readiness
    # for the first ball inside the arena.
    socketio.emit(
        "match:awaiting_first_ball",
        _ok({
            "match_id": match.id,
            "batting_team": match.batting_team,
            "message": "Are you ready for the first ball?",
        }),
        room=room_id,
    )
    _broadcast_snapshot(room_id)


@socketio.on("first_ball:ready")
def on_first_ball_ready(data):
    player = _require_player()
    if not player:
        return emit("first_ball:ack", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("first_ball:ack", _err("room_not_found"))

    try:
        room, match, activated = room_service.confirm_first_ball_ready(room, player)
    except (ValueError, PermissionError) as e:
        return emit("first_ball:ack", _err(str(e)))

    emit("first_ball:ack", _ok({"ready": True, "activated": activated}))
    if activated and match:
        socketio.emit(
            "match:first_ball",
            _ok({"match_id": match.id, "message": "Let's play!"}),
            room=room_id,
        )
        if match.active_bowler_id:
            _schedule_delivery_timer(room_id, match.id)
    _broadcast_snapshot(room_id)


@socketio.on("over:bowler-select")
def on_bowler_select(data):
    player = _require_player()
    if not player:
        return emit("bowler:selected", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    bowler_id = (data or {}).get("bowler_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("bowler:selected", _err("room_not_found"))

    try:
        match = room_service.select_bowler(room, player, bowler_id)
    except (ValueError, PermissionError) as e:
        return emit("bowler:selected", _err(str(e)))

    emit("bowler:selected", _ok(), room=room_id)
    _schedule_delivery_timer(room_id, match.id)
    _broadcast_snapshot(room_id)


@socketio.on("match:select_batter")
def on_select_batter(data):
    player = _require_player()
    if not player:
        return emit("batter:selected", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    batter_id = (data or {}).get("batter_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("batter:selected", _err("room_not_found"))

    try:
        match = room_service.select_batter(room, player, batter_id)
    except (ValueError, PermissionError) as e:
        return emit("batter:selected", _err(str(e)))

    emit("batter:selected", _ok(), room=room_id)
    if match.active_bowler_id:
        _schedule_delivery_timer(room_id, match.id)
    _broadcast_snapshot(room_id)


@socketio.on("delivery:submit")
def on_delivery_submit(data):
    player = _require_player()
    if not player:
        return emit("delivery:ack", _err("not_authenticated"))

    data = data or {}
    room_id = data.get("room_id", "")
    pick = data.get("pick")

    if pick is None:
        return emit("delivery:ack", _err("pick_required"))

    try:
        pick = int(pick)
    except (TypeError, ValueError):
        return emit("delivery:ack", _err("pick_must_be_integer"))

    def _as_int(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    submitted_over = _as_int(data.get("over"))
    submitted_ball = _as_int(data.get("ball"))
    submitted_phase = data.get("phase")
    submitted_phase = str(submitted_phase) if submitted_phase else None

    room = repo.get_room(room_id)
    if not room:
        return emit("delivery:ack", _err("room_not_found"))

    # Every ack echoes the ball it was meant for so the client can drop acks for
    # a ball that has already been resolved by the server.
    live = repo.get_match_by_room(room_id)
    ack_corr = {
        "over": submitted_over if submitted_over is not None else (live.current_over if live else None),
        "ball": submitted_ball if submitted_ball is not None else (live.current_ball if live else None),
        "phase": (
            submitted_phase
            if submitted_phase is not None
            else (live.phase.value if live and hasattr(live.phase, "value") else None)
        ),
    }

    try:
        match, resolved_delivery = room_service.submit_pick(
            room,
            player,
            pick,
            over=submitted_over,
            ball=submitted_ball,
            phase=submitted_phase,
        )
    except (ValueError, PermissionError) as e:
        return emit("delivery:ack", _err(str(e), **ack_corr))

    emit("delivery:ack", _ok({"pick_received": True, **ack_corr}))

    if resolved_delivery:
        _emit_delivery_resolution(room_id, match, resolved_delivery)
    else:
        # Waiting for other player's pick (or an idempotent retry of our own)
        _broadcast_snapshot(room_id)


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

@socketio.on("chat:send")
def on_chat_send(data):
    player = _require_player()
    if not player:
        return

    room_id = (data or {}).get("room_id", "")
    text = (data or {}).get("text", "")

    if not chat_rate_limiter.allow(player.id):
        return emit("chat:error", {"error": "rate_limited"})

    ok, reason = validate_chat_message(text)
    if not ok:
        return emit("chat:error", {"error": reason})

    mem = repo.get_membership(room_id, player.id)
    if not mem:
        return emit("chat:error", {"error": "not_in_room"})

    sanitized_text = html.escape(text.strip())
    socketio.emit(
        "chat:message",
        {
            "player_id": player.id,
            "display_name": player.display_name,
            "text": sanitized_text,
            "timestamp": datetime.utcnow().isoformat(),
        },
        room=room_id,
    )


# ---------------------------------------------------------------------------
# WebRTC signalling & Selective Voice Audience Security
# ---------------------------------------------------------------------------

@socketio.on("voice:mode")
def on_voice_mode(data):
    player = _require_player()
    if not player:
        return emit("voice:mode_ack", _err("not_authenticated"))

    data = data if isinstance(data, dict) else {}
    room_id = data.get("room_id", "")
    mode = data.get("mode", "EVERYONE")
    allowed = data.get("allowed_recipients", [])

    # Current clients send EVERYONE / CUSTOM / TEAM_ONLY; MUTED and
    # SELECTED_PLAYERS are kept for older clients and the stored defaults.
    if mode not in ("EVERYONE", "CUSTOM", "TEAM_ONLY", "MUTED", "SELECTED_PLAYERS"):
        return emit("voice:mode_ack", _err("invalid_voice_mode"))
    if not isinstance(allowed, list):
        allowed = []

    mem = repo.get_membership(room_id, player.id)
    if not mem:
        return emit("voice:mode_ack", _err("not_in_room"))

    # A recipient list can only name current members of this room.
    member_ids = {m.player_id for m in repo.get_room_members(room_id)}
    allowed = [
        pid
        for pid in dict.fromkeys(allowed)
        if isinstance(pid, str) and pid in member_ids and pid != player.id
    ][:64]

    mem.voice_mode = mode
    mem.allowed_recipients = allowed
    repo.save_membership(mem)
    emit("voice:mode_ack", _ok({"mode": mode, "allowed_recipients": allowed}))
    _broadcast_snapshot(room_id)


@socketio.on("voice:signal")
def on_voice_signal(data):
    player = _require_player()
    if not player:
        return

    data = data if isinstance(data, dict) else {}
    room_id = data.get("room_id", "")
    target_id = data.get("target_player_id") or data.get("target_id")
    if not room_id or not target_id or not isinstance(target_id, str):
        return

    if not voice_signal_rate_limiter.allow(player.id):
        emit("voice:error", _err("rate_limited"))
        return

    signal = data.get("signal")
    if not isinstance(signal, (dict, str)):
        emit("voice:error", _err("invalid_signal"))
        return
    try:
        signal_size = len(json.dumps(signal))
    except (TypeError, ValueError):
        emit("voice:error", _err("invalid_signal"))
        return
    # SDP offers/answers are a few KB; anything larger is not a real signal.
    if signal_size > 65536:
        emit("voice:error", _err("signal_too_large"))
        return

    # Authoritative server-side routing & permission enforcement
    if not room_service.is_voice_signal_authorized(room_id, player.id, target_id):
        emit("voice:error", _err("unauthorized_voice_route"))
        return

    target_player = repo.get_player(target_id)
    if target_player and target_player.socket_id:
        socketio.emit(
            "voice:signal",
            {
                "from_player_id": player.id,
                "signal": signal,
                "timestamp": int(datetime.utcnow().timestamp() * 1000),
            },
            to=target_player.socket_id,
        )


@socketio.on("voice:cross_team_request")
def on_voice_cross_team_request(data):
    player = _require_player()
    if not player:
        return emit("voice:cross_team_ack", _err("not_authenticated"))
    if not voice_request_rate_limiter.allow(player.id):
        return emit("voice:cross_team_ack", _err("rate_limited"))

    room_id = (data or {}).get("room_id", "")
    target_id = (data or {}).get("target_id", "")
    try:
        req_payload, target_socket = room_service.request_cross_team_voice(room_id, player, target_id)
    except (ValueError, PermissionError) as e:
        return emit("voice:cross_team_ack", _err(str(e)))

    if target_socket:
        socketio.emit("voice:cross_team_requested", req_payload, to=target_socket)
    emit("voice:cross_team_ack", _ok({"status": "pending", "target_id": target_id}))
    _broadcast_snapshot(room_id)


@socketio.on("voice:cross_team_response")
def on_voice_cross_team_response(data):
    player = _require_player()
    if not player:
        return emit("voice:cross_team_response_ack", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    sender_id = (data or {}).get("sender_id", "")
    accept = bool((data or {}).get("accept", False))

    try:
        accepted, sender_socket = room_service.respond_cross_team_voice(room_id, player, sender_id, accept)
    except (ValueError, PermissionError) as e:
        return emit("voice:cross_team_response_ack", _err(str(e)))

    if accepted:
        # Notify sender that request was accepted
        if sender_socket:
            socketio.emit(
                "voice:cross_team_approved",
                {
                    "room_id": room_id,
                    "peer_id": player.id,
                    "peer_name": player.display_name,
                },
                to=sender_socket,
            )
        # Notify responder of approval as well
        sender_p = repo.get_player(sender_id)
        emit(
            "voice:cross_team_approved",
            {
                "room_id": room_id,
                "peer_id": sender_id,
                "peer_name": sender_p.display_name if sender_p else "Opponent",
            },
        )
    else:
        if sender_socket:
            socketio.emit(
                "voice:cross_team_declined",
                {
                    "room_id": room_id,
                    "peer_id": player.id,
                    "peer_name": player.display_name,
                },
                to=sender_socket,
            )

    emit("voice:cross_team_response_ack", _ok({"accepted": accept}))
    _broadcast_snapshot(room_id)


@socketio.on("voice:cross_team_revoke")
def on_voice_cross_team_revoke(data):
    player = _require_player()
    if not player:
        return emit("voice:cross_team_revoke_ack", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    target_id = (data or {}).get("target_id", "")
    target_socket = room_service.revoke_cross_team_voice(room_id, player, target_id)
    if target_socket:
        socketio.emit(
            "voice:cross_team_revoked",
            {"room_id": room_id, "peer_id": player.id},
            to=target_socket,
        )
    emit("voice:cross_team_revoked", {"room_id": room_id, "peer_id": target_id})
    emit("voice:cross_team_revoke_ack", _ok({"target_id": target_id}))
    _broadcast_snapshot(room_id)


# ---------------------------------------------------------------------------
# 1:1 Video call signalling (beta)
# ---------------------------------------------------------------------------

@socketio.on("video:call_request")
def on_video_call_request(data):
    player = _require_player()
    if not player:
        return emit("video:call_ack", _err("not_authenticated"))
    if not video_call_rate_limiter.allow(player.id):
        return emit("video:call_ack", _err("rate_limited"))

    room_id = (data or {}).get("room_id", "")
    target_id = (data or {}).get("target_id", "")
    try:
        payload, target_socket = room_service.request_video_call(room_id, player, target_id)
    except (ValueError, PermissionError) as e:
        return emit("video:call_ack", _err(str(e)))

    if target_socket:
        socketio.emit("video:call_incoming", payload, to=target_socket)
    emit("video:call_ack", _ok({"target_id": target_id}))


@socketio.on("video:call_response")
def on_video_call_response(data):
    player = _require_player()
    if not player:
        return emit("video:call_response_ack", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    caller_id = (data or {}).get("caller_id", "")
    accept = bool((data or {}).get("accept", False))

    try:
        accepted, caller_socket = room_service.respond_video_call(
            room_id, player, caller_id, accept
        )
    except (ValueError, PermissionError) as e:
        return emit("video:call_response_ack", _err(str(e)))

    event = "video:call_accepted" if accepted else "video:call_declined"
    caller_payload = {
        "room_id": room_id,
        "peer_id": player.id,
        "peer_name": player.display_name,
    }
    if caller_socket:
        socketio.emit(event, caller_payload, to=caller_socket)

    caller_p = repo.get_player(caller_id)
    emit(
        event,
        {
            "room_id": room_id,
            "peer_id": caller_id,
            "peer_name": caller_p.display_name if caller_p else "Opponent",
        },
    )
    emit("video:call_response_ack", _ok({"accepted": accepted}))
    if accepted:
        # Cross-team accepts create media consent, which snapshot consumers use
        # to re-negotiate the WebRTC transport without a page reload.
        _broadcast_snapshot(room_id)


@socketio.on("video:call_end")
def on_video_call_end(data):
    player = _require_player()
    if not player:
        return

    room_id = (data or {}).get("room_id", "")
    peer_id = (data or {}).get("peer_id", "")
    peer_socket = room_service.end_video_call(room_id, player, peer_id)
    if peer_socket:
        socketio.emit(
            "video:call_ended",
            {"room_id": room_id, "peer_id": player.id},
            to=peer_socket,
        )
    emit("video:call_ended", {"room_id": room_id, "peer_id": peer_id})


# ---------------------------------------------------------------------------
# Match settings (before start)
# ---------------------------------------------------------------------------

@socketio.on("match:settings")
def on_match_settings(data):
    player = _require_player()
    if not player:
        return emit("settings:updated", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("settings:updated", _err("room_not_found"))

    mem = repo.get_membership(room_id, player.id)
    if not mem or not mem.is_host:
        return emit("settings:updated", _err("not_host"))

    if room.status not in ("LOBBY_READY", "WAITING_FOR_PLAYERS", "RULEBOOK_REQUIRED"):
        return emit("settings:updated", _err("match_already_started"))

    overs = data.get("overs") if isinstance(data, dict) else None
    if overs is not None:
        try:
            overs_int = int(overs)
        except (TypeError, ValueError):
            return emit("settings:updated", _err("overs_must_be_between_1_and_10"))
        if not (1 <= overs_int <= 10):
            return emit("settings:updated", _err("overs_must_be_between_1_and_10"))
        room.overs = overs_int

    wickets = data.get("wickets") if isinstance(data, dict) else None
    if wickets is not None:
        max_wickets = 5 if room.mode == GameMode.SOLO else 10
        try:
            w_int = int(wickets)
        except (TypeError, ValueError):
            return emit("settings:updated", _err(f"wickets_must_be_between_1_and_{max_wickets}"))
        if not (1 <= w_int <= max_wickets):
            return emit("settings:updated", _err(f"wickets_must_be_between_1_and_{max_wickets}"))
        room.wickets = w_int

    team_a_name = (data or {}).get("team_a_name")
    if team_a_name and isinstance(team_a_name, str):
        room.team_a_name = team_a_name.strip()[:24] or "Team A"

    team_b_name = (data or {}).get("team_b_name")
    if team_b_name and isinstance(team_b_name, str):
        room.team_b_name = team_b_name.strip()[:24] or "Team B"

    repo.save_room(room)
    emit("settings:updated", _ok())
    _broadcast_snapshot(room_id)


@socketio.on("room:update_teams")
def on_room_update_teams(data):
    player = _require_player()
    if not player:
        return emit("room:teams_updated", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("room:teams_updated", _err("room_not_found"))

    mem = repo.get_membership(room_id, player.id)
    if not mem:
        return emit("room:teams_updated", _err("not_in_room"))

    team_a_name = (data or {}).get("team_a_name")
    if team_a_name and isinstance(team_a_name, str):
        room.team_a_name = team_a_name.strip()[:24] or "Team A"

    team_b_name = (data or {}).get("team_b_name")
    if team_b_name and isinstance(team_b_name, str):
        room.team_b_name = team_b_name.strip()[:24] or "Team B"

    repo.save_room(room)
    _broadcast_snapshot(room_id)
    emit("room:teams_updated", _ok())


@socketio.on("voice:state")
def on_voice_state(data):
    player = _require_player()
    if not player:
        return
    data = data if isinstance(data, dict) else {}
    room_id = data.get("room_id", "")
    mem = repo.get_membership(room_id, player.id)
    if not mem:
        return
    is_speaking = bool(data.get("is_speaking", False))
    is_muted = bool(data.get("is_muted", True))
    socketio.emit(
        "voice:state_changed",
        {
            "player_id": player.id,
            "player_name": player.display_name,
            "is_speaking": is_speaking,
            "is_muted": is_muted,
        },
        room=room_id,
    )


@socketio.on("ping_check")
def on_ping_check(data):
    emit("pong_ack", data)


# ---------------------------------------------------------------------------
_super_over_announced_matches: set[str] = set()
# ---------------------------------------------------------------------------

_delivery_timers: dict[str, threading.Timer] = {}
_innings_break_timers: dict[str, threading.Timer] = {}


def _cancel_delivery_timer(room_id: str) -> None:
    timer = _delivery_timers.pop(f"delivery:{room_id}", None)
    if timer:
        timer.cancel()


def _cancel_innings_break_timer(room_id: str) -> None:
    timer = _innings_break_timers.pop(f"innings_break:{room_id}", None)
    if timer:
        timer.cancel()


def _schedule_innings_break_timer(room_id: str, match_id: str, delay_seconds: float = 10.0) -> None:
    key = f"innings_break:{room_id}"
    _cancel_innings_break_timer(room_id)

    def break_timeout():
        _innings_break_timers.pop(key, None)
        try:
            room, match = room_service.start_second_innings(room_id)
            if room.status == RoomStatus.INNINGS_ACTIVE:
                socketio.emit(
                    "match:innings_started",
                    {
                        "phase": match.phase.value if hasattr(match.phase, "value") else str(match.phase),
                        "batting_team": match.batting_team,
                        "target": match.target,
                    },
                    room=room_id,
                )
                _broadcast_snapshot(room_id)
                if match.active_bowler_id:
                    _schedule_delivery_timer(room_id, match.id)
        except Exception as e:
            logger.exception("Error transitioning after innings break: %s", e)

    timer = threading.Timer(max(0.1, delay_seconds), break_timeout)
    timer.daemon = True
    timer.start()
    _innings_break_timers[key] = timer


def _schedule_delivery_timer(room_id: str, match_id: str) -> None:
    key = f"delivery:{room_id}"
    existing = _delivery_timers.get(key)
    if existing:
        existing.cancel()

    def timeout_check():
        _delivery_timers.pop(key, None)
        result = room_service.resolve_timeout(room_id)
        if result:
            match, delivery = result
            _emit_delivery_resolution(room_id, match, delivery)
        else:
            # A stale/false alarm: keep the clock alive rather than stalling.
            current_room = repo.get_room(room_id)
            current_match = repo.get_match_by_room(room_id)
            if (
                current_room
                and current_room.status == RoomStatus.INNINGS_ACTIVE
                and current_match
                and not current_match.winner
                and current_match.delivery_deadline
            ):
                _schedule_delivery_timer(room_id, current_match.id)

    from ..services.room_service import DELIVERY_TIMEOUT_SECONDS, get_delivery_timeout_seconds
    match = repo.get_match_by_room(room_id)
    if match and match.delivery_deadline:
        remaining = (match.delivery_deadline - datetime.utcnow()).total_seconds()
        delay = max(1.0, remaining + 0.5)
    elif match:
        delay = float(get_delivery_timeout_seconds(match) + 1)
    else:
        delay = float(DELIVERY_TIMEOUT_SECONDS + 1)

    timer = threading.Timer(delay, timeout_check)
    timer.daemon = True
    timer.start()
    _delivery_timers[key] = timer


# ---------------------------------------------------------------------------
# Manual Pause / Resume
# ---------------------------------------------------------------------------

@socketio.on("match:pause")
def on_match_pause(data):
    player = _require_player()
    if not player:
        return emit("match:pause_ack", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("match:pause_ack", _err("room_not_found"))

    if room.status not in (RoomStatus.INNINGS_ACTIVE, RoomStatus.TOSS):
        return emit("match:pause_ack", _err("cannot_pause_current_state"))

    mem = repo.get_membership(room_id, player.id)
    if not mem or mem.is_spectator:
        return emit("match:pause_ack", _err("only_players_can_pause"))

    room.status = RoomStatus.PAUSED
    repo.save_room(room)
    _cancel_delivery_timer(room_id)
    _cancel_innings_break_timer(room_id)

    socketio.emit(
        "match:paused",
        {
            "paused": True,
            "reason": "manual_pause",
            "player_id": player.id,
            "player_name": player.display_name,
        },
        room=room_id,
    )
    _broadcast_snapshot(room_id)
    emit("match:pause_ack", _ok())


@socketio.on("match:resume")
def on_match_resume(data):
    player = _require_player()
    if not player:
        return emit("match:resume_ack", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    room = repo.get_room(room_id)
    if not room:
        return emit("match:resume_ack", _err("room_not_found"))

    if room.status != RoomStatus.PAUSED:
        return emit("match:resume_ack", _err("match_not_paused"))

    mem = repo.get_membership(room_id, player.id)
    if not mem:
        return emit("match:resume_ack", _err("not_in_room"))
    if mem.is_spectator:
        return emit("match:resume_ack", _err("only_players_can_resume"))

    # A pause caused by a disconnect must wait for that player: resuming early
    # would run their deliveries on a timeout while they are still offline.
    # Spectators are never a reason for the match to be paused.
    members = [m for m in repo.get_room_members(room_id) if not m.is_spectator]
    for m in members:
        member_player = repo.get_player(m.player_id)
        if not member_player or member_player.connection_state != ConnectionState.CONNECTED:
            return emit("match:resume_ack", _err("players_disconnected"))

    room.status = RoomStatus.INNINGS_ACTIVE
    repo.save_room(room)

    match = repo.get_match_by_room(room_id)
    if match and match.active_bowler_id and not match.winner:
        match.delivery_deadline = datetime.utcnow() + timedelta(seconds=room_service.get_delivery_timeout_seconds(match))
        repo.save_match(match)
        _schedule_delivery_timer(room_id, match.id)

    socketio.emit("match:resumed", {"paused": False}, room=room_id)
    _broadcast_snapshot(room_id)
    emit("match:resume_ack", _ok())


@socketio.on("feedback:submit")
def on_feedback_submit(data):
    player = _require_player()
    data = data if isinstance(data, dict) else {}
    player_id = player.id if player else (sanitize_text(data.get("player_id"), 64) or "unknown")
    player_name = sanitize_text(
        player.display_name if player else data.get("player_name"), 48
    ) or "Anonymous Player"

    if not feedback_rate_limiter.allow(player.id if player else f"sid:{request.sid}"):
        return emit("feedback:ack", _err("rate_limited"))

    raw_rating = data.get("rating", 5)
    try:
        rating = int(raw_rating)
    except (TypeError, ValueError):
        rating = 5
    rating = max(1, min(5, rating))

    raw_categories = data.get("categories", [])
    categories = (
        [sanitize_text(c, 32) for c in raw_categories if isinstance(c, str)][:10]
        if isinstance(raw_categories, list)
        else []
    )
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}

    headers = {k.lower(): v for k, v in request.headers.items()}
    client_ip = get_client_ip(headers, request.remote_addr)

    log_feedback_to_supabase_async(
        player_id=player_id,
        player_name=player_name,
        rating=rating,
        feedback_text=sanitize_text(data.get("feedback_text", ""), 2000),
        categories=categories,
        room_code=sanitize_text(data.get("room_code"), 16) or None,
        client_ip=client_ip,
        headers=headers,
        metadata=metadata,
    )
    emit("feedback:ack", _ok({"message": "feedback_saved"}))


# ---------------------------------------------------------------------------
# Helper: require authenticated player via socket session
# ---------------------------------------------------------------------------

def _require_player():
    """Try to find player by current socket ID."""
    return repo.get_player_by_socket(request.sid)
