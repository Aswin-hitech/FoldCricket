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
            "allowed_overs": self.allowed_overs,
            "capacity": self.capacity,
            "rules_version": self.rules_version,
            "toss": self.toss,
            "team_a_name": getattr(self, "team_a_name", "Team A"),
            "team_b_name": getattr(self, "team_b_name", "Team B"),
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

    # Active players
    active_batter_id: Optional[str] = None
    active_bowler_id: Optional[str] = None

    # Delivery deadline (UTC timestamp)
    delivery_deadline: Optional[datetime] = None

    # Result
    winner: Optional[str] = None        # "A" | "B" | "TIE"
    result_summary: Optional[str] = None

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
        """Players on team + extra wicket allowance (configurable)."""
        # Stored at match creation; default 10 if not set
        if team == "A":
            return getattr(self, "_team_a_size", 10) + self.team_a_extra_wickets
        return getattr(self, "_team_b_size", 10) + self.team_b_extra_wickets


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
            "result": self.result.value if self.result else None,
            "runs_scored": self.runs_scored,
        }
