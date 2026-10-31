"""
Player account service: registration, login, profile, friends, stats and
achievements.

Security notes:
  * Passwords are hashed with Werkzeug (scrypt) and never leave this module.
  * Session tokens are 256-bit random strings; only their SHA-256 hash is
    stored, so a database leak cannot be replayed.
  * Login errors are intentionally generic (no user enumeration).
"""

from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
from datetime import datetime, timedelta
from typing import Optional

from werkzeug.security import check_password_hash, generate_password_hash

from ..config import Config
from ..domain import achievements
from ..domain.models import DeliveryResult, GameMode
from ..repositories import accounts as accounts_repo
from ..repositories import memory as repo
from ..repositories import social as social_repo
from ..repositories.account_store import UserStoreConflict
from ..security.utils import validate_display_name

SESSION_DAYS = max(1, int(getattr(Config, "ACCOUNT_SESSION_DAYS", 30)))
SESSION_REFRESH_AFTER = timedelta(hours=1)

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
FRIEND_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I

AVATARS = (
    "🏏", "🏆", "⚡", "🔥", "🎯", "👑", "🦅", "🐯",
    "🦊", "🚀", "🧊", "🌟", "🎽", "🥇", "🫂", "✨",
)

# A real hash is verified even for unknown usernames so login latency does not
# reveal whether an account exists.
_DUMMY_HASH = generate_password_hash("handcricket-timing-equalizer")


class AccountError(Exception):
    """Domain error with an API-safe code and HTTP status."""

    def __init__(self, code: str, status: int = 400, message: str = ""):
        super().__init__(code)
        self.code = code
        self.status = status
        self.message = message or code


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def validate_username(username: str) -> str:
    if not isinstance(username, str):
        raise AccountError(
            "username_invalid",
            message="Username must be 3-20 characters: letters, numbers or underscore.",
        )
    value = username.strip()
    if not USERNAME_RE.match(value):
        raise AccountError(
            "username_invalid",
            message="Username must be 3-20 characters: letters, numbers or underscore.",
        )
    return value


def validate_password(password: str) -> str:
    if not isinstance(password, str):
        raise AccountError("password_invalid")
    if len(password) < 8:
        raise AccountError("password_too_short", message="Password must be at least 8 characters.")
    if len(password) > 128:
        raise AccountError("password_too_long")
    return password


def _clean_bio(bio: str) -> str:
    if not isinstance(bio, str):
        raise AccountError("bio_invalid")
    cleaned = re.sub(r"[\x00-\x1f\x7f]", " ", bio).strip()
    if len(cleaned) > 160:
        raise AccountError("bio_too_long", message="Bio must be 160 characters or fewer.")
    return cleaned


def normalize_friend_code(value: str) -> str:
    raw = re.sub(r"[\s-]", "", (value or "")).upper()
    if len(raw) == 8 and raw.startswith("FC"):
        raw = raw[2:]
    return raw if len(raw) == 6 and all(c in FRIEND_CODE_ALPHABET for c in raw) else ""


def display_friend_code(code: str) -> str:
    return f"FC-{code}" if code else ""


def _generate_friend_code() -> str:
    for _ in range(12):
        code = "".join(secrets.choice(FRIEND_CODE_ALPHABET) for _ in range(6))
        if not accounts_repo.friend_code_exists(code):
            return code
    raise AccountError("friend_code_unavailable", status=500)


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _expiry_iso() -> str:
    return (datetime.utcnow() + timedelta(days=SESSION_DAYS)).isoformat()


def issue_session(user: dict, user_agent: str = "") -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    expires_at = _expiry_iso()
    accounts_repo.create_session(
        user_id=user["id"],
        token_hash=_token_hash(token),
        user_agent=user_agent or "",
        expires_at=expires_at,
    )
    return token, expires_at


def resolve_session(token: str) -> Optional[dict]:
    """Return the user for a raw bearer token, or None. Also returns session id."""
    if not token or len(token) > 200:
        return None
    row = accounts_repo.get_session(_token_hash(token))
    if not row:
        return None
    if str(row.get("session_expires_at") or "") < datetime.utcnow().isoformat():
        accounts_repo.delete_session(_token_hash(token))
        return None

    try:
        last_used = datetime.fromisoformat(row["session_last_used_at"])
    except (KeyError, TypeError, ValueError):
        last_used = datetime.utcnow()
    if datetime.utcnow() - last_used > SESSION_REFRESH_AFTER:
        new_expiry = _expiry_iso()
        accounts_repo.touch_session(row["session_id"], new_expiry)
        row["session_expires_at"] = new_expiry
    return row


