from .config import RANCHBRAIN_DATA, MODULES_DIR
from .indexer import INDEX_PATH, load_index, index_status
from datetime import datetime, timezone
from .logging_config import LOG_FILE

REQUIRED_MODULES = ["system", "budget", "health", "property", "projects", "homeassistant"]

def run_doctor() -> int:
    problems = []

    print("RanchBrain Doctor")
    print("=================")

    checks = [
        ("Data directory", RANCHBRAIN_DATA.exists()),
        ("Modules directory", MODULES_DIR.exists()),
        ("Index file", INDEX_PATH.exists()),
        ("Log file", LOG_FILE.exists()),
    ]

    for label, ok in checks:
        print(f"{'✅' if ok else '❌'} {label}")
        if not ok:
            problems.append(label)

    for module in REQUIRED_MODULES:
        path = MODULES_DIR / module
        ok = path.exists()
        print(f"{'✅' if ok else '❌'} Module: {module}")
        if not ok:
            problems.append(f"module:{module}")

    print()
    print("Index Profiles")
    print("--------------")

    max_age_hours = 24

    for item in index_status():
        ok = item["exists"] and item["records"] > 0
        stale = False
        age_hours = None
        indexed_at = item.get("indexed_at", "")

        if indexed_at:
            try:
                dt = datetime.fromisoformat(indexed_at)
                age_hours = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
                stale = age_hours > max_age_hours
            except Exception:
                stale = True
        else:
            stale = True

        icon = "✅" if ok and not stale else "⚠️" if ok and stale else "❌"
        age_text = f", age {age_hours:.1f}h" if age_hours is not None else ", age unknown"

        print(f"{icon} {item['profile']}: {item['records']} records{age_text}")

        if not ok:
            problems.append(f"index:{item['profile']}")
        elif stale:
            problems.append(f"stale-index:{item['profile']}")

    records = load_index()
    print(f"Default index records: {len(records)}")

    if problems:
        print("\nStatus: PROBLEMS FOUND")
        return 1

    print("\nStatus: OK")
    return 0
