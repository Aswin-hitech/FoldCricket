"""Signed-in players must reconnect exactly like guests.

A signed-in client re-sends ``player:register`` on every socket connect (the
social world bootstraps its identity that way) and may no longer hold the guest
token after a login reset or a storage purge. Either way the account already
owns a game identity sitting in the live room, so reconnect must resolve that
identity, rejoin the room and resume the match instead of spawning a second
player that the room has never heard of.
"""

from __future__ import annotations

import time

import pytest

from app import create_app, socketio
from app.domain.models import RoomStatus
from app.repositories import memory as repo
from app.services import accounts_service

from app.sockets import events  # noqa: F401  (register handlers before create_app)

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


def _account():
    user, token = accounts_service.register("returning", "Returning Pro", "testpass123")
    return user, token


def _client(app, token: str = "", account_token: str = ""):
    query = "&".join(
        part for part in (f"token={token}" if token else "", f"account_token={account_token}" if account_token else "") if part
    )
    return socketio.test_client(app, query_string=query or None)


def _register(client, name, session_token=None, account_token=None):
    payload = {"display_name": name}
    if session_token:
        payload["session_token"] = session_token
    if account_token:
        payload["account_token"] = account_token
    client.emit("player:register", payload)
    return next(
        e for e in client.get_received() if e["name"] == "player:registered"
    )["args"][0]


def _setup_live_match(account_token=""):
    app = create_app()
    app.config["TESTING"] = True

    client_a = _client(app)
    client_b = socketio.test_client(app)
    reg_a = _register(client_a, "Returning Pro", account_token=account_token or None)
    reg_b = _register(client_b, "Opponent")

    client_a.emit(
        "room:create",
        {"mode": "SOLO", "overs": 2, "wickets": 1, "session_token": reg_a["session_token"]},
    )
    created = next(e for e in client_a.get_received() if e["name"] == "room:created")["args"][0]
    room_id = created["room_id"]

    client_b.emit("room:join", {"join_code": created["join_code"], "session_token": reg_b["session_token"]})
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
    clients = {reg_a["player_id"]: client_a, reg_b["player_id"]: client_b}
    clients[room.toss["caller_id"]].emit("toss:call", {"room_id": room_id, "choice": "HEADS"})
    time.sleep(0.1)
    room = repo.get_room(room_id)
    clients[room.toss["winner_id"]].emit("toss:decide", {"room_id": room_id, "decision": "BAT"})
    time.sleep(0.1)

    client_a.emit("first_ball:ready", {"room_id": room_id})
    client_b.emit("first_ball:ready", {"room_id": room_id})
    time.sleep(0.2)
    assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE

    client_a.get_received()
    client_b.get_received()
    return app, client_a, client_b, reg_a, reg_b, room_id


def test_signed_in_reconnect_keeps_the_same_identity_when_the_guest_token_is_lost():
    _user, account_token = _account()
    app, client_a, client_b, reg_a, reg_b, room_id = _setup_live_match(account_token)

    client_a.disconnect()
    time.sleep(0.2)
    assert repo.get_room(room_id).status == RoomStatus.PAUSED
    client_b.get_received()

    # The browser kept only the account session: no guest token in the
    # handshake, none in storage. This is what the social world sends on
    # connect, followed by the room sync the arena performs.
    returning = _client(app, account_token=account_token)
    reg = _register(returning, "Returning Pro", account_token=account_token)
    returning.emit("room:sync", {"room_id": room_id, "account_token": account_token})
    time.sleep(0.2)

    assert reg["success"] is True
    assert reg["player_id"] == reg_a["player_id"], "reconnect must reuse the account's game identity"

    room = repo.get_room(room_id)
    assert room.status == RoomStatus.INNINGS_ACTIVE

    events_b = client_b.get_received()
    assert any(e["name"] == "match:resumed" for e in events_b)
    snapshots = [e["args"][0] for e in events_b if e["name"] == "room:snapshot"]
    assert snapshots and snapshots[-1]["room"]["status"] == "INNINGS_ACTIVE"
    assert any(
        m["player"]["id"] == reg_a["player_id"] and m["player"]["connection_state"] == "CONNECTED"
        for m in snapshots[-1]["members"]
    )

    # The recovered client gets the authoritative snapshot for its own room.
    own = [e["args"][0] for e in returning.get_received() if e["name"] == "room:snapshot"]
    assert own and own[-1]["room"]["status"] == "INNINGS_ACTIVE"
    assert own[-1].get("self_player_id") == reg_a["player_id"]

    returning.disconnect()
    client_b.disconnect()


def test_register_on_reconnect_rejoins_the_live_room():
    _user, account_token = _account()
    app, client_a, client_b, reg_a, reg_b, room_id = _setup_live_match(account_token)

    client_a.disconnect()
    time.sleep(0.2)
    client_b.get_received()

    # Social bootstrap only: player:register with the still-valid guest token.
    returning = _client(app, token=reg_a["session_token"], account_token=account_token)
    _register(returning, "Returning Pro", reg_a["session_token"], account_token)
    time.sleep(0.2)

    assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE
    resume_events = client_b.get_received()
    assert any(e["name"] == "match:resumed" for e in resume_events)

    returning.disconnect()
    client_b.disconnect()


def test_registration_is_idempotent_on_the_same_socket():
    _user, account_token = _account()
    app = create_app()
    app.config["TESTING"] = True

    client = _client(app)
    reg_one = _register(client, "Returning Pro", account_token=account_token)
    reg_two = _register(client, "Returning Pro", account_token=account_token)

    assert reg_two["player_id"] == reg_one["player_id"]
    assert reg_two["session_token"] == reg_one["session_token"]

    client.disconnect()


def test_a_second_live_socket_keeps_its_own_identity():
    """Recovery must never steal a player another live tab is still using."""
    _user, account_token = _account()
    app = create_app()
    app.config["TESTING"] = True

    first = _client(app)
    reg_one = _register(first, "Returning Pro", account_token=account_token)

    second = _client(app)
    reg_two = _register(second, "Returning Pro", account_token=account_token)

    assert reg_two["player_id"] != reg_one["player_id"]
    assert reg_two["session_token"] != reg_one["session_token"]

    second.disconnect()
    first.disconnect()


def test_room_sync_recovers_the_account_player_without_a_prior_register():
    _user, account_token = _account()
    app, client_a, client_b, reg_a, reg_b, room_id = _setup_live_match(account_token)

    client_a.disconnect()
    time.sleep(0.2)
    client_b.get_received()

    returning = _client(app, account_token=account_token)
    returning.emit("room:sync", {"room_id": room_id, "account_token": account_token})
    time.sleep(0.2)

    assert repo.get_room(room_id).status == RoomStatus.INNINGS_ACTIVE
    own = [e["args"][0] for e in returning.get_received() if e["name"] == "room:snapshot"]
    assert own and own[-1]["room"]["status"] == "INNINGS_ACTIVE"

    returning.disconnect()
    client_b.disconnect()
