"""
SQL-level tests for the Neon/Postgres account repository.

These run only when TEST_DATABASE_URL points at a disposable database (a Neon
branch or a local Postgres). The schema is applied idempotently and test rows
are deleted afterwards. Example:

    TEST_DATABASE_URL=postgresql://... pytest tests/test_postgres_integration.py
"""

import os
import pathlib
import uuid
from datetime import datetime, timedelta

import psycopg
import pytest

from app.repositories import postgres_accounts

TEST_DSN = os.getenv("TEST_DATABASE_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not TEST_DSN, reason="set TEST_DATABASE_URL to run Postgres integration tests"
)

SCHEMA_PATH = pathlib.Path(__file__).resolve().parents[1] / "neon" / "accounts_schema.sql"


@pytest.fixture
def store():
    with psycopg.connect(TEST_DSN, autocommit=True) as conn:
        conn.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
    postgres_accounts.configure(TEST_DSN)
    yield postgres_accounts
    try:
        with psycopg.connect(TEST_DSN, autocommit=True) as conn:
            conn.execute("DELETE FROM public.app_user_sessions WHERE user_id IN "
                         "(SELECT id FROM public.app_users WHERE username LIKE 'it\\_%')")
            conn.execute("DELETE FROM public.app_users WHERE username LIKE 'it\\_%'")
    finally:
        postgres_accounts.close()
        postgres_accounts.configure("", "")


def test_user_and_session_round_trip(store):
    suffix = uuid.uuid4().hex[:10]
    user = store.create_user(
        username=f"it_{suffix}",
        display_name="Integration User",
        password_hash="scrypt:placeholder",
        friend_code=f"IT-{suffix.upper()}",
        avatar="🏏",
    )

    assert store.probe()
    assert store.get_user_by_id(user["id"])["username"] == f"it_{suffix}"
    assert store.get_user_by_username(f"IT_{suffix.upper()}")["id"] == user["id"]
    assert store.get_user_by_friend_code(f"it-{suffix}")["id"] == user["id"]
    assert store.username_exists(f"it_{suffix}")
    assert store.friend_code_exists(f"it-{suffix}")
    assert [row["id"] for row in store.get_users_by_ids([user["id"], "missing"])] == [
        user["id"]
    ]

    updated = store.update_user(user["id"], {"bio": "hello", "display_name": "Renamed"})
    assert updated["bio"] == "hello"
    assert updated["display_name"] == "Renamed"

    with pytest.raises(store.DuplicateRowError):
        store.create_user(
            username=f"IT_{suffix}",
            display_name="Duplicate",
            password_hash="x",
            friend_code=f"IT-OTHER-{suffix.upper()}",
            avatar="x",
        )

    future = (datetime.utcnow() + timedelta(days=1)).isoformat()
    session = store.create_session(
        user_id=user["id"], token_hash="a" * 64, user_agent="pytest", expires_at=future
    )
    loaded = store.get_session("a" * 64)
    assert loaded["id"] == user["id"]
    assert loaded["session_id"] == session["id"]
    assert loaded["session_expires_at"] == future
    assert "+" not in loaded["session_expires_at"]

    store.touch_session(session["id"], (datetime.utcnow() + timedelta(days=2)).isoformat())
    assert store.get_session("a" * 64)["session_expires_at"] != future

    store.create_session(
        user_id=user["id"], token_hash="b" * 64, user_agent="", expires_at=future
    )
    store.delete_other_sessions(user["id"], session["id"])
    assert store.get_session("b" * 64) is None
    store.delete_session("a" * 64)
    assert store.get_session("a" * 64) is None

    store.upsert_users([{**user, "bio": "upserted"}])
    assert store.get_user_by_id(user["id"])["bio"] == "upserted"
    sessions = store.fetch_all_sessions()
    assert isinstance(sessions, list)
    store.purge_expired_sessions()
