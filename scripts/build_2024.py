"""Combines every fetched pages_2024_raw/*.html into data_2024/courses.jsonl,
running each course's prereq_raw/coreq_raw through the same parse_prereq.py
grammar the other catalog years use -- this is the "2024-25 catalog" analog
of build.py, adapted for parse_course_2024.py's different source and schema
(see that module's docstring for what's different and why).

Some courses are fetched more than once: a handful of category pages are
genuine aliases of each other (two URL slugs for the same WordPress
category), and the site's "Honors" page (oaa/hon/) deliberately re-lists
honors sections that already belong to their real department (e.g.
"AMST 150A" appears under both arts-languages-letters/amst/ and oaa/hon/)
-- confirmed by hand, not a bug. Deduplicated here by WordPress post id,
keeping whichever copy is seen first; the data is identical either way
since it's the same underlying post.
"""

import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import parse_course_2024 as parse_course
import parse_prereq

RAW_DIR = ROOT / "pages_2024_raw"
DATA_PATH = ROOT / "data_2024"
OUT_JSONL = DATA_PATH / "courses.jsonl"
OUT_REPORT = DATA_PATH / "coverage_report.txt"

DB_COLUMNS = [
    "code", "subject", "number", "alpha_suffix", "title", "is_alpha_parent",
    "description", "credits_raw", "credits_min", "credits_max", "credits_format_raw",
    "gened", "focus", "prereq_raw", "prereq_tree", "prereq_parse_status", "coreq_raw",
    "coreq_tree", "coreq_parse_status", "restrictions_raw", "crosslisted_raw",
    "repeatable_raw", "grade_option_raw", "other_notes", "source_url", "post_id",
    "subject_file", "parse_status", "raw_heading", "raw_block_snippet",
]


def collect():
    entries = []
    seen_post_ids = {}
    dup_count = 0
    fail_count = 0

    for fn in sorted(RAW_DIR.glob("*.html")):
        html = fn.read_text(encoding="utf-8")
        for c in parse_course.parse_subject_page(html):
            if c["parse_status"] != "ok":
                fail_count += 1
                c["subject_file"] = fn.name
                entries.append(c)
                continue
            if c["post_id"] in seen_post_ids:
                dup_count += 1
                continue
            seen_post_ids[c["post_id"]] = fn.name
            c["subject_file"] = fn.name
            entries.append(c)

    return entries, dup_count, fail_count


def main():
    entries, dup_count, fail_count = collect()

    duplicate_codes = defaultdict(list)
    for c in entries:
        if c["parse_status"] == "ok":
            duplicate_codes[c["code"]].append(c["subject_file"])
    duplicate_codes = {code: files for code, files in duplicate_codes.items() if len(files) > 1}

    ok_count = 0
    real_count = 0
    coid_unused = 0  # this source has no coid system; field kept only for schema parity
    prereq_present = clean = partial = failed = 0
    coreq_present = coreq_clean = coreq_partial = coreq_failed = 0

    for c in entries:
        if c["parse_status"] != "ok":
            continue
        ok_count += 1
        if not c["is_alpha_parent"]:
            real_count += 1
        c["coid"] = None
        if c["prereq_raw"]:
            prereq_present += 1
            tree, status = parse_prereq.parse_prereq(c["prereq_raw"], c["subject"])
            c["prereq_tree"], c["prereq_parse_status"] = tree, status
            clean += status == "clean"; partial += status == "partial"; failed += status == "failed"
        else:
            c["prereq_tree"], c["prereq_parse_status"] = None, None
        if c["coreq_raw"]:
            coreq_present += 1
            tree, status = parse_prereq.parse_prereq(c["coreq_raw"], c["subject"])
            c["coreq_tree"], c["coreq_parse_status"] = tree, status
            coreq_clean += status == "clean"; coreq_partial += status == "partial"; coreq_failed += status == "failed"
        else:
            c["coreq_tree"], c["coreq_parse_status"] = None, None
        c["scraped_at"] = datetime.now(timezone.utc).isoformat()

    DATA_PATH.mkdir(parents=True, exist_ok=True)
    with open(OUT_JSONL, "w", encoding="utf-8") as f:
        for c in entries:
            row = {col: c.get(col) for col in DB_COLUMNS}
            row["scraped_at"] = c.get("scraped_at")
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    lines = []
    lines.append("=== UH Manoa 2024-25 Catalog -- Build Coverage Report ===")
    lines.append(f"Subject pages processed: {len(list(RAW_DIR.glob('*.html')))}")
    lines.append(f"Total course blocks seen: {len(entries)} ({dup_count} duplicate posts skipped, "
                 f"see module docstring)")
    lines.append(f"  Parsed OK: {ok_count}")
    lines.append(f"    Real courses: {real_count}")
    lines.append(f"    (Alpha) parent placeholders (not enrollable): {ok_count - real_count}")
    lines.append(f"  Failed to parse heading: {fail_count}")
    lines.append(f"Duplicate course codes detected (post-dedup, should be 0): {len(duplicate_codes)}")
    for code, files in list(duplicate_codes.items())[:10]:
        lines.append(f"  {code}: {files}")

    lines.append("")
    lines.append(f"prereq_raw present on {prereq_present}/{real_count} real courses -- "
                 f"clean: {clean}, partial: {partial}, failed: {failed}")
    lines.append(f"coreq_raw present on {coreq_present}/{real_count} real courses -- "
                 f"clean: {coreq_clean}, partial: {coreq_partial}, failed: {coreq_failed}")

    restrictions_count = sum(1 for c in entries if c.get("restrictions_raw"))
    lines.append(f"restrictions_raw extracted (best-effort, see parse_course_2024 docstring): {restrictions_count}")

    report = "\n".join(lines) + "\n"
    OUT_REPORT.write_text(report, encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
