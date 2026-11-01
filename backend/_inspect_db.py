import os
import sqlite3

path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend", "handcricket.db"))
print("db:", path, "exists:", os.path.exists(path))
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row

tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
print("tables:", tables)

for table in ("rooms", "matches", "deliveries", "match_history", "users", "user_sessions"):
    if table in tables:
        count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"{table}: {count}")

if "match_history" in tables:
    print("\nmatch_history rows:")
    for row in conn.execute("SELECT match_id, join_code, mode, team_a_runs, team_b_runs, winner, started_at, completed_at FROM match_history ORDER BY started_at DESC LIMIT 10"):
        print(dict(row))

if "matches" in tables:
    print("\nmatches rows:")
    for row in conn.execute("SELECT id, room_id, winner, team_a_runs, team_b_runs, created_at FROM matches ORDER BY created_at DESC LIMIT 10"):
        print(dict(row))

if "rooms" in tables:
    print("\nrooms:")
    for row in conn.execute("SELECT id, join_code, mode, status, created_at FROM rooms ORDER BY created_at DESC LIMIT 10"):
        print(dict(row))
conn.close()
