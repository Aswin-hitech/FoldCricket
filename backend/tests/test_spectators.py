"""
Spectator membership tests.

A spectator joins with ``team=None``: they can watch and chat at any stage of a
match, but they must never gate or alter gameplay — readiness, rules
acknowledgement, toss caller selection, first-ball quorum, pause, rematch or
stats.
"""

from __future__ import annotations

import time

import pytest

from app import create_app, socketio
from app.domain.models import PlayerRole, RoomStatus
from app.repositories import memory as repo
from app.services import room_service
from app.sockets import events

_TIMER_DICTS = (events._delivery_timers, events._innings_break_timers, events._grace_timers)


def _clear():
    for timers in _TIMER_DICTS:
        for timer in list(timers.values()):
            try:
                timer.cancel()
            except Exception:
                pass
        timers.clear()
    repo.clear_all()


@pytest.fixture(autouse=True)
def clean_environment():
    _clear()
    yield
    _clear()


# ---------------------------------------------------------------------------
# Service-level helpers
# ---------------------------------------------------------------------------

def _make_lobby(count=2):
    players = []
    room = None
    for i in range(count):
        p, _ = room_service.create_or_restore_player(f"Player{i + 1}", None)
        players.append(p)
        if room is None:
            room, _ = room_service.create_room(p, "SOLO", 2, wickets=2)
        else:
            room_service.join_room(p, room.join_code)
    return repo.get_room(room.id), players


def _advance_to_first_ball(room, players):
    room_service.ack_rules(room, players[0])
    room_service.ack_rules(room, players[1])
    room_service.set_ready(room, players[0], True)
    room_service.set_ready(room, players[1], True)
    room_service.start_toss(room, players[0])
    room = repo.get_room(room.id)
    caller = next(p for p in players if p.id == room.toss["caller_id"])
    room_service.call_toss(room, caller, "HEADS")
    room = repo.get_room(room.id)
    winner = next(p for p in players if p.id == room.toss["winner_id"])
    match = room_service.decide_toss(room, winner, "BAT")
    return repo.get_room(room.id), match


def _start_live_match():
    room, players = _make_lobby(2)
    room, match = _advance_to_first_ball(room, players)
    for m in repo.get_room_members(room.id):
        room, match, _ = room_service.confirm_first_ball_ready(
            room, repo.get_player(m.player_id)
        )
    assert room.status == RoomStatus.INNINGS_ACTIVE
    return room, match, players


def _new_spectator(name="Spectator"):
    player, _ = room_service.create_or_restore_player(name, None)
    return player


# ---------------------------------------------------------------------------
# Joining / membership
# ---------------------------------------------------------------------------

def test_spectator_join_is_marked_teamless_and_does_not_ready_the_lobby():
    room, players = _make_lobby(1)
    assert room.status == RoomStatus.WAITING_FOR_PLAYERS

    spectator = _new_spectator()
    room, membership = room_service.join_room(spectator, room.join_code, as_spectator=True)

    assert membership.is_spectator is True
    assert membership.team is None
    assert membership.role == PlayerRole.SPECTATOR
    # One real player plus a watcher is still not a playable room.
    assert repo.get_room(room.id).status == RoomStatus.WAITING_FOR_PLAYERS

    with pytest.raises(ValueError):
        room_service.set_ready(repo.get_room(room.id), spectator, True)


def test_second_real_player_still_promotes_the_lobby_with_a_spectator_present():
    room, players = _make_lobby(1)
    room_service.join_room(_new_spectator(), room.join_code, as_spectator=True)

    newcomer = _new_spectator("Player2")
    room, _ = room_service.join_room(newcomer, room.join_code)

    assert repo.get_room(room.id).status == RoomStatus.LOBBY_READY


