"""
Social world service: player discovery, presence, direct messages and play
requests.

Presence is read from live gameplay rows; invites only turn into a room when
both accounts have a connected game identity, which keeps every handoff
verifiable by the normal room/socket rules.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from ..extensions import socketio
from ..repositories import accounts as accounts_repo
from ..repositories import social as social_repo
from ..repositories import sqlite as gameplay_repo
from ..repositories.social import PLAY_REQUEST_TTL_SECONDS
from ..security.utils import validate_chat_message
from . import accounts_service, room_service
from .accounts_service import AccountError

MAX_SEARCH_RESULTS = 12


def _emit_to_user(user_id: str, event: str, payload: dict) -> None:
    if not user_id:
        return
    socketio.emit(event, payload, to=f"user:{user_id}")


def _presence_for(user_ids: list[str]) -> dict[str, dict]:
    return social_repo.presence_map(user_ids)


def _light_user(user: dict) -> dict:
    return {
        "user_id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "avatar": user["avatar"],
        "friend_code": accounts_service.display_friend_code(user["friend_code"]),
    }


def _user_with_presence(user: dict, presence: dict) -> dict:
    payload = _light_user(user)
    payload["presence"] = presence
    return payload


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def search_players(query: str, viewer: dict) -> list[dict]:
    cleaned = (query or "").strip()
    if len(cleaned) < 2:
        return []

    candidates: list[dict] = []
    exact = accounts_service.find_user(cleaned)
    if exact and exact["id"] != viewer["id"]:
        candidates.append(exact)

    for row in social_repo.search_users(cleaned, viewer["id"], limit=MAX_SEARCH_RESULTS):
        if row["id"] != viewer["id"] and all(row["id"] != c["id"] for c in candidates):
            candidates.append(row)

    candidates = candidates[:MAX_SEARCH_RESULTS]
    if not candidates:
        return []

    presence = _presence_for([user["id"] for user in candidates])
    results = []
    for user in candidates:
        payload = accounts_service.public_summary(user)
        payload["user_id"] = user["id"]
        relationship = accounts_service.relationship(viewer["id"], user["id"])
        payload["relationship"] = relationship
        payload["is_friend"] = relationship == "friend"
        payload["is_self"] = False
        payload["presence"] = presence.get(user["id"], {"status": "offline"})
        results.append(payload)

    # Exact identity hit first, then friends, then whoever is around right now.
    results.sort(
        key=lambda p: (
            0 if exact and p["user_id"] == exact["id"] else 1,
            0 if p["is_friend"] else 1,
            0 if p["presence"]["status"] != "offline" else 1,
            p["display_name"].lower(),
        )
    )
    return results


def friend_presence(user: dict) -> dict:
    ids = social_repo.social_user_ids(user["id"])
    return {"presence": _presence_for(ids)}


# ---------------------------------------------------------------------------
# Direct messages
# ---------------------------------------------------------------------------

def _peer_or_error(identifier: str) -> dict:
    target = accounts_service.find_user(identifier)
    if not target:
        raise AccountError("user_not_found", status=404, message="No player found with that ID.")
    return target


def _message_payload(message: dict, viewer_id: str) -> dict:
    payload = dict(message)
    payload["mine"] = message["sender_id"] == viewer_id
    return payload


def thread_list(user: dict) -> dict:
    rows = social_repo.list_threads(user["id"])
    unread = social_repo.unread_counts(user["id"])
    peers = {
        row["peer_id"]: accounts_repo.get_user_by_id(row["peer_id"])
        for row in rows
    }
    presence = _presence_for([pid for pid in peers if pid])

    threads = []
    for row in rows:
        peer_user = peers.get(row["peer_id"])
        if not peer_user:
            continue
        threads.append(
            {
                "peer": _user_with_presence(
                    peer_user, presence.get(row["peer_id"], {"status": "offline"})
                ),
                "last_message": _message_payload(row, user["id"]),
                "unread": int(unread.get(row["peer_id"], 0)),
            }
        )
    return {
        "threads": threads,
        "unread_total": sum(unread.values()),
    }


def thread_with(user: dict, identifier: str, limit: int = 80, before: str = "") -> dict:
    peer = _peer_or_error(identifier)
    if peer["id"] == user["id"]:
        raise AccountError("self_conversation", message="Pick another player to chat with.")

    messages = social_repo.list_messages(user["id"], peer["id"], limit=limit, before=before)
    presence = _presence_for([peer["id"]])
    return {
        "peer": _user_with_presence(peer, presence.get(peer["id"], {"status": "offline"})),
        "messages": [_message_payload(m, user["id"]) for m in messages],
        "unread": int(social_repo.unread_counts(user["id"]).get(peer["id"], 0)),
    }


def send_message(user: dict, identifier: str, text: str) -> dict:
    peer = _peer_or_error(identifier)
    if peer["id"] == user["id"]:
        raise AccountError("self_conversation", message="Pick another player to chat with.")

    ok, reason = validate_chat_message(text)
    if not ok:
        raise AccountError(reason, message="Messages must be 1–200 characters.")
    body = text.strip()

    message = social_repo.insert_message(user["id"], peer["id"], body)
    sender = accounts_repo.get_user_by_id(user["id"]) or user
    presence = _presence_for([peer["id"]])
    peer_payload = _user_with_presence(peer, presence.get(peer["id"], {"status": "offline"}))
    sender_payload = _light_user(sender)

    _emit_to_user(
        peer["id"],
        "dm:message",
        {
            "peer": sender_payload,
            "message": _message_payload(message, peer["id"]),
        },
    )
    _emit_to_user(
        user["id"],
        "dm:message",
        {
            "peer": peer_payload,
            "message": _message_payload(message, user["id"]),
            "echo": True,
        },
    )
    return {"message": _message_payload(message, user["id"]), "peer": peer_payload}


def mark_read(user: dict, identifier: str) -> dict:
    peer = _peer_or_error(identifier)
    updated = social_repo.mark_thread_read(user["id"], peer["id"])
    if updated:
        _emit_to_user(peer["id"], "dm:read", {"by": user["id"]})
    return {"ok": True, "unread_total": social_repo.unread_total(user["id"])}


def unread_summary(user: dict) -> dict:
    return {
        "unread_total": social_repo.unread_total(user["id"]),
        "threads": thread_list(user)["threads"],
    }


# ---------------------------------------------------------------------------
# Play requests
# ---------------------------------------------------------------------------

def _validate_settings(mode: str, overs, wickets) -> tuple[str, int, int]:
    normalized = str(mode or "SOLO").upper()
    if normalized not in ("SOLO", "TEAM"):
        raise AccountError("mode_invalid", message="Pick solo or team mode.")
    try:
        overs_val = int(overs if overs is not None else 2)
        wickets_val = int(wickets if wickets is not None else (1 if normalized == "SOLO" else 5))
    except (TypeError, ValueError):
        raise AccountError("settings_invalid", message="Choose valid match settings.") from None
    if not 1 <= overs_val <= 10:
        raise AccountError("overs_invalid", message="Overs must be between 1 and 10.")
    max_wickets = 5 if normalized == "SOLO" else 10
    if not 1 <= wickets_val <= max_wickets:
        raise AccountError(
            "wickets_invalid", message=f"Wickets must be between 1 and {max_wickets}."
        )
    return normalized, overs_val, wickets_val


def _require_available(presence: dict) -> None:
    """Only a player who is online and not already in a room can be invited.

    Turning an invite into a room creates fresh memberships, so inviting
    someone who already sits in another lobby would silently leave that room
    behind. Treat every active room state as busy.
    """
    status = presence.get("status", "offline")
    if status == "offline":
        raise AccountError(
            "player_offline", status=409, message="That player is offline right now."
        )
    if status == "in_match":
        raise AccountError(
            "player_busy", status=409, message="That player is in a match right now."
        )
    if status == "spectating":
        raise AccountError(
            "player_spectating", status=409, message="That player is watching a match right now."
        )
    if status == "in_lobby":
        raise AccountError(
            "player_busy", status=409, message="That player is already in a lobby."
        )


def _request_payload(request: dict, viewer_id: str) -> dict:
    counterpart_id = (
        request["recipient_id"] if request["requester_id"] == viewer_id else request["requester_id"]
    )
    user = accounts_repo.get_user_by_id(counterpart_id)
    if not user:
        return {}
    presence = _presence_for([counterpart_id]).get(counterpart_id, {"status": "offline"})
    payload = {
        "id": request["id"],
        "mode": request["mode"],
        "overs": request["overs"],
        "wickets": request["wickets"],
        "status": request["status"],
        "room_id": request["room_id"],
        "join_code": request["room_code"],
        "created_at": request["created_at"],
        "direction": "incoming" if request["recipient_id"] == viewer_id else "outgoing",
        "player": _user_with_presence(user, presence),
    }
    return payload


def _pending_payloads(user: dict) -> dict:
    incoming, outgoing = social_repo.list_play_requests(user["id"])
    return {
        "incoming": [
            payload
            for payload in (_request_payload(r, user["id"]) for r in incoming)
            if payload
        ],
        "outgoing": [
            payload
            for payload in (_request_payload(r, user["id"]) for r in outgoing)
            if payload
        ],
    }


def list_play_requests(user: dict) -> dict:
    social_repo.expire_stale_play_requests()
    return _pending_payloads(user)


def send_play_request(user: dict, identifier: str, mode: str, overs, wickets) -> dict:
    peer = _peer_or_error(identifier)
    if peer["id"] == user["id"]:
        raise AccountError("cannot_invite_self", message="That's you — send this to a friend.")

    mode_val, overs_val, wickets_val = _validate_settings(mode, overs, wickets)
    social_repo.expire_stale_play_requests()

    requester_presence = _presence_for([user["id"]]).get(user["id"], {"status": "offline"})
    if requester_presence.get("status") != "online":
        raise AccountError(
            "not_available",
            status=409,
            message="Leave your current room before inviting someone to a new match.",
        )

    presence = _presence_for([peer["id"]]).get(peer["id"], {"status": "offline"})
    _require_available(presence)

    existing = social_repo.find_pending_play_request(user["id"], peer["id"])
    if existing:
        payload = _request_payload(existing, user["id"])
        return {"request": payload, "already_sent": True}

    request = social_repo.create_play_request(
        user["id"], peer["id"], mode_val, overs_val, wickets_val
    )
    requester = accounts_repo.get_user_by_id(user["id"]) or user
    requester_payload = _light_user(requester)
    requester_presence = _presence_for([user["id"]]).get(user["id"], {"status": "online"})
    requester_payload["presence"] = requester_presence

    _emit_to_user(
        peer["id"],
        "play:invite",
        {
            "request": _request_payload(request, peer["id"]),
            "from": requester_payload,
        },
    )
    return {"request": _request_payload(request, user["id"]), "already_sent": False}


def cancel_play_request(user: dict, request_id: str) -> dict:
    request = social_repo.get_play_request(request_id)
    if not request or request["requester_id"] != user["id"]:
        raise AccountError("request_not_found", status=404)
    if request["status"] != social_repo.STATUS_PENDING:
        raise AccountError("request_not_pending", status=409, message="That invite is already settled.")
    updated = social_repo.update_play_request(request_id, social_repo.STATUS_CANCELLED)
    _emit_to_user(request["recipient_id"], "play:cancelled", {"request_id": request_id})
    return {"request": _request_payload(updated, user["id"])}


def respond_play_request(user: dict, request_id: str, accept: bool) -> dict:
    request = social_repo.get_play_request(request_id)
    if not request or request["recipient_id"] != user["id"]:
        raise AccountError("request_not_found", status=404)
    if request["status"] != social_repo.STATUS_PENDING:
        raise AccountError("request_not_pending", status=409, message="That invite is already settled.")

    created = _as_datetime(request["created_at"])
    if created and datetime.utcnow() - created > timedelta(seconds=PLAY_REQUEST_TTL_SECONDS):
        social_repo.update_play_request(request_id, social_repo.STATUS_EXPIRED)
        _emit_to_user(request["requester_id"], "play:expired", {"request_id": request_id})
        raise AccountError("request_expired", status=409, message="That invite has expired.")

    if not accept:
        social_repo.update_play_request(request_id, social_repo.STATUS_DECLINED)
        _emit_to_user(
            request["requester_id"],
            "play:declined",
            {"request_id": request_id, "player": _light_user(user)},
        )
        return {"status": "declined"}

    acceptor_presence = _presence_for([user["id"]]).get(user["id"], {"status": "offline"})
    acceptor_status = acceptor_presence.get("status", "offline")
    if acceptor_status == "offline":
        raise AccountError(
            "not_online", status=409, message="Reconnect before accepting a match invite."
        )
    if acceptor_status != "online":
        raise AccountError(
            "you_are_busy",
            status=409,
            message="Leave your current room before accepting a match invite.",
        )

    requester_presence = _presence_for([request["requester_id"]]).get(
        request["requester_id"], {"status": "offline"}
    )
    if requester_presence.get("status") in ("offline",):
        social_repo.update_play_request(request_id, social_repo.STATUS_EXPIRED)
        raise AccountError(
            "requester_offline", status=409, message="The inviting player went offline."
        )
    if requester_presence.get("status") in ("in_lobby", "in_match", "spectating"):
        raise AccountError(
            "requester_busy", status=409, message="The inviting player is already in a room."
        )

    requester_player = gameplay_repo.get_connected_player_for_user(request["requester_id"])
    acceptor_player = gameplay_repo.get_connected_player_for_user(user["id"])
    if not requester_player:
        social_repo.update_play_request(request_id, social_repo.STATUS_EXPIRED)
        raise AccountError(
            "requester_offline", status=409, message="The inviting player went offline."
        )
    if not acceptor_player:
        raise AccountError(
            "not_online", status=409, message="Reconnect before accepting a match invite."
        )

    try:
        room, _membership = room_service.create_room(
            acceptor_player, request["mode"], request["overs"], request["wickets"]
        )
        room_service.join_room(requester_player, room.join_code)
    except ValueError:
        raise AccountError(
            "room_unavailable", status=409, message="Could not open a room. Try again."
        ) from None

    updated = social_repo.update_play_request(
        request_id, social_repo.STATUS_ACCEPTED, room_id=room.id, room_code=room.join_code
    )
    payload = {
        "request_id": request_id,
        "room_id": room.id,
        "join_code": room.join_code,
        "mode": request["mode"],
        "overs": room.overs,
        "wickets": room.wickets,
    }
    _emit_to_user(request["requester_id"], "play:accepted", payload)
    _emit_to_user(user["id"], "play:accepted", payload)
    return {
        "status": "accepted",
        "room": payload,
        "request": _request_payload(updated, user["id"]),
    }


def _as_datetime(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
