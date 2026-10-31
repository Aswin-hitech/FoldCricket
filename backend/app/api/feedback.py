"""
Player Feedback REST API endpoint.
Receives post-match feedback reports and persists them to Supabase Storage and Database.
"""

from flask import Blueprint, jsonify, request

from ..security.utils import SimpleRateLimiter, sanitize_text
from ..services.supabase_logger import get_client_ip, log_feedback_to_supabase_async

bp = Blueprint("feedback", __name__)

_feedback_limiter = SimpleRateLimiter(max_tokens=6, refill_per_second=0.1)


@bp.route("/feedback", methods=["POST", "OPTIONS"])
def submit_feedback():
    if request.method == "OPTIONS":
        return jsonify({"status": "ok"}), 200

    headers = {k.lower(): v for k, v in request.headers.items()}
    client_ip = get_client_ip(headers, request.remote_addr)
    if not _feedback_limiter.allow(client_ip):
        return jsonify({"error": "rate_limited", "message": "Too many submissions."}), 429

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        data = {}

    player_id = sanitize_text(data.get("player_id"), 64) or "unknown"
    player_name = sanitize_text(data.get("player_name"), 48) or "Anonymous Player"

    try:
        rating = int(data.get("rating", 5))
    except (TypeError, ValueError):
        rating = 5
    rating = max(1, min(5, rating))

    raw_categories = data.get("categories", [])
    categories = (
        [sanitize_text(c, 32) for c in raw_categories if isinstance(c, str)][:10]
        if isinstance(raw_categories, list)
        else []
    )
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}

    log_feedback_to_supabase_async(
        player_id=player_id,
        player_name=player_name,
        rating=rating,
        feedback_text=sanitize_text(data.get("feedback_text"), 2000),
        categories=categories,
        room_code=sanitize_text(data.get("room_code"), 16) or None,
        client_ip=client_ip,
        headers=headers,
        metadata=metadata,
    )

    return jsonify({
        "success": True,
        "message": "Feedback successfully submitted and saved to Supabase",
    }), 200
