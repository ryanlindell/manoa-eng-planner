"""Orchestrates the full build: pages/ -> data/courses.jsonl + courses.db,
plus an honest coverage report. Does not fetch anything -- run
capture_playwright.py first.
"""

import json
import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import local_pages
import parse_course
import parse_prereq
from capture_playwright import listing_url
from config import CATOID, DATA_DIR, MANUAL_PAGES_DIR

PAGES_DIR = Path(MANUAL_PAGES_DIR)
DATA_PATH = Path(DATA_DIR)
OUT_JSONL = DATA_PATH / "courses.jsonl"
OUT_DB = DATA_PATH / "courses.db"
OUT_REPORT = DATA_PATH / "coverage_report.txt"

DB_COLUMNS = [
    "code", "subject", "number", "alpha_suffix", "title", "is_alpha_parent",
    "description", "credits_raw", "credits_min", "credits_max", "gened",
    "prereq_raw", "prereq_tree", "prereq_parse_status", "coreq_raw", "coreq_tree",
    "coreq_parse_status", "restrictions_raw", "crosslisted_raw", "repeatable_raw",
    "grade_option_raw", "other_notes", "coid", "catoid", "source_url", "scraped_at",
    "subject_file", "cpage", "parse_status", "raw_heading", "raw_block_snippet",
]


def discover_subjects() -> list[str]:
    """Subjects actually present in pages/ -- the real source of truth, not
    data/subjects.json (which we already found could silently drop an entry)."""
    subjects = {re.sub(r"_\d+$", "", p.stem) for p in PAGES_DIR.glob("*.html")}
    return sorted(subjects)


def load_known_subjects() -> set[str]:
    path = DATA_PATH / "subjects.json"
    if not path.exists():
        return set()
    return {s["code"] for s in json.loads(path.read_text(encoding="utf-8"))}


def collect() -> list[dict]:
    subjects = discover_subjects()
    entries = []
    all_html = []

    for subject in subjects:
        for cpage, html in local_pages.iter_pages(subject):
            all_html.append(html)
            mtime = local_pages.page_path(subject, cpage).stat().st_mtime
            for course in parse_course.parse_subject_page(html):
                entries.append({
                    "course": course,
                    "subject_file": subject,
                    "cpage": cpage,
                    "mtime": mtime,
                })

    # Global coid cross-reference: a course's own page may never link to
    # itself, but some other department's prereq/coreq/cross-list likely does.
    global_refs: dict[str, str] = {}
    for html in all_html:
        for code, coid in parse_course.extract_ref_coids(html).items():
            global_refs.setdefault(code, coid)

    local_coid_hits = sum(
        1 for e in entries if e["course"]["parse_status"] == "ok" and e["course"]["coid"]
    )
    for e in entries:
        c = e["course"]
        if c["parse_status"] == "ok" and c["coid"] is None:
            c["coid"] = global_refs.get(c["code"])
    total_coid_hits = sum(
        1 for e in entries if e["course"]["parse_status"] == "ok" and e["course"]["coid"]
    )

    for e in entries:
        c = e["course"]
        c["catoid"] = CATOID
        c["scraped_at"] = datetime.fromtimestamp(e["mtime"], tz=timezone.utc).isoformat()
        c["subject_file"] = e["subject_file"]
        c["cpage"] = e["cpage"]
        if c["parse_status"] == "ok":
            c["prereq_tree"], c["prereq_parse_status"] = parse_prereq.parse_prereq(
                c["prereq_raw"], c["subject"]
            )
            c["coreq_tree"], c["coreq_parse_status"] = parse_prereq.parse_prereq(
                c["coreq_raw"], c["subject"]
            )
            if c["coid"]:
                c["source_url"] = (
                    f"https://catalog.manoa.hawaii.edu/preview_course_nopop.php"
                    f"?catoid={CATOID}&coid={c['coid']}"
                )
            else:
                c["source_url"] = listing_url(e["subject_file"], e["cpage"])
        else:
            c["source_url"] = listing_url(e["subject_file"], e["cpage"])

    return entries, subjects, local_coid_hits, total_coid_hits


def find_duplicate_codes(entries: list[dict]) -> dict[str, list[str]]:
    by_code = defaultdict(list)
    for e in entries:
        c = e["course"]
        if c["parse_status"] == "ok":
            by_code[c["code"]].append(e["subject_file"])
    return {code: files for code, files in by_code.items() if len(files) > 1}


