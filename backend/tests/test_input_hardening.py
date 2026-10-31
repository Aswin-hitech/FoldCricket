"""
Security hardening tests: room subscription authorization, socket input
validation, external log redaction and browser security headers.
"""

import pytest

from app import create_app
from app.api import feedback as feedback_api
from app.api import telemetry as telemetry_api
from app.repositories import memory as repo
from app.security import utils as security_utils
from app.services import room_service
from app.services.supabase_logger import _clean_headers

# Import handlers before the first create_app() so every test app (not just the
# first one in the process) gets the Socket.IO event registrations.
from app.sockets import events  # noqa: F401,E402


@pytest.fixture(autouse=True)
def clean_state():
    repo.clear_all()
    for limiter in (
        security_utils.chat_rate_limiter,
        security_utils.create_rate_limiter,
        security_utils.join_rate_limiter,
        security_utils.feedback_rate_limiter,
        security_utils.voice_signal_rate_limiter,
        security_utils.room_lookup_rate_limiter,
        feedback_api._feedback_limiter,
        telemetry_api._telemetry_limiter,
    ):
        limiter._buckets.clear()
    yield


@pytest.fixture
def app():
    application = create_app()
    application.config["TESTING"] = True
    return application


@pytest.fixture
def client(app):
    with app.test_client() as c:
        yield c


def _register(socket, player):
    socket.emit("player:register", {
        "display_name": player.display_name,
        "session_token": player.session_token,
    })
    received = socket.get_received()
    registered = [e for e in received if e["name"] == "player:registered"]
    assert registered and registered[-1]["args"][0]["success"] is True


def _name_list(received):
    return [event["name"] for event in received]


def test_room_sync_rejects_non_members(app):
    from app.extensions import socketio

    member, _ = room_service.create_or_restore_player("Member", None)
    room, _ = room_service.create_room(member, "SOLO", 2)

    outsider, _ = room_service.create_or_restore_player("Outsider", None)
    socket = socketio.test_client(app)
    try:
        _register(socket, outsider)
        socket.get_received()

        socket.emit("room:sync", {
            "room_id": room.id,
            "session_token": outsider.session_token,
        })
        events = socket.get_received()
        names = _name_list(events)
        assert "room:snapshot" not in names
        errors = [e for e in events if e["name"] == "room:error"]
        assert errors and errors[-1]["args"][0]["error"] == "not_in_room"
    finally:
        socket.disconnect()


def test_room_sync_allows_members(app):
    from app.extensions import socketio

    member, _ = room_service.create_or_restore_player("Member", None)
    room, _ = room_service.create_room(member, "SOLO", 2)

    socket = socketio.test_client(app)
    try:
        _register(socket, member)
        socket.get_received()

        socket.emit("room:sync", {
            "room_id": room.id,
            "session_token": member.session_token,
        })
        snapshots = [e for e in socket.get_received() if e["name"] == "room:snapshot"]
        assert snapshots
        assert snapshots[-1]["args"][0]["room"]["id"] == room.id
    finally:
        socket.disconnect()


def test_player_register_rejects_wrong_types(app):
    from app.extensions import socketio

    socket = socketio.test_client(app)
    try:
        socket.emit("player:register", {"display_name": 123, "session_token": None})
        result = [e for e in socket.get_received() if e["name"] == "player:registered"]
        assert result and result[-1]["args"][0]["success"] is False

        socket.emit("player:register", {"display_name": "Valid", "session_token": ["x" * 500]})
        result = [e for e in socket.get_received() if e["name"] == "player:registered"]
        assert result and result[-1]["args"][0]["error"] == "invalid_session_token"
    finally:
        socket.disconnect()


def test_omitted_overs_is_rejected_without_breaking_room_create(app):
    from app.extensions import socketio

    host, _ = room_service.create_or_restore_player("Host", None)
    socket = socketio.test_client(app)
    try:
        _register(socket, host)
        socket.get_received()

        socket.emit("room:create", {"mode": "SOLO", "overs": "not-a-number"})
        result = [e for e in socket.get_received() if e["name"] == "room:created"]
        assert result and result[-1]["args"][0]["success"] is False
    finally:
        socket.disconnect()