def revoke_session(token: str) -> None:
    if token:
        accounts_repo.delete_session(_token_hash(token))


# ---------------------------------------------------------------------------
# Registration / login
# ---------------------------------------------------------------------------

def register(
    username: str,
    display_name: str,
    password: str,
    avatar: Optional[str] = None,
    user_agent: str = "",
) -> tuple[dict, str]:
    username = validate_username(username)
    password = validate_password(password)

    display_name = display_name.strip() if isinstance(display_name, str) else ""
    display_name = display_name or username
    ok, reason = validate_display_name(display_name)
    if not ok:
        raise AccountError(reason, message="Display name must be 1-24 letters, numbers, spaces or . _ -")
    if avatar not in AVATARS:
        avatar = AVATARS[0]
    if accounts_repo.username_exists(username):
        raise AccountError("username_taken", message="That username is already taken.")

    try:
        user = accounts_repo.create_user(
            username=username,
            display_name=display_name.strip(),
            password_hash=generate_password_hash(password),
            friend_code=_generate_friend_code(),
            avatar=avatar,
        )
    except (sqlite3.IntegrityError, UserStoreConflict):
        raise AccountError("username_taken", message="That username is already taken.") from None

    accounts_repo.purge_expired_sessions()
    token, _ = issue_session(user, user_agent)
    return user, token


def login(username: str, password: str, user_agent: str = "") -> tuple[dict, str]:
    username = username.strip() if isinstance(username, str) else ""
    password = password if isinstance(password, str) else ""
    user = accounts_repo.get_user_by_username(username)

    if not user:
        check_password_hash(_DUMMY_HASH, password)
        raise AccountError("invalid_credentials", status=401, message="Incorrect username or password.")
    if not check_password_hash(user["password_hash"], password):
        raise AccountError("invalid_credentials", status=401, message="Incorrect username or password.")

    accounts_repo.purge_expired_sessions()
    token, _ = issue_session(user, user_agent)
    return user, token


def change_password(user: dict, current_password: str, new_password: str, session_id: str) -> None:
    if not check_password_hash(user["password_hash"], current_password or ""):
        raise AccountError("invalid_password", status=401, message="Current password is incorrect.")
    validate_password(new_password)
    if check_password_hash(user["password_hash"], new_password):
        raise AccountError("password_unchanged", message="Choose a different password.")
    accounts_repo.update_user(user["id"], {"password_hash": generate_password_hash(new_password)})
    accounts_repo.delete_other_sessions(user["id"], session_id)


# ---------------------------------------------------------------------------
# Stats / achievements
# ---------------------------------------------------------------------------

def _level_for(xp: int) -> tuple[int, int, int]:
    level = int((max(0, xp) / 200) ** 0.5) + 1
    base = (level - 1) ** 2 * 200
    next_level = level**2 * 200
    return level, xp - base, next_level - base


def build_stats(user_id: str) -> dict:
    agg = accounts_repo.aggregate_stats(user_id)
    matches = int(agg.get("matches") or 0)
    wins = int(agg.get("wins") or 0)
    losses = int(agg.get("losses") or 0)
    ties = int(agg.get("ties") or 0)
    runs = int(agg.get("runs") or 0)
    wickets = int(agg.get("wickets") or 0)
    super_overs = int(agg.get("super_overs") or 0)
    super_over_wins = int(agg.get("super_over_wins") or 0)

    results = accounts_repo.list_results_chronological(user_id)
    best_streak = current = 0
    for result in results:
        current = current + 1 if result == "WIN" else 0
        best_streak = max(best_streak, current)
    current_streak = 0
    for result in reversed(results):
        if result != "WIN":
            break
        current_streak += 1

    xp = (
        wins * 100
        + losses * 30
        + ties * 40
        + runs * 2
        + wickets * 20
        + super_over_wins * 50
    )
    level, xp_into_level, xp_for_level = _level_for(xp)

    return {
        "matches": matches,
        "wins": wins,
        "losses": losses,
        "ties": ties,
        "win_rate": round(wins / matches * 100, 1) if matches else 0.0,
        "runs": runs,
        "wickets": wickets,
        "wickets_lost": int(agg.get("wickets_lost") or 0),
        "balls_faced": int(agg.get("balls_faced") or 0),
        "balls_bowled": int(agg.get("balls_bowled") or 0),
        "best_score": int(agg.get("best_score") or 0),
        "super_overs": super_overs,
        "super_over_wins": super_over_wins,
        "team_matches": int(agg.get("team_matches") or 0),
        "dead_balls": int(agg.get("dead_balls") or 0),
        "best_streak": best_streak,
        "current_streak": current_streak,
        "xp": xp,
        "level": level,
        "xp_into_level": xp_into_level,
        "xp_for_level": xp_for_level,
    }