def test_snapshot_exposes_the_spectator_flag():
    room, players = _make_lobby(2)
    spectator = _new_spectator()
    room_service.join_room(spectator, room.join_code, as_spectator=True)

    snapshot = room_service.get_room_snapshot(room.id, spectator.id)
    member = next(m for m in snapshot["members"] if m["player"]["id"] == spectator.id)

    assert member["is_spectator"] is True
    assert member["team"] is None


def test_spectator_joining_mid_match_does_not_disrupt_it():
    room, match, players = _start_live_match()
    version_before = match.version

    spectator = _new_spectator()
    room, membership = room_service.join_room(spectator, room.join_code, as_spectator=True)
    current_room = repo.get_room(room.id)
    current_match = repo.get_match_by_room(room.id)

    assert membership.is_spectator is True
    assert current_room.status == RoomStatus.INNINGS_ACTIVE
    assert current_match.active_batter_id == match.active_batter_id
    assert current_match.version == version_before


# ---------------------------------------------------------------------------
# Gameplay gates
# ---------------------------------------------------------------------------

def test_spectator_is_excluded_from_the_toss_caller_pool():
    room, players = _make_lobby(2)
    room_service.join_room(_new_spectator(), room.join_code, as_spectator=True)

    toss = room_service.start_toss(room, players[0])

    assert toss["caller_id"] in {p.id for p in players}


def test_spectator_is_ignored_by_the_first_ball_quorum():
    room, players = _make_lobby(2)
    room, match = _advance_to_first_ball(room, players)
    assert room.status == RoomStatus.AWAITING_FIRST_BALL

    room_service.join_room(_new_spectator(), room.join_code, as_spectator=True)

    room, match, activated_a = room_service.confirm_first_ball_ready(room, players[0])
    assert activated_a is False
    room, match, activated_b = room_service.confirm_first_ball_ready(room, players[1])
    # The spectator never confirms, yet the match starts for the two players.
    assert activated_b is True
    assert repo.get_room(room.id).status == RoomStatus.INNINGS_ACTIVE


def test_spectator_cannot_pick_or_confirm_first_ball():
    room, match, players = _start_live_match()
    spectator = _new_spectator()
    room_service.join_room(spectator, room.join_code, as_spectator=True)

    with pytest.raises(PermissionError):
        room_service.submit_pick(room, spectator, 3)

    waiting_room, _ = _make_lobby(2)
    waiting_room, _ = _advance_to_first_ball(waiting_room, [
        repo.get_player(m.player_id) for m in repo.get_room_members(waiting_room.id)
    ])
    watcher = _new_spectator()
    room_service.join_room(watcher, waiting_room.join_code, as_spectator=True)
    with pytest.raises(ValueError):
        room_service.confirm_first_ball_ready(waiting_room, watcher)


def test_spectator_cannot_start_a_rematch():
    room, match, players = _start_live_match()
    spectator = _new_spectator()
    room_service.join_room(spectator, room.join_code, as_spectator=True)
    room.status = RoomStatus.MATCH_COMPLETE
    repo.save_room(room)

    with pytest.raises(PermissionError):
        room_service.reset_room_for_rematch(room, spectator)


# ---------------------------------------------------------------------------
# Leaving
# ---------------------------------------------------------------------------

def test_spectator_can_leave_a_live_match_without_changing_its_state():
    room, match, players = _start_live_match()
    spectator = _new_spectator()
    room, _ = room_service.join_room(spectator, room.join_code, as_spectator=True)

    result = room_service.leave_lobby(room, spectator)

    assert result is not None
    assert result.status == RoomStatus.INNINGS_ACTIVE
    assert repo.get_membership(room.id, spectator.id) is None
    assert repo.get_match_by_room(room.id) is not None
    assert len(repo.get_room_members(room.id)) == 2


def test_last_spectator_leaving_a_lobby_leaves_the_room_for_its_players():
    room, players = _make_lobby(1)
    spectator = _new_spectator()
    room_service.join_room(spectator, room.join_code, as_spectator=True)

    result = room_service.leave_lobby(repo.get_room(room.id), spectator)

    assert result is not None
    assert repo.get_membership(room.id, spectator.id) is None
    assert repo.get_membership(room.id, players[0].id).is_host is True


