"""
Lifetime feedback and visit analytics for the creator dashboard.

Feedback reports and visit records are written to the Supabase Storage bucket by
``supabase_logger``. The bucket is the only durable record of visitor activity,
so the dashboard reads it back here:

* ``records/YYYY-MM-DD/<ip>_<timestamp_ms>_<action>.json`` – visits/actions
* ``feedback/YYYY-MM-DD/<player_id>_<timestamp_ms>.json`` – feedback reports

Listing every object is expensive, so the aggregate is cached in-process.
Failures degrade to an empty payload rather than breaking the dashboard.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any, Iterator

logger = logging.getLogger("platform_analytics")

CACHE_TTL_SECONDS = 300
FAILURE_TTL_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 10
FETCH_BUDGET_SECONDS = 45
LIST_LIMIT = 100
LIST_WORKERS = 8
MAX_FEEDBACK_DOCS = 500
VISIT_ACTIVITY_DAYS = 30
RECENT_FEEDBACK = 6
RECENT_ACTIONS = 8

_RECORD_RE = re.compile(
    r"^(?P<ip>.+)_(?P<ts>\d{10,16})_(?P<action>[a-z_]+)\.json$"
)
_TS_RE = re.compile(r"_(?P<ts>\d{10,16})\.json$")

_lock = threading.Lock()
_cache: dict[str, Any] = {"expires_at": 0.0, "payload": None}


def _supabase_config() -> tuple[str, str, str]:
    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = (
        os.getenv("SUPABASE_SECRET_KEY")
        or os.getenv("SUPABASE_KEY")
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("SUPABASE_PUBLISHABLE_KEY")
        or os.getenv("SUPABASE_ANON_KEY")
        or ""
    ).strip()
    bucket = os.getenv("SUPABASE_BUCKET_NAME", "ip-logs").strip() or "ip-logs"
    return url, key, bucket


def _empty_feedback() -> dict:
    return {
        "total": 0,
        "average_rating": None,
        "rating_distribution": {str(rating): 0 for rating in range(1, 6)},
        "categories": [],
        "recent": [],
        "last_at": None,
        "sampled": False,
    }


def _empty_visits() -> dict:
    return {
        "total_visits": 0,
        "unique_visitors": 0,
        "visits_today": 0,
        "unique_today": 0,
        "total_events": 0,
        "actions": [],
        "activity": [],
        "first_visit_at": None,
        "last_visit_at": None,
        "days_covered": 0,
        "truncated": False,
    }


def empty_payload(source: str = "unavailable") -> dict:
    return {
        "source": source,
        "updated_at": None,
        "feedback": _empty_feedback(),
        "visits": _empty_visits(),
    }


def _request(url: str, key: str, *, data: bytes | None = None) -> bytes:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        return response.read()


class _DeadlineExceeded(Exception):
    """The shared log-scan budget expired before a listing finished."""


def _list_folder(
    base: str, key: str, bucket: str, prefix: str, deadline: float
) -> Iterator[dict]:
    offset = 0
    list_url = f"{base}/storage/v1/object/list/{urllib.parse.quote(bucket)}"
    while True:
        if time.monotonic() >= deadline:
            raise _DeadlineExceeded
        body = json.dumps(
            {
                "prefix": prefix,
                "limit": LIST_LIMIT,
                "offset": offset,
                "sortBy": {"column": "name", "order": "asc"},
            }
        ).encode("utf-8")
        items = json.loads(_request(list_url, key, data=body))
        if not items:
            return
        for item in items:
            yield item
        if len(items) < LIST_LIMIT:
            return
        offset += len(items)


def _download_json(base: str, key: str, bucket: str, path: str) -> dict:
    encoded = urllib.parse.quote(f"{bucket}/{path}", safe="/")
    body = _request(f"{base}/storage/v1/object/{encoded}", key)
    payload = json.loads(body)
    return payload if isinstance(payload, dict) else {}


def _timestamp_from_name(name: str) -> int:
    match = _TS_RE.search(name)
    return int(match.group("ts")) if match else 0


def _iso_from_ms(timestamp_ms: int) -> str | None:
    if not timestamp_ms:
        return None
    return datetime.utcfromtimestamp(timestamp_ms / 1000).isoformat() + "Z"


def _clamp_rating(value: Any) -> int | None:
    try:
        rating = int(value)
    except (TypeError, ValueError):
        return None
    return max(1, min(5, rating))


def _clean_categories(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item)[:48] for item in value if isinstance(item, str) and item][:5]


def _fetch_feedback(base: str, key: str, bucket: str, deadline: float) -> dict:
    folders = sorted(
        (item["name"] for item in _list_folder(base, key, bucket, "feedback/", deadline)),
        reverse=True,
    )
    entries: list[tuple[int, str, str]] = []
    incomplete = False
    for folder in folders:
        try:
            for item in _list_folder(base, key, bucket, f"feedback/{folder}/", deadline):
                entries.append((_timestamp_from_name(item["name"]), folder, item["name"]))
        except _DeadlineExceeded:
            incomplete = True
            break

    entries.sort(key=lambda entry: entry[0], reverse=True)
    total = len(entries)
    sampled = total > MAX_FEEDBACK_DOCS or incomplete

    ratings: Counter[int] = Counter()
    categories: Counter[str] = Counter()
    recent: list[dict] = []
    rating_total = 0
    rating_count = 0
    last_at = _iso_from_ms(entries[0][0]) if entries else None

    for timestamp, folder, name in entries[:MAX_FEEDBACK_DOCS]:
        if time.monotonic() >= deadline:
            sampled = True
            break
        try:
            payload = _download_json(base, key, bucket, f"feedback/{folder}/{name}")
        except Exception as exc:  # one corrupt/unreadable report must not blank the panel
            logger.debug("Feedback document %s/%s unreadable: %s", folder, name, exc)
            continue

        rating = _clamp_rating(payload.get("rating"))
        if rating is not None:
            ratings[rating] += 1
            rating_total += rating
            rating_count += 1

        entry_categories = _clean_categories(payload.get("categories"))
        categories.update(entry_categories)

        if len(recent) < RECENT_FEEDBACK:
            recent.append(
                {
                    "player_name": str(payload.get("player_name") or "Anonymous")[:48],
                    "rating": rating,
                    "feedback_text": str(payload.get("feedback_text") or "")[:600],
                    "categories": entry_categories,
                    "room_code": (
                        str(payload["room_code"])[:16] if payload.get("room_code") else None
                    ),
                    "created_at": payload.get("timestamp_utc")
                    or _iso_from_ms(timestamp),
                }
            )

    return {
        "total": total,
        "average_rating": (
            round(rating_total / rating_count, 2) if rating_count else None
        ),
        "rating_distribution": {str(rating): ratings[rating] for rating in range(1, 6)},
        "categories": [
            {"name": name, "count": count}
            for name, count in categories.most_common(8)
        ],
        "recent": recent,
        "last_at": last_at,
        "sampled": sampled,
    }


def _fetch_visits(base: str, key: str, bucket: str, deadline: float) -> dict:
    folders = sorted(
        (item["name"] for item in _list_folder(base, key, bucket, "records/", deadline)),
        reverse=True,
    )

    actions: Counter[str] = Counter()
    per_day: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"visits": 0, "visitors": set()}
    )
    total_events = 0
    truncated = False
    first_ts: int | None = None
    last_visit_ts: int | None = None

    def list_day(folder: str) -> tuple[list[str], bool]:
        names: list[str] = []
        try:
            for item in _list_folder(base, key, bucket, f"records/{folder}/", deadline):
                names.append(item["name"])
            return names, False
        except _DeadlineExceeded:
            return names, True

    # Per-day folders are independent, so listing them side by side keeps the
    # scan inside the budget even on busy days.
    if folders:
        workers = min(LIST_WORKERS, len(folders))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(list_day, folders))
    else:
        results = []

    for folder, (names, incomplete) in zip(folders, results):
        if incomplete:
            truncated = True
        for name in names:
            match = _RECORD_RE.match(name)
            if not match:
                continue
            timestamp = int(match.group("ts"))
            action = match.group("action")
            ip = match.group("ip")

            total_events += 1
            actions[action] += 1
            if first_ts is None or timestamp < first_ts:
                first_ts = timestamp
            if "visit" in action:
                per_day[folder]["visits"] += 1
                per_day[folder]["visitors"].add(ip)
                if last_visit_ts is None or timestamp > last_visit_ts:
                    last_visit_ts = timestamp

    today = datetime.utcnow().date()
    activity = []
    for offset in range(VISIT_ACTIVITY_DAYS - 1, -1, -1):
        key_day = (today - timedelta(days=offset)).isoformat()
        day = per_day.get(key_day)
        activity.append(
            {
                "date": key_day,
                "visits": day["visits"] if day else 0,
                "visitors": len(day["visitors"]) if day else 0,
            }
        )

    today_key = today.isoformat()
    today_visits = per_day.get(today_key, {"visits": 0, "visitors": set()})
    all_visitors: set[str] = set()
    total_visits = 0
    for day in per_day.values():
        total_visits += day["visits"]
        all_visitors.update(day["visitors"])

    return {
        "total_visits": total_visits,
        "unique_visitors": len(all_visitors),
        "visits_today": today_visits["visits"],
        "unique_today": len(today_visits["visitors"]),
        "total_events": total_events,
        "actions": [
            {"action": action, "count": count}
            for action, count in actions.most_common(RECENT_ACTIONS)
        ],
        "activity": activity,
        "first_visit_at": _iso_from_ms(first_ts or 0),
        "last_visit_at": _iso_from_ms(last_visit_ts or 0),
        "days_covered": len(folders),
        "truncated": truncated,
    }


def _collect(base: str, key: str, bucket: str) -> tuple[dict, bool]:
    deadline = time.monotonic() + FETCH_BUDGET_SECONDS
    ok = False

    try:
        feedback = _fetch_feedback(base, key, bucket, deadline)
        ok = True
    except Exception as exc:
        logger.warning("Feedback analytics unavailable: %s", exc)
        feedback = _empty_feedback()

    try:
        visits = _fetch_visits(base, key, bucket, deadline)
        ok = True
    except Exception as exc:
        logger.warning("Visit analytics unavailable: %s", exc)
        visits = _empty_visits()

    return {"feedback": feedback, "visits": visits}, ok


def get_platform_analytics(force: bool = False) -> dict:
    """Return cached lifetime feedback/visit aggregates from Supabase."""
    base, key, bucket = _supabase_config()
    if not base or not key:
        return empty_payload("not_configured")

    now = time.monotonic()
    with _lock:
        cached = _cache["payload"]
        if not force and cached is not None and _cache["expires_at"] > now:
            return cached

        payload, ok = _collect(base, key, bucket)
        payload["source"] = "supabase" if ok else "unavailable"
        payload["updated_at"] = datetime.utcnow().isoformat() + "Z"
        _cache["payload"] = payload
        _cache["expires_at"] = now + (
            CACHE_TTL_SECONDS if ok else FAILURE_TTL_SECONDS
        )
        return payload


def reset_cache() -> None:
    """Test hook: forget the cached Supabase aggregate."""
    with _lock:
        _cache["payload"] = None
        _cache["expires_at"] = 0.0
