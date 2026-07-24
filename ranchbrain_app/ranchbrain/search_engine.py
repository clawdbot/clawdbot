from .indexer import load_index, build_index
from .logging_config import get_logger

logger = get_logger(__name__)

def search(query: str, limit: int = 25, profile: str = "knowledge") -> tuple[list[tuple[str, int, str]], int]:
    q = query.lower()
    index = load_index(profile)

    if not index:
        index = build_index(profile)

    hits = []

    for record in index:
        path = record.get("path", "")
        for line in record.get("lines", []):
            line_text = line.get("text", "")
            if q in line_text.lower():
                hits.append((path, line.get("line", 0), line_text))

    logger.info(f"Line search query={query!r} profile={profile} hits={len(hits)}")
    return hits[:limit], len(hits)
