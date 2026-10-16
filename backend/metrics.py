
import json
from pathlib import Path
from datetime import datetime, timezone

LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

LOG_FILE = LOG_DIR / "events.jsonl"


def log_event(event: dict) -> None:
    record = {
        "logged_at": datetime.now(timezone.utc).isoformat(),
        **event,
    }

    with LOG_FILE.open("a", encoding="utf-8") as file:
        file.write(json.dumps(record, ensure_ascii=False) + "\n")
