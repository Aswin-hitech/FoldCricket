"""
Flask application factory and configuration.
"""

from __future__ import annotations

import os

from werkzeug.security import generate_password_hash

# Werkzeug scrypt hash of the built-in dashboard password. The plaintext is
# never stored in code or config; override with CREATOR_PASSWORD_HASH (preferred)
# or the legacy CREATOR_PASSWORD, which is hashed in memory at startup.
_DEFAULT_CREATOR_PASSWORD_HASH = (
    "scrypt:32768:8:1$qcVqYTV2asJy7AQX$"
    "df7d9c50a0f712065bfdd4c3e8ab084ddaca2537ae7f3a1615ea2569e81c79be"
    "36dcd8e70cd72dcff570f9003ded774a056070f0d28be0bde9a2e58df9b82d96"
)

_creator_password_env = os.getenv("CREATOR_PASSWORD", "")
_creator_password_hash_env = os.getenv("CREATOR_PASSWORD_HASH", "").strip()
if _creator_password_hash_env:
    _CREATOR_PASSWORD_HASH = _creator_password_hash_env
elif _creator_password_env:
    _CREATOR_PASSWORD_HASH = generate_password_hash(_creator_password_env)
else:
    _CREATOR_PASSWORD_HASH = _DEFAULT_CREATOR_PASSWORD_HASH
del _creator_password_env


class Config:
    SECRET_KEY: str = os.getenv("SECRET_KEY", "dev-secret-change-in-production")
    DEBUG: bool = os.getenv("FLASK_DEBUG", "false").lower() == "true"

    # CORS
    raw_cors: str = os.getenv("CORS_ORIGINS", "").strip()
    is_prod: bool = not DEBUG and os.getenv("FLASK_ENV") != "development"
    if not raw_cors or raw_cors == "*" or "your-app.vercel.app" in raw_cors:
        if is_prod:
            # Strict production CORS protection
            origins = [
                "https://fold-cricket.vercel.app",
                "https://foldcricket.vercel.app",
                "http://localhost:5173",
                "http://localhost:3000",
                "http://127.0.0.1:5173",
                "http://127.0.0.1:3000",
            ]
            CORS_ORIGINS: list[str] = origins
            SOCKETIO_CORS_ALLOWED_ORIGINS: list[str] = origins
        else:
            CORS_ORIGINS: str | list[str] = "*"
            SOCKETIO_CORS_ALLOWED_ORIGINS: str = "*"
    else:
        origins = [o.strip() for o in raw_cors.split(",") if o.strip()]
        if "https://fold-cricket.vercel.app" not in origins:
            origins.append("https://fold-cricket.vercel.app")
        CORS_ORIGINS: list[str] = origins
        SOCKETIO_CORS_ALLOWED_ORIGINS: list[str] = origins

    # Socket.IO
    SOCKETIO_ASYNC_MODE: str = os.getenv("SOCKETIO_ASYNC_MODE", "threading")

    # Creator dashboard. The creator signs in with these credentials; the
    # server issues a signed, expiring bearer token. Only a password hash is
    # kept (never the plaintext). Override both values in the environment for
    # any real deployment. The optional CREATOR_DASHBOARD_KEY remains an
    # automation-only bypass header.
    CREATOR_USERNAME: str = os.getenv("CREATOR_USERNAME", "aswin_dashboard")
    CREATOR_PASSWORD_HASH: str = _CREATOR_PASSWORD_HASH
    CREATOR_SESSION_HOURS: int = int(os.getenv("CREATOR_SESSION_HOURS", "12"))
    CREATOR_DASHBOARD_KEY: str = os.getenv("CREATOR_DASHBOARD_KEY", "")

    # Player accounts. Sessions are opaque bearer tokens stored hashed at
    # rest; the browser keeps the raw token and sends it as Authorization:
    # Bearer. 30 days of inactivity expires a session.
    ACCOUNT_SESSION_DAYS: int = int(os.getenv("ACCOUNT_SESSION_DAYS", "30"))

    # Account storage. "sqlite" keeps accounts in the local file, "postgres"
    # stores them in Neon Postgres (tables are created automatically on first
    # boot; see neon/accounts_schema.sql for the full user-data schema), and
    # "auto" uses Postgres when DATABASE_URL is set, otherwise the local file.
    USER_STORE: str = os.getenv("USER_STORE", "auto").strip().lower()

    # Neon Postgres connection string used for player accounts. Neon provides
    # this in the dashboard; keep the pooled URL if available.
    DATABASE_URL: str = (
        os.getenv("DATABASE_URL", "").strip()
        or os.getenv("NEON_DATABASE_URL", "").strip()
    )

    # Game rules (20-second authoritative server deadline per delivery)
    DELIVERY_TIMEOUT_SECONDS: int = int(os.getenv("DELIVERY_TIMEOUT_SECONDS", "20"))
    INNINGS_BREAK_SECONDS: int = int(os.getenv("INNINGS_BREAK_SECONDS", "10"))
    RECONNECT_GRACE_SECONDS: int = int(os.getenv("RECONNECT_GRACE_SECONDS", "120"))
    ALLOWED_OVERS: list[int] = [int(x) for x in os.getenv("ALLOWED_OVERS", "1,2,5,10").split(",")]
    ROOM_CAPACITY: int = int(os.getenv("ROOM_CAPACITY", "20"))

    # Supabase IP Logging & Storage
    SUPABASE_URL: str = os.getenv("SUPABASE_URL", "")
    SUPABASE_KEY: str = (
        os.getenv("SUPABASE_SECRET_KEY")
        or os.getenv("SUPABASE_KEY")
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("SUPABASE_PUBLISHABLE_KEY")
        or os.getenv("SUPABASE_ANON_KEY")
        or ""
    )
    SUPABASE_BUCKET_NAME: str = os.getenv("SUPABASE_BUCKET_NAME", "ip-logs")
