"""Drive a real, visible Chromium instance to save subject listing pages.

content.php is behind an AWS WAF JS challenge that a plain requests.Session
cannot pass, and a copied cookie only survives a couple of requests. A real
browser solves the challenge itself on every navigation, the same way a human
would -- this script just automates the click-save-next loop the user would
otherwise do by hand, at a polite, single-request-at-a-time pace.

Usage:
    python capture_playwright.py ECE           # one subject
    python capture_playwright.py                # all subjects in data/subjects.json, resumable
"""

import json
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

from config import CATOID, NAVOID
from local_pages import page_path

DELAY_SECONDS = 4
# Override via env var so a second instance can run in parallel against its own
# browser profile -- two Playwright instances sharing one persistent profile
# directory will lock each other out.
USER_DATA_DIR = os.environ.get("CAPTURE_PROFILE_DIR", "browser_profile")

CHALLENGE_MARKERS = ("Please wait while your request is being verified", "aws-waf")


def listing_url(prefix: str, cpage: int = 1) -> str:
    return (
        "https://catalog.manoa.hawaii.edu/content.php?"
        f"catoid={CATOID}&navoid={NAVOID}&cur_cat_oid={CATOID}"
        f"&filter%5B27%5D={prefix}&filter%5B29%5D=&filter%5Bkeyword%5D="
        f"&filter%5B32%5D=1&filter%5Bcpage%5D={cpage}"
        "&search_database=Filter&expand=1&print="
    )


def looks_challenged(html: str) -> bool:
    if len(html) < 2000:
        return True
    return any(marker in html for marker in CHALLENGE_MARKERS)


def has_next_page(html: str, cpage: int) -> bool:
    return bool(re.search(rf'filter%5Bcpage%5D={cpage + 1}\b', html)) or bool(
        re.search(rf'cpage=({cpage + 1})\b', html)
    )


def capture_subject(page, prefix: str) -> int:
    saved = 0
    cpage = 1
    while True:
        out_path = page_path(prefix, cpage)
        if out_path.exists():
            cpage += 1
            saved += 1
            continue

        url = listing_url(prefix, cpage)
        html = None
        for attempt in range(3):
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                try:
                    # Real listing pages always have the subject-prefix filter dropdown.
                    # The WAF challenge page reloads itself once it gets a token, so give
                    # that reload time to land before giving up.
                    page.wait_for_selector("#courseprefix", timeout=30000)
                except Exception:
                    pass
                html = page.content()
                break
            except Exception as e:
                print(f"  [{prefix} p{cpage}] attempt {attempt + 1} failed: {e}")
                time.sleep(DELAY_SECONDS)

        if html is None:
            print(f"  [{prefix} p{cpage}] giving up after 3 attempts")
            return saved

        if looks_challenged(html):
            print(f"  [{prefix} p{cpage}] still challenged / too short ({len(html)} chars)")
            return saved

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html, encoding="utf-8")
        print(f"  [{prefix} p{cpage}] saved {len(html)} chars")
        saved += 1

        if not has_next_page(html, cpage):
            break
        cpage += 1
        time.sleep(DELAY_SECONDS)

    return saved


def main():
    targets = sys.argv[1:]
    if not targets:
        subjects = json.load(open("data/subjects.json", encoding="utf-8"))
        targets = [s["code"] for s in subjects]

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            USER_DATA_DIR,
            headless=False,
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()

        for i, prefix in enumerate(targets):
            if page_path(prefix, 1).exists():
                print(f"[{i+1}/{len(targets)}] {prefix}: already saved, skipping")
                continue
            print(f"[{i+1}/{len(targets)}] {prefix}: fetching...")
            try:
                capture_subject(page, prefix)
            except Exception as e:
                print(f"  [{prefix}] unexpected error, skipping: {e}")
            time.sleep(DELAY_SECONDS)

        context.close()


if __name__ == "__main__":
    main()