def _profile_complete(user: dict) -> bool:
    return bool((user.get("avatar") or "").strip() and (user.get("bio") or "").strip())


def _badge_payload(user: dict, stats: Optional[dict] = None) -> list[dict]:
    stats = stats or build_stats(user["id"])
    return achievements.badge_payload(
        accounts_repo.list_achievement_codes(user["id"]),
        stats,
        accounts_repo.count_friends(user["id"]),
        _profile_complete(user),
    )


def evaluate_achievements(user: dict) -> list[str]:
    """Award any newly reached badges and return their codes."""
    stats = build_stats(user["id"])
    earned_now = achievements.earned_codes(
        stats,
        accounts_repo.count_friends(user["id"]),
        _profile_complete(user),
    )
    existing = accounts_repo.list_achievement_codes(user["id"])
    new_codes = sorted(earned_now - existing)
    for code in new_codes:
        accounts_repo.add_achievement(user["id"], code)
    return new_codes


def _public_summary(user: dict) -> dict:
    stats = build_stats(user["id"])
    return {
        "username": user["username"],
        "display_name": user["display_name"],
        "avatar": user["avatar"],
        "friend_code": display_friend_code(user["friend_code"]),
        "level": stats["level"],
        "wins": stats["wins"],
        "matches": stats["matches"],
        "win_rate": stats["win_rate"],
    }


def _self_payload(user: dict) -> dict:
    summary = _public_summary(user)
    summary.update(
        {
            "bio": user["bio"],
            "default_mode": user["default_mode"],
            "default_overs": user["default_overs"],
            "default_wickets": user["default_wickets"],
            "created_at": user["created_at"],
            "profile_complete": _profile_complete(user),
        }
    )
    return summary


def owner_profile(user: dict, include_new_achievements: bool = True) -> dict:
    new_codes = evaluate_achievements(user) if include_new_achievements else []
    user = accounts_repo.get_user_by_id(user["id"]) or user
    stats = build_stats(user["id"])
    badges = _badge_payload(user, stats)
    return {
        "user": _self_payload(user),
        "stats": stats,
        "achievements": badges,
        "recent_matches": accounts_repo.list_recent_matches(user["id"], 5),
        "friends_count": accounts_repo.count_friends(user["id"]),
        "incoming_requests": accounts_repo.count_incoming_requests(user["id"]),
        "new_achievements": new_codes,
    }


def relationship(viewer_id: str, target_id: str) -> str:
    if viewer_id == target_id:
        return "self"
    friendship = accounts_repo.get_friendship_between(viewer_id, target_id)
    if not friendship or friendship["status"] != "ACCEPTED":
        if friendship and friendship["status"] == "PENDING":
            return "incoming" if friendship["addressee_id"] == viewer_id else "outgoing"
        return "none"
    return "friend"


def public_summary(user: dict) -> dict:
    return _public_summary(user)


def profile_for_viewer(target: dict, viewer: dict) -> dict:
    rel = relationship(viewer["id"], target["id"])
    payload = {
        **_public_summary(target),
        "user_id": target["id"],
        "relationship": rel,
        "is_friend": rel == "friend",
        "is_self": rel == "self",
        "presence": social_repo.presence_map([target["id"]]).get(
            target["id"], {"status": "offline"}
        ),
    }
    if rel in ("friend", "self"):
        stats = build_stats(target["id"])
        payload.update(
            {
                "bio": target["bio"],
                "stats": stats,
                "achievements": _badge_payload(target, stats),
                "recent_matches": accounts_repo.list_recent_matches(target["id"], 5),
                "friends_count": accounts_repo.count_friends(target["id"]),
            }
        )
    return payload


# ---------------------------------------------------------------------------
# Profile updates
# ---------------------------------------------------------------------------

