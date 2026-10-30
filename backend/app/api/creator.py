"""
Creator dashboard API.

Read-only aggregate insights, gated behind a creator key. When no key is
configured the API stays available to loopback requests only, so local
development works out of the box while deployments must set
CREATOR_DASHBOARD_KEY.
"""

import hmac

from flask import Blueprint, current_app, jsonify, request

from ..repositories.insights import get_creator_insights
from ..security.utils import SimpleRateLimiter

bp = Blueprint("creator", __name__)

_request_limiter = SimpleRateLimiter(max_tokens=60, refill_per_second=1.0)

_LOOPBACK = {"127.0.0.1", "::1"}


def _configured_key() -> str:
    return current_app.config.get("CREATOR_DASHBOARD_KEY", "") or ""


def _authorised(configured: str) -> bool:
    if configured:
        provided = request.headers.get("X-Creator-Key", "")
        return bool(provided) and hmac.compare_digest(provided, configured)
    # No key configured: local development only. remote_addr is not
    # spoofable through headers, so this stays closed on a public host.
    return (request.remote_addr or "") in _LOOPBACK


@bp.get("/creator/insights")
def insights():
    remote = request.remote_addr or "unknown"
    if not _request_limiter.allow(remote):
        return jsonify({"error": "rate_limited"}), 429

    configured = _configured_key()
    if not _authorised(configured):
        error = "unauthorized" if configured else "dashboard_not_configured"
        return jsonify({"error": error}), 401

    try:
        days = int(request.args.get("days", 7))
    except (TypeError, ValueError):
        days = 7
    days = max(1, min(days, 90))

    payload = get_creator_insights(days)
    return jsonify(payload)
