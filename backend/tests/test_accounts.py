"""
Account system: auth security, profile privacy, friendships, durable match
stats and achievements.
"""

import pytest
from werkzeug.security import check_password_hash

from app import create_app
from app.api import accounts as accounts_api
from app.domain.models import Delivery, DeliveryResult, InningsPhase
from app.repositories import accounts as accounts_repo
from app.repositories import memory as repo
from app.services import accounts_service, room_service


@pytest.fixture(autouse=True)
def clean_state():
    repo.clear_all()
    for limiter in (
        accounts_api._register_limiter,
        accounts_api._login_ip_limiter,
        accounts_api._login_user_limiter,
        accounts_api._search_limiter,
        accounts_api._social_limiter,
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


def _register(client, username, password="testpass123", display_name=None):
    response = client.post(
        "/api/auth/register",
        json={
            "username": username,
            "display_name": display_name or username.title(),
            "password": password,
        },
    )
    assert response.status_code == 201, response.get_json()
    payload = response.get_json()
    return payload["token"], payload["profile"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _link_account(username):
    user, token = accounts_service.register(username, username.title(), "testpass123")
    player, _ = room_service.create_or_restore_player(
        user["display_name"], None, user_id=user["id"]
    )
    return user, token, player


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def test_register_hashes_password_and_never_exposes_it(client):
    token, profile = _register(client, "aswin", display_name="Aswin N")

    assert profile["user"]["username"] == "aswin"
    assert profile["user"]["friend_code"].startswith("FC-")
    assert "password" not in str(profile).lower()
    assert token

    stored = accounts_repo.get_user_by_username("aswin")
    assert stored["password_hash"] != "testpass123"
    assert check_password_hash(stored["password_hash"], "testpass123")

    # The raw bearer token is never stored, only its hash.
    assert accounts_repo.get_session(token) is None
    assert accounts_repo.get_session(accounts_service._token_hash(token)) is not None


def test_register_validation_and_case_insensitive_usernames(client):
    _register(client, "Aswin")

    duplicate = client.post(
        "/api/auth/register",
        json={"username": "aswin", "display_name": "Other", "password": "testpass123"},
    )
    assert duplicate.status_code == 400
    assert duplicate.get_json()["error"] == "username_taken"

    short = client.post(
        "/api/auth/register",
        json={"username": "ab", "display_name": "Short", "password": "testpass123"},
    )
    assert short.status_code == 400
    assert short.get_json()["error"] == "username_invalid"

    weak = client.post(
        "/api/auth/register",
        json={"username": "weakling", "display_name": "Weak", "password": "short"},
    )
    assert weak.status_code == 400
    assert weak.get_json()["error"] == "password_too_short"


def test_login_logout_and_session_lifecycle(client):
    _register(client, "keeper")

    wrong = client.post("/api/auth/login", json={"username": "keeper", "password": "nope"})
    assert wrong.status_code == 401
    assert wrong.get_json()["error"] == "invalid_credentials"

    login = client.post("/api/auth/login", json={"username": "KEEPER", "password": "testpass123"})
    assert login.status_code == 200
    token = login.get_json()["token"]

    assert client.get("/api/auth/me", headers=_auth(token)).status_code == 200
    assert client.get("/api/auth/me").status_code == 401

    assert client.post("/api/auth/logout", headers=_auth(token)).status_code == 200
    assert client.get("/api/auth/me", headers=_auth(token)).status_code == 401


def test_password_change_revokes_other_devices(client):
    _register(client, "twofactor")
    first = client.post(
        "/api/auth/login", json={"username": "twofactor", "password": "testpass123"}
    ).get_json()["token"]
    second = client.post(
        "/api/auth/login", json={"username": "twofactor", "password": "testpass123"}
    ).get_json()["token"]

    bad = client.post(
        "/api/auth/password",
        json={"current_password": "wrong", "new_password": "newpass123"},
        headers=_auth(first),
    )
    assert bad.status_code == 401

    changed = client.post(
        "/api/auth/password",
        json={"current_password": "testpass123", "new_password": "newpass123"},
        headers=_auth(first),
    )
    assert changed.status_code == 200

    assert client.get("/api/auth/me", headers=_auth(first)).status_code == 200
    assert client.get("/api/auth/me", headers=_auth(second)).status_code == 401
    assert (
        client.post(
            "/api/auth/login", json={"username": "twofactor", "password": "newpass123"}
        ).status_code
        == 200
    )


def test_register_rate_limit(client):
    for index in range(6):
        _register(client, f"burst{index}")
    blocked = client.post(
        "/api/auth/register",
        json={"username": "burst9", "display_name": "Burst", "password": "testpass123"},
    )
    assert blocked.status_code == 429
    assert blocked.get_json()["error"] == "rate_limited"


# ---------------------------------------------------------------------------
# Profiles & privacy
# ---------------------------------------------------------------------------

def test_public_summary_then_full_profile_once_friends(client):
    token_a, _ = _register(client, "alpha", display_name="Alpha")
    token_b, _ = _register(client, "bravo", display_name="Bravo")

    me = client.get("/api/auth/me", headers=_auth(token_a)).get_json()
    alpha_code = me["user"]["friend_code"]

    found = client.get(f"/api/users/search?q={alpha_code}", headers=_auth(token_b)).get_json()
    assert len(found["results"]) == 1
    summary = found["results"][0]
    assert summary["display_name"] == "Alpha"
    assert summary["relationship"] == "none"
    assert "stats" not in summary
    assert "recent_matches" not in summary

    request = client.post(
        "/api/friends/requests", json={"identifier": alpha_code}, headers=_auth(token_b)
    ).get_json()
    client.post(
        f"/api/friends/requests/{request['request_id']}/accept", headers=_auth(token_a)
    )

    detail = client.get(f"/api/users/{alpha_code}", headers=_auth(token_b)).get_json()
    assert detail["is_friend"] is True
    assert "stats" in detail
    assert "achievements" in detail
    assert "recent_matches" in detail

    anonymous = client.get(f"/api/users/{alpha_code}")
    assert anonymous.status_code == 401


def test_profile_update_validates_and_unlocks_badge(client):
    token, _ = _register(client, "editor")

    invalid = client.patch(
        "/api/profile", json={"avatar": "💣"}, headers=_auth(token)
    )
    assert invalid.status_code == 400
    assert invalid.get_json()["error"] == "avatar_invalid"

    updated = client.patch(
        "/api/profile",
        json={"avatar": "🔥", "bio": "Middle-order hitter", "default_mode": "TEAM",
              "default_overs": 5, "default_wickets": 5},
        headers=_auth(token),
    )
    assert updated.status_code == 200
    payload = updated.get_json()
    assert payload["user"]["avatar"] == "🔥"
    assert payload["user"]["default_mode"] == "TEAM"
    assert "PROFILE_COMPLETE" in payload["new_achievements"]
    assert any(b["code"] == "PROFILE_COMPLETE" and b["earned"] for b in payload["achievements"])


# ---------------------------------------------------------------------------
# Friends
# ---------------------------------------------------------------------------

def test_friend_request_lifecycle_and_reciprocal_accept(client):
    token_a, _ = _register(client, "frienda")
    token_b, _ = _register(client, "friendb")
    code_a = client.get("/api/auth/me", headers=_auth(token_a)).get_json()["user"]["friend_code"]
    code_b = client.get("/api/auth/me", headers=_auth(token_b)).get_json()["user"]["friend_code"]

    self_add = client.post("/api/friends/requests", json={"identifier": code_a}, headers=_auth(token_a))
    assert self_add.status_code == 400
    assert self_add.get_json()["error"] == "cannot_add_self"

    sent = client.post("/api/friends/requests", json={"identifier": code_a}, headers=_auth(token_b))
    assert sent.get_json()["status"] == "pending"
    request_id = sent.get_json()["request_id"]

    duplicate = client.post("/api/friends/requests", json={"identifier": code_a}, headers=_auth(token_b))
    assert duplicate.get_json()["error"] == "request_pending"

    inbox = client.get("/api/friends", headers=_auth(token_a)).get_json()
    assert inbox["incoming_count"] == 1
    assert inbox["incoming"][0]["display_name"] == "Friendb"

    accepted = client.post(f"/api/friends/requests/{request_id}/accept", headers=_auth(token_a))
    assert accepted.status_code == 200
    assert client.get("/api/friends", headers=_auth(token_a)).get_json()["friends_count"] == 1
    assert client.get("/api/friends", headers=_auth(token_b)).get_json()["friends_count"] == 1

    wrong_accept = client.post(f"/api/friends/requests/{request_id}/accept", headers=_auth(token_a))
    assert wrong_accept.status_code == 400

    removed = client.delete(f"/api/friends/{code_a}", headers=_auth(token_b))
    assert removed.status_code == 200
    assert client.get("/api/friends", headers=_auth(token_a)).get_json()["friends_count"] == 0

    again = client.delete(f"/api/friends/{code_a}", headers=_auth(token_b))
    assert again.get_json()["error"] == "not_friends"


def test_reciprocal_request_auto_accepts(client):
    token_a, _ = _register(client, "mutuala")
    token_b, _ = _register(client, "mutualb")
    code_a = client.get("/api/auth/me", headers=_auth(token_a)).get_json()["user"]["friend_code"]
    code_b = client.get("/api/auth/me", headers=_auth(token_b)).get_json()["user"]["friend_code"]

    assert (
        client.post("/api/friends/requests", json={"identifier": code_a}, headers=_auth(token_b))
        .get_json()["status"]
        == "pending"
    )
    result = client.post(
        "/api/friends/requests", json={"identifier": code_b}, headers=_auth(token_a)
    ).get_json()
    assert result["status"] == "accepted"
    assert client.get("/api/friends", headers=_auth(token_a)).get_json()["friends_count"] == 1


# ---------------------------------------------------------------------------
# Match stats & achievements
# ---------------------------------------------------------------------------

def _seed_finished_solo_match():
    user_a, _, player_a = _link_account("statwinner")
    user_b, _, player_b = _link_account("statloser")
    room, _ = room_service.create_room(player_a, "SOLO", 2)
    room_service.join_room(player_b, room.join_code)

    from app.domain.models import Match

    match = Match(
        room_id=room.id,
        overs=2,
        wickets=2,
        team_a_name="Statwinner's Team",
        team_b_name="Statloser's Team",
    )
    match.winner = "A"
    match.team_a_runs = 12
    match.team_b_runs = 9
    repo.save_match(match)

    repo.save_delivery(
        Delivery(
            match_id=match.id,
            innings=InningsPhase.FIRST,
            over_index=0,
            ball_index=0,
            batter_pick=4,
            bowler_pick=2,
            batter_id=player_a.id,
            bowler_id=player_b.id,
            result=DeliveryResult.RUNS,
            runs_scored=4,
            committed=True,
        )
    )
    repo.save_delivery(
        Delivery(
            match_id=match.id,
            innings=InningsPhase.FIRST,
            over_index=0,
            ball_index=1,
            batter_id=player_a.id,
            bowler_id=player_b.id,
            result=DeliveryResult.TIMEOUT,
            runs_scored=0,
            committed=True,
        )
    )
    repo.save_delivery(
        Delivery(
            match_id=match.id,
            innings=InningsPhase.SECOND,
            over_index=0,
            ball_index=0,
            batter_pick=3,
            bowler_pick=3,
            batter_id=player_b.id,
            bowler_id=player_a.id,
            result=DeliveryResult.OUT,
            committed=True,
        )
    )
    return (user_a, user_b, room, match, player_a, player_b)


def test_recording_match_stats_updates_both_accounts_once():
    user_a, user_b, room, match, player_a, player_b = _seed_finished_solo_match()

    assert accounts_service.record_match_stats(room, match) == 2
    # A retried completion path must not double-count the match.
    assert accounts_service.record_match_stats(room, match) == 0

    stats_a = accounts_service.build_stats(user_a["id"])
    stats_b = accounts_service.build_stats(user_b["id"])

    assert stats_a["matches"] == 1
    assert stats_a["wins"] == 1
    assert stats_a["runs"] == 4
    assert stats_a["wickets"] == 1
    assert stats_a["dead_balls"] == 1
    assert stats_a["best_score"] == 4
    assert stats_a["current_streak"] == 1

    assert stats_b["matches"] == 1
    assert stats_b["losses"] == 1
    assert stats_b["wickets"] == 0
    assert stats_b["runs"] == 0
    assert stats_b["best_streak"] == 0

    recent_a = accounts_repo.list_recent_matches(user_a["id"])
    assert recent_a[0]["result"] == "WIN"
    assert recent_a[0]["opponent_name"] == "Statloser"

    codes_a = accounts_repo.list_achievement_codes(user_a["id"])
    assert {"FIRST_MATCH", "FIRST_WIN"} <= codes_a
    codes_b = accounts_repo.list_achievement_codes(user_b["id"])
    assert "FIRST_MATCH" in codes_b
    assert "FIRST_WIN" not in codes_b


def test_guest_match_does_not_create_account_stats():
    guest_a, _ = room_service.create_or_restore_player("GuestA", None)
    guest_b, _ = room_service.create_or_restore_player("GuestB", None)
    room, _ = room_service.create_room(guest_a, "SOLO", 1)
    room_service.join_room(guest_b, room.join_code)

    from app.domain.models import Match

    match = Match(room_id=room.id, overs=1, wickets=1, team_a_name="A", team_b_name="B")
    match.winner = "A"
    repo.save_match(match)

    assert accounts_service.record_match_stats(room, match) == 0


def test_full_match_completion_credits_logged_in_players():
    """The real gameplay path (not the seeding helper) must record stats."""
    user_a, _, player_a = _link_account("realone")
    user_b, _, player_b = _link_account("realtwo")

    room, _ = room_service.create_room(player_a, "SOLO", 1, wickets=1)
    room_service.join_room(player_b, room.join_code)
    room_service.set_ready(room, player_a, True)
    room_service.set_ready(room, player_b, True)

    room_service.start_toss(room, player_a)
    toss = room_service.call_toss(room, player_b, "HEADS")
    winner = player_a if toss["winner_id"] == player_a.id else player_b
    match = room_service.decide_toss(room, winner, "BAT")

    for member in repo.get_room_members(room.id):
        room, match, _ = room_service.confirm_first_ball_ready(
            room, repo.get_player(member.player_id)
        )
    assert room.status.value == "INNINGS_ACTIVE"

    batting = player_a if match.batting_team == "A" else player_b
    bowling = player_b if batting is player_a else player_a

    # 4 runs, then a wicket on the next ball ends the one-wicket innings.
    room_service.submit_pick(room, batting, 4)
    match, reveal = room_service.submit_pick(room, bowling, 6)
    assert reveal.runs_scored == 4
    room_service.submit_pick(room, batting, 3)
    match, reveal = room_service.submit_pick(room, bowling, 3)
    assert reveal.result == DeliveryResult.OUT
    assert room.status.value == "INNINGS_BREAK"

    room, match = room_service.start_second_innings(room)
    # Chasing side wins with a six on the first ball (target 5).
    room_service.submit_pick(room, bowling, 6)
    match, reveal = room_service.submit_pick(room, batting, 2)
    assert reveal.runs_scored == 6
    assert room.status.value == "MATCH_COMPLETE"
    assert match.winner is not None

    stats_a = accounts_service.build_stats(user_a["id"])
    stats_b = accounts_service.build_stats(user_b["id"])
    assert stats_a["matches"] == 1
    assert stats_b["matches"] == 1
    assert stats_a["runs"] + stats_b["runs"] == 10
    assert {stats_a["wins"], stats_b["wins"]} == {0, 1}
    assert {stats_a["losses"], stats_b["losses"]} == {0, 1}
    assert (stats_a["wickets"] + stats_b["wickets"]) == 1
