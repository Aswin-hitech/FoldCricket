"""
Social world API: player discovery, presence, direct messages, play requests.

All endpoints are authenticated with the same opaque bearer session as the
account API; presence is never inferred from client-supplied values.
"""

from __future__ import annotations

from flask import Blueprint, g, jsonify, request

from ..security.utils import SimpleRateLimiter
from ..services import social_service
from ..services.accounts_service import AccountError
from .accounts import require_user

bp = Blueprint("social", __name__)

_search_limiter = SimpleRateLimiter(max_tokens=40, refill_per_second=1.5)
_dm_limiter = SimpleRateLimiter(max_tokens=30, refill_per_second=0.75)
_invite_limiter = SimpleRateLimiter(max_tokens=8, refill_per_second=0.1)


@bp.errorhandler(AccountError)
def _account_error(error: AccountError):
    return jsonify({"error": error.code, "message": error.message}), error.status


def _json_body() -> dict:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def _remote() -> str:
    return request.remote_addr or "unknown"


@bp.get("/social/search")
@require_user
def search():
    if not _search_limiter.allow(_remote()):
        return jsonify({"error": "rate_limited"}), 429
    query = (request.args.get("q") or "").strip()
    if len(query) < 2:
        return jsonify({"results": []})
    return jsonify({"results": social_service.search_players(query, g.user)})


@bp.get("/social/presence")
@require_user
def presence():
    return jsonify(social_service.friend_presence(g.user))


@bp.get("/social/unread")
@require_user
def unread():
    return jsonify(social_service.unread_summary(g.user))


# ---------------------------------------------------------------------------
# Direct messages
# ---------------------------------------------------------------------------

@bp.get("/social/threads")
@require_user
def threads():
    return jsonify(social_service.thread_list(g.user))


@bp.get("/social/threads/<path:identifier>")
@require_user
def thread(identifier: str):
    try:
        limit = int(request.args.get("limit", 80))
    except (TypeError, ValueError):
        limit = 80
    before = (request.args.get("before") or "").strip()
    return jsonify(social_service.thread_with(g.user, identifier, limit=limit, before=before))


@bp.post("/social/threads/<path:identifier>")
@require_user
def send(identifier: str):
    if not _dm_limiter.allow(g.user["id"]):
        return jsonify({"error": "rate_limited", "message": "Slow down a moment."}), 429
    body = _json_body()
    return jsonify(social_service.send_message(g.user, identifier, body.get("text", "")))


@bp.post("/social/threads/<path:identifier>/read")
@require_user
def read(identifier: str):
    return jsonify(social_service.mark_read(g.user, identifier))


# ---------------------------------------------------------------------------
# Play requests
# ---------------------------------------------------------------------------

@bp.get("/social/play-requests")
@require_user
def play_requests():
    return jsonify(social_service.list_play_requests(g.user))


@bp.post("/social/play-requests")
@require_user
def create_play_request():
    if not _invite_limiter.allow(g.user["id"]):
        return jsonify({"error": "rate_limited", "message": "Too many invites. Wait a moment."}), 429
    body = _json_body()
    identifier = str(body.get("identifier") or body.get("code") or body.get("user_id") or "")
    return jsonify(
        social_service.send_play_request(
            g.user,
            identifier,
            body.get("mode", "SOLO"),
            body.get("overs", 2),
            body.get("wickets"),
        )
    )


@bp.post("/social/play-requests/<request_id>/accept")
@require_user
def accept_play_request(request_id: str):
    return jsonify(social_service.respond_play_request(g.user, request_id, True))


@bp.post("/social/play-requests/<request_id>/decline")
@require_user
def decline_play_request(request_id: str):
    return jsonify(social_service.respond_play_request(g.user, request_id, False))


@bp.post("/social/play-requests/<request_id>/cancel")
@require_user
def cancel_play_request(request_id: str):
    return jsonify(social_service.cancel_play_request(g.user, request_id))
