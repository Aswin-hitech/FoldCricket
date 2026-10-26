"""
Socket.IO event handlers for HandCricket Live.
All game logic is delegated to the service layer.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta

from flask import request
from flask_socketio import emit, join_room, leave_room

from ..domain.models import ConnectionState, RoomStatus
from ..extensions import socketio
from ..repositories import memory as repo
from ..security.utils import (
    chat_rate_limiter,
    create_rate_limiter,
    join_rate_limiter,
    validate_chat_message,
    validate_display_name,
)
from ..services import room_service
from ..services.supabase_logger import get_client_ip, log_ip_event_async

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RULES_TEXT = """
**HandCricket Live – Rules v1.0**

1. Each player picks a number from **1 to 10** per delivery.
2. If both picks are **equal** → the batter is **OUT**.
3. If picks are **different** → the batter scores their chosen number.
4. Each delivery has a **15-second** server-enforced deadline.
5. An innings ends when the over limit or wicket limit is reached.
6. The second innings target = first innings runs + 1.
7. A disconnect starts a **120-second** grace period.
8. The smaller team receives **one extra wicket** allowance.
""".strip()


def _err(msg: str) -> dict:
    return {"success": False, "error": msg}


def _ok(data: dict | None = None) -> dict:
    return {"success": True, **(data or {})}


def _get_authenticated_player():
    """Extract and verify session token from the connection auth."""
    token = (request.args.get("token") or "").strip()
    if not token:
        return None
    return repo.get_player_by_session(token)


def _broadcast_snapshot(room_id: str, requesting_player_id: str | None = None) -> None:
    """Emit a room:snapshot to every member of the room."""
    members = repo.get_room_members(room_id)
    for m in members:
        player = repo.get_player(m.player_id)
        if player and player.socket_id:
            snapshot = room_service.get_room_snapshot(room_id, m.player_id)
            socketio.emit("room:snapshot", snapshot, to=player.socket_id)


# ---------------------------------------------------------------------------
# Connection lifecycle
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect(auth=None):
    headers = {k.lower(): v for k, v in request.headers.items()}
    client_ip = get_client_ip(headers, request.remote_addr)
    log_ip_event_async(ip=client_ip, action="socket_connect", headers=headers)

    token = (auth or {}).get("token") or request.args.get("token", "")
    if not token:
        # Allow connection; player must register/restore before acting
        return

    player = repo.get_player_by_session(token)
    if player:
        repo.update_player_socket(player.id, request.sid)
        player.connection_state = ConnectionState.CONNECTED
        repo.save_player(player)

        # Rejoin any active rooms
        memberships = [
            m for m in _all_memberships_for_player(player.id)
        ]
        for mem in memberships:
            join_room(mem.room_id)
            _broadcast_snapshot(mem.room_id)


def _all_memberships_for_player(player_id: str):
    """Scan all rooms for this player's memberships (V1 linear scan)."""
    from ..repositories.memory import _memberships
    for room_id, members in _memberships.items():
        for m in members:
            if m.player_id == player_id:
                yield m


@socketio.on("disconnect")
def on_disconnect():
    player = repo.get_player_by_socket(request.sid)
    if not player:
        return

    player.connection_state = ConnectionState.DISCONNECTED
    repo.update_player_socket(player.id, None)
    repo.save_player(player)

    # Notify rooms and start grace timers
    for mem in _all_memberships_for_player(player.id):
        room = repo.get_room(mem.room_id)
        if room and room.status == RoomStatus.INNINGS_ACTIVE:
            socketio.emit(
                "player:disconnect",
                {"player_id": player.id, "grace_seconds": room_service.RECONNECT_GRACE_SECONDS},
                room=mem.room_id,
            )
            _start_grace_timer(player.id, mem.room_id)


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
            if room and room.status == RoomStatus.INNINGS_ACTIVE:
                match = repo.get_match_by_room(room_id)
                if match:
                    mem = repo.get_membership(room_id, player_id)
                    if mem:
                        winning_team = "B" if mem.team == "A" else "A"
                        match.winner = winning_team
                        match.result_summary = f"Team {winning_team} wins by forfeit (opponent disconnected)"
                        repo.save_match(match)
                        room.status = RoomStatus.MATCH_COMPLETE
                        repo.save_room(room)
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
    display_name = (data or {}).get("display_name", "").strip()
    session_token = (data or {}).get("session_token", "").strip() or None

    try:
        player, is_new = room_service.create_or_restore_player(display_name, session_token)
    except ValueError as e:
        return emit("player:registered", _err(str(e)))

    repo.update_player_socket(player.id, request.sid)
    player.connection_state = ConnectionState.CONNECTED
    repo.save_player(player)

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


# ---------------------------------------------------------------------------
# Room: create / join
# ---------------------------------------------------------------------------

