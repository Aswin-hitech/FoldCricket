"""
Durable account storage: Neon/Postgres user/session store, local mirror,
reconciliation, error mapping and hashed creator credentials.

The transport is replaced with an in-memory implementation here so these tests
never touch a real database. ``test_postgres_integration.py`` covers the SQL
against a real Postgres when TEST_DATABASE_URL is provided.
"""

import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest
from werkzeug.security import check_password_hash

from app import create_app
from app.api import accounts as accounts_api
from app.config import Config
from app.repositories import account_store, postgres_accounts
from app.repositories import accounts as accounts_repo
from app.repositories import memory as repo
from app.repositories.sqlite import _get_connection
from app.services import accounts_service
from app.services.accounts_service import AccountError


class FakePostgres:
    """In-memory implementation of the postgres_accounts public surface."""

    def __init__(self):
        self.users: dict[str, dict] = {}
        self.sessions: dict[str, dict] = {}

    def _now(self):
        return datetime.utcnow().isoformat()

    def _conflict(self, username=None, friend_code=None, skip_id=None):
        for row in self.users.values():
            if skip_id and row["id"] == skip_id:
                continue
            if username is not None and row["username"].lower() == username.lower():
                return True
            if friend_code is not None and row["friend_code"] == friend_code:
                return True
        return False

    def probe(self, timeout: float = 4.0):
        return True

    def create_user(self, *, username, display_name, password_hash, friend_code, avatar):
        if self._conflict(username=username, friend_code=friend_code):
            raise postgres_accounts.DuplicateRowError("duplicate_row")
        now = self._now()
        user = {
            "id": str(uuid.uuid4()),
            "username": username,
            "display_name": display_name,
            "password_hash": password_hash,
            "friend_code": friend_code,
            "avatar": avatar,
            "bio": "",
            "default_mode": "SOLO",
            "default_overs": 2,
            "default_wickets": 1,
            "created_at": now,
            "updated_at": now,
        }
        self.users[user["id"]] = user
        return dict(user)

    def get_user_by_id(self, user_id):
        user = self.users.get(user_id)
        return dict(user) if user else None

    def get_user_by_username(self, username):
        key = (username or "").strip().lower()
        for user in self.users.values():
            if user["username"].lower() == key:
                return dict(user)
        return None

    def get_user_by_friend_code(self, code):
        key = (code or "").strip().upper()
        for user in self.users.values():
            if user["friend_code"] == key:
                return dict(user)
        return None

    def friend_code_exists(self, code):
        return self.get_user_by_friend_code(code) is not None

    def username_exists(self, username):
        return self.get_user_by_username(username) is not None

    def get_users_by_ids(self, user_ids):
        return [dict(self.users[uid]) for uid in user_ids if uid in self.users]

    def update_user(self, user_id, fields):
        user = self.users.get(user_id)
        if not user:
            return None
        allowed = {
            "display_name",
            "avatar",
            "bio",
            "default_mode",
            "default_overs",
            "default_wickets",
            "password_hash",
        }
        user.update({k: v for k, v in fields.items() if k in allowed})
        user["updated_at"] = self._now()
        return dict(user)

    def upsert_users(self, users):
        for incoming in users:
            row = dict(incoming)
            if self._conflict(
                username=row.get("username"),
                friend_code=row.get("friend_code"),
                skip_id=row["id"],
            ):
                raise postgres_accounts.DuplicateRowError("duplicate_row")
            existing = self.users.get(row["id"], {})
            merged = {**existing, **row}
            merged.setdefault("bio", "")
            merged.setdefault("default_mode", "SOLO")
            merged.setdefault("default_overs", 2)
            merged.setdefault("default_wickets", 1)
            merged.setdefault("created_at", self._now())
            merged.setdefault("updated_at", self._now())
            self.users[row["id"]] = merged

    def fetch_all_users(self):
        return [dict(user) for user in self.users.values()]

    def create_session(self, *, user_id, token_hash, user_agent, expires_at):
        session_id = str(uuid.uuid4())
        now = self._now()
        self.sessions[session_id] = {
            "id": session_id,
            "user_id": user_id,
            "token_hash": token_hash,
            "user_agent": (user_agent or "")[:255],
            "created_at": now,
            "last_used_at": now,
            "expires_at": expires_at,
        }
        return {"id": session_id, "user_id": user_id, "expires_at": expires_at}

    def get_session(self, token_hash):
        for session in self.sessions.values():
            if session["token_hash"] == token_hash:
                user = self.users.get(session["user_id"])
                if not user:
                    return None
                payload = dict(user)
                payload["session_id"] = session["id"]
                payload["session_expires_at"] = session["expires_at"]
                payload["session_last_used_at"] = session["last_used_at"]
                return payload
        return None

    def touch_session(self, session_id, expires_at):
        session = self.sessions.get(session_id)
        if session:
            session["last_used_at"] = self._now()
            session["expires_at"] = expires_at

    def delete_session(self, token_hash):
        for session_id, session in list(self.sessions.items()):
            if session["token_hash"] == token_hash:
                self.sessions.pop(session_id, None)

    def delete_other_sessions(self, user_id, keep_session_id):
        for session_id, session in list(self.sessions.items()):
            if session["user_id"] == user_id and session_id != keep_session_id:
                self.sessions.pop(session_id, None)

    def purge_expired_sessions(self):
        now = self._now()
        for session_id, session in list(self.sessions.items()):
            if session["expires_at"] < now:
                self.sessions.pop(session_id, None)

    def fetch_all_sessions(self):
        return [dict(session) for session in self.sessions.values()]

    def upsert_sessions(self, sessions):
        for session in sessions:
            self.sessions[session["id"]] = dict(session)


