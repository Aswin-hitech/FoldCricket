"""Health check endpoint."""

from flask import Blueprint, jsonify

from ..repositories import account_store

bp = Blueprint("health", __name__)


@bp.get("/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "service": "handcricket-live",
            "account_store": account_store.active_backend(),
        }
    )