def update_profile(user: dict, payload: dict) -> dict:
    fields: dict = {}

    if "display_name" in payload:
        name = str(payload.get("display_name") or "").strip()
        ok, reason = validate_display_name(name)
        if not ok:
            raise AccountError(reason, message="Display name must be 1-24 letters, numbers, spaces or . _ -")
        fields["display_name"] = name

    if "avatar" in payload:
        avatar = payload.get("avatar")
        if avatar not in AVATARS:
            raise AccountError("avatar_invalid", message="Pick one of the available avatars.")
        fields["avatar"] = avatar

    if "bio" in payload:
        fields["bio"] = _clean_bio(payload.get("bio") or "")

    mode = payload.get("default_mode")
    overs = payload.get("default_overs")
    wickets = payload.get("default_wickets")
    if mode is not None or overs is not None or wickets is not None:
        current = accounts_repo.get_user_by_id(user["id"]) or user
        next_mode = str(mode or current["default_mode"]).upper()
        if next_mode not in ("SOLO", "TEAM"):
            raise AccountError("mode_invalid")
        try:
            next_overs = int(overs if overs is not None else current["default_overs"])
            next_wickets = int(wickets if wickets is not None else current["default_wickets"])
        except (TypeError, ValueError):
            raise AccountError("settings_invalid") from None
        if not 1 <= next_overs <= 10:
            raise AccountError("overs_invalid", message="Overs must be between 1 and 10.")
        max_wickets = 5 if next_mode == "SOLO" else 10
        if not 1 <= next_wickets <= max_wickets:
            raise AccountError("wickets_invalid", message=f"Wickets must be between 1 and {max_wickets}.")
        fields.update(
            {
                "default_mode": next_mode,
                "default_overs": next_overs,
                "default_wickets": next_wickets,
            }
        )

    if not fields:
        return owner_profile(user)

    updated = accounts_repo.update_user(user["id"], fields)
    if not updated:
        raise AccountError("user_not_found", status=404)
    return owner_profile(updated)


# ---------------------------------------------------------------------------
# User search / public profiles
# ---------------------------------------------------------------------------

def find_user(identifier: str) -> Optional[dict]:
    value = (identifier or "").strip()
    code = normalize_friend_code(value)
    if code:
        found = accounts_repo.get_user_by_friend_code(code)
        if found:
            return found
    username = value[1:] if value.startswith("@") else value
    found = accounts_repo.get_user_by_username(username)
    if found:
        return found
    if len(value) == 36 and value.count("-") == 4:
        return accounts_repo.get_user_by_id(value)
    return None


# ---------------------------------------------------------------------------
# Friends
# ---------------------------------------------------------------------------

def _friend_row_payload(row: dict, presence: Optional[dict] = None) -> dict:
    # The list queries already join the account columns _public_summary needs;
    # reusing them avoids one account lookup per friend.
    summary = _public_summary(row)
    summary["user_id"] = row["id"]
    summary["friendship_id"] = row.get("friendship_id")
    summary["presence"] = (presence or {}).get(row["id"], {"status": "offline"})
    if row.get("friends_since"):
        summary["friends_since"] = row["friends_since"]
    if row.get("requested_at"):
        summary["requested_at"] = row["requested_at"]
    return summary


def friend_list(user_id: str) -> dict:
    friend_rows = accounts_repo.list_friends(user_id)
    incoming_rows = accounts_repo.list_incoming_requests(user_id)
    outgoing_rows = accounts_repo.list_outgoing_requests(user_id)
    ids = {row["id"] for row in (*friend_rows, *incoming_rows, *outgoing_rows)}
    presence = social_repo.presence_map(ids)

    friends = [_friend_row_payload(row, presence) for row in friend_rows]
    incoming = [_friend_row_payload(row, presence) for row in incoming_rows]
    outgoing = [_friend_row_payload(row, presence) for row in outgoing_rows]
    return {
        "friends": friends,
        "incoming": incoming,
        "outgoing": outgoing,
        "friends_count": len(friends),
        "incoming_count": len(incoming),
    }


def send_friend_request(user: dict, identifier: str) -> dict:
    target = find_user(identifier)
    if not target:
        raise AccountError("user_not_found", status=404, message="No player found with that ID.")
    if target["id"] == user["id"]:
        raise AccountError("cannot_add_self", message="That's your own friend code.")

    existing = accounts_repo.get_friendship_between(user["id"], target["id"])
    if existing:
        if existing["status"] == "ACCEPTED":
            raise AccountError("already_friends", message="You are already friends.")
        if existing["status"] == "PENDING":
            if existing["addressee_id"] == user["id"]:
                # Both sides asked: accept immediately instead of leaving two
                # pending requests pointing at each other.
                accounts_repo.set_friendship_status(existing["id"], "ACCEPTED")
                evaluate_achievements(user)
                target_user = accounts_repo.get_user_by_id(target["id"])
                if target_user:
                    evaluate_achievements(target_user)
                return {"status": "accepted", "friend": _public_summary(target)}
            raise AccountError("request_pending", message="Friend request already sent.")

    friendship = accounts_repo.create_friendship(user["id"], target["id"])
    return {"status": "pending", "request_id": friendship["id"], "friend": _public_summary(target)}


