"""
Read-only analytics queries for the creator dashboard.

All timestamps are stored as naive UTC ISO-8601 strings, so lexicographic
comparisons against an ISO cut-off are exact.

The dashboard is cross-filterable: every aggregate honours an optional game
mode and an optional single day, mirroring how a BI dashboard slices a report.
"""

from __future__ import annotations

from datetime import datetime, time, timedelta
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

MODE_VALUES = ("SOLO", "TEAM")


def _scalar(conn, sql: str, params: tuple = ()) -> int:
    row = conn.execute(sql, params).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _float_or_none(value: Any) -> Optional[float]:
    return round(float(value), 2) if value is not None else None


def _score(runs: int, wickets: int, over: int, ball: int) -> str:
    return f"{runs}/{wickets} · {over}.{ball} ov"


def _day_series(conn, sql: str, params: tuple) -> dict[str, int]:
    rows = conn.execute(sql, params).fetchall()
    return {row[0]: int(row[1]) for row in rows if row[0]}


def _normalise_mode(mode: Optional[str]) -> Optional[str]:
    value = (mode or "").strip().upper()
    return value if value in MODE_VALUES else None


def _normalise_date(value: Optional[str]) -> Optional[datetime]:
    try:
        return datetime.strptime((value or "").strip(), "%Y-%m-%d")
    except ValueError:
        return None


def _match_filters(
    mode: Optional[str], start: str, end: Optional[str]
) -> tuple[list[str], list]:
    clauses = ["m.created_at >= ?"]
    params: list = [start]
    if end:
        clauses.append("m.created_at < ?")
        params.append(end)
    if mode:
        clauses.append("r.mode = ?")
        params.append(mode)
    return clauses, params


def _delivery_filters(
    mode: Optional[str], start: str, end: Optional[str]
) -> tuple[str, list[str], list]:
    """Return (FROM clause, WHERE clauses, params) for committed deliveries."""
    from_clause = "deliveries d"
    clauses = ["d.committed = 1"]
    params: list = []
    if mode:
        from_clause = (
            "deliveries d "
            "JOIN matches dm ON dm.id = d.match_id "
            "JOIN rooms dr ON dr.id = dm.room_id"
        )
        clauses.append("dr.mode = ?")
        params.append(mode)
    clauses.append("d.created_at >= ?")
    params.append(start)
    if end:
        clauses.append("d.created_at < ?")
        params.append(end)
    return from_clause, clauses, params


def _where(clauses: list[str]) -> str:
    return " AND ".join(clauses)


def _totals_for_window(
    conn,
    mode: Optional[str],
    start: str,
    end: Optional[str],
) -> dict:
    """Headline counts for an arbitrary window, used for period comparison."""
    match_clauses, match_params = _match_filters(mode, start, end)
    where = _where(match_clauses)

    matches = _scalar(
        conn,
        f"SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id WHERE {where}",
        tuple(match_params),
    )
    completed = _scalar(
        conn,
        f"SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id "
        f"WHERE {where} AND m.winner IS NOT NULL",
        tuple(match_params),
    )

    from_clause, delivery_clauses, delivery_params = _delivery_filters(mode, start, end)
    deliveries = _scalar(
        conn,
        f"SELECT COUNT(*) FROM {from_clause} WHERE {_where(delivery_clauses)}",
        tuple(delivery_params),
    )
    active_players = _scalar(
        conn,
        f"SELECT COUNT(DISTINCT d.batter_id) FROM {from_clause} "
        f"WHERE {_where(delivery_clauses)} AND d.batter_id IS NOT NULL",
        tuple(delivery_params),
    )
    runs = _scalar(
        conn,
        f"SELECT COALESCE(SUM(d.runs_scored), 0) FROM {from_clause} "
        f"WHERE {_where(delivery_clauses)} AND d.result = 'RUNS'",
        tuple(delivery_params),
    )
    dead_balls = _scalar(
        conn,
        f"SELECT COUNT(*) FROM {from_clause} "
        f"WHERE {_where(delivery_clauses)} AND d.result = 'TIMEOUT'",
        tuple(delivery_params),
    )

    players_new = _scalar(
        conn,
        "SELECT COUNT(*) FROM players WHERE created_at >= ?"
        + (" AND created_at < ?" if end else ""),
        (start, end) if end else (start,),
    )

    return {
        "matches": matches,
        "completed_matches": completed,
        "deliveries": deliveries,
        "active_players": active_players,
        "runs": runs,
        "dead_balls": dead_balls,
        "new_players": players_new,
    }


