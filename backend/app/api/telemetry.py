"""
Telemetry and IP logging REST API endpoint.
"""

from flask import Blueprint, jsonify, request

from ..security.utils import SimpleRateLimiter, sanitize_text
from ..services.supabase_logger import get_client_ip, log_ip_event_async

bp = Blueprint("telemetry", __name__)

_telemetry_limiter = SimpleRateLimiter(max_tokens=30, refill_per_second=0.5)


@bp.route("/log-ip", methods=["GET", "POST"])
def log_ip():
    headers = {k.lower(): v for k, v in request.headers.items()}
    client_ip = get_client_ip(headers, request.remote_addr)

    if not _telemetry_limiter.allow(client_ip):
        return jsonify({"error": "rate_limited", "success": False}), 429

    client_metadata = {}
    action = "api_visit"

    if request.method == "POST" and request.is_json:
        data = request.get_json(silent=True)
        if isinstance(data, dict):
            # Only keep bounded scalar/list metadata; refuse to forward an
            # attacker-controlled payload of arbitrary size to the logger.
            for key, value in list(data.items())[:32]:
                if not isinstance(key, str) or len(key) > 64:
                    continue
                client_metadata[key] = value
            action = sanitize_text(data.get("action"), 40) or "client_event"

    log_ip_event_async(
        ip=client_ip,
        action=action,
        headers=headers,
        client_metadata=client_metadata,
    )

    return jsonify({
        "success": True,
        "ip": client_ip,
        "action": action,
    })
