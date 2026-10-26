"""Room metadata REST endpoints."""

from flask import Blueprint, jsonify, request

from ..repositories import memory as repo
from ..services import room_service

bp = Blueprint("rooms", __name__)


@bp.get("/rooms/<room_id>")
def get_room(room_id: str):
    room = repo.get_room(room_id)
    if not room:
        return jsonify({"error": "room_not_found"}), 404
    return jsonify(room.to_public_dict())


@bp.get("/rooms/code/<join_code>")
def get_room_by_code(join_code: str):
    room = repo.get_room_by_code(join_code.upper())
    if not room:
        return jsonify({"error": "room_not_found"}), 404
    return jsonify(room.to_public_dict())
