"""
Player account API: auth, profile, user search, friends.

Every endpoint is JSON-only. Authenticated endpoints read an opaque bearer
token from the Authorization header; the token is never accepted from the
query string or cookies, which also removes CSRF exposure entirely.
"""

from __future__ import annotations

from functools import wraps

from flask import Blueprint, g, jsonify, request

from ..services import accounts_service
from ..services.accounts_service import AccountError
from ..security.utils import SimpleRateLimiter

bp = Blueprint("accounts", __name__)

_register_limiter = SimpleRateLimiter(max_tokens=6, refill_per_second=0.05)
_login_ip_limiter = SimpleRateLimiter(max_tokens=20, refill_per_second=0.3)
_login_user_limiter = SimpleRateLimiter(max_tokens=8, refill_per_second=0.1)
_search_limiter = SimpleRateLimiter(max_tokens=30, refill_per_second=1.0)
_social_limiter = SimpleRateLimiter(max_tokens=20, refill_per_second=0.5)


@bp.errorhandler(AccountError)
def _account_error(error: AccountError):
    return jsonify({"error": error.code, "message": error.message}), error.status


def _json_body() -> dict:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def _remote() -> str:
    return request.remote_addr or "unknown"


def _bearer_token() -> str:
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:].strip()
    return ""


def _load_viewer():
    token = _bearer_token()
    if not token:
        return None, None
    user = accounts_service.resolve_session(token)
    return user, token


def require_user(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        user, token = _load_viewer()
        if not user:
            return jsonify({"error": "not_authenticated", "message": "Sign in to continue."}), 401
        g.user = user
        g.token = token
        return view(*args, **kwargs)

    return wrapper


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

@bp.post("/auth/register")
def register():
    if not _register_limiter.allow(_remote()):
        return jsonify({"error": "rate_limited", "message": "Too many attempts. Try again shortly."}), 429

    body = _json_body()
    user, token = accounts_service.register(
        username=body.get("username", ""),
        display_name=body.get("display_name", ""),
        password=body.get("password", ""),
        avatar=body.get("avatar"),
        user_agent=request.headers.get("User-Agent", ""),
    )
    return jsonify({"token": token, "profile": accounts_service.owner_profile(user)}), 201


@bp.post("/auth/login")
def login():
    body = _json_body()
    username = str(body.get("username", "")).strip().lower()
    remote = _remote()

    if not _login_ip_limiter.allow(remote) or not _login_user_limiter.allow(f"{remote}:{username}"):
        return jsonify({"error": "rate_limited", "message": "Too many attempts. Try again shortly."}), 429

    user, token = accounts_service.login(
        username=body.get("username", ""),
        password=body.get("password", ""),
        user_agent=request.headers.get("User-Agent", ""),
    )
    return jsonify({"token": token, "profile": accounts_service.owner_profile(user)})


@bp.post("/auth/logout")
@require_user
def logout():
    accounts_service.revoke_session(g.token)
    return jsonify({"ok": True})


@bp.get("/auth/me")
@require_user
def me():
    return jsonify(accounts_service.owner_profile(g.user))


@bp.post("/auth/password")
@require_user
def change_password():
    body = _json_body()
    accounts_service.change_password(
        g.user,
        body.get("current_password", ""),
        body.get("new_password", ""),
        g.user.get("session_id", ""),
    )
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------

@bp.get("/profile")
@require_user
def get_profile():
    return jsonify(accounts_service.owner_profile(g.user))


@bp.patch("/profile")
@require_user
def update_profile():
    payload = accounts_service.update_profile(g.user, _json_body())
    return jsonify(payload)


# ---------------------------------------------------------------------------
# Users (search by friend code, public/friend profiles)
# ---------------------------------------------------------------------------

@bp.get("/users/search")
@require_user
def search_users():
    if not _search_limiter.allow(_remote()):
        return jsonify({"error": "rate_limited"}), 429
    query = (request.args.get("q") or "").strip()
    if len(query) < 3:
        return jsonify({"results": []})
    return jsonify({"results": accounts_service.search_users(query, g.user)})


@bp.get("/users/<path:identifier>")
@require_user
def public_profile(identifier: str):
    target = accounts_service.find_user(identifier)
    if not target:
        return jsonify({"error": "user_not_found", "message": "No player found with that ID."}), 404
    return jsonify(accounts_service.profile_for_viewer(target, g.user))


# ---------------------------------------------------------------------------
# Friends
# ---------------------------------------------------------------------------

@bp.get("/friends")
@require_user
def friends():
    return jsonify(accounts_service.friend_list(g.user["id"]))


@bp.post("/friends/requests")
@require_user
def send_request():
    if not _social_limiter.allow(_remote()):
        return jsonify({"error": "rate_limited"}), 429
    body = _json_body()
    identifier = str(body.get("identifier") or body.get("code") or "")
    result = accounts_service.send_friend_request(g.user, identifier)
    result["profile"] = accounts_service.owner_profile(g.user)
    return jsonify(result)


@bp.post("/friends/requests/<request_id>/accept")
@require_user
def accept_request(request_id: str):
    if not _social_limiter.allow(_remote()):
        return jsonify({"error": "rate_limited"}), 429
    result = accounts_service.accept_friend_request(g.user, request_id)
    result["profile"] = accounts_service.owner_profile(g.user)
    return jsonify(result)


@bp.post("/friends/requests/<request_id>/decline")
@require_user
def decline_request(request_id: str):
    if not _social_limiter.allow(_remote()):
        return jsonify({"error": "rate_limited"}), 429
    return jsonify(accounts_service.decline_friend_request(g.user, request_id))


@bp.delete("/friends/<path:identifier>")
@require_user
def remove_friend(identifier: str):
    if not _social_limiter.allow(_remote()):
        return jsonify({"error": "rate_limited"}), 429
    return jsonify(accounts_service.remove_friend(g.user, identifier))
