"""
Achievement and badge catalog.

Pure data + evaluation. A badge is earned once its metric reaches the
threshold; the catalog is static so the UI can show locked badges with
progress instead of hiding future goals.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Badge:
    code: str
    name: str
    description: str
    icon: str
    tier: str          # bronze | silver | gold
    metric: str
    threshold: int


CATALOG: tuple[Badge, ...] = (
    Badge("FIRST_MATCH", "First Stride", "Finish your first match", "🌱", "bronze", "matches", 1),
    Badge("FIRST_WIN", "Opening Victory", "Win your first match", "🏆", "bronze", "wins", 1),
    Badge("WIN_5", "Winning Habit", "Win 5 matches", "🔥", "silver", "wins", 5),
    Badge("WIN_25", "Club Legend", "Win 25 matches", "👑", "gold", "wins", 25),
    Badge("RUNS_100", "Century Club", "Score 100 career runs", "🏏", "silver", "runs", 100),
    Badge("RUNS_500", "Run Machine", "Score 500 career runs", "🚀", "gold", "runs", 500),
    Badge("WICKETS_10", "Strike Bowler", "Take 10 wickets", "🎯", "silver", "wickets", 10),
    Badge("WICKETS_50", "Wicket Hunter", "Take 50 wickets", "🦅", "gold", "wickets", 50),
    Badge("SUPER_OVER", "Clutch Player", "Play a Super Over", "⚡", "bronze", "super_overs", 1),
    Badge("SUPER_OVER_WIN", "Super Over Hero", "Win a match in the Super Over", "🌟", "gold", "super_over_wins", 1),
    Badge("STREAK_3", "On Fire", "Win 3 matches in a row", "💥", "silver", "best_streak", 3),
    Badge("STREAK_5", "Unstoppable", "Win 5 matches in a row", "🌊", "gold", "best_streak", 5),
    Badge("TEAM_10", "Team Player", "Play 10 team matches", "🤝", "silver", "team_matches", 10),
    Badge("SOCIAL_5", "Inner Circle", "Add 5 friends", "🫂", "silver", "friends", 5),
    Badge("PROFILE_COMPLETE", "All Set", "Add an avatar and a bio", "✨", "bronze", "profile_complete", 1),
    Badge("DEAD_BALL_10", "Ice Cool", "Stay involved in 10 dead balls", "🧊", "bronze", "dead_balls", 10),
)

_BY_CODE = {badge.code: badge for badge in CATALOG}


def _metric_value(
    stats: dict,
    friend_count: int,
    profile_complete: bool,
    metric: str,
) -> int:
    if metric == "friends":
        return int(friend_count)
    if metric == "profile_complete":
        return 1 if profile_complete else 0
    try:
        return int(stats.get(metric, 0) or 0)
    except (TypeError, ValueError):
        return 0


def earned_codes(
    stats: dict,
    friend_count: int = 0,
    profile_complete: bool = False,
) -> set[str]:
    return {
        badge.code
        for badge in CATALOG
        if _metric_value(stats, friend_count, profile_complete, badge.metric) >= badge.threshold
    }


def progress_value(
    badge: Badge,
    stats: dict,
    friend_count: int,
    profile_complete: bool,
) -> int:
    return _metric_value(stats, friend_count, profile_complete, badge.metric)


def badge_payload(
    earned: set[str],
    stats: dict,
    friend_count: int = 0,
    profile_complete: bool = False,
) -> list[dict]:
    result = []
    for badge in CATALOG:
        value = progress_value(badge, stats, friend_count, profile_complete)
        result.append(
            {
                **asdict(badge),
                "earned": badge.code in earned,
                "progress": min(1.0, round(value / badge.threshold, 3)),
                "value": min(value, badge.threshold),
            }
        )
    return result


def is_badge(code: str) -> bool:
    return code in _BY_CODE