@pytest.fixture(autouse=True)
def clean_state():
    repo.clear_all()
    for limiter in (
        accounts_api._register_limiter,
        accounts_api._login_ip_limiter,
        accounts_api._login_user_limiter,
    ):
        limiter._buckets.clear()
    from app.api import creator as creator_api

    creator_api._login_limiter._buckets.clear()
    creator_api._request_limiter._buckets.clear()
    account_store.set_backend_for_tests(account_store.BACKEND_SQLITE)
    postgres_accounts.configure("", "")
    yield
    account_store.set_backend_for_tests(account_store.BACKEND_SQLITE)
    account_store._cache_clear()
    postgres_accounts.close()
    postgres_accounts.configure("", "")


@pytest.fixture
def fake_postgres(monkeypatch):
    fake = FakePostgres()
    for name in (
        "create_user",
        "get_user_by_id",
        "get_user_by_username",
        "get_user_by_friend_code",
        "friend_code_exists",
        "username_exists",
        "get_users_by_ids",
        "update_user",
        "upsert_users",
        "fetch_all_users",
        "create_session",
        "get_session",
        "touch_session",
        "delete_session",
        "delete_other_sessions",
        "purge_expired_sessions",
        "fetch_all_sessions",
        "upsert_sessions",
        "probe",
    ):
        monkeypatch.setattr(postgres_accounts, name, getattr(fake, name))
    monkeypatch.setattr(postgres_accounts, "configured", lambda: True)
    backend = account_store.configure(
        {"USER_STORE": "postgres", "DATABASE_URL": "postgresql://fake/db"}
    )
    assert backend == account_store.BACKEND_POSTGRES
    yield fake


def _local_users() -> dict[str, dict]:
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT id, username, password_hash, friend_code FROM users"
        ).fetchall()
    return {row["id"]: dict(row) for row in rows}


def _local_sessions() -> dict[str, dict]:
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT id, user_id, token_hash, expires_at FROM user_sessions"
        ).fetchall()
    return {row["id"]: dict(row) for row in rows}


# ---------------------------------------------------------------------------
# Postgres-backed users and sessions
# ---------------------------------------------------------------------------

def test_register_writes_hashed_user_to_postgres_and_local_mirror(fake_postgres):
    user, token = accounts_service.register("neon_user", "Neon User", "testpass123")

    assert len(fake_postgres.users) == 1
    stored = next(iter(fake_postgres.users.values()))
    assert stored["id"] == user["id"]
    assert stored["friend_code"] == user["friend_code"]
    assert stored["password_hash"] != "testpass123"
    assert check_password_hash(stored["password_hash"], "testpass123")

    # Raw bearer token is never stored; only its SHA-256 hash is.
    assert len(fake_postgres.sessions) == 1
    session = next(iter(fake_postgres.sessions.values()))
    assert session["token_hash"] != token
    assert len(session["token_hash"]) == 64

    # The SQLite mirror keeps the existing joins working.
    mirrored = _local_users()
    assert user["id"] in mirrored
    assert mirrored[user["id"]]["username"] == "neon_user"
    assert user["id"] in {row["user_id"] for row in _local_sessions().values()}


