"""
Creator dashboard API.

Insights are read-only and gated behind a signed-in creator session.
Credentials live only on the server (CREATOR_USERNAME / CREATOR_PASSWORD);
a successful login returns a signed, expiring bearer token that the
dashboard sends as ``Authorization: Bearer``. The optional
``X-Creator-Key`` header stays available for automation.
"""

import hmac

from flask import Blueprint, current_app, jsonify, request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from ..repositories.insights import get_creator_insights
from ..security.utils import SimpleRateLimiter

bp = Blueprint("creator", __name__)

_request_limiter = SimpleRateLimiter(max_tokens=60, refill_per_second=1.0)
_login_limiter = SimpleRateLimiter(max_tokens=10, refill_per_second=0.1)

_TOKEN_SALT = "hcl-creator-dashboard"


def _configured_key() -> str:
    return current_app.config.get("CREATOR_DASHBOARD_KEY", "") or ""


def _configured_username() -> str:
    return current_app.config.get("CREATOR_USERNAME", "") or ""


def _configured_password() -> str:
    return current_app.config.get("CREATOR_PASSWORD", "") or ""


def _session_seconds() -> int:
    try:
        hours = int(current_app.config.get("CREATOR_SESSION_HOURS", 12))
    except (TypeError, ValueError):
        hours = 12
    return max(1, hours) * 3600


def _credentials_configured() -> bool:
    return bool(_configured_username()) and bool(_configured_password())


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.config["SECRET_KEY"], salt=_TOKEN_SALT)


def _issue_token(username: str) -> str:
    return _serializer().dumps({"u": username})


def _token_username(token: str) -> str | None:
    try:
        payload = _serializer().loads(token, max_age=_session_seconds())
    except (BadSignature, SignatureExpired):
        return None
    username = payload.get("u") if isinstance(payload, dict) else None
    return username if isinstance(username, str) else None


def _bearer_token() -> str:
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


def _authorised() -> bool:
    configured_key = _configured_key()
    if configured_key:
        provided_key = request.headers.get("X-Creator-Key", "")
        if provided_key and hmac.compare_digest(provided_key, configured_key):
            return True

    token = _bearer_token() or request.headers.get("X-Creator-Session", "")
    if not token:
        return False
    username = _token_username(token)
    expected = _configured_username()
    return bool(username and expected and hmac.compare_digest(username, expected))


@bp.post("/creator/login")
def login():
    remote = request.remote_addr or "unknown"
    if not _login_limiter.allow(remote):
        return jsonify({"error": "rate_limited"}), 429

    if not _credentials_configured():
        return jsonify({"error": "dashboard_not_configured"}), 401

    payload = request.get_json(silent=True) or {}
    username = payload.get("username")
    password = payload.get("password")
    if not isinstance(username, str) or not isinstance(password, str):
        return jsonify({"error": "invalid_credentials"}), 401

    # Compare both fields so a wrong username and a wrong password take the
    # same path; never reveal which one failed.
    user_ok = hmac.compare_digest(username.strip(), _configured_username())
    pass_ok = hmac.compare_digest(password, _configured_password())
    if not (user_ok and pass_ok):
        return jsonify({"error": "invalid_credentials"}), 401

    return jsonify(
        {
            "token": _issue_token(_configured_username()),
            "expires_in": _session_seconds(),
        }
    )


@bp.get("/creator/insights")
def insights():
    remote = request.remote_addr or "unknown"
    if not _request_limiter.allow(remote):
        return jsonify({"error": "rate_limited"}), 429

    if not _authorised():
        if not _credentials_configured() and not _configured_key():
            return jsonify({"error": "dashboard_not_configured"}), 401
        return jsonify({"error": "unauthorized"}), 401

    try:
        days = int(request.args.get("days", 7))
    except (TypeError, ValueError):
        days = 7
    days = max(1, min(days, 90))

    mode = (request.args.get("mode") or "").strip().upper()
    if mode not in ("SOLO", "TEAM"):
        mode = None

    payload = get_creator_insights(
        days, mode=mode, date=request.args.get("date") or None
    )
    return jsonify(payload)