def _score_record(row) -> Optional[dict]:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def _lifetime_stats(conn) -> dict:
    """All-time totals from the non-purging match_history table."""
    totals = conn.execute(
        """
        SELECT
            COUNT(*) AS games_started,
            COALESCE(SUM(CASE WHEN winner IS NOT NULL THEN 1 ELSE 0 END), 0) AS games_completed,
            COALESCE(SUM(CASE WHEN winner = 'TIE' THEN 1 ELSE 0 END), 0) AS ties,
            COALESCE(SUM(CASE WHEN winner IS NOT NULL AND mode = 'SOLO' THEN 1 ELSE 0 END), 0) AS solo_games,
            COALESCE(SUM(CASE WHEN winner IS NOT NULL AND mode = 'TEAM' THEN 1 ELSE 0 END), 0) AS team_games,
            COALESCE(SUM(CASE WHEN winner IS NOT NULL
                THEN team_a_runs + team_b_runs ELSE 0 END), 0) AS runs,
            COALESCE(SUM(CASE WHEN winner IS NOT NULL THEN
                CASE WHEN EXISTS(SELECT 1 FROM deliveries d
                                 WHERE d.match_id = match_history.match_id)
                    THEN (SELECT COUNT(*) FROM deliveries d
                          WHERE d.match_id = match_history.match_id)
                    ELSE deliveries END
                ELSE 0 END), 0) AS deliveries,
            COALESCE(SUM(CASE WHEN winner IS NOT NULL THEN
                CASE WHEN EXISTS(SELECT 1 FROM deliveries d
                                 WHERE d.match_id = match_history.match_id)
                    THEN (SELECT COUNT(*) FROM deliveries d
                          WHERE d.match_id = match_history.match_id
                            AND d.result = 'TIMEOUT')
                    ELSE dead_balls END
                ELSE 0 END), 0) AS dead_balls,
            MIN(started_at) AS first_game_at,
            MAX(COALESCE(completed_at, started_at)) AS last_game_at
        FROM match_history
        """
    ).fetchone()

    duration = conn.execute(
        """
        SELECT AVG((julianday(completed_at) - julianday(started_at)) * 1440.0)
        FROM match_history
        WHERE winner IS NOT NULL AND completed_at IS NOT NULL
        """
    ).fetchone()[0]

    play_ph = ",".join("?" for _ in IN_PLAY_STATUSES)
    live_games = _scalar(
        conn,
        f"""
        SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id
        WHERE m.winner IS NULL AND r.status IN ({play_ph})
        """,
        tuple(s.value for s in IN_PLAY_STATUSES),
    )

    highest_team = conn.execute(
        """
        SELECT team, runs, wickets, opponent, join_code, mode, played_at FROM (
            SELECT team_a_name AS team, team_a_runs AS runs, team_a_wickets AS wickets,
                   team_b_name AS opponent, join_code, mode,
                   COALESCE(completed_at, started_at) AS played_at
            FROM match_history WHERE winner IS NOT NULL
            UNION ALL
            SELECT team_b_name AS team, team_b_runs AS runs, team_b_wickets AS wickets,
                   team_a_name AS opponent, join_code, mode,
                   COALESCE(completed_at, started_at) AS played_at
            FROM match_history WHERE winner IS NOT NULL
        )
        ORDER BY runs DESC, wickets ASC LIMIT 1
        """
    ).fetchone()

    highest_total = conn.execute(
        """
        SELECT team_a_name, team_b_name, team_a_runs, team_a_wickets,
               team_b_runs, team_b_wickets,
               team_a_runs + team_b_runs AS total,
               join_code, mode, COALESCE(completed_at, started_at) AS played_at
        FROM match_history
        WHERE winner IS NOT NULL
        ORDER BY total DESC LIMIT 1
        """
    ).fetchone()

    margin_sql = """
        SELECT
            CASE WHEN winner = 'A' THEN team_a_name ELSE team_b_name END AS winner_name,
            CASE WHEN winner = 'A' THEN team_b_name ELSE team_a_name END AS loser_name,
            team_a_runs, team_a_wickets, team_b_runs, team_b_wickets,
            ABS(team_a_runs - team_b_runs) AS margin,
            join_code, mode, COALESCE(completed_at, started_at) AS played_at
        FROM match_history
        WHERE winner IN ('A', 'B')
    """
    biggest_win = conn.execute(
        margin_sql + " ORDER BY margin DESC, played_at DESC LIMIT 1"
    ).fetchone()
    closest_game = conn.execute(
        margin_sql + " AND ABS(team_a_runs - team_b_runs) > 0 ORDER BY margin ASC, played_at DESC LIMIT 1"
    ).fetchone()

    recent_rows = conn.execute(
        """
        SELECT match_id, join_code, mode, team_a_name, team_b_name,
               team_a_runs, team_a_wickets, team_b_runs, team_b_wickets,
               winner, result_summary, COALESCE(completed_at, started_at) AS played_at
        FROM match_history
        WHERE winner IS NOT NULL
        ORDER BY played_at DESC LIMIT 5
        """
    ).fetchall()

    return {
        "games_started": int(totals["games_started"] or 0),
        "games_completed": int(totals["games_completed"] or 0),
        "in_progress": live_games,
        "ties": int(totals["ties"] or 0),
        "solo_games": int(totals["solo_games"] or 0),
        "team_games": int(totals["team_games"] or 0),
        "runs": int(totals["runs"] or 0),
        "deliveries": int(totals["deliveries"] or 0),
        "dead_balls": int(totals["dead_balls"] or 0),
        "avg_match_minutes": _float_or_none(duration),
        "first_game_at": totals["first_game_at"],
        "last_game_at": totals["last_game_at"],
        "highest_team_score": _score_record(highest_team),
        "highest_total": _score_record(highest_total),
        "biggest_win": _score_record(biggest_win),
        "closest_game": _score_record(closest_game),
        "recent_completed": [
            {
                "id": row["match_id"],
                "join_code": row["join_code"],
                "mode": row["mode"],
                "team_a": row["team_a_name"],
                "team_b": row["team_b_name"],
                "team_a_score": f"{row['team_a_runs']}/{row['team_a_wickets']}",
                "team_b_score": f"{row['team_b_runs']}/{row['team_b_wickets']}",
                "winner": row["winner"],
                "result_summary": row["result_summary"],
                "played_at": row["played_at"],
            }
            for row in recent_rows
        ],
    }


