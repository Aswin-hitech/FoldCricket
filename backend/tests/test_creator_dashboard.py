"""
Creator dashboard: aggregate insights and access control.
"""

import pytest

from app import create_app
from app.domain.models import Delivery, DeliveryResult, InningsPhase, Match
from app.repositories import memory as repo
from app.repositories.insights import get_creator_insights
from app.services import room_service


@pytest.fixture(autouse=True)
def clean_memory():
    repo.clear_all()


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


def test_api_allows_loopback_when_no_key_is_configured(client):
    _seed_finished_match()
    response = client.get("/api/creator/insights")
    assert response.status_code == 200
    assert response.get_json()["totals"]["matches"] == 1


def test_api_is_closed_to_public_traffic_when_no_key_is_configured(client):
    response = client.get(
        "/api/creator/insights", environ_overrides={"REMOTE_ADDR": "203.0.113.9"}
    )
    assert response.status_code == 401
    assert response.get_json()["error"] == "dashboard_not_configured"


def test_api_requires_the_configured_key(app, client):
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
    response = client.get("/api/creator/insights?days=500")
    assert response.status_code == 200
    assert response.get_json()["days"] == 90

    bad = client.get("/api/creator/insights?days=abc")
    assert bad.status_code == 200
    assert bad.get_json()["days"] == 7
