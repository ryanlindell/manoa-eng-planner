"""Ingestion for manually-saved listing pages.

content.php is behind an AWS WAF challenge that a scripted request cannot pass
and that a human-solved cookie only survives for a couple of requests (see
fetch.ChallengeError). The reliable path is: a human opens each subject's
listing page in a real browser (which solves the challenge invisibly) and
saves it to disk; parse_course.py reads from here rather than the network.
"""

from pathlib import Path

from config import MANUAL_PAGES_DIR


def page_path(prefix: str, cpage: int = 1) -> Path:
    name = f"{prefix}.html" if cpage == 1 else f"{prefix}_{cpage}.html"
    return Path(MANUAL_PAGES_DIR) / name


def load(prefix: str, cpage: int = 1) -> str | None:
    path = page_path(prefix, cpage)
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def available_subjects() -> list[str]:
    """Subjects that have at least a page-1 file saved."""
    d = Path(MANUAL_PAGES_DIR)
    if not d.exists():
        return []
    return sorted(p.stem for p in d.glob("*.html") if "_" not in p.stem)


def iter_pages(prefix: str):
    """Yield (cpage, html) for every saved page of a subject, in order."""
    cpage = 1
    while True:
        html = load(prefix, cpage)
        if html is None:
            return
        yield cpage, html
        cpage += 1
