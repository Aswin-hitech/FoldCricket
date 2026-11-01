"""
Durable lifetime match history: store conversions and reconciliation rules.
"""

from datetime import datetime, timezone

import pytest

from app.repositories import history_store, postgres_history
from app.repositories import memory as repo
from app.repositories import sqlite as sqlite_repo


@pytest.fixture(autouse=True)
def clean_memory():
    repo.clear_all()


def _history_row(**overrides):
    base = {
        "match_id": "match-1",
        "room_id": "room-1",
        "join_code": "ABC123",
        "mode": "SOLO",
        "team_a_name": "",
        "team_b_name": "",
        "team_a_runs": 0,
        "team_a_wickets": 0,
        "team_b_runs": 0,
        "team_b_wickets": 0,
        "winner": None,
        "result_summary": None,
        "overs": 2,
        "target": None,
        "deliveries": 3,
        "dead_balls": 0,
        "total_runs": 8,
        "score_known": 0,
        "duration_known": 0,
        "started_at": "2026-01-01T10:00:00",
        "completed_at": "2026-01-01T10:05:00",
    }
    base.update(overrides)
    return base


def _only_history_row():
    rows = sqlite_repo.list_match_history()
    assert len(rows) == 1
    return rows[0]


def test_import_upgrades_a_scorecard_less_row_with_a_real_scorecard():
    assert sqlite_repo.import_match_history([_history_row()]) == 1
    assert _only_history_row()["score_known"] == 0

    upgraded = _history_row(
        team_a_name="Ash's Team",
        team_b_name="Sam's Team",
        team_a_runs=6,
        team_a_wickets=0,
        team_b_runs=2,
        team_b_wickets=1,
        winner="A",
        score_known=1,
        duration_known=1,
    )
    assert sqlite_repo.import_match_history([upgraded]) == 1

    row = _only_history_row()
    assert row["score_known"] == 1
    assert row["team_a_name"] == "Ash's Team"
    assert row["team_a_runs"] == 6
    assert row["winner"] == "A"


def test_import_never_downgrades_a_real_scorecard():
    scorecard = _history_row(
        team_a_name="Ash's Team",
        team_b_name="Sam's Team",
        team_a_runs=6,
        team_b_runs=2,
        winner="A",
        score_known=1,
        duration_known=1,
    )
    sqlite_repo.import_match_history([scorecard])

    assert sqlite_repo.import_match_history([_history_row()]) == 0

    row = _only_history_row()
    assert row["score_known"] == 1
    assert row["team_a_name"] == "Ash's Team"
    assert row["winner"] == "A"


def test_import_fills_a_missing_completion_time():
    sqlite_repo.import_match_history(
        [_history_row(completed_at=None, score_known=1, duration_known=1)]
    )
    assert _only_history_row()["completed_at"] is None

    assert (
        sqlite_repo.import_match_history(
            [_history_row(score_known=1, duration_known=1)]
        )
        == 1
    )
    assert _only_history_row()["completed_at"] == "2026-01-01T10:05:00"


def test_reconcile_is_a_noop_without_postgres():
    assert not postgres_history.configured()
    assert history_store.reconcile() == {"pushed": 0, "pulled": 0}


def test_postgres_row_conversion_round_trips_flags_and_timestamps():
    row = _history_row(score_known=1, duration_known=0)
    values = postgres_history._row_values(row)
    converted = dict(zip(postgres_history.HISTORY_COLUMNS, values))

    assert converted["score_known"] is True
    assert converted["duration_known"] is False
    assert converted["started_at"] == datetime(
        2026, 1, 1, 10, 0, tzinfo=timezone.utc
    )

    restored = postgres_history._row_to_dict(
        {**row, "score_known": True, "duration_known": False}
    )
    assert restored["score_known"] == 1
    assert restored["duration_known"] == 0
    assert restored["started_at"] == "2026-01-01T10:00:00"


def test_is_richer_prefers_scorecards_and_completion_details():
    legacy = _history_row()

    scorecard = _history_row(
        score_known=1,
        duration_known=1,
        team_a_name="Ash's Team",
        team_a_runs=6,
    )
    assert history_store._is_richer(scorecard, legacy)
    assert not history_store._is_richer(legacy, scorecard)

    unfinished = _history_row(completed_at=None)
    assert history_store._is_richer(_history_row(), unfinished)
    assert not history_store._is_richer(unfinished, _history_row())
