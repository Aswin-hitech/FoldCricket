"""
Flask application factory and configuration.
"""

from __future__ import annotations

import os


class Config:
    SECRET_KEY: str = os.getenv("SECRET_KEY", "dev-secret-change-in-production")
    DEBUG: bool = os.getenv("FLASK_DEBUG", "false").lower() == "true"

    # CORS
    raw_cors: str = os.getenv("CORS_ORIGINS", "*").strip()
    if raw_cors == "*" or not raw_cors:
        CORS_ORIGINS: str | list[str] = "*"
        SOCKETIO_CORS_ALLOWED_ORIGINS: str = "*"
    else:
        CORS_ORIGINS: list[str] = [o.strip() for o in raw_cors.split(",") if o.strip()]
        SOCKETIO_CORS_ALLOWED_ORIGINS: str | list[str] = CORS_ORIGINS

    # Socket.IO
    SOCKETIO_ASYNC_MODE: str = os.getenv("SOCKETIO_ASYNC_MODE", "threading")

    # Game
    DELIVERY_TIMEOUT_SECONDS: int = int(os.getenv("DELIVERY_TIMEOUT_SECONDS", "15"))
    RECONNECT_GRACE_SECONDS: int = int(os.getenv("RECONNECT_GRACE_SECONDS", "120"))
    ALLOWED_OVERS: list[int] = [int(x) for x in os.getenv("ALLOWED_OVERS", "1,2,5,10").split(",")]
    ROOM_CAPACITY: int = int(os.getenv("ROOM_CAPACITY", "20"))

    # Supabase IP Logging
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
