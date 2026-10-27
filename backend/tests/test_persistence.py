"""
Persistence tests verifying SQLite durability, process restart recovery, and delivery uniqueness.
"""

import sqlite3
import pytest

from app.domain.models import RoomStatus
from app.repositories import memory as repo
from app.repositories import sqlite as sqlite_repo
from app.services import room_service


@pytest.fixture(autouse=True)
def clean_memory():
    repo._players.clear()
    repo._players_by_socket.clear()
    repo._players_by_session.clear()
    repo._rooms.clear()
    repo._rooms_by_code.clear()
    repo._memberships.clear()
    repo._matches.clear()
    repo._match_by_room.clear()
    repo._deliveries.clear()


def test_sqlite_persistence_and_process_restart_recovery():
    """Verify state saved to SQLite can be recovered when in-memory caches are completely cleared."""
    # 1. Create players and room
    p1, _ = room_service.create_or_restore_player("PersistUser1", None)
    p2, _ = room_service.create_or_restore_player("PersistUser2", None)
    room, _ = room_service.create_room(p1, "SOLO", 2)
    room_service.join_room(p2, room.join_code)
    room_service.ack_rules(room, p1)
    room_service.ack_rules(room, p2)
    room_service.set_ready(room, p1, True)
    room_service.set_ready(room, p2, True)

    # 2. Play toss and start match
    room_service.start_toss(room, p1)
    toss = room_service.call_toss(room, p2, "HEADS")
    winner = p1 if toss["winner_id"] == p1.id else p2
    match = room_service.decide_toss(room, winner, "BAT")

    # 3. Submit a delivery
    batting_p = p1 if match.batting_team == "A" else p2
    bowling_p = p2 if match.batting_team == "A" else p1
    room_service.submit_pick(room, batting_p, 4)
    _, delivery = room_service.submit_pick(room, bowling_p, 2)
    assert delivery is not None
    assert delivery.runs_scored == 4

    # 4. Verify direct SQLite database tables contain the rows
    with sqlite_repo._get_connection() as conn:
        c = conn.cursor()
        c.execute("SELECT count(*) FROM matches WHERE id = ?", (match.id,))
        assert c.fetchone()[0] == 1

        c.execute("SELECT count(*) FROM deliveries WHERE match_id = ?", (match.id,))
        assert c.fetchone()[0] == 1

        c.execute("SELECT count(*) FROM rooms WHERE id = ?", (room.id,))
        assert c.fetchone()[0] == 1

    # 5. SIMULATE PROCESS RESTART:
    # Clear the entire in-memory identity map cache
    sqlite_repo._players_cache.clear()
    sqlite_repo._rooms_cache.clear()
    sqlite_repo._memberships_cache.clear()
    sqlite_repo._matches_cache.clear()
    sqlite_repo._deliveries_cache.clear()

    # 6. Verify reloading from SQLite restores accurate match and room state
    reloaded_room = sqlite_repo.get_room(room.id)
    assert reloaded_room is not None
    assert reloaded_room.id == room.id
    assert reloaded_room.join_code == room.join_code

    reloaded_match = sqlite_repo.get_match_for_room(room.id)
    assert reloaded_match is not None
    assert reloaded_match.id == match.id
    assert reloaded_match.current_ball == 1
    total_runs = reloaded_match.team_a_runs if reloaded_match.batting_team == "A" else reloaded_match.team_b_runs
    assert total_runs == 4

    reloaded_deliveries = sqlite_repo.get_deliveries_for_match(match.id)
    assert len(reloaded_deliveries) == 1
    assert reloaded_deliveries[0].runs_scored == 4
    assert reloaded_deliveries[0].batter_pick == 4
    assert reloaded_deliveries[0].bowler_pick == 2


def test_sqlite_unique_delivery_constraint():
    """Verify the database schema enforces uniqueness on (match_id, innings, over_index, ball_index)."""
    with sqlite_repo._get_connection() as conn:
        c = conn.cursor()

        # Attempt inserting two deliveries with identical match_id, innings, over_index, and ball_index
        c.execute("""
            INSERT OR IGNORE INTO matches (id, room_id, phase, overs, current_over, current_ball, batting_team)
            VALUES ('m_test', 'r_test', 'FIRST', 2, 0, 1, 'A')
        """)

        c.execute("""
            INSERT INTO deliveries (id, match_id, innings, over_index, ball_index, batter_id, bowler_id, batter_pick, bowler_pick, result, runs_scored, committed, commit_sequence, created_at)
            VALUES ('d1', 'm_test', 'FIRST', 0, 1, 'p1', 'p2', 4, 6, 'RUNS', 4, 1, 1, '2026-10-27T00:00:00Z')
        """)

    with pytest.raises(sqlite3.IntegrityError):
        with sqlite_repo._get_connection() as conn2:
            c2 = conn2.cursor()
            c2.execute("""
                INSERT INTO deliveries (id, match_id, innings, over_index, ball_index, batter_id, bowler_id, batter_pick, bowler_pick, result, runs_scored, committed, commit_sequence, created_at)
                VALUES ('d2', 'm_test', 'FIRST', 0, 1, 'p1', 'p2', 5, 5, 'OUT', 0, 1, 2, '2026-10-27T00:00:01Z')
            """)
