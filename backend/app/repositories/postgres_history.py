"""
Durable lifetime match history in Neon Postgres.

Rooms, matches and deliveries are purged from the local SQLite file an hour
after they are created, and the hosting disk itself is not persistent. The
``app_match_history`` table keeps one row per match forever so the creator
dashboard can report all-time totals across deploys.

The row shape mirrors the local ``match_history`` table one-to-one, which lets
the reconciliation in ``history_store`` copy rows between the two stores
without translation.
"""

from __future__ import annotations

import logging
from typing import Optional

from psycopg.rows import dict_row

from . import postgres_accounts
from .postgres_accounts import PostgresStoreError, _connection, _iso, _utc

logger = logging.getLogger(__name__)

HISTORY_TABLE = "app_match_history"

HISTORY_COLUMNS = (
    "match_id",
    "room_id",
    "join_code",
    "mode",
    "team_a_name",
    "team_b_name",
    "team_a_runs",
    "team_a_wickets",
    "team_b_runs",
    "team_b_wickets",
    "winner",
    "result_summary",
    "overs",
    "target",
    "deliveries",
    "dead_balls",
    "total_runs",
    "score_known",
    "duration_known",
    "started_at",
    "completed_at",
)

_TIMESTAMP_COLUMNS = frozenset({"started_at", "completed_at"})
_FLAG_COLUMNS = frozenset({"score_known", "duration_known"})
_SELECT = ", ".join(HISTORY_COLUMNS)
_MAX_PAGE = 1000

_SCHEMA_SQL = f"""
create table if not exists public.{HISTORY_TABLE} (
    match_id       text primary key,
    room_id        text not null default '',
    join_code      text not null default '',
    mode           text not null default '',
    team_a_name    text not null default '',
    team_b_name    text not null default '',
    team_a_runs    integer not null default 0,
    team_a_wickets integer not null default 0,
    team_b_runs    integer not null default 0,
    team_b_wickets integer not null default 0,
    winner         text,
    result_summary text,
    overs          integer not null default 0,
    target         integer,
    deliveries     integer not null default 0,
    dead_balls     integer not null default 0,
    total_runs     integer not null default 0,
    score_known    boolean not null default true,
    duration_known boolean not null default true,
    started_at     timestamptz not null,
    completed_at   timestamptz
);
create index if not exists idx_app_match_history_started
    on public.{HISTORY_TABLE} (started_at);
create index if not exists idx_app_match_history_completed
    on public.{HISTORY_TABLE} (completed_at);
"""


def configured() -> bool:
    return postgres_accounts.configured()


def ensure_schema() -> bool:
    """Create the lifetime history table. Idempotent."""
    if not configured():
        return False
    try:
        with _connection() as conn:
            with conn.cursor() as cur:
                cur.execute(_SCHEMA_SQL)
        return True
    except PostgresStoreError as error:
        logger.warning("Could not create the Neon/Postgres match history table: %s", error)
        return False


def _row_values(row: dict) -> tuple:
    values = []
    for column in HISTORY_COLUMNS:
        value = row.get(column)
        if column in _TIMESTAMP_COLUMNS:
            value = _utc(value)
        elif column in _FLAG_COLUMNS:
            value = bool(value)
        elif value is None and column not in ("winner", "result_summary", "target"):
            value = ""
        values.append(value)
    return tuple(values)


def _row_to_dict(row) -> dict:
    result = dict(row)
    for column in _TIMESTAMP_COLUMNS:
        result[column] = _iso(result.get(column))
    for column in _FLAG_COLUMNS:
        result[column] = 1 if result.get(column) else 0
    return result


def upsert_rows(rows: list[dict]) -> int:
    """Insert or improve rows. A scorecard always beats a stats-only row."""
    if not rows:
        return 0
    placeholders = ", ".join("%s" for _ in HISTORY_COLUMNS)
    updates = ", ".join(
        f"{column} = excluded.{column}"
        for column in HISTORY_COLUMNS
        if column != "match_id"
    )
    with _connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(
                f"""
                INSERT INTO public.{HISTORY_TABLE} ({_SELECT})
                VALUES ({placeholders})
                ON CONFLICT (match_id) DO UPDATE SET {updates}
                WHERE (excluded.score_known AND NOT public.{HISTORY_TABLE}.score_known)
                   OR (public.{HISTORY_TABLE}.completed_at IS NULL
                       AND excluded.completed_at IS NOT NULL)
                """,
                [_row_values(row) for row in rows],
            )
    return len(rows)


def fetch_all() -> list[dict]:
    """Every durable history row, oldest first."""
    rows: list[dict] = []
    offset = 0
    with _connection() as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            while True:
                cur.execute(
                    f"SELECT {_SELECT} FROM public.{HISTORY_TABLE} "
                    "ORDER BY started_at ASC, match_id ASC LIMIT %s OFFSET %s",
                    (_MAX_PAGE, offset),
                )
                page = cur.fetchall()
                rows.extend(_row_to_dict(item) for item in page)
                if len(page) < _MAX_PAGE:
                    return rows
                offset += _MAX_PAGE


def count_rows() -> Optional[int]:
    try:
        with _connection() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT COUNT(*) FROM public.{HISTORY_TABLE}")
                row = cur.fetchone()
        return int(row[0]) if row else 0
    except PostgresStoreError:
        return None
