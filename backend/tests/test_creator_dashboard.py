"""
Creator dashboard: aggregate insights and access control.
"""

from datetime import datetime

import pytest

from app import create_app
from app.api import creator as creator_api
from app.domain.models import Delivery, DeliveryResult, InningsPhase, Match
from app.repositories import memory as repo
from app.repositories.insights import get_creator_insights
from app.services import room_service


@pytest.fixture(autouse=True)
def clean_memory():
    repo.clear_all()
    creator_api._request_limiter._buckets.clear()
    creator_api._login_limiter._buckets.clear()


@pytest.fixture
def app():
    application = create_app()
    application.config["TESTING"] = True
    return application


@pytest.fixture
def client(app):
    with app.test_client() as c:
        yield c


def _seed_finished_match():
    host, _ = room_service.create_or_restore_player("DashHost", None)
    guest, _ = room_service.create_or_restore_player("DashGuest", None)
    room, _ = room_service.create_room(host, "TEAM", 2, wickets=2)
    room_service.join_room(guest, room.join_code)

    match = Match(
        room_id=room.id,
        overs=2,
        wickets=2,
        team_a_name="DashHost's Team",
        team_b_name="DashGuest's Team",
    )
    match.winner = "A"
    match.team_a_runs = 7
    match.team_a_wickets = 1
    match.team_b_runs = 5
    match.team_b_wickets = 2
    repo.save_match(match)

    repo.save_delivery(
        Delivery(
            match_id=match.id,
            innings=InningsPhase.FIRST,
            over_index=0,
            ball_index=0,
            batter_pick=3,
            bowler_pick=5,
            batter_id=host.id,
            bowler_id=guest.id,
            result=DeliveryResult.RUNS,
            runs_scored=3,
            committed=True,
        )
    )
    repo.save_delivery(
        Delivery(
            match_id=match.id,
            innings=InningsPhase.FIRST,
            over_index=0,
            ball_index=1,
            batter_id=host.id,
            bowler_id=guest.id,
            result=DeliveryResult.TIMEOUT,
            runs_scored=0,
            committed=True,
        )
    )
    repo.save_delivery(
        Delivery(
            match_id=match.id,
            innings=InningsPhase.FIRST,
            over_index=0,
            ball_index=1,
            batter_pick=4,
            bowler_pick=2,
            batter_id=host.id,
            bowler_id=guest.id,
            result=DeliveryResult.RUNS,
            runs_scored=4,
            committed=True,
        )
    )
    return room, match, host, guest


def _seed_solo_match():
    host, _ = room_service.create_or_restore_player("SoloHost", None)
    guest, _ = room_service.create_or_restore_player("SoloGuest", None)
    room, _ = room_service.create_room(host, "SOLO", 2, wickets=1)
    room_service.join_room(guest, room.join_code)

    match = Match(
        room_id=room.id,
        overs=2,
        wickets=1,
        team_a_name="SoloHost's Team",
        team_b_name="SoloGuest's Team",
    )
    match.winner = "A"
    match.team_a_runs = 6
    match.team_a_wickets = 0
    match.team_b_runs = 2
    match.team_b_wickets = 1
    repo.save_match(match)

    repo.save_delivery(
        Delivery(
            match_id=match.id,
            innings=InningsPhase.FIRST,
            over_index=0,
            ball_index=0,
            batter_pick=6,
            bowler_pick=1,
            batter_id=host.id,
            bowler_id=guest.id,
            result=DeliveryResult.RUNS,
            runs_scored=6,
            committed=True,
        )
    )
    return room, match, host, guest


def test_insights_aggregate_players_matches_and_deliveries():
    _seed_finished_match()

    data = get_creator_insights(7)
    totals = data["totals"]

    assert totals["players"] == 2
    assert totals["matches"] == 1
    assert totals["completed_matches"] == 1
    assert totals["completion_rate"] == 1.0
    assert totals["live_rooms"] == 1
    assert totals["deliveries"] == 3
    assert totals["dead_balls"] == 1
    assert totals["dead_ball_rate"] == pytest.approx(0.333, abs=0.001)
    assert totals["runs"] == 7
    assert totals["team_matches"] == 1
    assert totals["solo_matches"] == 0

    assert data["delivery_mix"]["3"] == 1
    assert data["delivery_mix"]["4"] == 1
    assert data["delivery_mix"]["dead"] == 1
    assert len(data["activity"]) == 7
    assert data["activity"][-1]["matches"] == 1
    assert data["recent_matches"][0]["join_code"]
    assert data["recent_matches"][0]["duration_minutes"] is not None
    assert [b["name"] for b in data["top_batters"]] == ["DashHost"]


