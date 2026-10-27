"""
HandCricket Live – Domain Models
Pure dataclasses / enums with no framework dependencies.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum, auto
from typing import Optional


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class RoomStatus(str, Enum):
    WAITING_FOR_PLAYERS = "WAITING_FOR_PLAYERS"
    LOBBY_READY = "LOBBY_READY"
    RULEBOOK_REQUIRED = "RULEBOOK_REQUIRED"
    TOSS = "TOSS"
    MATCH_SETUP = "MATCH_SETUP"
    INNINGS_ACTIVE = "INNINGS_ACTIVE"
    INNINGS_BREAK = "INNINGS_BREAK"
    MATCH_COMPLETE = "MATCH_COMPLETE"
    PAUSED = "PAUSED"


class GameMode(str, Enum):
    SOLO = "SOLO"
    TEAM = "TEAM"


class PlayerRole(str, Enum):
    BATTER = "BATTER"
    BOWLER = "BOWLER"
    SPECTATOR = "SPECTATOR"


class ConnectionState(str, Enum):
    CONNECTED = "CONNECTED"
    DISCONNECTED = "DISCONNECTED"
    RECONNECTING = "RECONNECTING"


class ReadinessState(str, Enum):
    READY = "READY"
    NOT_READY = "NOT_READY"
    DISCONNECTED = "DISCONNECTED"
    WAITING_FOR_BOWLER = "WAITING_FOR_BOWLER"


class DeliveryResult(str, Enum):
    RUNS = "RUNS"
    OUT = "OUT"
    TIMEOUT = "TIMEOUT"


class InningsPhase(str, Enum):
    FIRST = "FIRST"
    SECOND = "SECOND"
    SUPER_OVER_FIRST = "SUPER_OVER_FIRST"
    SUPER_OVER_SECOND = "SUPER_OVER_SECOND"


# ---------------------------------------------------------------------------
# Player / User
# ---------------------------------------------------------------------------

@dataclass
class Player:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    display_name: str = ""
    session_token: str = field(default_factory=lambda: str(uuid.uuid4()))
    connection_state: ConnectionState = ConnectionState.CONNECTED
    socket_id: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.utcnow)

    def to_public_dict(self) -> dict:
        """Safe serialisation – never includes session_token."""
        return {
            "id": self.id,
            "display_name": self.display_name,
            "connection_state": self.connection_state.value,
        }


# ---------------------------------------------------------------------------
# Membership
# ---------------------------------------------------------------------------

@dataclass
class Membership:
    room_id: str
    player_id: str
    team: Optional[str] = None          # "A" | "B" | None
    is_captain: bool = False
    is_host: bool = False
    joined_at: datetime = field(default_factory=datetime.utcnow)
    role: PlayerRole = PlayerRole.SPECTATOR
    readiness: ReadinessState = ReadinessState.NOT_READY
    rules_acked_version: Optional[str] = None
    voice_mode: str = "EVERYONE"         # "EVERYONE" | "TEAM_ONLY" | "SELECTED_PLAYERS" | "MUTED"
    allowed_recipients: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Room
# ---------------------------------------------------------------------------

@dataclass
class Room:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    join_code: str = ""                 # 6-char random alphanum
    host_id: str = ""
    mode: GameMode = GameMode.SOLO
    status: RoomStatus = RoomStatus.WAITING_FOR_PLAYERS
    capacity: int = 10
    rules_version: str = "1.0"
    created_at: datetime = field(default_factory=datetime.utcnow)
    # Match settings
    overs: int = 2
    wickets: int = 1
    allowed_overs: list = field(default_factory=lambda: list(range(1, 11)))
    toss: Optional[dict] = None
    team_a_name: str = "Team A"
    team_b_name: str = "Team B"

    def to_public_dict(self) -> dict:
        return {
            "id": self.id,
            "join_code": self.join_code,
            "mode": self.mode.value,
            "status": self.status.value,
            "overs": self.overs,
            "wickets": getattr(self, "wickets", 1 if self.mode == GameMode.SOLO else 5),
            "max_wickets": 5 if self.mode == GameMode.SOLO else 10,
            "allowed_overs": self.allowed_overs,
            "capacity": self.capacity,
            "rules_version": self.rules_version,
            "toss": self.toss,
            "team_a_name": getattr(self, "team_a_name", "Team A"),
            "team_b_name": getattr(self, "team_b_name", "Team B"),
            "is_paused": self.status == RoomStatus.PAUSED,
        }


# ---------------------------------------------------------------------------
# Match
# ---------------------------------------------------------------------------

@dataclass
class Match:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    room_id: str = ""
    phase: InningsPhase = InningsPhase.FIRST
    overs: int = 2
    wickets: Optional[int] = None
    team_a_name: str = "Team A"
    team_b_name: str = "Team B"

    # Scoring
    team_a_runs: int = 0
    team_a_wickets: int = 0
    team_b_runs: int = 0
    team_b_wickets: int = 0
    target: Optional[int] = None        # set after first innings

    # Extra wickets for smaller team
    team_a_extra_wickets: int = 0
    team_b_extra_wickets: int = 0

    # Progress
    current_over: int = 0               # 0-indexed
    current_ball: int = 0               # balls within current over (0-5)
    batting_team: str = "A"             # "A" or "B"
    first_batting_team: str = "A"       # team that batted in first innings

    # Active players
    active_batter_id: Optional[str] = None
    active_bowler_id: Optional[str] = None

    # Delivery deadline (UTC timestamp)
    delivery_deadline: Optional[datetime] = None

    # Result
    winner: Optional[str] = None        # "A" | "B" | "TIE"
    result_summary: Optional[str] = None

    # Team Match Batting Order & All Out Tracking
    dismissed_batters_a: list[str] = field(default_factory=list)
    dismissed_batters_b: list[str] = field(default_factory=list)
    is_all_out: bool = False
    all_out_team: Optional[str] = None
    is_all_out_a: bool = False
    is_all_out_b: bool = False
    all_out_announced_a: bool = False
    all_out_announced_b: bool = False

    # Super Over Tracking
    is_super_over: bool = False
    main_match_team_a_runs: int = 0
    main_match_team_b_runs: int = 0
    main_match_team_a_wickets: int = 0
    main_match_team_b_wickets: int = 0

    # Idempotency
    version: int = 0
    created_at: datetime = field(default_factory=datetime.utcnow)

    @property
    def batting_runs(self) -> int:
        return self.team_a_runs if self.batting_team == "A" else self.team_b_runs

    @property
    def batting_wickets(self) -> int:
        return self.team_a_wickets if self.batting_team == "A" else self.team_b_wickets

    @property
    def bowling_team(self) -> str:
        return "B" if self.batting_team == "A" else "A"

    def wicket_limit(self, team: str) -> int:
        """Configured match wickets or players on team + extra wicket allowance."""
        if getattr(self, "is_super_over", False):
            return 2
        extra = self.team_a_extra_wickets if team == "A" else self.team_b_extra_wickets
        base = getattr(self, "wickets", None)
        if base is not None and base > 0:
            return base + extra
        # Fallback stored at match creation; default 10 if not set
        team_size = getattr(self, "_team_a_size", 10) if team == "A" else getattr(self, "_team_b_size", 10)
        return team_size + extra


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------

@dataclass
class Delivery:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    match_id: str = ""
    innings: InningsPhase = InningsPhase.FIRST
    over_index: int = 0
    ball_index: int = 0

    batter_pick: Optional[int] = None
    bowler_pick: Optional[int] = None
    batter_id: Optional[str] = None
    bowler_id: Optional[str] = None
    result: Optional[DeliveryResult] = None
    runs_scored: int = 0
    timeout_reason: Optional[str] = None

    committed: bool = False
    commit_sequence: int = 0
    created_at: datetime = field(default_factory=datetime.utcnow)

    def to_reveal_dict(self) -> dict:
        """Safe dict emitted after resolution."""
        return {
            "id": self.id,
            "over": self.over_index,
            "ball": self.ball_index,
            "batter_pick": self.batter_pick,
            "bowler_pick": self.bowler_pick,
            "batter_id": getattr(self, "batter_id", None),
            "bowler_id": getattr(self, "bowler_id", None),
            "result": self.result.value if self.result else None,
            "runs_scored": self.runs_scored,
        }