def _community_stats(conn) -> dict:
    """Account, social and achievement totals that never expire."""
    now = datetime.utcnow()
    day_ago = (now - timedelta(hours=24)).isoformat()
    week_ago = (now - timedelta(days=7)).isoformat()
    online_cutoff = (now - timedelta(minutes=15)).isoformat()

    return {
        "accounts": _scalar(conn, "SELECT COUNT(*) FROM users"),
        "new_accounts_24h": _scalar(
            conn, "SELECT COUNT(*) FROM users WHERE created_at >= ?", (day_ago,)
        ),
        "new_accounts_7d": _scalar(
            conn, "SELECT COUNT(*) FROM users WHERE created_at >= ?", (week_ago,)
        ),
        "online_accounts": _scalar(
            conn,
            "SELECT COUNT(DISTINCT user_id) FROM user_sessions "
            "WHERE last_used_at >= ? AND expires_at > ?",
            (online_cutoff, now.isoformat()),
        ),
        "friendships": _scalar(
            conn, "SELECT COUNT(*) FROM friendships WHERE status = 'ACCEPTED'"
        ),
        "direct_messages": _scalar(conn, "SELECT COUNT(*) FROM direct_messages"),
        "achievements": _scalar(conn, "SELECT COUNT(*) FROM user_achievements"),
        "play_requests": _scalar(conn, "SELECT COUNT(*) FROM play_requests"),
    }