def test_login_and_session_lifecycle_use_postgres(fake_postgres):
    accounts_service.register("neon_login", "Neon Login", "testpass123")
    user, token = accounts_service.login("NEON_LOGIN", "testpass123")

    resolved = accounts_service.resolve_session(token)
    assert resolved and resolved["id"] == user["id"]
    assert resolved["session_id"]

    accounts_service.revoke_session(token)
    assert accounts_service.resolve_session(token) is None
    token_hash = accounts_service._token_hash(token)
    assert all(
        session["token_hash"] != token_hash
        for session in fake_postgres.sessions.values()
    )
    assert all(
        session["token_hash"] != token_hash for session in _local_sessions().values()
    )


def test_duplicate_username_surfaces_as_username_taken(fake_postgres):
    accounts_service.register("dupe_user", "Dupe User", "testpass123")

    with pytest.raises(AccountError) as error:
        accounts_service.register("DUPE_USER", "Dupe Again", "testpass123")
    assert error.value.code == "username_taken"

    existing = next(iter(fake_postgres.users.values()))
    with pytest.raises(account_store.UserStoreConflict):
        accounts_repo.create_user(
            username="dupe_other",
            display_name="Dupe Other",
            password_hash=existing["password_hash"],
            friend_code=existing["friend_code"],
            avatar="🏏",
        )


def test_profile_updates_are_written_to_postgres_and_mirror(fake_postgres):
    user, _ = accounts_service.register("profile_user", "Profile User", "testpass123")
    accounts_repo.update_user(user["id"], {"bio": "hello", "display_name": "Renamed"})

    stored = fake_postgres.users[user["id"]]
    assert stored["bio"] == "hello"
    assert stored["display_name"] == "Renamed"
    assert _local_users()[user["id"]]["username"] == "profile_user"

    refreshed = accounts_repo.get_user_by_id(user["id"])
    assert refreshed["bio"] == "hello"


def test_reconcile_unions_postgres_and_local_accounts(fake_postgres):
    local_user, _ = accounts_service.register("local_only", "Local Only", "testpass123")

    now = datetime.utcnow()
    local_session_id = "22222222-2222-2222-2222-222222222222"
    with _get_connection() as conn:
        conn.execute(
            """
            INSERT INTO user_sessions (
                id, user_id, token_hash, user_agent, created_at, last_used_at, expires_at
            ) VALUES (?, ?, ?, '', ?, ?, ?)
            """,
            (
                local_session_id,
                local_user["id"],
                "a" * 64,
                now.isoformat(),
                now.isoformat(),
                (now + timedelta(days=1)).isoformat(),
            ),
        )

    remote_user = {
        "id": "11111111-1111-1111-1111-111111111111",
        "username": "remote_only",
        "display_name": "Remote Only",
        "password_hash": "scrypt:placeholder",
        "friend_code": "REMOTE",
        "avatar": "🏏",
        "bio": "",
        "default_mode": "SOLO",
        "default_overs": 2,
        "default_wickets": 1,
        "created_at": "2026-01-01T00:00:00",
        "updated_at": "2026-01-01T00:00:00",
    }
    fake_postgres.users[remote_user["id"]] = dict(remote_user)

    result = account_store.reconcile()

    assert result["users"] == 2
    assert remote_user["id"] in _local_users()
    assert local_user["id"] in fake_postgres.users
    assert local_session_id in fake_postgres.sessions
    assert local_session_id in _local_sessions()


def test_health_reports_active_account_store():
    app = create_app()
    account_store.set_backend_for_tests(account_store.BACKEND_POSTGRES)
    app.config["TESTING"] = True
    with app.test_client() as client:
        payload = client.get("/health").get_json()
    assert payload["account_store"] == "postgres"


def test_default_account_store_is_sqlite():
    app = create_app()
    app.config["TESTING"] = True
    with app.test_client() as client:
        payload = client.get("/health").get_json()
    assert payload["account_store"] == "sqlite"


def test_missing_database_url_falls_back_to_sqlite():
    backend = account_store.configure({"USER_STORE": "postgres", "DATABASE_URL": ""})
    assert backend == account_store.BACKEND_SQLITE


def test_unprovisioned_database_falls_back_to_sqlite(monkeypatch):
    monkeypatch.setattr(postgres_accounts, "probe", lambda: False)
    monkeypatch.setattr(postgres_accounts, "ensure_schema", lambda: False)
    backend = account_store.configure(
        {"USER_STORE": "auto", "DATABASE_URL": "postgresql://fake/db"}
    )
    assert backend == account_store.BACKEND_SQLITE


def test_missing_tables_are_created_on_boot(monkeypatch):
    calls = {"ensure": 0}
    provisioned = {"value": False}

    def probe():
        return provisioned["value"]

    def ensure_schema():
        calls["ensure"] += 1
        provisioned["value"] = True
        return True

    monkeypatch.setattr(postgres_accounts, "probe", probe)
    monkeypatch.setattr(postgres_accounts, "ensure_schema", ensure_schema)
    backend = account_store.configure(
        {"USER_STORE": "auto", "DATABASE_URL": "postgresql://fake/db"}
    )
    assert backend == account_store.BACKEND_POSTGRES
    assert calls["ensure"] == 1