def write_jsonl(entries: list[dict]):
    DATA_PATH.mkdir(parents=True, exist_ok=True)
    with open(OUT_JSONL, "w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e["course"], ensure_ascii=False) + "\n")


def write_db(entries: list[dict]):
    if OUT_DB.exists():
        OUT_DB.unlink()
    conn = sqlite3.connect(OUT_DB)
    cols_sql = ", ".join(f'"{col}"' for col in DB_COLUMNS)
    conn.execute(f"CREATE TABLE courses ({cols_sql})")
    placeholders = ", ".join("?" for _ in DB_COLUMNS)
    rows = []
    for e in entries:
        c = e["course"]
        row = []
        for col in DB_COLUMNS:
            val = c.get(col)
            if isinstance(val, (list, dict)):
                val = json.dumps(val, ensure_ascii=False)
            row.append(val)
        rows.append(row)
    conn.executemany(f"INSERT INTO courses VALUES ({placeholders})", rows)
    conn.execute("CREATE INDEX idx_courses_code ON courses(code)")
    conn.execute("CREATE INDEX idx_courses_subject ON courses(subject)")
    conn.commit()
    conn.close()


def build_report(entries, subjects, known_subjects, local_coid_hits, total_coid_hits, duplicates) -> str:
    ok = [e for e in entries if e["course"]["parse_status"] == "ok"]
    failed = [e for e in entries if e["course"]["parse_status"] != "ok"]
    real_courses = [e for e in ok if not e["course"]["is_alpha_parent"]]
    alpha_parents = [e for e in ok if e["course"]["is_alpha_parent"]]
    credits_missing = [e for e in real_courses if e["course"]["credits_raw"] is None]

    unknown_in_pages = sorted(set(subjects) - known_subjects)
    missing_from_pages = sorted(known_subjects - set(subjects))

    failed_by_subject = defaultdict(list)
    for e in failed:
        failed_by_subject[e["subject_file"]].append(e["course"])

    lines = []
    lines.append("=== UH Manoa Catalog -- Build Coverage Report ===")
    lines.append(f"Subjects processed: {len(subjects)}")
    lines.append(f"Total course blocks seen: {len(entries)}")
    lines.append(f"  Parsed OK: {len(ok)}")
    lines.append(f"    Real courses: {len(real_courses)}")
    lines.append(f"    (Alpha) parent placeholders (not enrollable): {len(alpha_parents)}")
    lines.append(f"  Failed to parse heading: {len(failed)}")
    lines.append(f"Credits missing on real courses: {len(credits_missing)}")
    lines.append(
        f"coid resolved: {local_coid_hits}/{len(real_courses)} from same-page refs, "
        f"{total_coid_hits}/{len(real_courses)} after global cross-reference pass"
    )
    lines.append(f"Duplicate course codes detected: {len(duplicates)}")
    if duplicates:
        for code, files in sorted(duplicates.items()):
            lines.append(f"  {code}: appears in {files}")

    lines.append("")
    for label, raw_field, status_field in (
        ("prereq", "prereq_raw", "prereq_parse_status"),
        ("coreq", "coreq_raw", "coreq_parse_status"),
    ):
        applicable = [e for e in real_courses if e["course"][raw_field]]
        by_status = defaultdict(int)
        for e in applicable:
            by_status[e["course"][status_field]] += 1
        lines.append(
            f"{label}_raw present on {len(applicable)}/{len(real_courses)} real courses -- "
            f"clean: {by_status.get('clean', 0)}, partial: {by_status.get('partial', 0)}, "
            f"failed: {by_status.get('failed', 0)}"
        )
        if by_status.get("failed"):
            worst = defaultdict(int)
            for e in applicable:
                if e["course"][status_field] == "failed":
                    worst[e["subject_file"]] += 1
            top = sorted(worst.items(), key=lambda kv: -kv[1])[:10]
            lines.append(f"  worst subjects for failed {label}: {top}")

    lines.append("")
    lines.append(f"Subjects in pages/ but not in data/subjects.json: {unknown_in_pages or 'none'}")
    lines.append(f"Subjects in data/subjects.json but never captured: {missing_from_pages or 'none'}")

    if failed:
        lines.append("")
        lines.append("--- Failed-heading blocks by subject ---")
        for subject, courses in sorted(failed_by_subject.items()):
            lines.append(f"  {subject}: {len(courses)}")
            for c in courses[:3]:
                lines.append(f"    heading={c['raw_heading']!r} snippet={c['raw_block_snippet'][:80]!r}")

    if credits_missing:
        lines.append("")
        lines.append("--- Subjects with credits-missing courses (top 10) ---")
        by_subj = defaultdict(int)
        for e in credits_missing:
            by_subj[e["subject_file"]] += 1
        for subject, n in sorted(by_subj.items(), key=lambda kv: -kv[1])[:10]:
            lines.append(f"  {subject}: {n}")

    return "\n".join(lines) + "\n"


def main():
    entries, subjects, local_coid_hits, total_coid_hits = collect()
    known_subjects = load_known_subjects()
    duplicates = find_duplicate_codes(entries)

    write_jsonl(entries)
    write_db(entries)

    report = build_report(entries, subjects, known_subjects, local_coid_hits, total_coid_hits, duplicates)
    OUT_REPORT.write_text(report, encoding="utf-8")
    print(report)


if __name__ == "__main__":
    main()
