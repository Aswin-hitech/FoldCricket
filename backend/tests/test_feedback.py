"""
Tests for player feedback API endpoint and Supabase persistence handler.
"""

import json
import pytest
from app import create_app


@pytest.fixture
def client():
    app = create_app()
    app.config["TESTING"] = True
    with app.test_client() as client:
        yield client


def test_submit_feedback_endpoint(client):
    payload = {
        "player_id": "test-player-123",
        "player_name": "Aswin N",
        "rating": 5,
        "feedback_text": "Loved the nostalgic finger notations and sound effects!",
        "categories": ["🏏 Vintage School Memories", "⚡ Fast Real-time Sync"],
        "room_code": "ABCD",
        "metadata": {"test": True},
    }

    response = client.post(
        "/api/feedback",
        data=json.dumps(payload),
        content_type="application/json",
    )

    assert response.status_code == 200
    data = response.get_json()
    assert data["success"] is True
    assert "saved" in data["message"].lower() or "submitted" in data["message"].lower()
