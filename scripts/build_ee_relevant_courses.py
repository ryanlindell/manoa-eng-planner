"""Computes the set of courses "relevant" to the EE major -- everything that
could plausibly count toward an EE student's degree -- for the visualizer's
major filter (visualizer/app.js's program picker).

A course counts as relevant if any of:
  - it's one of the ~30 fixed requirements on the check sheet's semester
    grid (REAL_CODES_CATEGORY in build_ece_fixture.py)
  - it's in a Major Track Group I/II list, or Technical-Elective- or
    Engineering-Breadth-eligible, per checksheets/data/<year>.json
  - its gened tags include FGA/FGB/FGC/DH/DL/DS -- the check sheet's open
    "any qualifying course" slots (the two Foundation: Global &
    Multicultural courses, and the "DH or DL"/"DS" slots). This is a real,
    deliberate scope decision, not an oversight: it pulls in 1000+ courses
    university-wide (an AMST or a history course tagged DH is just as
    "relevant" as an ECE course, if it's what actually satisfies that
    slot) -- see the conversation this was designed in for the reasoning.
    H/E/O/W Focus slots are NOT resolvable this way -- those are assigned
    per course *section* at registration time, not in the catalog data,
    so they stay abstract placeholders with no backing course list; this
    is a real data limitation, not a choice.
  - its subject is ECE, at any course level (covers grad/masters ECE
    courses a continuing EE student might also go on to take)

Output: visualizer/data/ee_relevant_EE.json -- a flat list of course codes
plus a little metadata, consumed by the visualizer's program-picker
manifest (see PROGRAMS in visualizer/app.js).

This is tied to catoid 4 (2026-2027, the default catalog) specifically,
matching checksheets/data/2026.json -- it reads data/courses.jsonl
directly rather than via config.DATA_DIR, since that could be pointed at
a different catalog mid-scrape and this script's correctness depends on
matching the *2026* catalog specifically. Re-run this (pointed at a new
checksheets/data/<year>.json and the matching data_catoid<N>/courses.jsonl)
whenever another year's check sheet gets extracted.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from build_ece_fixture import REAL_CODES_CATEGORY  # noqa: E402

COURSES_JSONL = ROOT / "data" / "courses.jsonl"
CHECKSHEET = ROOT / "checksheets" / "data" / "2026.json"
OUT_PATH = ROOT / "visualizer" / "data" / "ee_relevant_EE.json"

# The check sheet's open "any qualifying course" gened tags -- see the
# module docstring for why these are in scope and H/E/O/W Focus isn't.
OPEN_GENED_TAGS = {"FGA", "FGB", "FGC", "DH", "DL", "DS"}


def checksheet_codes(sheet: dict) -> set[str]:
    codes = set()
    for track in sheet["tracks"].values():
        for area in track["areas"].values():
            codes.update(area["group1"])
            codes.update(area["group2"])
    codes.update(sheet["technical_electives"]["additional_eligible"])
    codes.update(sheet["technical_electives"]["case_by_case"])
    codes.update(sheet["engineering_breadth"]["named_eligible"])
    return codes


def main():
    sheet = json.loads(CHECKSHEET.read_text(encoding="utf-8"))
    relevant = set(REAL_CODES_CATEGORY) | checksheet_codes(sheet)

    reasons = {c: "fixed requirement" for c in REAL_CODES_CATEGORY}
    for c in checksheet_codes(sheet) - set(REAL_CODES_CATEGORY):
        reasons[c] = "major track / TE / EB eligible"

    gened_count = 0
    ece_count = 0
    all_codes = set()
    with COURSES_JSONL.open(encoding="utf-8") as f:
        for line in f:
            c = json.loads(line)
            if c["parse_status"] != "ok" or c["is_alpha_parent"]:
                continue
            all_codes.add(c["code"])
            if c["code"] in relevant:
                continue
            if OPEN_GENED_TAGS.intersection(c.get("gened") or []):
                relevant.add(c["code"])
                reasons[c["code"]] = "open gen-ed slot (FG/DH/DL/DS)"
                gened_count += 1
            elif c["subject"] == "ECE":
                relevant.add(c["code"])
                reasons[c["code"]] = "ECE course (any level)"
                ece_count += 1

    # Not a typo check we can skip -- e.g. the check sheet's own "ECE 491"
    # is an alpha-parent placeholder (only ECE 491B, 491C, ... are real,
    # enrollable courses, and those are already pulled in by the "ECE any
    # level" rule above), so it never matches a real graph node. Drop
    # anything that doesn't resolve to a real course rather than ship a
    # dead code, but say so -- a genuine typo would look identical here.
    missing = relevant - all_codes
    if missing:
        print(f"NOTE: dropping {len(missing)} code(s) that don't match any real course "
              f"(expected for e.g. an alpha-parent placeholder; verify anything unexpected here): "
              f"{sorted(missing)}")
        relevant -= missing

    out = {
        "program": "EE",
        "label": "Electrical Engineering",
        "catalog_year": sheet["year"],
        "source_checksheet": str(CHECKSHEET.relative_to(ROOT)).replace("\\", "/"),
        "courses": sorted(relevant),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(relevant)} relevant courses to {OUT_PATH}")
    print(f"  {len(REAL_CODES_CATEGORY)} fixed requirements, "
          f"{len(checksheet_codes(sheet) - set(REAL_CODES_CATEGORY))} track/TE/EB eligible, "
          f"{gened_count} via open gen-ed tags, {ece_count} ECE (any level)")


if __name__ == "__main__":
    main()
