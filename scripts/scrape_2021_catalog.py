"""Fetches every subject's course-listing page from the 2021-22 catalog
(manoa.hawaii.edu/catalog-2021-22/) -- the same plain WordPress site as the
2024-25 catalog (see scripts/scrape_2024_catalog.py), just one year earlier.
Confirmed by hand: identical template (post-<id> divs, entry-title, dtags,
gened-tags-* classes, same courses-overview/ category hierarchy), so this is
a straight copy of that script with the year swapped -- no WAF, no bot
challenge, plain HTTP.

robots.txt for this host declares Crawl-delay: 3, same as 2024-25.

Usage:
    python scripts/scrape_2021_catalog.py                 # all subjects, resumable
    python scripts/scrape_2021_catalog.py --workers 10     # same, 10 parallel threads
    python scripts/scrape_2021_catalog.py category/engineering/ee  # one subject path
"""

import argparse
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock

import requests

BASE = "https://manoa.hawaii.edu/catalog-2021-22/"
OVERVIEW_URL = BASE + "courses-overview/"
RAW_DIR = Path(__file__).resolve().parent.parent / "pages_2021_raw"
DELAY_SECONDS = 3
USER_AGENT = "manoa-course-planner/0.1 (personal academic planning tool, non-commercial)"

CATEGORY_LINK_RE = re.compile(r'href="(https://manoa\.hawaii\.edu/catalog-2021-22/category/[^"#?]+)"')


def _session():
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def discover_subject_paths(session) -> list[str]:
    """Same leaf-filtering logic as scrape_2024_catalog.py's own function:
    a URL counts as a leaf subject page only if no *other* listed URL
    extends it (e.g. ".../engineering/" is a parent of ".../engineering/ee/"
    and gets excluded)."""
    html = session.get(OVERVIEW_URL, timeout=30).text
    urls = sorted({m.rstrip("/") for m in CATEGORY_LINK_RE.findall(html) if not m.rstrip("/").endswith("/feed")})
    url_set = set(urls)
    leaves = [u for u in urls if not any(other.startswith(u + "/") for other in url_set if other != u)]
    return [u.split("/category/", 1)[1] + "/" for u in leaves]


def path_to_filename(path: str) -> str:
    return path.strip("/").replace("/", "__") + ".html"


_last_request_by_thread = {}
_rate_lock = Lock()


def _throttle():
    import threading
    tid = threading.get_ident()
    with _rate_lock:
        last = _last_request_by_thread.get(tid)
        now = time.monotonic()
        if last is not None:
            wait = DELAY_SECONDS - (now - last)
            if wait > 0:
                time.sleep(wait)
        _last_request_by_thread[tid] = time.monotonic()


def fetch_subject(session, path: str) -> tuple[str, str, int]:
    """Returns (path, status, course_count). Caches to disk; skips subjects
    already saved, so re-running only fetches what's missing."""
    out_path = RAW_DIR / path_to_filename(path)
    if out_path.exists():
        return path, "cached", out_path.read_text(encoding="utf-8").count('class="post-')

    url = BASE + "category/" + path
    _throttle()
    try:
        r = session.get(url, timeout=30)
        r.raise_for_status()
    except Exception as e:
        return path, f"error: {e}", 0

    html = r.text
    if 'class="post-' not in html and "No courses found" not in html:
        return path, f"unexpected content (no course posts found, {len(html)} chars)", 0

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    return path, "ok", html.count('class="post-')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("paths", nargs="*", help="specific category paths, e.g. category/engineering/ee/")
    args = parser.parse_args()

    session = _session()
    targets = args.paths or discover_subject_paths(session)
    print(f"{len(targets)} subject page(s) to fetch, {args.workers} worker(s), "
          f"{DELAY_SECONDS}s delay per worker -> {RAW_DIR}/")

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_subject, session, p): p for p in targets}
        for i, fut in enumerate(as_completed(futures), 1):
            path, status, count = fut.result()
            results.append((path, status, count))
            print(f"[{i}/{len(targets)}] {path}: {status} ({count} course blocks)")

    ok = [r for r in results if r[1] in ("ok", "cached")]
    errors = [r for r in results if r[1] not in ("ok", "cached")]
    total_courses = sum(r[2] for r in ok)
    print(f"\n{len(ok)}/{len(results)} subjects fetched, {total_courses} course blocks total.")
    if errors:
        print(f"{len(errors)} failed:")
        for path, status, _ in errors:
            print(f"  {path}: {status}")


if __name__ == "__main__":
    main()
