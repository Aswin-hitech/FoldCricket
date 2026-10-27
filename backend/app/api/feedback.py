"""
Player Feedback REST API endpoint.
Receives post-match feedback reports and persists them to Supabase Storage and Database.
"""

from flask import Blueprint, jsonify, request
from ..services.supabase_logger import get_client_ip, log_feedback_to_supabase_async

bp = Blueprint("feedback", __name__)


@bp.route("/feedback", methods=["POST", "OPTIONS"])
def submit_feedback():
    if request.method == "OPTIONS":
        return jsonify({"status": "ok"}), 200

    headers = {k.lower(): v for k, v in request.headers.items()}
    client_ip = get_client_ip(headers, request.remote_addr)

    data = request.get_json(silent=True) or {}
    player_id = data.get("player_id", "unknown")
    player_name = data.get("player_name", "Anonymous Player")
    rating = int(data.get("rating", 5))
    feedback_text = data.get("feedback_text", "").strip()
    categories = data.get("categories", [])
    room_code = data.get("room_code")
    metadata = data.get("metadata", {})

    log_feedback_to_supabase_async(
        player_id=player_id,
        player_name=player_name,
        rating=rating,
        feedback_text=feedback_text,
        categories=categories,
        room_code=room_code,
        client_ip=client_ip,
        headers=headers,
        metadata=metadata,
    )

    return jsonify({
        "success": True,
        "message": "Feedback successfully submitted and saved to Supabase",
    }), 200