# ---------------------------------------------------------------------------
# Socket-level behaviour: chat allowed, pause/disconnect do not affect play
# ---------------------------------------------------------------------------

def _register(client, name):
    client.emit("player:register", {"display_name": name})
    return client.get_received()[0]["args"][0]


def _setup_live_solo_match():
    app = create_app()
    app.config["TESTING"] = True

    client_a = socketio.test_client(app)
    client_b = socketio.test_client(app)
    reg_a = _register(client_a, "Host")
    reg_b = _register(client_b, "Opponent")

    client_a.emit(
        "room:create",
        {"mode": "SOLO", "overs": 1, "wickets": 1, "session_token": reg_a["session_token"]},
    )
    created = next(e for e in client_a.get_received() if e["name"] == "room:created")["args"][0]
    room_id = created["room_id"]
    join_code = created["join_code"]

    client_b.emit("room:join", {"join_code": join_code, "session_token": reg_b["session_token"]})
    time.sleep(0.1)
    client_a.get_received()
    client_b.get_received()

    client_a.emit("match:ready", {"room_id": room_id, "ready": True})
    client_b.emit("match:ready", {"room_id": room_id, "ready": True})
    time.sleep(0.1)
    client_a.get_received()
    client_b.get_received()

    client_a.emit("match:start", {"room_id": room_id})
    time.sleep(0.1)
    room = repo.get_room(room_id)
    assert room.status == RoomStatus.TOSS

    clients = {reg_a["player_id"]: client_a, reg_b["player_id"]: client_b}
    clients[room.toss["caller_id"]].emit("toss:call", {"room_id": room_id, "choice": "HEADS"})
    time.sleep(0.1)
    room = repo.get_room(room_id)
    clients[room.toss["winner_id"]].emit(
        "toss:decide", {"room_id": room_id, "decision": "BAT"}
    )
    time.sleep(0.1)

    client_a.emit("first_ball:ready", {"room_id": room_id})
    client_b.emit("first_ball:ready", {"room_id": room_id})
    time.sleep(0.2)
    assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE

    client_a.get_received()
    client_b.get_received()
    return app, client_a, client_b, reg_a, reg_b, room_id, join_code


def test_spectator_can_watch_chat_and_cannot_pause_or_forfeit():
    app, client_a, client_b, reg_a, reg_b, room_id, join_code = _setup_live_solo_match()

    watcher = socketio.test_client(app)
    reg_w = _register(watcher, "Watcher")
    watcher.emit(
        "room:join",
        {"join_code": join_code, "session_token": reg_w["session_token"], "as_spectator": True},
    )
    time.sleep(0.1)

    joined = next(e for e in watcher.get_received() if e["name"] == "room:joined")["args"][0]
    assert joined["success"] is True
    assert joined["is_spectator"] is True
    assert repo.get_membership(room_id, reg_w["player_id"]).is_spectator is True

    # Chat is open to watchers: everyone in the room receives it.
    watcher.emit("chat:send", {"room_id": room_id, "text": "What a shot!"})
    time.sleep(0.1)
    host_events = client_a.get_received()
    assert any(
        e["name"] == "chat:message" and e["args"][0]["text"] == "What a shot!"
        for e in host_events
    )

    # Pause is a player-only action.
    watcher.emit("match:pause", {"room_id": room_id})
    time.sleep(0.1)
    acks = [e["args"][0] for e in watcher.get_received() if e["name"] == "match:pause_ack"]
    assert acks and acks[-1]["success"] is False
    assert acks[-1]["error"] == "only_players_can_pause"
    assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE

    # A watcher dropping out must not pause the match or start a forfeit clock.
    watcher.disconnect()
    time.sleep(0.2)
    assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE
    assert not any(
        e["name"] == "match:paused" for e in client_a.get_received()
    )
