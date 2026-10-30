"""
Read-only analytics queries for the creator dashboard.

All timestamps are stored as naive UTC ISO-8601 strings, so lexicographic
comparisons against an ISO cut-off are exact.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from ..domain.models import RoomStatus
from .sqlite import _get_connection, _lock

LIVE_ROOM_STATUSES = (
    RoomStatus.WAITING_FOR_PLAYERS,
    RoomStatus.LOBBY_READY,
    RoomStatus.RULEBOOK_REQUIRED,
    RoomStatus.TOSS,
    RoomStatus.MATCH_SETUP,
    RoomStatus.AWAITING_FIRST_BALL,
    RoomStatus.INNINGS_ACTIVE,
    RoomStatus.INNINGS_BREAK,
    RoomStatus.PAUSED,
)

IN_PLAY_STATUSES = (
    RoomStatus.TOSS,
    RoomStatus.MATCH_SETUP,
    RoomStatus.AWAITING_FIRST_BALL,
    RoomStatus.INNINGS_ACTIVE,
    RoomStatus.INNINGS_BREAK,
    RoomStatus.PAUSED,
)


def _scalar(conn, sql: str, params: tuple = ()) -> int:
    row = conn.execute(sql, params).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _float_or_none(value: Any) -> Optional[float]:
    return round(float(value), 2) if value is not None else None


def _score(runs: int, wickets: int, over: int, ball: int) -> str:
    return f"{runs}/{wickets} · {over}.{ball} ov"


def _day_series(conn, sql: str, cutoff: str) -> dict[str, int]:
    rows = conn.execute(sql, (cutoff,)).fetchall()
    return {row[0]: int(row[1]) for row in rows if row[0]}


def get_creator_insights(days: int = 7) -> dict:
    """Aggregate platform health for the creator dashboard."""
    now = datetime.utcnow()
    cutoff = (now - timedelta(days=days)).isoformat()
    # Midnight-anchored window so the chart always shows whole days.
    window_start = (now - timedelta(days=days - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    window_iso = window_start.isoformat()

    live_ph = ",".join("?" for _ in LIVE_ROOM_STATUSES)
    live_values = tuple(s.value for s in LIVE_ROOM_STATUSES)
    play_ph = ",".join("?" for _ in IN_PLAY_STATUSES)
    play_values = tuple(s.value for s in IN_PLAY_STATUSES)

    with _lock, _get_connection() as conn:
        players_total = _scalar(conn, "SELECT COUNT(*) FROM players")
        players_new = _scalar(
            conn, "SELECT COUNT(*) FROM players WHERE created_at >= ?", (cutoff,)
        )
        players_active = _scalar(
            conn,
            """
            SELECT COUNT(DISTINCT batter_id) FROM deliveries
            WHERE committed = 1 AND batter_id IS NOT NULL AND created_at >= ?
            """,
            (cutoff,),
        )

        rooms_total = _scalar(
            conn, "SELECT COUNT(*) FROM rooms WHERE created_at >= ?", (cutoff,)
        )
        live_rooms = _scalar(
            conn, f"SELECT COUNT(*) FROM rooms WHERE status IN ({live_ph})", live_values
        )

        matches_total = _scalar(
            conn, "SELECT COUNT(*) FROM matches WHERE created_at >= ?", (cutoff,)
        )
        completed_matches = _scalar(
            conn,
            "SELECT COUNT(*) FROM matches WHERE winner IS NOT NULL AND created_at >= ?",
            (cutoff,),
        )
        live_matches = _scalar(
            conn,
            f"""
            SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id
            WHERE m.winner IS NULL AND r.status IN ({play_ph})
            """,
            play_values,
        )
        solo_matches = _scalar(
            conn,
            """
            SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id
            WHERE r.mode = 'SOLO' AND m.created_at >= ?
            """,
            (cutoff,),
        )
        team_matches = _scalar(
            conn,
            """
            SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id
            WHERE r.mode = 'TEAM' AND m.created_at >= ?
            """,
            (cutoff,),
        )

        deliveries_total = _scalar(
            conn,
            "SELECT COUNT(*) FROM deliveries WHERE committed = 1 AND created_at >= ?",
            (cutoff,),
        )
        runs_total = _scalar(
            conn,
            """
            SELECT COALESCE(SUM(runs_scored), 0) FROM deliveries
            WHERE committed = 1 AND result = 'RUNS' AND created_at >= ?
            """,
            (cutoff,),
        )
        dead_balls = _scalar(
            conn,
            """
            SELECT COUNT(*) FROM deliveries
            WHERE committed = 1 AND result = 'TIMEOUT' AND created_at >= ?
            """,
            (cutoff,),
        )

        avg_match_minutes = _float_or_none(
            conn.execute(
                """
                SELECT AVG((julianday(last_at) - julianday(created_at)) * 1440.0)
                FROM (
                    SELECT m.created_at, MAX(d.created_at) AS last_at
                    FROM matches m JOIN deliveries d ON d.match_id = m.id
                    WHERE m.winner IS NOT NULL AND m.created_at >= ?
                    GROUP BY m.id
                )
                """,
                (cutoff,),
            ).fetchone()[0]
        )

        # --- activity time series (zero-filled below) ---
        matches_by_day = _day_series(
            conn,
            "SELECT substr(created_at, 1, 10), COUNT(*) FROM matches "
            "WHERE created_at >= ? GROUP BY 1",
            window_iso,
        )
        new_players_by_day = _day_series(
            conn,
            "SELECT substr(created_at, 1, 10), COUNT(*) FROM players "
            "WHERE created_at >= ? GROUP BY 1",
            window_iso,
        )
        deliveries_by_day = _day_series(
            conn,
            "SELECT substr(created_at, 1, 10), COUNT(*) FROM deliveries "
            "WHERE committed = 1 AND created_at >= ? GROUP BY 1",
            window_iso,
        )
        batters_by_day = _day_series(
            conn,
            "SELECT substr(created_at, 1, 10), COUNT(DISTINCT batter_id) FROM deliveries "
            "WHERE committed = 1 AND batter_id IS NOT NULL AND created_at >= ? GROUP BY 1",
            window_iso,
        )

        # --- delivery mix ---
        pick_rows = conn.execute(
            """
            SELECT batter_pick, COUNT(*) FROM deliveries
            WHERE committed = 1 AND result = 'RUNS' AND batter_pick IS NOT NULL
              AND created_at >= ?
            GROUP BY batter_pick
            """,
            (cutoff,),
        ).fetchall()
        outs = _scalar(
            conn,
            "SELECT COUNT(*) FROM deliveries WHERE committed = 1 AND result = 'OUT' "
            "AND created_at >= ?",
            (cutoff,),
        )

        # --- live rooms ---
        live_rows = conn.execute(
            f"""
            SELECT r.id, r.join_code, r.mode, r.status, r.overs, r.created_at,
                   (SELECT COUNT(*) FROM memberships mm WHERE mm.room_id = r.id) AS players,
                   m.team_a_name, m.team_b_name,
                   m.team_a_runs, m.team_a_wickets, m.team_b_runs, m.team_b_wickets,
                   m.current_over, m.current_ball, m.winner
            FROM rooms r
            LEFT JOIN matches m ON m.id = (
                SELECT id FROM matches WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1
            )
            WHERE r.status IN ({live_ph})
            ORDER BY r.created_at DESC
            LIMIT 12
            """,
            live_values,
        ).fetchall()

        # --- recent matches ---
        recent_rows = conn.execute(
            """
            SELECT m.id, r.join_code, r.mode, r.status,
                   m.team_a_name, m.team_b_name,
                   m.team_a_runs, m.team_a_wickets, m.team_b_runs, m.team_b_wickets,
                   m.winner, m.result_summary, m.created_at,
                   (SELECT MAX(d.created_at) FROM deliveries d WHERE d.match_id = m.id) AS last_at
            FROM matches m JOIN rooms r ON r.id = m.room_id
            WHERE m.created_at >= ?
            ORDER BY m.created_at DESC
            LIMIT 8
            """,
            (cutoff,),
        ).fetchall()

        # --- standout players ---
        top_batters = conn.execute(
            """
            SELECT p.display_name, COUNT(*) AS balls, COALESCE(SUM(d.runs_scored), 0) AS runs
            FROM deliveries d JOIN players p ON p.id = d.batter_id
            WHERE d.committed = 1 AND d.result = 'RUNS' AND d.created_at >= ?
            GROUP BY d.batter_id
            ORDER BY balls DESC, runs DESC
            LIMIT 5
            """,
            (cutoff,),
        ).fetchall()
        top_bowlers = conn.execute(
            """
            SELECT p.display_name, COUNT(*) AS wickets
            FROM deliveries d JOIN players p ON p.id = d.bowler_id
            WHERE d.committed = 1 AND d.result = 'OUT' AND d.created_at >= ?
            GROUP BY d.bowler_id
            ORDER BY wickets DESC
            LIMIT 5
            """,
            (cutoff,),
        ).fetchall()

    # Zero-fill every day in the window (including today).
    activity = []
    cursor = window_start
    for _ in range(days):
        key = cursor.date().isoformat()
        activity.append(
            {
                "date": key,
                "matches": matches_by_day.get(key, 0),
                "new_players": new_players_by_day.get(key, 0),
                "deliveries": deliveries_by_day.get(key, 0),
                "batters": batters_by_day.get(key, 0),
            }
        )
        cursor += timedelta(days=1)

    delivery_mix = {str(pick): 0 for pick in range(1, 7)}
    for pick, count in pick_rows:
        if pick in range(1, 7):
            delivery_mix[str(pick)] = int(count)
    delivery_mix["out"] = outs
    delivery_mix["dead"] = dead_balls

    live = []
    for row in live_rows:
        has_match = row["team_a_name"] is not None
        live.append(
            {
                "id": row["id"],
                "join_code": row["join_code"],
                "mode": row["mode"],
                "status": row["status"],
                "players": int(row["players"] or 0),
                "overs": row["overs"],
                "created_at": row["created_at"],
                "score": (
                    _score(
                        row["team_a_runs"],
                        row["team_a_wickets"],
                        row["current_over"],
                        row["current_ball"],
                    )
                    if has_match
                    else None
                ),
                "team_a": row["team_a_name"],
                "team_b": row["team_b_name"],
            }
        )

    recent_matches = []
    for row in recent_rows:
        duration = None
        if row["winner"] is not None and row["last_at"]:
            try:
                started = datetime.fromisoformat(row["created_at"])
                ended = datetime.fromisoformat(row["last_at"])
                duration = round((ended - started).total_seconds() / 60, 1)
            except ValueError:
                duration = None
        recent_matches.append(
            {
                "id": row["id"],
                "join_code": row["join_code"],
                "mode": row["mode"],
                "completed": row["winner"] is not None,
                "team_a": row["team_a_name"],
                "team_b": row["team_b_name"],
                "team_a_score": f"{row['team_a_runs']}/{row['team_a_wickets']}",
                "team_b_score": f"{row['team_b_runs']}/{row['team_b_wickets']}",
                "winner": row["winner"],
                "result_summary": row["result_summary"],
                "created_at": row["created_at"],
                "duration_minutes": duration,
            }
        )

    return {
        "days": days,
        "window_start": window_start.isoformat() + "Z",
        "totals": {
            "players": players_total,
            "new_players": players_new,
            "active_players": players_active,
            "rooms": rooms_total,
            "live_rooms": live_rooms,
            "matches": matches_total,
            "completed_matches": completed_matches,
            "live_matches": live_matches,
            "completion_rate": round(completed_matches / matches_total, 3)
            if matches_total
            else None,
            "solo_matches": solo_matches,
            "team_matches": team_matches,
            "deliveries": deliveries_total,
            "runs": runs_total,
            "dead_balls": dead_balls,
            "dead_ball_rate": round(dead_balls / deliveries_total, 3)
            if deliveries_total
            else None,
            "avg_match_minutes": avg_match_minutes,
        },
        "activity": activity,
        "delivery_mix": delivery_mix,
        "live": live,
        "recent_matches": recent_matches,
        "top_batters": [
            {"name": r[0] or "Unknown", "balls": int(r[1]), "runs": int(r[2] or 0)}
            for r in top_batters
        ],
        "top_bowlers": [
            {"name": r[0] or "Unknown", "wickets": int(r[1])} for r in top_bowlers
        ],
    }
