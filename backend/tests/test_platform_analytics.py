"""Unit tests for the Supabase-backed feedback and visit aggregates."""

from datetime import datetime, timedelta

import pytest

from app.services import platform_analytics as analytics


def _folder_map(files):
    def fake_list(base, key, bucket, prefix, deadline):
        yield from files.get(prefix, [])

    return fake_list


def _day(offset: int) -> str:
    return (datetime.utcnow() - timedelta(days=offset)).date().isoformat()


def test_visit_aggregation_counts_visits_visitors_actions_and_today(monkeypatch):
    today = _day(0)
    yesterday = _day(1)
    files = {
        "records/": [{"name": today}, {"name": yesterday}],
        f"records/{today}/": [
            {"name": "1_2_3_4_1700000000000_app_visit.json"},
            {"name": "1_2_3_4_1700000001000_app_visit.json"},
            {"name": "5_6_7_8_1700000002000_app_visit.json"},
            {"name": "1_2_3_4_1700000003000_socket_connect.json"},
        ],
        f"records/{yesterday}/": [
            {"name": "9_9_9_9_1690000000000_app_visit.json"},
        ],
    }
    monkeypatch.setattr(analytics, "_list_folder", _folder_map(files))

    result = analytics._fetch_visits("base", "key", "bucket", 10**9)

    assert result["total_visits"] == 4
    assert result["unique_visitors"] == 3
    assert result["visits_today"] == 3
    assert result["unique_today"] == 2
    assert result["total_events"] == 5
    assert result["days_covered"] == 2
    assert dict((item["action"], item["count"]) for item in result["actions"]) == {
        "app_visit": 4,
        "socket_connect": 1,
    }
    assert len(result["activity"]) == 30
    assert result["activity"][-1]["date"] == today
    assert result["activity"][-1]["visits"] == 3
    assert result["activity"][-1]["visitors"] == 2
    assert result["truncated"] is False


def test_visit_scan_reports_truncation_when_the_budget_expires(monkeypatch):
    today = _day(0)

    def slow_list(base, key, bucket, prefix, deadline):
        if prefix == "records/":
            yield {"name": today}
            return
        yield {"name": "1_2_3_4_1700000000000_app_visit.json"}
        raise analytics._DeadlineExceeded

    monkeypatch.setattr(analytics, "_list_folder", slow_list)

    result = analytics._fetch_visits("base", "key", "bucket", 10**9)

    assert result["truncated"] is True
    assert result["total_events"] == 1
    assert result["total_visits"] == 1


def test_listing_raises_once_the_budget_is_spent(monkeypatch):
    monkeypatch.setattr(analytics, "_request", lambda *args, **kwargs: b"[]")

    with pytest.raises(analytics._DeadlineExceeded):
        list(analytics._list_folder("base", "key", "bucket", "records/", 0))


def test_feedback_aggregation_reads_ratings_categories_and_recent(monkeypatch):
    today = _day(0)
    yesterday = _day(1)
    files = {
        "feedback/": [{"name": today}, {"name": yesterday}],
        f"feedback/{today}/": [{"name": "p1_1700000000000.json"}],
        f"feedback/{yesterday}/": [
            {"name": "p2_1690000000000.json"},
            {"name": "p3_1680000000000.json"},
        ],
    }
    documents = {
        f"feedback/{today}/p1_1700000000000.json": {
            "player_name": "Asha",
            "rating": 5,
            "feedback_text": "Loved it",
            "categories": ["Vintage"],
            "room_code": "ABC123",
            "timestamp_utc": "2026-10-31T10:00:00Z",
        },
        f"feedback/{yesterday}/p2_1690000000000.json": {
            "player_name": "Ravi",
            "rating": 3,
            "feedback_text": "",
            "categories": ["Vintage", "Speed"],
        },
        f"feedback/{yesterday}/p3_1680000000000.json": {
            "player_name": "Meera",
            "rating": 4,
            "feedback_text": "Nice",
            "categories": [],
        },
    }
    monkeypatch.setattr(analytics, "_list_folder", _folder_map(files))
    monkeypatch.setattr(
        analytics,
        "_download_json",
        lambda base, key, bucket, path: documents[path],
    )

    result = analytics._fetch_feedback("base", "key", "bucket", 10**9)

    assert result["total"] == 3
    assert result["average_rating"] == 4.0
    assert result["rating_distribution"] == {"1": 0, "2": 0, "3": 1, "4": 1, "5": 1}
    assert result["categories"][0] == {"name": "Vintage", "count": 2}
    assert [entry["player_name"] for entry in result["recent"]] == ["Asha", "Ravi", "Meera"]
    assert result["recent"][0]["room_code"] == "ABC123"
    assert result["last_at"] is not None


def test_analytics_without_credentials_is_empty(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "")
    analytics.reset_cache()

    payload = analytics.get_platform_analytics()

    assert payload["source"] == "not_configured"
    assert payload["feedback"]["total"] == 0
    assert payload["visits"]["total_visits"] == 0
