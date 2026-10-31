"""conftest for pytest."""
import atexit
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Tests must never touch the developer/production SQLite file: point the
# repository at a throwaway database before the app package is imported.
_TEST_DB_DIR = tempfile.mkdtemp(prefix="hc_test_db_")
os.environ["SQLITE_PATH"] = os.path.join(_TEST_DB_DIR, "handcricket_test.db")
# Tests must also never read or write the production Neon/Postgres account
# tables. Integration tests opt in explicitly through TEST_DATABASE_URL.
os.environ["USER_STORE"] = "sqlite"
# Tests must never touch the Supabase Storage bucket (feedback/visit logs), so
# clear every credential the logger and the creator analytics service read.
for _supabase_var in (
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
):
    os.environ[_supabase_var] = ""
atexit.register(shutil.rmtree, _TEST_DB_DIR, ignore_errors=True)