def accept_friend_request(user: dict, request_id: str) -> dict:
    friendship = accounts_repo.get_friendship(request_id)
    if not friendship or friendship["addressee_id"] != user["id"]:
        raise AccountError("request_not_found", status=404)
    if friendship["status"] != "PENDING":
        raise AccountError("request_not_pending")
    accounts_repo.set_friendship_status(request_id, "ACCEPTED")

    new_codes = evaluate_achievements(user)
    requester = accounts_repo.get_user_by_id(friendship["requester_id"])
    if requester:
        evaluate_achievements(requester)
    return {
        "status": "accepted",
        "friend": _public_summary(requester) if requester else None,
        "new_achievements": new_codes,
    }


def decline_friend_request(user: dict, request_id: str) -> dict:
    friendship = accounts_repo.get_friendship(request_id)
    if not friendship or friendship["addressee_id"] != user["id"]:
        raise AccountError("request_not_found", status=404)
    accounts_repo.delete_friendship(request_id)
    return {"status": "declined"}


def remove_friend(user: dict, identifier: str) -> dict:
    target = find_user(identifier)
    if not target:
        raise AccountError("user_not_found", status=404)
    removed = accounts_repo.delete_friendship_between(user["id"], target["id"])
    if not removed:
        raise AccountError("not_friends", message="You are not friends with that player.")
    return {"status": "removed"}


# ---------------------------------------------------------------------------
# Gameplay integration
# ---------------------------------------------------------------------------

def record_match_stats(room, match) -> int:
    """
    Persist one durable row per registered participant when a match finishes.
    Idempotent per (user, match), safe to call from any completion path.
    """
    if not match or not match.winner:
        return 0

    members = repo.get_room_members(room.id)
    deliveries = [d for d in repo.get_deliveries(match.id) if d.committed]
    players = {m.player_id: repo.get_player(m.player_id) for m in members}
    user_ids = {
        getattr(player, "user_id", None)
        for player in players.values()
        if player and getattr(player, "user_id", None)
    }
    users_by_id = accounts_repo.get_users_by_ids(sorted(user_ids))

    recorded = 0
    seen_users: set[str] = set()
    for member in members:
        if member.team not in ("A", "B"):
            continue
        player = players.get(member.player_id)
        user_id = getattr(player, "user_id", None) if player else None
        if not user_id or user_id in seen_users:
            continue
        user = users_by_id.get(user_id)
        if not user:
            continue

        runs = wickets_taken = wickets_lost = 0
        balls_faced = balls_bowled = dead_balls = 0
        for delivery in deliveries:
            if delivery.result == DeliveryResult.TIMEOUT:
                if player.id in (delivery.batter_id, delivery.bowler_id):
                    dead_balls += 1
                continue
            if delivery.batter_id == player.id:
                balls_faced += 1
                if delivery.result == DeliveryResult.RUNS:
                    runs += delivery.runs_scored
                elif delivery.result == DeliveryResult.OUT:
                    wickets_lost += 1
            if delivery.bowler_id == player.id:
                balls_bowled += 1
                if delivery.result == DeliveryResult.OUT:
                    wickets_taken += 1

        if match.winner == "TIE":
            result = "TIE"
        elif match.winner == member.team:
            result = "WIN"
        else:
            result = "LOSS"

        if room.mode == GameMode.SOLO:
            opponent = next(
                (
                    players[m.player_id].display_name
                    for m in members
                    if m.player_id != player.id
                    and m.team in ("A", "B")
                    and players.get(m.player_id)
                ),
                "Opponent",
            )
        else:
            opponent = match.team_b_name if member.team == "A" else match.team_a_name

        inserted = accounts_repo.insert_match_stat(
            {
                "user_id": user_id,
                "match_id": match.id,
                "room_id": room.id,
                "mode": room.mode.value,
                "team": member.team,
                "result": result,
                "opponent_name": opponent or "Opponent",
                "runs_scored": runs,
                "wickets_taken": wickets_taken,
                "wickets_lost": wickets_lost,
                "balls_faced": balls_faced,
                "balls_bowled": balls_bowled,
                "dead_balls": dead_balls,
                "super_over": bool(getattr(match, "is_super_over", False)),
                "overs": room.overs,
                "created_at": match.created_at.isoformat(),
            }
        )
        if inserted:
            recorded += 1
        seen_users.add(user_id)
        evaluate_achievements(user)
    return recorded
