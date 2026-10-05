"""Generates contracts/fixtures/courses.json for the web planner from the real
scraped dataset (data/courses.jsonl) -- replaces the old BU-placeholder sample.

Only includes: every real course referenced by the ECE Normal Schedule (the
Aug 2026 curriculum check sheet), plus hand-labeled placeholder entries for
slots the check sheet itself leaves student-choice-dependent (Major Track
Group I/II, Technical Electives, EB, FG, Focus designations, DH-or-DL). Those
placeholders are never real specific courses -- Focus in particular can't be:
it's a Banner/section-level property, not in the catalog (see the `focus`
field in the schema).
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COURSES_JSONL = ROOT / "data" / "courses.jsonl"
OUT_PATH = ROOT / "contracts" / "fixtures" / "courses.json"

REAL_CODES_CATEGORY = {
    # Math / basic sciences sequence (ABET's 30cr math+basic-science bucket)
    "MATH 241": "core", "MATH 242": "core", "MATH 243": "core", "MATH 244": "core",
    "MATH 307": "core",
    "PHYS 170": "core", "PHYS 170L": "core", "PHYS 272": "core", "PHYS 272L": "core",
    "PHYS 274": "core", "CHEM 161": "core", "CHEM 161L": "core", "CHEM 162": "core",
    # ECE major courses (ABET's 45cr engineering-topics bucket)
    "ECE 160": "technical", "ECE 110": "technical", "ECE 211": "technical",
    "ECE 260": "technical", "ECE 213": "technical", "ECE 296": "technical",
    "ECE 315": "technical", "ECE 324": "technical", "ECE 371": "technical",
    "ECE 345": "technical", "ECE 323": "technical", "ECE 323L": "technical",
    "ECE 342": "technical", "ECE 396": "technical", "ECE 496": "technical",
    "ECE 495": "technical",
    # Gen-ed / Hub-style designated courses
    "ENG 100": "hub", "COMG 251": "hub",
    "ECON 120": "hub", "ECON 130": "hub", "ECON 131": "hub",
}

# Real either/or alternatives within the ~34 REAL_CODES_CATEGORY codes --
# taking ONE satisfies the whole check-sheet slot, not both/all. Every code
# listed here is also a REAL_CODES_CATEGORY key; any REAL_CODES_CATEGORY
# code that never appears in a group here is its own one-course slot (no
# alternative). Hand-transcribed from the 2026 sheet's own semester grid,
# same as REAL_CODES_CATEGORY itself -- see build_ee_relevant_courses.py's
# fixed_groups_for_subject() for how this crosses the EE/ECE rename for
# pre-2024 catalogs the same way fixed_codes_for_subject() already does for
# REAL_CODES_CATEGORY's own codes.
FIXED_OR_GROUPS = [
    ["ECE 160", "ECE 110"],
    ["ECE 345", "MATH 307"],
    ["ECON 120", "ECON 130", "ECON 131"],
]

# code -> (title, credits) for slots the check sheet leaves student-choice
# dependent. Never a stand-in for a specific real course. Codes use the
# check sheet's own short labels -- a "#N" suffix is added only where a
# label genuinely repeats (the app needs each slot independently placeable
# and gradeable, e.g. the 3 separate Group I slots need 3 different real
# courses, not the same one three times), never as a naming style choice.
PLACEHOLDERS = {
    "H Focus": ("Hawaiian, Asian & Pacific Issues — any qualifying course", 1),
    "E Focus": ("Contemporary Ethical Issues — any qualifying course", 1),
    "O Focus": ("Oral Communication — any qualifying course", 1),
    "W Focus": ("Writing Intensive — 5 courses total across the degree, min. 2 upper-division", 5),
    "FG #1": ("Foundation: Global & Multicultural", 3),
    "FG #2": ("Foundation: Global & Multicultural", 3),
    "EB": ("Engineering Breadth — CEE/ME/OE/BE 300+, CEE 270, or an approved 300+ science course", 3),
    "TE ECE #1": ("Technical Elective — ECE 300+ or department-approved (see check sheet notes)", 3),
    "TE ECE #2": ("Technical Elective — ECE 300+ or department-approved (see check sheet notes)", 3),
    "(Lab) TE ECE": ("Technical Elective — must be a laboratory (see check sheet notes)", 1),
    "Major ECE (Group I) #1": ("Major Track — Group I course (your chosen EP or SDS track)", 3),
    "Major ECE (Group I) #2": ("Major Track — Group I course (your chosen EP or SDS track)", 3),
    "Major ECE (Group I) #3": ("Major Track — Group I course (your chosen EP or SDS track)", 3),
    "(Lab) ECE (Group I) #1": ("Major Track — Group I lab", 1),
    "(Lab) ECE (Group I) #2": ("Major Track — Group I lab", 1),
    "Major ECE (Group II) #1": ("Major Track — Group II course", 3),
    "Major ECE (Group II) #2": ("Major Track — Group II course", 3),
    "DH or DL": ("Diversification: Humanities or Literature", 3),
    "DS": ("Diversification: Social Science", 3),
}


def main():
    courses_by_code = {}
    with open(COURSES_JSONL, encoding="utf-8") as f:
        for line in f:
            c = json.loads(line)
            if c["code"] in REAL_CODES_CATEGORY:
                courses_by_code[c["code"]] = c

    missing = set(REAL_CODES_CATEGORY) - set(courses_by_code)
    if missing:
        raise SystemExit(f"Missing real courses, check the catalog: {sorted(missing)}")

    out = []
    for code, category in REAL_CODES_CATEGORY.items():
        c = courses_by_code[code]
        credits = c["credits_min"] if c["credits_min"] is not None else None
        out.append({
            "code": code,
            "title": c["title"],
            "credits": credits,
            "credits_raw": c["credits_raw"],
            "gened": c["gened"],
            "category": category,
            "prereq_parse_status": c["prereq_parse_status"] or "clean",
            "prereq_raw": c["prereq_raw"],
            "source_url": c["source_url"],
        })

    for code, (title, credits) in PLACEHOLDERS.items():
        out.append({
            "code": code,
            "title": title,
            "credits": credits,
            "credits_raw": str(credits),
            "gened": [],
            "category": "elective",
            "prereq_parse_status": "clean",
            "prereq_raw": None,
            "source_url": None,
            "is_placeholder": True,
        })

    out.sort(key=lambda c: c["code"])
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(out)} courses ({len(courses_by_code)} real, {len(PLACEHOLDERS)} placeholder) to {OUT_PATH}")


if __name__ == "__main__":
    main()