def test_mode_filter_narrows_matches_deliveries_and_leaderboards():
    _seed_finished_match()
    _seed_solo_match()

    team = get_creator_insights(7, mode="TEAM")
    assert team["filters"]["mode"] == "TEAM"
    assert team["totals"]["matches"] == 1
    assert team["totals"]["team_matches"] == 1
    assert team["totals"]["solo_matches"] == 0
    assert team["totals"]["deliveries"] == 3
    assert team["delivery_mix"]["dead"] == 1

    solo = get_creator_insights(7, mode="SOLO")
    assert solo["filters"]["mode"] == "SOLO"
    assert solo["totals"]["matches"] == 1
    assert solo["totals"]["solo_matches"] == 1
    assert solo["totals"]["team_matches"] == 0
    assert solo["totals"]["deliveries"] == 1
    assert solo["totals"]["dead_balls"] == 0
    assert solo["delivery_mix"]["6"] == 1

    unfiltered = get_creator_insights(7)
    assert unfiltered["filters"]["mode"] is None
    assert unfiltered["totals"]["matches"] == 2


def test_date_filter_scopes_totals_but_keeps_the_full_trend():
    _seed_finished_match()
    today = datetime.utcnow().date().isoformat()

    data = get_creator_insights(7, date=today)
    assert data["filters"]["date"] == today
    assert data["totals"]["matches"] == 1
    assert data["totals"]["deliveries"] == 3
    # Trend context stays visible while the aggregate is sliced to one day.
    assert len(data["activity"]) == 7
    assert len(data["hourly"]) == 24
    assert sum(point["deliveries"] for point in data["hourly"]) == 3
    # Yesterday had no activity.
    assert data["previous"]["matches"] == 0


def test_invalid_filters_are_ignored():
    _seed_finished_match()
    data = get_creator_insights(7, mode="banana", date="not-a-day")
    assert data["filters"] == {"mode": None, "date": None}
    assert data["totals"]["matches"] == 1

    # Dates outside the visible window are dropped rather than 400ing.
    stale = get_creator_insights(7, date="2001-01-01")
    assert stale["filters"]["date"] is None


def _login(client, username="aswin_dashboard", password="12345678"):
    return client.post(
        "/api/creator/login", json={"username": username, "password": password}
    )


def _bearer(client) -> dict[str, str]:
    token = _login(client).get_json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_api_requires_a_login_even_from_loopback(client):
    _seed_finished_match()
    assert client.get("/api/creator/insights").status_code == 401

    response = client.get(
        "/api/creator/insights", environ_overrides={"REMOTE_ADDR": "203.0.113.9"}
    )
    assert response.status_code == 401
    assert response.get_json()["error"] == "unauthorized"

    authed = client.get("/api/creator/insights", headers=_bearer(client))
    assert authed.status_code == 200
    assert authed.get_json()["totals"]["matches"] == 1


def test_login_rejects_wrong_credentials_without_leaking_which_field(client):
    wrong_password = _login(client, password="letmein")
    assert wrong_password.status_code == 401
    assert wrong_password.get_json()["error"] == "invalid_credentials"

    wrong_username = _login(client, username="aswin")
    assert wrong_username.status_code == 401
    assert wrong_username.get_json()["error"] == "invalid_credentials"

    missing = client.post("/api/creator/login", json={"username": "aswin_dashboard"})
    assert missing.status_code == 401
    assert missing.get_json()["error"] == "invalid_credentials"


def test_login_token_is_signed_and_required(client):
    _seed_finished_match()
    tampered = _bearer(client)
    tampered["Authorization"] += "x"
    assert client.get("/api/creator/insights", headers=tampered).status_code == 401

    assert (
        client.get(
            "/api/creator/insights", headers={"Authorization": "Bearer not-a-token"}
        ).status_code
        == 401
    )


def test_login_is_rate_limited(client):
    for _ in range(10):
        assert _login(client, password="nope").status_code == 401
    blocked = _login(client, password="nope")
    assert blocked.status_code == 429
    assert blocked.get_json()["error"] == "rate_limited"


def test_api_still_accepts_the_automation_key(app, client):
    _seed_finished_match()
    app.config["CREATOR_DASHBOARD_KEY"] = "creator-secret"

    assert client.get("/api/creator/insights").status_code == 401
    assert (
        client.get(
            "/api/creator/insights", headers={"X-Creator-Key": "wrong"}
        ).status_code
        == 401
    )

    ok = client.get("/api/creator/insights", headers={"X-Creator-Key": "creator-secret"})
    assert ok.status_code == 200
    # A valid key works from any address.
    remote_ok = client.get(
        "/api/creator/insights",
        headers={"X-Creator-Key": "creator-secret"},
        environ_overrides={"REMOTE_ADDR": "203.0.113.9"},
    )
    assert remote_ok.status_code == 200


def test_api_clamps_the_range(client):
    headers = _bearer(client)

    response = client.get("/api/creator/insights?days=500", headers=headers)
    assert response.status_code == 200
    assert response.get_json()["days"] == 90

    bad = client.get("/api/creator/insights?days=abc", headers=headers)
    assert bad.status_code == 200
    assert bad.get_json()["days"] == 7