@socketio.on("room:create")
def on_room_create(data):
    if not create_rate_limiter.allow(request.sid):
        return emit("room:created", _err("rate_limited"))

    player = _get_or_register_player(data)
    if not player:
        return emit("room:created", _err("not_authenticated"))

    mode = (data or {}).get("mode", "SOLO")
    overs = int((data or {}).get("overs", 2))

    try:
        room, membership = room_service.create_room(player, mode, overs)
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

    player = _get_or_register_player(data)
    if not player:
        return emit("room:joined", _err("not_authenticated"))

    join_code = ((data or {}).get("join_code") or "").strip().upper()

    try:
        room, membership = room_service.join_room(player, join_code)
    except ValueError as e:
        return emit("room:joined", _err(str(e)))

    join_room(room.id)
    emit("room:joined", _ok({
        "room_id": room.id,
        "join_code": room.join_code,
        "rules_text": RULES_TEXT,
    }))
    _broadcast_snapshot(room.id)


@socketio.on("room:sync")
def on_room_sync(data):
    token = ((data or {}).get("session_token") or "").strip()
    room_id = (data or {}).get("room_id", "")

    player = repo.get_player_by_session(token) if token else _require_player()
    if not player:
        return emit("room:error", _err("not_authenticated"))

    repo.update_player_socket(player.id, request.sid)
    player.connection_state = ConnectionState.CONNECTED
    repo.save_player(player)

    room = repo.get_room(room_id)
    if room:
        join_room(room.id)
        snapshot = room_service.get_room_snapshot(room.id, player.id)
        emit("room:snapshot", snapshot)


def _get_or_register_player(data: dict | None):
    """Get player from session token in data."""
    token = ((data or {}).get("session_token") or "").strip()
    if not token:
        return None
    return repo.get_player_by_session(token)


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

    emit("team:assigned", _ok())
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


@socketio.on("delivery:submit")
def on_delivery_submit(data):
    player = _require_player()
    if not player:
        return emit("delivery:ack", _err("not_authenticated"))

    room_id = (data or {}).get("room_id", "")
    pick = (data or {}).get("pick")

    if pick is None:
        return emit("delivery:ack", _err("pick_required"))

    try:
        pick = int(pick)
    except (TypeError, ValueError):
        return emit("delivery:ack", _err("pick_must_be_integer"))

    room = repo.get_room(room_id)
    if not room:
        return emit("delivery:ack", _err("room_not_found"))

    try:
        match, resolved_delivery = room_service.submit_pick(room, player, pick)
    except (ValueError, PermissionError) as e:
        return emit("delivery:ack", _err(str(e)))

    emit("delivery:ack", _ok({"pick_received": True}))

    if resolved_delivery:
        # Broadcast result
        socketio.emit(
            "delivery:reveal",
            resolved_delivery.to_reveal_dict(),
            room=room_id,
        )
        _broadcast_snapshot(room_id)

        if match.winner:
            socketio.emit(
                "match:finished",
                {"winner": match.winner, "result_summary": match.result_summary},
                room=room_id,
            )
    else:
        # Waiting for other player's pick
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

    socketio.emit(
        "chat:message",
        {
            "player_id": player.id,
            "display_name": player.display_name,
            "text": text.strip(),
            "timestamp": datetime.utcnow().isoformat(),
        },
        room=room_id,
    )


# ---------------------------------------------------------------------------
# WebRTC signalling (relayed only – no audio transported over Socket.IO)
# ---------------------------------------------------------------------------

@socketio.on("voice:signal")
def on_voice_signal(data):
    player = _require_player()
    if not player:
        return

    room_id = (data or {}).get("room_id", "")
    mem = repo.get_membership(room_id, player.id)
    if not mem:
        return  # silently ignore unauthorised

    target_id = (data or {}).get("target_player_id")
    if not target_id:
        return

    # Verify target is in the same room
    target_mem = repo.get_membership(room_id, target_id)
    if not target_mem:
        return

    target_player = repo.get_player(target_id)
    if target_player and target_player.socket_id:
        socketio.emit(
            "voice:signal",
            {
                "from_player_id": player.id,
                "signal": data.get("signal"),
            },
            to=target_player.socket_id,
        )


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

    overs = (data or {}).get("overs")
    if overs is not None:
        overs_int = int(overs)
        if not (1 <= overs_int <= 10):
            return emit("settings:updated", _err("overs_must_be_between_1_and_10"))
        room.overs = overs_int

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
    room_id = (data or {}).get("room_id", "")
    is_speaking = bool((data or {}).get("is_speaking", False))
    is_muted = bool((data or {}).get("is_muted", True))
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
# Delivery timer (server-side)
# ---------------------------------------------------------------------------

_delivery_timers: dict[str, threading.Timer] = {}


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
            socketio.emit("delivery:reveal", delivery.to_reveal_dict(), room=room_id)
            _broadcast_snapshot(room_id)
            if match.winner:
                socketio.emit(
                    "match:finished",
                    {"winner": match.winner, "result_summary": match.result_summary},
                    room=room_id,
                )

    from ..services.room_service import DELIVERY_TIMEOUT_SECONDS
    timer = threading.Timer(DELIVERY_TIMEOUT_SECONDS + 1, timeout_check)
    timer.daemon = True
    timer.start()
    _delivery_timers[key] = timer


# ---------------------------------------------------------------------------
# Helper: require authenticated player via socket session
# ---------------------------------------------------------------------------

def _require_player():
    """Try to find player by current socket ID."""
    return repo.get_player_by_socket(request.sid)
