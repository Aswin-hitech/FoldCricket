"""Reconnect must resynchronize every client, not just the returning one.

Regression: the auto-resume path used to emit ``match:resumed`` without a fresh
snapshot, so the other clients kept the paused snapshot forever (they stayed
behind a "Match Paused" overlay while the game ran on for the reconnected
player). The stale snapshot also kept describing the returning player as
disconnected, which disabled the Resume button as well.
"""

from __future__ import annotations

import time

import pytest

from app import create_app, socketio
from app.domain.models import RoomStatus
from app.repositories import memory as repo
from app.sockets import events

_TIMER_DICTS = (events._delivery_timers, events._innings_break_timers, events._grace_timers)
_REPO_DICTS = (
    "_players",
    "_players_by_socket",
    "_players_by_session",
    "_rooms",
    "_rooms_by_code",
    "_memberships",
    "_matches",
    "_match_by_room",
    "_deliveries",
)


def _clear():
    for timers in _TIMER_DICTS:
        for timer in list(timers.values()):
            try:
                timer.cancel()
            except Exception:
                pass
        timers.clear()
    for name in _REPO_DICTS:
        getattr(repo, name).clear()


@pytest.fixture(autouse=True)
def clean_environment():
    _clear()
    yield
    _clear()


def _register(client, name):
    client.emit("player:register", {"display_name": name})
    return client.get_received()[0]["args"][0]


def _setup_live_solo_match():
    app = create_app()
    app.config["TESTING"] = True

    client_a = socketio.test_client(app)
    client_b = socketio.test_client(app)

    reg_a = _register(client_a, "Syncer")
    reg_b = _register(client_b, "Watcher")

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
    caller = clients[room.toss["caller_id"]]
    caller.emit("toss:call", {"room_id": room_id, "choice": "HEADS"})
    time.sleep(0.1)
    room = repo.get_room(room_id)
    winner = clients[room.toss["winner_id"]]
    winner.emit("toss:decide", {"room_id": room_id, "decision": "BAT"})
    time.sleep(0.1)

    client_a.emit("first_ball:ready", {"room_id": room_id})
    client_b.emit("first_ball:ready", {"room_id": room_id})
    time.sleep(0.2)
    assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE

    client_a.get_received()
    client_b.get_received()
    return app, client_a, client_b, reg_a, reg_b, room_id


def test_reconnect_broadcasts_fresh_snapshot_to_the_other_player():
    app, client_a, client_b, reg_a, reg_b, room_id = _setup_live_solo_match()

    client_a.disconnect()
    time.sleep(0.2)

    pause_events = client_b.get_received()
    assert any(e["name"] == "match:paused" for e in pause_events)
    assert repo.get_room(room_id).status == RoomStatus.PAUSED
    pause_snaps = [e["args"][0] for e in pause_events if e["name"] == "room:snapshot"]
    assert pause_snaps and pause_snaps[-1]["room"]["status"] == "PAUSED"

    returning = socketio.test_client(app)
    returning.emit("player:restore", {"session_token": reg_a["session_token"]})
    time.sleep(0.2)

    assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE

    resume_events = client_b.get_received()
    assert any(e["name"] == "match:resumed" for e in resume_events)
    resume_snaps = [e["args"][0] for e in resume_events if e["name"] == "room:snapshot"]
    assert resume_snaps, "the waiting client must get a fresh snapshot when the match resumes"
    final = resume_snaps[-1]
    assert final["room"]["status"] == "INNINGS_ACTIVE"
    assert all(
        m["player"]["connection_state"] == "CONNECTED" for m in final["members"]
    ), "the resumed snapshot must clear the stale disconnected member"

    returning.disconnect()
    client_b.disconnect()


def test_disconnect_during_toss_keeps_the_toss_alive():
    """A drop while the coin is in the air must not skip the toss.

    The toss has no clock, so it is never paused; if it were marked PAUSED the
    reconnect path would have resumed it into INNINGS_ACTIVE with no match.
    """
    app = create_app()
    app.config["TESTING"] = True

    client_a = socketio.test_client(app)
    client_b = socketio.test_client(app)
    reg_a = _register(client_a, "Tosser")
    reg_b = _register(client_b, "Caller")

    client_a.emit(
        "room:create",
        {"mode": "SOLO", "overs": 1, "wickets": 1, "session_token": reg_a["session_token"]},
    )
    created = next(e for e in client_a.get_received() if e["name"] == "room:created")["args"][0]
    client_b.emit("room:join", {"join_code": created["join_code"], "session_token": reg_b["session_token"]})
    time.sleep(0.1)
    client_a.get_received()
    client_b.get_received()

    client_a.emit("match:ready", {"room_id": created["room_id"], "ready": True})
    client_b.emit("match:ready", {"room_id": created["room_id"], "ready": True})
    time.sleep(0.1)
    client_a.get_received()
    client_b.get_received()
    client_a.emit("match:start", {"room_id": created["room_id"]})
    time.sleep(0.1)

    room = repo.get_room(created["room_id"])
    assert room.status == RoomStatus.TOSS

    clients = {reg_a["player_id"]: client_a, reg_b["player_id"]: client_b}
    caller = clients[room.toss["caller_id"]]
    caller.disconnect()
    time.sleep(0.2)
    assert repo.get_room(created["room_id"]).status == RoomStatus.TOSS

    returning = socketio.test_client(app)
    returning.emit("player:restore", {"session_token": (reg_a if caller is client_a else reg_b)["session_token"]})
    time.sleep(0.2)
    room = repo.get_room(created["room_id"])
    assert room.status == RoomStatus.TOSS
    assert room.toss is not None and room.toss.get("elected_choice") is None

    returning.disconnect()
    for c in (client_a, client_b):
        try:
            c.disconnect()
        except Exception:
            pass
