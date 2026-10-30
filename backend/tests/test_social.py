"""
Social world: discovery, live presence, direct messages and play requests.
"""

import pytest

from app import create_app
from app.api import social as social_api
from app.domain.models import RoomStatus
from app.repositories import accounts as accounts_repo
from app.repositories import memory as repo
from app.services import accounts_service, room_service, social_service

# Import handlers before the first create_app() so every test app (not just the
# first one in the process) gets the Socket.IO event registrations.
from app.sockets import events  # noqa: F401,E402


@pytest.fixture(autouse=True)
def clean_state():
    repo.clear_all()
    for limiter in (
        social_api._search_limiter,
        social_api._dm_limiter,
        social_api._invite_limiter,
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


def _account(username, display_name=None):
    user, token = accounts_service.register(
        username, display_name or username.title(), "testpass123"
    )
    return user, token


def _with_player(user, token):
    player, _ = room_service.create_or_restore_player(
        user["display_name"], None, user_id=user["id"]
    )
    return user, token, player


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _set_room_status(room, status: RoomStatus) -> None:
    room.status = status
    repo.save_room(room)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def test_search_matches_display_name_username_code_and_uuid(client):
    viewer, token = _account("finder")
    target, _ = _account("rahul_k", display_name="Rahul Striker")
    _with_player(target, "")

    for query in ("Rahul", "rahul_k", target["friend_code"], target["id"]):
        response = client.get(
            "/api/social/search", query_string={"q": query}, headers=_auth(token)
        )
        assert response.status_code == 200
        results = response.get_json()["results"]
        assert any(r["user_id"] == target["id"] for r in results), query

    # Self is never returned.
    response = client.get(
        "/api/social/search", query_string={"q": "finder"}, headers=_auth(token)
    )
    assert response.get_json()["results"] == []


def test_search_results_carry_presence_and_relationship(client):
    viewer, viewer_token = _account("viewer", display_name="Viewer One")
    friend, _ = _account("friend1", display_name="Friendly Player")
    _with_player(friend, "")

    request = accounts_service.send_friend_request(viewer, friend["friend_code"])
    accounts_repo.set_friendship_status(request["request_id"], "ACCEPTED")

    response = client.get(
        "/api/social/search", query_string={"q": "Friendly"}, headers=_auth(viewer_token)
    )
    result = response.get_json()["results"][0]
    assert result["is_friend"] is True
    assert result["presence"]["status"] == "online"
    assert result["friend_code"].startswith("FC-")


def test_public_profile_exposes_live_presence(client):
    viewer, viewer_token = _account("viewer")
    target, _ = _account("target")
    _player = _with_player(target, "")[2]

    response = client.get(f"/api/users/{target['friend_code']}", headers=_auth(viewer_token))
    payload = response.get_json()
    assert payload["presence"]["status"] == "online"
    assert payload["user_id"] == target["id"]


def test_presence_distinguishes_lobby_match_and_spectating():
    lobby_user, _, lobby_player = _with_player(*_account("lobbyuser"))
    match_user, _, match_player = _with_player(*_account("matchuser"))
    watcher, _, watcher_player = _with_player(*_account("watcher"))
    _, _, host_player = _with_player(*_account("hostuser"))

    room = room_service.create_room(host_player, "SOLO", 2, 1)[0]
    room_service.join_room(lobby_player, room.join_code)
    room_service.join_room(watcher_player, room.join_code, as_spectator=True)

    second_room = room_service.create_room(match_player, "SOLO", 2, 1)[0]
    _set_room_status(second_room, RoomStatus.INNINGS_ACTIVE)

    presence = social_service._presence_for(
        [lobby_user["id"], match_user["id"], watcher["id"]]
    )

    assert presence[lobby_user["id"]]["status"] == "in_lobby"
    assert presence[match_user["id"]]["status"] == "in_match"
    assert presence[watcher["id"]]["status"] == "spectating"
    assert presence[watcher["id"]]["join_code"] == room.join_code
    assert presence[lobby_user["id"]]["mode"] == "SOLO"


def test_social_presence_covers_friends(client):
    viewer, token = _account("viewer")
    friend, _ = _account("friend2", display_name="Best Friend")
    _with_player(friend, "")
    accounts_service.send_friend_request(viewer, friend["friend_code"])
    # The request is pending, so the friend is still in the sweep (outgoing).
    response = client.get("/api/social/presence", headers=_auth(token))
    payload = response.get_json()["presence"]
    assert payload[friend["id"]]["status"] == "online"


# ---------------------------------------------------------------------------
# Direct messages
# ---------------------------------------------------------------------------

def test_direct_message_persists_and_tracks_unread(client):
    sender, sender_token = _account("sender")
    recipient, recipient_token = _account("recipient")

    response = client.post(
        f"/api/social/threads/{recipient['friend_code']}",
        json={"text": "Ready for a match?"},
        headers=_auth(sender_token),
    )
    assert response.status_code == 200
    sent = response.get_json()["message"]
    assert sent["body"] == "Ready for a match?"
    assert sent["mine"] is True

    inbox = client.get("/api/social/threads", headers=_auth(recipient_token)).get_json()
    assert inbox["unread_total"] == 1
    thread = inbox["threads"][0]
    assert thread["peer"]["username"] == "sender"
    assert thread["last_message"]["body"] == "Ready for a match?"

    thread_response = client.get(
        f"/api/social/threads/{sender['friend_code']}", headers=_auth(recipient_token)
    )
    assert thread_response.status_code == 200
    assert [m["body"] for m in thread_response.get_json()["messages"]] == [
        "Ready for a match?"
    ]

    read = client.post(
        f"/api/social/threads/{sender['friend_code']}/read", headers=_auth(recipient_token)
    )
    assert read.get_json()["unread_total"] == 0

    after = client.get("/api/social/threads", headers=_auth(recipient_token)).get_json()
    assert after["unread_total"] == 0


def test_direct_message_rejects_empty_self_and_unknown(client):
    user, token = _account("chatter")
    stranger, _ = _account("stranger")

    empty = client.post(
        f"/api/social/threads/{stranger['friend_code']}",
        json={"text": "   "},
        headers=_auth(token),
    )
    assert empty.status_code == 400
    assert empty.get_json()["error"] == "msg_empty"

    self_chat = client.post(
        f"/api/social/threads/{user['friend_code']}",
        json={"text": "hello me"},
        headers=_auth(token),
    )
    assert self_chat.status_code == 400
    assert self_chat.get_json()["error"] == "self_conversation"

    unknown = client.post(
        "/api/social/threads/FC-NOPE99", json={"text": "hi"}, headers=_auth(token)
    )
    assert unknown.status_code == 404


# ---------------------------------------------------------------------------
# Play requests
# ---------------------------------------------------------------------------

def test_play_request_declined_flow(client):
    requester, requester_token = _account("requester")
    recipient, recipient_token = _account("recipient")
    _with_player(requester, "")
    _with_player(recipient, "")

    created = client.post(
        "/api/social/play-requests",
        json={"identifier": recipient["friend_code"], "mode": "SOLO", "overs": 3, "wickets": 2},
        headers=_auth(requester_token),
    )
    assert created.status_code == 200
    request_id = created.get_json()["request"]["id"]

    incoming = client.get("/api/social/play-requests", headers=_auth(recipient_token)).get_json()
    assert incoming["incoming"][0]["id"] == request_id
    assert incoming["incoming"][0]["player"]["username"] == "requester"

    declined = client.post(
        f"/api/social/play-requests/{request_id}/decline", headers=_auth(recipient_token)
    )
    assert declined.status_code == 200
    assert declined.get_json()["status"] == "declined"

    pending = client.get("/api/social/play-requests", headers=_auth(recipient_token)).get_json()
    assert pending["incoming"] == []


def test_play_request_accept_creates_room_for_both(client):
    requester, requester_token, requester_player = _with_player(*_account("requester"))
    recipient, recipient_token, recipient_player = _with_player(*_account("recipient"))

    created = client.post(
        "/api/social/play-requests",
        json={"identifier": recipient["friend_code"], "mode": "SOLO", "overs": 4, "wickets": 2},
        headers=_auth(requester_token),
    )
    request_id = created.get_json()["request"]["id"]

    accepted = client.post(
        f"/api/social/play-requests/{request_id}/accept", headers=_auth(recipient_token)
    )
    assert accepted.status_code == 200, accepted.get_json()
    room_payload = accepted.get_json()["room"]
    assert room_payload["mode"] == "SOLO"
    assert room_payload["overs"] == 4

    room = repo.get_room(room_payload["room_id"])
    assert room is not None
    member_ids = {m.player_id for m in repo.get_room_members(room.id)}
    assert member_ids == {requester_player.id, recipient_player.id}

    # The recipient accepts, so they host; the requester fills team B.
    host_member = repo.get_membership(room.id, recipient_player.id)
    guest_member = repo.get_membership(room.id, requester_player.id)
    assert host_member.is_host is True
    assert guest_member.team == "B"

    outgoing = client.get("/api/social/play-requests", headers=_auth(requester_token)).get_json()
    assert outgoing["outgoing"] == []


def test_invite_to_offline_player_is_rejected(client):
    requester, requester_token = _account("requester")
    offline, _ = _account("offlineuser")
    _with_player(requester, "")

    response = client.post(
        "/api/social/play-requests",
        json={"identifier": offline["friend_code"], "mode": "SOLO", "overs": 2},
        headers=_auth(requester_token),
    )
    assert response.status_code == 409
    assert response.get_json()["error"] == "player_offline"


def test_invite_to_player_in_match_is_rejected(client):
    requester, requester_token = _account("requester")
    busy, _, busy_player = _with_player(*_account("busyuser"))
    _with_player(requester, "")

    room = room_service.create_room(busy_player, "SOLO", 2, 1)[0]
    _set_room_status(room, RoomStatus.INNINGS_ACTIVE)

    response = client.post(
        "/api/social/play-requests",
        json={"identifier": busy["friend_code"], "mode": "SOLO", "overs": 2},
        headers=_auth(requester_token),
    )
    assert response.status_code == 409
    assert response.get_json()["error"] == "player_busy"


def test_invite_to_player_in_lobby_is_rejected(client):
    requester, requester_token = _account("requester")
    lobby_user, _, lobby_player = _with_player(*_account("lobbyuser"))
    _with_player(requester, "")

    room = room_service.create_room(lobby_player, "SOLO", 2, 1)[0]
    _set_room_status(room, RoomStatus.LOBBY_READY)

    response = client.post(
        "/api/social/play-requests",
        json={"identifier": lobby_user["friend_code"], "mode": "SOLO", "overs": 2},
        headers=_auth(requester_token),
    )
    assert response.status_code == 409
    assert response.get_json()["error"] == "player_busy"


def test_invite_sender_must_be_free(client):
    requester, requester_token, requester_player = _with_player(*_account("requester"))
    recipient, _ = _account("recipient")
    _with_player(recipient, "")

    room = room_service.create_room(requester_player, "SOLO", 2, 1)[0]
    _set_room_status(room, RoomStatus.LOBBY_READY)

    response = client.post(
        "/api/social/play-requests",
        json={"identifier": recipient["friend_code"], "mode": "SOLO", "overs": 2},
        headers=_auth(requester_token),
    )
    assert response.status_code == 409
    assert response.get_json()["error"] == "not_available"


def test_accept_is_rejected_when_the_acceptor_joined_a_room(client):
    requester, requester_token, requester_player = _with_player(*_account("requester"))
    recipient, recipient_token, recipient_player = _with_player(*_account("recipient"))

    created = client.post(
        "/api/social/play-requests",
        json={"identifier": recipient["friend_code"], "mode": "SOLO", "overs": 2},
        headers=_auth(requester_token),
    )
    request_id = created.get_json()["request"]["id"]

    other = room_service.create_room(recipient_player, "TEAM", 2, 5)[0]
    _set_room_status(other, RoomStatus.LOBBY_READY)

    accepted = client.post(
        f"/api/social/play-requests/{request_id}/accept", headers=_auth(recipient_token)
    )
    assert accepted.status_code == 409
    assert accepted.get_json()["error"] == "you_are_busy"

    # The request stays open; no second room was created.
    outgoing = client.get("/api/social/play-requests", headers=_auth(requester_token)).get_json()
    assert [item["id"] for item in outgoing["outgoing"]] == [request_id]
    assert repo.get_memberships_for_player(requester_player.id) == []
    assert [m.room_id for m in repo.get_memberships_for_player(recipient_player.id)] == [other.id]


def test_duplicate_play_request_is_idempotent(client):
    requester, requester_token = _account("requester")
    recipient, recipient_token = _account("recipient")
    _with_player(requester, "")
    _with_player(recipient, "")

    first = client.post(
        "/api/social/play-requests",
        json={"identifier": recipient["friend_code"], "mode": "TEAM", "overs": 2},
        headers=_auth(requester_token),
    ).get_json()
    second = client.post(
        "/api/social/play-requests",
        json={"identifier": recipient["friend_code"], "mode": "TEAM", "overs": 2},
        headers=_auth(requester_token),
    ).get_json()

    assert second["already_sent"] is True
    assert second["request"]["id"] == first["request"]["id"]

    cancelled = client.post(
        f"/api/social/play-requests/{first['request']['id']}/cancel",
        headers=_auth(requester_token),
    )
    assert cancelled.status_code == 200


def test_play_request_requires_authentication(client):
    assert client.get("/api/social/threads").status_code == 401
    assert client.get("/api/social/play-requests").status_code == 401
    assert client.get("/api/social/search").status_code == 401


def test_direct_message_is_pushed_to_the_recipient_socket(app):
    from app.extensions import socketio

    sender, sender_token = _account("sender")
    recipient, recipient_token = _account("recipient")

    sender_socket = socketio.test_client(app, auth={"account_token": sender_token})
    recipient_socket = socketio.test_client(app, auth={"account_token": recipient_token})
    try:
        assert sender_socket.is_connected()
        assert recipient_socket.is_connected()

        social_service.send_message(sender, recipient["friend_code"], "live ping")

        events = [event["name"] for event in recipient_socket.get_received()]
        assert "dm:message" in events
        # The sender's own tabs also receive the echo for multi-device sync.
        sender_events = [event["name"] for event in sender_socket.get_received()]
        assert "dm:message" in sender_events
    finally:
        sender_socket.disconnect()
        recipient_socket.disconnect()
