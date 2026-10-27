"""
Flask application factory and configuration.
"""

from __future__ import annotations

import os


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

    # Game rules (15-second authoritative server deadline)
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
