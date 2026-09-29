"""Drive a real, visible Chromium instance to save subject listing pages.

content.php is behind an AWS WAF JS challenge that a plain requests.Session
cannot pass, and a copied cookie only survives a couple of requests. A real
browser solves the challenge itself on every navigation, the same way a human
would -- this script just automates the click-save-next loop the user would
otherwise do by hand, at a polite, single-request-at-a-time pace.

NOTE on robots.txt: catalog.manoa.hawaii.edu declares crawl-delay: 120 for
User-agent: * (see config.py). DELAY_SECONDS below is 4, and --workers
multiplies that up further -- already a deliberate departure from that for a
personal, non-commercial tool, made once before (see config.py's own note).
Running with --workers makes that departure more aggressive again; it's your
call to make each time, this script won't second-guess it.

Usage:
    python capture_playwright.py ECE            # one subject
    python capture_playwright.py                 # all subjects in data/subjects.json, resumable
    python capture_playwright.py --workers 8      # same, split across 8 parallel browser windows
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

from config import CATOID, MANUAL_PAGES_DIR, NAVOID
from local_pages import page_path

DELAY_SECONDS = 4
# Override via env var so a second instance can run in parallel against its own
# browser profile -- two Playwright instances sharing one persistent profile
# directory will lock each other out. run_supervisor sets this itself for each
# worker it spawns; set it by hand only if you're launching instances yourself.
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


def all_subject_codes() -> list[str]:
    subjects = json.load(open("data/subjects.json", encoding="utf-8"))
    return [s["code"] for s in subjects]


def run_worker(targets: list[str]):
    """One browser window working through `targets` sequentially, at the
    usual polite pace. This is the whole job when run directly; run_supervisor
    below just launches several of these as separate OS processes so each
    gets its own browser profile (Playwright instances can't share one)."""
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


def run_supervisor(workers: int):
    """Splits every not-yet-captured subject across `workers` child processes
    (each `python capture_playwright.py <its subjects...>`, i.e. run_worker
    again), each with its own browser profile dir and log file, and waits for
    them all. CATOID/MANUAL_PAGES_DIR come from config.py as normal -- change
    the catalog there, not here."""
    targets = [c for c in all_subject_codes() if not page_path(c, 1).exists()]
    if not targets:
        print("Nothing to do -- every subject already has a saved page in "
              f"{MANUAL_PAGES_DIR}/ (catoid={CATOID}).")
        return

    workers = max(1, min(workers, len(targets)))
    # Round-robin, not contiguous slices: subjects vary a lot in page count
    # (multi-page ones scattered through the alphabetized list), so this
    # spreads that unevenness across workers instead of one worker getting
    # stuck with a run of the biggest subjects back to back.
    buckets = [targets[i::workers] for i in range(workers)]

    print(f"{len(targets)} subjects left to capture, catoid={CATOID} -> {MANUAL_PAGES_DIR}/")
    print(f"Splitting across {workers} browser windows:")
    for i, bucket in enumerate(buckets, start=1):
        print(f"  worker {i}: {len(bucket)} subjects -> capture_log_{i}.txt")

    procs = []
    for i, bucket in enumerate(buckets, start=1):
        env = dict(os.environ)
        env["CAPTURE_PROFILE_DIR"] = f"browser_profile_{i}"
        log_file = open(f"capture_log_{i}.txt", "w", encoding="utf-8")
        proc = subprocess.Popen(
            # -u: unbuffered stdout/stderr, or these prints just sit in a
            # buffer until the process exits -- capture_log_N.txt would stay
            # empty the whole run instead of being tail-able as it happens.
            [sys.executable, "-u", __file__, *bucket],
            env=env, stdout=log_file, stderr=subprocess.STDOUT,
        )
        procs.append((proc, log_file, i, len(bucket)))
        # Stagger launches so 8 browser windows don't all hit the WAF
        # challenge in the same instant -- that looks more bot-like than
        # spacing them out, on top of the raw rate-limit question above.
        time.sleep(2)

    print("All workers launched. Tail capture_log_*.txt to watch progress "
          "(this will wait here until every window finishes)...")
    failed = []
    for proc, log_file, i, n in procs:
        code = proc.wait()
        log_file.close()
        print(f"  worker {i} ({n} subjects) finished: {'ok' if code == 0 else f'exit {code}'} "
              f"-- see capture_log_{i}.txt")
        if code != 0:
            failed.append(i)

    if failed:
        print(f"Workers {failed} exited non-zero -- check their logs. Anything still missing "
              "will just get picked up by running this again (workers or not).")
    else:
        print("All workers finished cleanly.")


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--workers", type=int, default=None)
    args, remaining = parser.parse_known_args()

    if args.workers is not None:
        if remaining:
            print("--workers always covers every remaining subject; pass either "
                  "--workers N or explicit subject codes, not both.", file=sys.stderr)
            sys.exit(1)
        run_supervisor(args.workers)
        return

    run_worker(remaining or all_subject_codes())


if __name__ == "__main__":
    main()
