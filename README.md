# HandCricket Live 🏏

> A responsive, multiplayer hand cricket platform with real-time gameplay, voice chat, and a TV broadcast-style UI.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript |
| Backend | Python 3.12 + Flask + Flask-SocketIO |
| Real-time | Socket.IO |
| Voice | WebRTC (simple-peer) |
| Styling | CSS Modules + dark stadium theme |

## Quick Start

### 1. Backend

```bash
cd backend

# Create virtual environment
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux

# Install dependencies
pip install -r requirements.txt

# Copy and edit env
copy ..\env.example .env

# Run
python run.py
```

Backend starts at **http://localhost:5000**

### 2. Frontend

```bash
cd frontend

# Install dependencies
npm install

# Run dev server
npm run dev
```

Frontend starts at **http://localhost:5173**

## How to Play

1. Open the app and enter your name
2. **Create Room** → choose Solo (1v1) or Team mode, select overs
3. Share the **6-character room code** with friends
4. Acknowledge the rules, set Ready
5. Host clicks **Start Match**
6. Each delivery: both batter and bowler pick a number 1–10 within **15 seconds**
   - Same numbers → **OUT** 🔴
   - Different numbers → batter scores their pick ✅
7. First innings ends on over limit or wicket limit; second innings chases the target

## Game Rules Summary

| Rule | Detail |
|---|---|
| Valid picks | 1–10 |
| Out | Both picks equal |
| Scoring | Batter's pick (if different) |
| Deadline | 15 seconds (server-enforced) |
| Innings end | Over limit OR wicket limit |
| Target | First innings runs + 1 |
| Wickets | Both teams get the same wicket limit |
| Reconnect grace | 120 seconds |

## Project Structure

```
handcricket-live/
├── backend/
│   ├── app/
│   │   ├── domain/          # Pure Python game engine
│   │   │   ├── models.py    # Dataclasses (Player, Room, Match, Delivery)
│   │   │   └── rules.py     # Game rules engine
│   │   ├── repositories/    # In-memory data store (V1)
│   │   ├── services/        # Room & match orchestration
│   │   ├── sockets/         # Socket.IO event handlers
│   │   ├── api/             # REST endpoints
│   │   └── security/        # Tokens, validation, rate limiting
│   ├── tests/               # pytest unit tests
│   └── run.py
├── frontend/
│   └── src/
│       ├── app/pages/       # LandingPage, RoomPage, ArenaPage, ResultPage
│       ├── hooks/           # useSocket
│       ├── services/        # Socket.IO client, TypeScript types
│       └── styles/          # Global CSS (dark stadium theme)
└── docs/
```

## Running Tests

```bash
cd backend
python -m pytest tests/ -v
```

## Architecture Principles

- **Server is authoritative**: all game state transitions validated server-side
- **Pure game engine**: `domain/rules.py` has zero Flask/Socket.IO dependencies
- **No client-reported scores**: clients request actions, server commits results
- **Secret choices**: batter/bowler picks are never broadcast until both submit
- **Idempotent delivery resolution**: duplicate submissions rejected

## Implementation Milestones

- [x] **M1** – Repository setup, health endpoint, frontend shell
- [x] **M2** – Domain models and pure Python game engine with tests
- [x] **M3** – Socket.IO rooms, auth, state snapshots, lobby
- [x] **M4** – Team assignment, captain selection, bowler select, server timer
- [x] **M5** – Arena UI, scoreboard, number pad, result animations
- [x] **M6** – WebRTC voice: Dynamic STUN/TURN, private team audio by default, mutual-consent cross-team authorization, and independent local mute controls
- [x] **M7** – Durable persistence: ACID SQLite with WAL mode, atomic unique delivery constraints, and process restart state recovery
- [x] **M8** – Production hardening: Concurrency locking, chat HTML sanitization, strict production CORS whitelist, and 48 automated tests passed