def test_voice_mode_rejects_unknown_mode_and_filters_members(app):
    from app.extensions import socketio

    p1, _ = room_service.create_or_restore_player("VoiceA", None)
    p2, _ = room_service.create_or_restore_player("VoiceB", None)
    room, _ = room_service.create_room(p1, "TEAM", 2)
    room_service.join_room(p2, room.join_code)

    socket = socketio.test_client(app)
    try:
        _register(socket, p1)
        socket.get_received()

        socket.emit("voice:mode", {"room_id": room.id, "mode": "GOD_MODE"})
        ack = [e for e in socket.get_received() if e["name"] == "voice:mode_ack"]
        assert ack and ack[-1]["args"][0]["success"] is False

        socket.emit("voice:mode", {
            "room_id": room.id,
            "mode": "CUSTOM",
            "allowed_recipients": [p2.id, "not-a-member", 42],
        })
        ack = [e for e in socket.get_received() if e["name"] == "voice:mode_ack"]
        assert ack and ack[-1]["args"][0]["success"] is True
        assert ack[-1]["args"][0]["allowed_recipients"] == [p2.id]
        assert repo.get_membership(room.id, p1.id).voice_mode == "CUSTOM"
    finally:
        socket.disconnect()


def test_voice_signal_rejects_oversized_payload(app):
    from app.extensions import socketio

    p1, _ = room_service.create_or_restore_player("SignalA", None)
    p2, _ = room_service.create_or_restore_player("SignalB", None)
    room, _ = room_service.create_room(p1, "SOLO", 2)
    room_service.join_room(p2, room.join_code)

    socket = socketio.test_client(app)
    try:
        _register(socket, p1)
        socket.get_received()

        socket.emit("voice:signal", {
            "room_id": room.id,
            "target_player_id": p2.id,
            "signal": {"sdp": "x" * 70000},
        })
        errors = [e for e in socket.get_received() if e["name"] == "voice:error"]
        assert errors and errors[-1]["args"][0]["error"] == "signal_too_large"
    finally:
        socket.disconnect()


def test_feedback_endpoint_clamps_and_sanitizes(client, monkeypatch):
    captured = {}

    def fake_log(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(feedback_api, "log_feedback_to_supabase_async", fake_log)

    response = client.post("/api/feedback", json={
        "player_id": {"nested": "object"},
        "player_name": "A" * 200,
        "rating": 99,
        "feedback_text": "<script>alert(1)</script>",
        "categories": ["ui", 5, "voice"],
        "metadata": {"ok": True},
    })
    assert response.status_code == 200
    assert captured["rating"] == 5
    assert len(captured["player_name"]) <= 48
    assert captured["categories"] == ["ui", "voice"]
    assert captured["player_id"] == "unknown"

    response = client.post("/api/feedback", json={"rating": -7})
    assert response.status_code == 200
    assert captured["rating"] == 1

    response = client.post("/api/feedback", json={"rating": "not-a-number"})
    assert response.status_code == 200
    assert captured["rating"] == 5


def test_telemetry_endpoint_is_rate_limited(client):
    for _ in range(30):
        assert client.post("/api/log-ip", json={"action": "visit"}).status_code == 200
    assert client.post("/api/log-ip", json={"action": "visit"}).status_code == 429


def test_sensitive_headers_are_redacted_before_external_logging():
    cleaned = _clean_headers({
        "Authorization": "Bearer secret",
        "cookie": "session=abc",
        "x-api-key": "key",
        "X-Supabase-Secret": "s",
        "user-agent": "pytest",
    })
    assert cleaned == {"user-agent": "pytest"}


def test_security_headers_are_present(client):
    response = client.get("/health")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "microphone=(self)" in response.headers["Permissions-Policy"]
    # Plain HTTP requests must not advertise HSTS.
    assert "Strict-Transport-Security" not in response.headers