def test_postgres_url_is_never_used_as_the_sqlite_path(monkeypatch):
    from app.repositories import sqlite as sqlite_repo

    monkeypatch.delenv("SQLITE_PATH", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@ep-x.neon.tech/neondb")
    assert sqlite_repo._resolve_db_path() == sqlite_repo.DEFAULT_DB_PATH

    monkeypatch.setenv("DATABASE_URL", "sqlite:///tmp/legacy.db")
    assert sqlite_repo._resolve_db_path() == "tmp/legacy.db"

    monkeypatch.setenv("SQLITE_PATH", "D:/data/dev.db")
    assert sqlite_repo._resolve_db_path() == "D:/data/dev.db"


def test_naive_iso_timestamps_are_read_as_utc():
    assert postgres_accounts._utc("2026-01-02T03:04:05").isoformat() == (
        "2026-01-02T03:04:05+00:00"
    )
    aware = postgres_accounts._utc("2026-01-02T03:04:05+05:30")
    assert aware.isoformat() == "2026-01-01T21:34:05+00:00"
    assert postgres_accounts._utc("") == ""


# ---------------------------------------------------------------------------
# DSN handling and error mapping
# ---------------------------------------------------------------------------

def test_dsn_normalization():
    assert postgres_accounts._normalize_dsn("") == ""
    assert (
        postgres_accounts._normalize_dsn("postgres://u:p@db.example.com/x")
        == "postgresql://u:p@db.example.com/x?connect_timeout=10"
    )
    neon = postgres_accounts._normalize_dsn("postgresql://u:p@ep-x.neon.tech/neondb")
    assert neon.startswith("postgresql://u:p@ep-x.neon.tech/neondb?")
    assert "sslmode=require" in neon
    assert "connect_timeout=10" in neon
    already = "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require&connect_timeout=3"
    assert postgres_accounts._normalize_dsn(already) == already


def test_timestamp_normalization_is_naive_utc():
    aware = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    assert postgres_accounts._iso(aware) == "2026-01-01T21:34:05"
    naive = datetime(2026, 1, 2, 3, 4, 5)
    assert postgres_accounts._iso(naive) == "2026-01-02T03:04:05"
    assert postgres_accounts._iso("already-a-string") == "already-a-string"


class _RaisingPool:
    def __init__(self, error):
        self.error = error

    def connection(self):
        raise self.error


def test_unique_violation_maps_to_duplicate_row(monkeypatch):
    postgres_accounts.configure("postgresql://fake/db")
    monkeypatch.setattr(
        postgres_accounts,
        "_get_pool",
        lambda: _RaisingPool(psycopg.errors.UniqueViolation("duplicate key")),
    )
    with pytest.raises(postgres_accounts.DuplicateRowError):
        postgres_accounts.get_user_by_id("someone")


def test_connection_error_maps_to_store_error(monkeypatch):
    postgres_accounts.configure("postgresql://fake/db")
    monkeypatch.setattr(
        postgres_accounts,
        "_get_pool",
        lambda: _RaisingPool(psycopg.OperationalError("connection refused")),
    )
    with pytest.raises(postgres_accounts.PostgresStoreError):
        postgres_accounts.get_user_by_id("someone")


# ---------------------------------------------------------------------------
# Creator credentials
# ---------------------------------------------------------------------------

def test_creator_password_is_stored_as_a_hash():
    assert Config.CREATOR_PASSWORD_HASH != "12345678"
    assert Config.CREATOR_PASSWORD_HASH.startswith(("scrypt:", "pbkdf2:"))
    assert check_password_hash(Config.CREATOR_PASSWORD_HASH, "12345678")
    assert not check_password_hash(Config.CREATOR_PASSWORD_HASH, "wrong-password")


def test_creator_login_still_accepts_the_configured_credentials():
    app = create_app()
    app.config["TESTING"] = True
    with app.test_client() as client:
        ok = client.post(
            "/api/creator/login",
            json={"username": "aswin_dashboard", "password": "12345678"},
        )
        assert ok.status_code == 200
        assert ok.get_json()["token"]

        bad = client.post(
            "/api/creator/login",
            json={"username": "aswin_dashboard", "password": "12345678x"},
        )
        assert bad.status_code == 401
        assert bad.get_json()["error"] == "invalid_credentials"
