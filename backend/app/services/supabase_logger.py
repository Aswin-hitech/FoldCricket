"""
Supabase Storage Bucket IP & Visit Logger.
Saves client IP address, headers, geolocation, and session details
to a configured Supabase Storage bucket asynchronously.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any, Dict, Optional

logger = logging.getLogger("supabase_logger")

# Headers that must never reach external storage: credentials, cookies and
# any key whose name hints at a secret.
_SENSITIVE_HEADER_PARTS = (
    "authorization",
    "proxy-authorization",
    "cookie",
    "token",
    "api-key",
    "apikey",
    "secret",
    "password",
    "x-creator",
)

MAX_HEADER_VALUE_LENGTH = 512
MAX_METADATA_BYTES = 8192


def _clean_headers(headers: Optional[Dict[str, str]]) -> Dict[str, str]:
    safe: Dict[str, str] = {}
    for raw_key, raw_value in (headers or {}).items():
        key = str(raw_key).lower()
        if any(part in key for part in _SENSITIVE_HEADER_PARTS):
            continue
        if len(safe) >= 64:
            break
        safe[key] = str(raw_value)[:MAX_HEADER_VALUE_LENGTH]
    return safe


def _clean_metadata(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    try:
        encoded = json.dumps(metadata)
    except (TypeError, ValueError):
        return {}
    if len(encoded.encode("utf-8")) > MAX_METADATA_BYTES:
        return {"truncated": True}
    return metadata


def get_client_ip(headers: Dict[str, str], remote_addr: Optional[str] = None) -> str:
    """
    Extract the most accurate client IP from proxy and cloud headers,
    handling Vercel, Cloudflare, AWS, and standard reverse proxies.
    """
    # 1. Vercel specific forwarded IP
    if headers.get("x-vercel-forwarded-for"):
        return headers["x-vercel-forwarded-for"].split(",")[0].strip()

    # 2. Cloudflare
    if headers.get("cf-connecting-ip"):
        return headers["cf-connecting-ip"].strip()

    # 3. Standard X-Forwarded-For (first IP is the client)
    if headers.get("x-forwarded-for"):
        return headers["x-forwarded-for"].split(",")[0].strip()

    # 4. X-Real-IP
    if headers.get("x-real-ip"):
        return headers["x-real-ip"].strip()

    # 5. Fallback to direct remote address
    return remote_addr or "unknown"


def _upload_to_supabase_bucket(
    supabase_url: str,
    supabase_key: str,
    bucket_name: str,
    file_path: str,
    payload: Dict[str, Any],
) -> bool:
    """Synchronous upload of a JSON payload to Supabase Storage."""
    try:
        supabase_url = supabase_url.rstrip("/")
        endpoint = f"{supabase_url}/storage/v1/object/{bucket_name}/{file_path}"

        data_bytes = json.dumps(payload, indent=2).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=data_bytes,
            headers={
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
                "Content-Type": "application/json",
                "x-upsert": "true",
            },
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=8) as response:
            return response.status in (200, 201)
    except urllib.error.HTTPError as err:
        # If bucket does not exist (404), attempt to create it
        if err.code == 404:
            try:
                create_endpoint = f"{supabase_url}/storage/v1/bucket"
                create_payload = json.dumps({
                    "id": bucket_name,
                    "name": bucket_name,
                    "public": False,
                }).encode("utf-8")

                create_req = urllib.request.Request(
                    create_endpoint,
                    data=create_payload,
                    headers={
                        "apikey": supabase_key,
                        "Authorization": f"Bearer {supabase_key}",
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(create_req, timeout=5):
                    pass
                # Retry upload once after creating bucket
                return _upload_to_supabase_bucket(
                    supabase_url, supabase_key, bucket_name, file_path, payload
                )
            except Exception:
                pass
        logger.warning("Supabase storage upload error: HTTP %s", err.code)
        return False
    except Exception as exc:
        logger.warning("Supabase storage upload failed: %s", exc)
        return False


def log_ip_event_async(
    ip: str,
    action: str = "visit",
    headers: Optional[Dict[str, str]] = None,
    client_metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Fire-and-forget background logger that saves the IP record to Supabase bucket.
    """
    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = (
        os.getenv("SUPABASE_SECRET_KEY")
        or os.getenv("SUPABASE_KEY")
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("SUPABASE_PUBLISHABLE_KEY")
        or os.getenv("SUPABASE_ANON_KEY")
        or ""
    ).strip()
    bucket_name = os.getenv("SUPABASE_BUCKET_NAME", "ip-logs").strip()

    if not supabase_url or not supabase_key:
        # Supabase credentials not configured yet; skip quietly
        return

    safe_headers = _clean_headers(headers)
    client_metadata = _clean_metadata(client_metadata)

    now = datetime.utcnow()
    date_str = now.strftime("%Y-%m-%d")
    timestamp_ms = int(time.time() * 1000)
    clean_ip = ip.replace(":", "_").replace(".", "_")
    file_path = f"records/{date_str}/{clean_ip}_{timestamp_ms}_{action}.json"

    log_payload = {
        "ip": ip,
        "action": action,
        "timestamp_utc": now.isoformat() + "Z",
        "date": date_str,
        "headers": safe_headers,
        "metadata": client_metadata,
        "geo": {
            "country": safe_headers.get("x-vercel-ip-country"),
            "region": safe_headers.get("x-vercel-ip-country-region"),
            "city": safe_headers.get("x-vercel-ip-city"),
            "latitude": safe_headers.get("x-vercel-ip-latitude"),
            "longitude": safe_headers.get("x-vercel-ip-longitude"),
            "timezone": safe_headers.get("x-vercel-ip-timezone"),
        },
    }

    thread = threading.Thread(
        target=_upload_to_supabase_bucket,
        args=(supabase_url, supabase_key, bucket_name, file_path, log_payload),
        daemon=True,
    )
    thread.start()