def get_creator_insights(
    days: int = 7, mode: Optional[str] = None, date: Optional[str] = None
) -> dict:
    """Aggregate platform health for the creator dashboard.

    ``mode`` narrows match and delivery aggregates to SOLO or TEAM. ``date``
    (YYYY-MM-DD) narrows everything except the always-live panels to one day
    inside the selected range. Invalid filters are ignored rather than 400ing,
    so a stale dashboard tab never breaks.
    """
    now = datetime.utcnow()
    cutoff = (now - timedelta(days=days)).isoformat()
    # Midnight-anchored window so the chart always shows whole days.
    window_start = (now - timedelta(days=days - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    window_iso = window_start.isoformat()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    selected_mode = _normalise_mode(mode)
    selected_day = _normalise_date(date)
    if selected_day is not None:
        # Only days inside the visible window are meaningful to the slicer.
        if not (window_start <= selected_day <= today_start):
            selected_day = None

    if selected_day is not None:
        start_iso = selected_day.isoformat()
        end_iso = (selected_day + timedelta(days=1)).isoformat()
        previous_start = (selected_day - timedelta(days=1)).isoformat()
        previous_end = start_iso
    else:
        start_iso = cutoff
        end_iso = None
        previous_start = (now - timedelta(days=days * 2)).isoformat()
        previous_end = cutoff

    live_ph = ",".join("?" for _ in LIVE_ROOM_STATUSES)
    live_values = tuple(s.value for s in LIVE_ROOM_STATUSES)
    play_ph = ",".join("?" for _ in IN_PLAY_STATUSES)
    play_values = tuple(s.value for s in IN_PLAY_STATUSES)

    match_clauses, match_params = _match_filters(selected_mode, start_iso, end_iso)
    match_where = _where(match_clauses)
    delivery_from, delivery_clauses, delivery_params = _delivery_filters(
        selected_mode, start_iso, end_iso
    )
    delivery_where = _where(delivery_clauses)

    with _lock, _get_connection() as conn:
        players_total = _scalar(conn, "SELECT COUNT(*) FROM players")
        players_new = _scalar(
            conn,
            "SELECT COUNT(*) FROM players WHERE created_at >= ?"
            + (" AND created_at < ?" if end_iso else ""),
            (start_iso, end_iso) if end_iso else (start_iso,),
        )

        rooms_total = _scalar(
            conn,
            "SELECT COUNT(*) FROM rooms WHERE created_at >= ?"
            + (" AND created_at < ?" if end_iso else "")
            + (" AND mode = ?" if selected_mode else ""),
            (
                (start_iso, end_iso, selected_mode)
                if end_iso and selected_mode
                else (start_iso, end_iso)
                if end_iso
                else (start_iso, selected_mode)
                if selected_mode
                else (start_iso,)
            ),
        )
        live_rooms = _scalar(
            conn,
            f"SELECT COUNT(*) FROM rooms WHERE status IN ({live_ph})"
            + (" AND mode = ?" if selected_mode else ""),
            live_values + ((selected_mode,) if selected_mode else ()),
        )

        matches_total = _scalar(
            conn,
            f"SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id "
            f"WHERE {match_where}",
            tuple(match_params),
        )
        completed_matches = _scalar(
            conn,
            f"SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id "
            f"WHERE {match_where} AND m.winner IS NOT NULL",
            tuple(match_params),
        )
        live_matches = _scalar(
            conn,
            f"""
            SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id
            WHERE m.winner IS NULL AND r.status IN ({play_ph})
            """
            + (" AND r.mode = ?" if selected_mode else ""),
            play_values + ((selected_mode,) if selected_mode else ()),
        )

        # The mode slicer zeroes the excluded slice instead of showing stale
        # totals the rest of the report no longer reflects.
        solo_matches = 0
        team_matches = 0
        if selected_mode in (None, "SOLO"):
            solo_clauses, solo_params = _match_filters("SOLO", start_iso, end_iso)
            solo_matches = _scalar(
                conn,
                f"SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id "
                f"WHERE {_where(solo_clauses)}",
                tuple(solo_params),
            )
        if selected_mode in (None, "TEAM"):
            team_clauses, team_params = _match_filters("TEAM", start_iso, end_iso)
            team_matches = _scalar(
                conn,
                f"SELECT COUNT(*) FROM matches m JOIN rooms r ON r.id = m.room_id "
                f"WHERE {_where(team_clauses)}",
                tuple(team_params),
            )

        players_active = _scalar(
            conn,
            f"SELECT COUNT(DISTINCT d.batter_id) FROM {delivery_from} "
            f"WHERE {delivery_where} AND d.batter_id IS NOT NULL",
            tuple(delivery_params),
        )
        deliveries_total = _scalar(
            conn,
            f"SELECT COUNT(*) FROM {delivery_from} WHERE {delivery_where}",
            tuple(delivery_params),
        )
        runs_total = _scalar(
            conn,
            f"SELECT COALESCE(SUM(d.runs_scored), 0) FROM {delivery_from} "
            f"WHERE {delivery_where} AND d.result = 'RUNS'",
            tuple(delivery_params),
        )
        dead_balls = _scalar(
            conn,
            f"SELECT COUNT(*) FROM {delivery_from} "
            f"WHERE {delivery_where} AND d.result = 'TIMEOUT'",
            tuple(delivery_params),
        )

        avg_match_minutes = _float_or_none(
            conn.execute(
                f"""
                SELECT AVG((julianday(last_at) - julianday(created_at)) * 1440.0)
                FROM (
                    SELECT m.created_at, MAX(d.created_at) AS last_at
                    FROM matches m
                    JOIN rooms r ON r.id = m.room_id
                    JOIN deliveries d ON d.match_id = m.id
                    WHERE {match_where} AND m.winner IS NOT NULL
                    GROUP BY m.id
                )
                """,
                tuple(match_params),
            ).fetchone()[0]
        )

        previous = _totals_for_window(
            conn, selected_mode, previous_start, previous_end
        )

        # --- activity time series (always the full window, zero-filled below) ---
        series_mode_params = (window_iso, selected_mode) if selected_mode else (window_iso,)
        matches_by_day = _day_series(
            conn,
            "SELECT substr(m.created_at, 1, 10), COUNT(*) "
            "FROM matches m JOIN rooms r ON r.id = m.room_id "
            "WHERE m.created_at >= ?"
            + (" AND r.mode = ?" if selected_mode else "")
            + " GROUP BY 1",
            series_mode_params,
        )
        mode_rows = conn.execute(
            "SELECT substr(m.created_at, 1, 10), r.mode, COUNT(*) "
            "FROM matches m JOIN rooms r ON r.id = m.room_id "
            "WHERE m.created_at >= ? GROUP BY 1, 2",
            (window_iso,),
        ).fetchall()
        solo_by_day: dict[str, int] = {}
        team_by_day: dict[str, int] = {}
        for row in mode_rows:
            target = solo_by_day if row[1] == "SOLO" else team_by_day
            target[row[0]] = target.get(row[0], 0) + int(row[2])

        new_players_by_day = _day_series(
            conn,
            "SELECT substr(created_at, 1, 10), COUNT(*) FROM players "
            "WHERE created_at >= ? GROUP BY 1",
            (window_iso,),
        )

        window_from, window_clauses, window_params = _delivery_filters(
            selected_mode, window_iso, None
        )
        window_where = _where(window_clauses)
        deliveries_by_day = _day_series(
            conn,
            f"SELECT substr(d.created_at, 1, 10), COUNT(*) FROM {window_from} "
            f"WHERE {window_where} GROUP BY 1",
            tuple(window_params),
        )
        batters_by_day = _day_series(
            conn,
            f"SELECT substr(d.created_at, 1, 10), COUNT(DISTINCT d.batter_id) "
            f"FROM {window_from} WHERE {window_where} AND d.batter_id IS NOT NULL "
            f"GROUP BY 1",
            tuple(window_params),
        )
        runs_by_day = _day_series(
            conn,
            f"SELECT substr(d.created_at, 1, 10), COALESCE(SUM(d.runs_scored), 0) "
            f"FROM {window_from} WHERE {window_where} AND d.result = 'RUNS' GROUP BY 1",
            tuple(window_params),
        )
        dead_by_day = _day_series(
            conn,
            f"SELECT substr(d.created_at, 1, 10), COUNT(*) FROM {window_from} "
            f"WHERE {window_where} AND d.result = 'TIMEOUT' GROUP BY 1",
            tuple(window_params),
        )

        # --- hourly drilldown: the selected day, else the whole window by hour ---
        hour_deliveries = conn.execute(
            f"SELECT substr(d.created_at, 12, 2), COUNT(*) FROM {delivery_from} "
            f"WHERE {delivery_where} GROUP BY 1",
            tuple(delivery_params),
        ).fetchall()
        hourly_matches = conn.execute(
            f"SELECT substr(m.created_at, 12, 2), COUNT(*) FROM matches m "
            f"JOIN rooms r ON r.id = m.room_id WHERE {match_where} GROUP BY 1",
            tuple(match_params),
        ).fetchall()

        # --- delivery mix ---
        pick_rows = conn.execute(
            f"SELECT d.batter_pick, COUNT(*) FROM {delivery_from} "
            f"WHERE {delivery_where} AND d.result = 'RUNS' "
            f"AND d.batter_pick IS NOT NULL GROUP BY d.batter_pick",
            tuple(delivery_params),
        ).fetchall()
        outs = _scalar(
            conn,
            f"SELECT COUNT(*) FROM {delivery_from} "
            f"WHERE {delivery_where} AND d.result = 'OUT'",
            tuple(delivery_params),
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
            """ + (" AND r.mode = ?" if selected_mode else "") + """
            ORDER BY r.created_at DESC
            LIMIT 12
            """,
            live_values + ((selected_mode,) if selected_mode else ()),
        ).fetchall()

        # --- recent matches ---
        recent_rows = conn.execute(
            f"""
            SELECT m.id, r.join_code, r.mode, r.status,
                   m.team_a_name, m.team_b_name,
                   m.team_a_runs, m.team_a_wickets, m.team_b_runs, m.team_b_wickets,
                   m.winner, m.result_summary, m.created_at,
                   (SELECT MAX(d.created_at) FROM deliveries d WHERE d.match_id = m.id) AS last_at
            FROM matches m JOIN rooms r ON r.id = m.room_id
            WHERE {match_where}
            ORDER BY m.created_at DESC
            LIMIT 8
            """,
            tuple(match_params),
        ).fetchall()

        # --- standout players ---
        top_batters = conn.execute(
            f"""
            SELECT p.display_name, COUNT(*) AS balls, COALESCE(SUM(d.runs_scored), 0) AS runs
            FROM {delivery_from} JOIN players p ON p.id = d.batter_id
            WHERE {delivery_where} AND d.result = 'RUNS'
            GROUP BY d.batter_id
            ORDER BY balls DESC, runs DESC
            LIMIT 5
            """,
            tuple(delivery_params),
        ).fetchall()
        top_bowlers = conn.execute(
            f"""
            SELECT p.display_name, COUNT(*) AS wickets
            FROM {delivery_from} JOIN players p ON p.id = d.bowler_id
            WHERE {delivery_where} AND d.result = 'OUT'
            GROUP BY d.bowler_id
            ORDER BY wickets DESC
            LIMIT 5
            """,
            tuple(delivery_params),
        ).fetchall()

        lifetime = _lifetime_stats(conn)
        community = _community_stats(conn)

    # Zero-fill every day in the window (including today).
    activity = []
    cursor = window_start
    for _ in range(days):
        key = cursor.date().isoformat()
        activity.append(
            {
                "date": key,
                "matches": matches_by_day.get(key, 0),
                "solo_matches": solo_by_day.get(key, 0),
                "team_matches": team_by_day.get(key, 0),
                "new_players": new_players_by_day.get(key, 0),
                "deliveries": deliveries_by_day.get(key, 0),
                "batters": batters_by_day.get(key, 0),
                "runs": runs_by_day.get(key, 0),
                "dead_balls": dead_by_day.get(key, 0),
            }
        )
        cursor += timedelta(days=1)

    hourly = []
    delivery_hours = {int(row[0]): int(row[1]) for row in hour_deliveries if row[0]}
    match_hours = {int(row[0]): int(row[1]) for row in hourly_matches if row[0]}
    for hour in range(24):
        hourly.append(
            {
                "hour": hour,
                "deliveries": delivery_hours.get(hour, 0),
                "matches": match_hours.get(hour, 0),
            }
        )

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
        "filters": {
            "mode": selected_mode,
            "date": selected_day.date().isoformat() if selected_day else None,
        },
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
        "previous": previous,
        "activity": activity,
        "hourly": hourly,
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
        "lifetime": lifetime,
        "community": community,
    }
