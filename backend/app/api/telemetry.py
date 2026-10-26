"""
Telemetry and IP logging REST API endpoint.
"""

from flask import Blueprint, jsonify, request
from ..services.supabase_logger import get_client_ip, log_ip_event_async

bp = Blueprint("telemetry", __name__)


@bp.route("/log-ip", methods=["GET", "POST"])
def log_ip():
    headers = {k.lower(): v for k, v in request.headers.items()}
    client_ip = get_client_ip(headers, request.remote_addr)

    client_metadata = {}
    action = "api_visit"

    if request.method == "POST" and request.is_json:
        data = request.get_json(silent=True) or {}
        action = data.get("action", "client_event")
        client_metadata = data

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
