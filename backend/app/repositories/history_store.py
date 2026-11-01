"""
Startup reconciliation for lifetime match history.

The local SQLite file is the read model for the creator dashboard, but it is
recreated on every deploy. Neon Postgres keeps the durable copy. This module
merges the two stores once per boot: durable rows are pulled down so all-time
totals survive a deploy, and rows recorded while the local store was active are
pushed up so the durable copy stays complete.

No scorecard is ever invented: a row recovered from per-player match stats
carries ``score_known = 0`` and is only replaced by a real scorecard.
"""

from __future__ import annotations

import logging

from . import account_store, postgres_history
from . import sqlite as sqlite_repo
from .postgres_accounts import PostgresStoreError

logger = logging.getLogger(__name__)


def _is_richer(local: dict, remote: dict) -> bool:
    """True when the local row carries information the durable row lacks."""
    if local.get("score_known") and not remote.get("score_known"):
        return True
    if local.get("completed_at") and not remote.get("completed_at"):
        return True
    if (
        not local.get("score_known")
        and not remote.get("score_known")
        and int(local.get("total_runs") or 0) > int(remote.get("total_runs") or 0)
    ):
        return True
    return False


def reconcile() -> dict:
    """Merge local and durable history. Safe to call when Postgres is inactive."""
    empty = {"pushed": 0, "pulled": 0}
    if not account_store.is_postgres() or not postgres_history.configured():
        return empty
    if not postgres_history.ensure_schema():
        return empty

    try:
        remote_rows = postgres_history.fetch_all()
    except PostgresStoreError as error:
        logger.warning("Postgres match history sync skipped: %s", error)
        return empty

    local_rows = sqlite_repo.list_match_history()
    remote_by_id = {row["match_id"]: row for row in remote_rows}
    local_by_id = {row["match_id"]: row for row in local_rows}

    to_push = [
        row
        for row in local_rows
        if row["match_id"] not in remote_by_id
        or _is_richer(row, remote_by_id[row["match_id"]])
    ]
    pulled = 0
    if to_push:
        try:
            postgres_history.upsert_rows(to_push)
        except PostgresStoreError as error:
            logger.warning("Could not push local match history to Postgres: %s", error)
            to_push = []
        else:
            logger.info("Pushed %s lifetime match row(s) to Postgres.", len(to_push))

    to_pull = [
        row
        for row in remote_rows
        if row["match_id"] not in local_by_id
        or _is_richer(row, local_by_id[row["match_id"]])
    ]
    if to_pull:
        pulled = sqlite_repo.import_match_history(to_pull)
        if pulled:
            logger.info("Pulled %s lifetime match row(s) from Postgres.", pulled)

    return {"pushed": len(to_push), "pulled": pulled}