def log_feedback_to_supabase_async(
    player_id: str,
    player_name: str,
    rating: int,
    feedback_text: str,
    categories: Optional[list] = None,
    room_code: Optional[str] = None,
    client_ip: Optional[str] = None,
    headers: Optional[Dict[str, str]] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Saves a player's first-game feedback report to Supabase Storage bucket and Database table.
    """
    supabase_url = os.getenv("SUPABASE_URL", "").strip()
    supabase_key = (
        os.getenv("SUPABASE_SECRET_KEY")
        or os.getenv("SUPABASE_KEY")
        or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("SUPABASE_PUBLISHABLE_KEY")
        or os.getenv("SUPABASE_ANON_KEY")
        or ""
    ).strip()
    bucket_name = os.getenv("SUPABASE_BUCKET_NAME", "ip-logs").strip()

    if not supabase_url or not supabase_key:
        logger.info("Supabase not configured for feedback logging, skipping upload.")
        return

    safe_headers = _clean_headers(headers)
    metadata = _clean_metadata(metadata)

    now = datetime.utcnow()
    date_str = now.strftime("%Y-%m-%d")
    timestamp_ms = int(time.time() * 1000)
    clean_id = (player_id or "anon").replace(":", "_").replace("-", "_")
    file_path = f"feedback/{date_str}/{clean_id}_{timestamp_ms}.json"

    feedback_payload = {
        "player_id": player_id,
        "player_name": player_name,
        "rating": rating,
        "feedback_text": feedback_text,
        "categories": categories or [],
        "room_code": room_code,
        "ip": client_ip,
        "timestamp_utc": now.isoformat() + "Z",
        "date": date_str,
        "headers": safe_headers,
        "metadata": metadata or {},
    }

    def _worker():
        # 1. Upload to Supabase Storage bucket
        _upload_to_supabase_bucket(
            supabase_url, supabase_key, bucket_name, file_path, feedback_payload
        )
        # 2. Attempt insert into Supabase database table 'feedback'
        try:
            db_endpoint = f"{supabase_url.rstrip('/')}/rest/v1/feedback"
            db_data = json.dumps({
                "player_id": player_id,
                "player_name": player_name,
                "rating": rating,
                "feedback_text": feedback_text,
                "categories": categories or [],
                "room_code": room_code,
                "ip": client_ip,
                "metadata": metadata or {},
            }).encode("utf-8")
            req = urllib.request.Request(
                db_endpoint,
                data=db_data,
                headers={
                    "apikey": supabase_key,
                    "Authorization": f"Bearer {supabase_key}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5):
                pass
        except Exception:
            # Table might not exist or requires custom policies; storage bucket already has the payload!
            pass

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()
