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
atexit.register(shutil.rmtree, _TEST_DB_DIR, ignore_errors=True)
