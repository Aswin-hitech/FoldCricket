"""
Security utilities: session tokens, join codes, input validation.
"""

from __future__ import annotations

import re
import secrets
import string

# ---------------------------------------------------------------------------
# Token / code generation
# ---------------------------------------------------------------------------

def generate_join_code(length: int = 6) -> str:
    """Cryptographically random uppercase alphanumeric join code."""
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def generate_session_token() -> str:
    return secrets.token_hex(32)


def generate_invite_token() -> str:
    return secrets.token_urlsafe(24)


# ---------------------------------------------------------------------------
# Display name validation
# ---------------------------------------------------------------------------

_ALLOWED_NAME_RE = re.compile(r"^[a-zA-Z0-9 _\-\.]{1,24}$")

BASIC_PROFANITY = {"badword"}  # extend as needed


def validate_display_name(name: str) -> tuple[bool, str]:
    """
    Returns (valid, reason). reason is empty string on success.
    """
    if not isinstance(name, str):
        return False, "name_must_be_string"
    name = name.strip()
    if len(name) < 1:
        return False, "name_too_short"
    if len(name) > 24:
        return False, "name_too_long"
    if not _ALLOWED_NAME_RE.match(name):
        return False, "name_invalid_chars"
    if name.lower() in BASIC_PROFANITY:
        return False, "name_not_allowed"
    return True, ""


# ---------------------------------------------------------------------------
# Message validation
# ---------------------------------------------------------------------------

MAX_CHAT_LENGTH = 200


def validate_chat_message(text: str) -> tuple[bool, str]:
    if not isinstance(text, str):
        return False, "msg_must_be_string"
    text = text.strip()
    if len(text) == 0:
        return False, "msg_empty"
    if len(text) > MAX_CHAT_LENGTH:
        return False, "msg_too_long"
    return True, ""


# ---------------------------------------------------------------------------
# Rate limiter (simple in-memory token bucket per player)
# ---------------------------------------------------------------------------

import threading
import time


class SimpleRateLimiter:
    """Thread-safe token-bucket rate limiter keyed by arbitrary string."""

    def __init__(self, max_tokens: int = 5, refill_per_second: float = 1.0):
        self._max = max_tokens
        self._rate = refill_per_second
        self._buckets: dict[str, tuple[float, float]] = {}  # key → (tokens, last_time)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(key, (float(self._max), now))
            elapsed = now - last
            tokens = min(self._max, tokens + elapsed * self._rate)
            if tokens >= 1:
                self._buckets[key] = (tokens - 1, now)
                return True
            self._buckets[key] = (tokens, now)
            return False


chat_rate_limiter = SimpleRateLimiter(max_tokens=10, refill_per_second=2.0)
join_rate_limiter = SimpleRateLimiter(max_tokens=5, refill_per_second=0.2)
create_rate_limiter = SimpleRateLimiter(max_tokens=3, refill_per_second=0.1)
