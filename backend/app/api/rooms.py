"""Room metadata REST endpoints."""

from flask import Blueprint, jsonify, request

from ..repositories import memory as repo
from ..security.utils import room_lookup_rate_limiter
from ..services.supabase_logger import get_client_ip

bp = Blueprint("rooms", __name__)


def _client_key() -> str:
    headers = {k.lower(): v for k, v in request.headers.items()}
    return get_client_ip(headers, request.remote_addr)


@bp.get("/rooms/<room_id>")
def get_room(room_id: str):
    if not room_lookup_rate_limiter.allow(_client_key()):
        return jsonify({"error": "rate_limited"}), 429
    if len(room_id) > 64:
        return jsonify({"error": "room_not_found"}), 404
    room = repo.get_room(room_id)
    if not room:
        return jsonify({"error": "room_not_found"}), 404
    return jsonify(room.to_public_dict())


@bp.get("/rooms/code/<join_code>")
def get_room_by_code(join_code: str):
    if not room_lookup_rate_limiter.allow(_client_key()):
        return jsonify({"error": "rate_limited"}), 429
    if len(join_code) > 12:
        return jsonify({"error": "room_not_found"}), 404
    room = repo.get_room_by_code(join_code.upper())
    if not room:
        return jsonify({"error": "room_not_found"}), 404
    return jsonify(room.to_public_dict())
