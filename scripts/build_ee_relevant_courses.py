"""Computes the set of courses "relevant" to the EE major -- everything that
could plausibly count toward an EE student's degree -- for the visualizer's
major filter (visualizer/app.js's program picker).

A course counts as relevant if any of:
  - it's one of the ~30 fixed requirements on the check sheet's semester
    grid (REAL_CODES_CATEGORY in build_ece_fixture.py -- ECE-prefixed,
    built against the 2026 sheet; see --subject-prefix below for pre-2024
    catalogs, where the department's own prefix was "EE" instead)
  - it's in a Major Track Group I/II list, or Technical-Elective- or
    Engineering-Breadth-eligible, per the given checksheets/data/<year>.json
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
  - its subject is ECE (or --subject-prefix), at any course level (covers
    grad/masters courses a continuing EE student might also go on to take)

The output also carries a "categories" breakdown (group1/group2/te/eb) for
the visualizer's within-major sub-filter -- see checksheet_categories()'s
own docstring for exactly what goes in each and why they can overlap -- and
a "category_by_code" map (one category per code: fixed/group1/group2/te/
eb/gened/any_level) for the graph page's color-by-requirement-type view,
which *does* need a single unambiguous category per course. Priority order
when a code would otherwise land in more than one (see checksheet_
categories()'s own note on TE/Group overlap): fixed > group1 > group2 >
te > eb > gened > any_level.

Usage:
    python scripts/build_ee_relevant_courses.py
        (default: 2026-27, matching checksheets/data/2026.json and
        data/courses.jsonl -- what this script has always done)

    python scripts/build_ee_relevant_courses.py \
        --checksheet checksheets/data/2025.json \
        --courses data_catoid2/courses.jsonl \
        --out visualizer/data/ee_relevant_EE_catoid2.json
        (any other post-rename catalog this site can show and has a
        matching check sheet year for -- see visualizer/app.js's PROGRAMS)

    python scripts/build_ee_relevant_courses.py \
        --checksheet checksheets/data/2022.json \
        --courses data_2022/courses.jsonl \
        --out visualizer/data/ee_relevant_EE_2022.json \
        --subject-prefix EE
        (a pre-2024 catalog, where the department's own course prefix was
        still "EE", not "ECE" -- see checksheets/data/2023.json's own
        note on the rename. --subject-prefix swaps both the "any level"
        subject check below AND every "ECE "-prefixed code in
        REAL_CODES_CATEGORY to "EE " -- verified by direct comparison
        against the 2020/2021 check sheets' own semester grids that the
        department's ~30 fixed-requirement course *numbers* are identical
        either side of the rename, only the prefix changed, so a plain
        substitution is correct here, not an assumption. Non-ECE codes in
        REAL_CODES_CATEGORY (MATH/PHYS/CHEM/ENG/COMG/ECON) are untouched.)

REAL_CODES_CATEGORY is ECE-prefixed (build_ece_fixture.py was written
against the 2026 sheet); --subject-prefix handles the pre-2024 "EE" era.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from build_ece_fixture import REAL_CODES_CATEGORY, FIXED_OR_GROUPS  # noqa: E402

DEFAULT_COURSES_JSONL = ROOT / "data" / "courses.jsonl"
DEFAULT_CHECKSHEET = ROOT / "checksheets" / "data" / "2026.json"
DEFAULT_OUT_PATH = ROOT / "visualizer" / "data" / "ee_relevant_EE.json"
DEFAULT_SUBJECT_PREFIX = "ECE"

# The check sheet's open "any qualifying course" gened tags -- see the
# module docstring for why these are in scope and H/E/O/W Focus isn't.
OPEN_GENED_TAGS = {"FGA", "FGB", "FGC", "DH", "DL", "DS"}


def fixed_codes_for_subject(subject_prefix: str) -> set[str]:
    """REAL_CODES_CATEGORY as-is for the post-rename "ECE" era; for
    --subject-prefix EE (pre-2024 catalogs), every "ECE "-prefixed code is
    swapped to the given prefix -- see the module docstring for why this
    substitution (not a re-derivation from each year's own grid) is
    verified safe, not an assumption. Non-ECE codes (MATH/PHYS/CHEM/ENG/
    COMG/ECON) are shared across every catalog year and pass through
    unchanged."""
    if subject_prefix == "ECE":
        return set(REAL_CODES_CATEGORY)
    return {
        (f"{subject_prefix} {code.split(' ', 1)[1]}" if code.startswith("ECE ") else code)
        for code in REAL_CODES_CATEGORY
    }


def fixed_groups_for_subject(subject_prefix: str) -> list[list[str]]:
    """FIXED_OR_GROUPS as-is for "ECE"; same per-code ECE-&gt;subject_prefix
    swap as fixed_codes_for_subject(), for the same pre-2024 "EE" reason."""
    if subject_prefix == "ECE":
        return [list(g) for g in FIXED_OR_GROUPS]
    return [
        [(f"{subject_prefix} {c.split(' ', 1)[1]}" if c.startswith("ECE ") else c) for c in g]
        for g in FIXED_OR_GROUPS
    ]


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


def checksheet_categories(sheet: dict) -> dict[str, set[str]]:
    """Splits checksheet_codes() back out by which specific requirement
    bucket a code came from, for the visualizer's Group I / Group II / TE
    sub-filter (only shown once a major with this data is selected). Not
    a full degree-audit partition -- note 8 on every EE check sheet says
    TE credit can *also* be drawn from unused Group I/II courses, so a
    course can legitimately appear in more than one bucket here; the
    filter is "could count toward this", not "must be used for this"."""
    group1, group2 = set(), set()
    for track in sheet["tracks"].values():
        for area in track["areas"].values():
            group1.update(area["group1"])
            group2.update(area["group2"])
    te = set(sheet["technical_electives"]["additional_eligible"]) | set(sheet["technical_electives"]["case_by_case"])
    eb = set(sheet["engineering_breadth"]["named_eligible"])
    return {"group1": group1, "group2": group2, "te": te, "eb": eb}


def checksheet_track_groups(sheet: dict) -> dict:
    """Per-track Group I/Group II course lists with their required credits
    and display name, keyed by track id (e.g. "EP", "SDS") -- unlike
    checksheet_categories()'s group1/group2 (flattened across tracks, used
    for display coloring), this keeps track identity for progress
    evaluation, which needs to know e.g. "is this course in *my* track's
    Group I" specifically, and which track a Group I/II course is a
    leftover-eligible "outside track" course for."""
    out = {}
    for track_id, track in sheet["tracks"].items():
        group1, group2 = set(), set()
        for area in track["areas"].values():
            group1.update(area["group1"])
            group2.update(area["group2"])
        out[track_id] = {
            "name": track["name"],
            "group1_required_credits": track["group1_required_credits"],
            "group2_required_credits": track["group2_required_credits"],
            "group1": sorted(group1),
            "group2": sorted(group2),
        }
    return out


def build(checksheet_path: Path, courses_jsonl_path: Path, out_path: Path,
          subject_prefix: str = DEFAULT_SUBJECT_PREFIX):
    sheet = json.loads(checksheet_path.read_text(encoding="utf-8"))
    fixed_codes = fixed_codes_for_subject(subject_prefix)
    cats = checksheet_categories(sheet)
    relevant = set(fixed_codes) | checksheet_codes(sheet)

    # Priority order for category_by_code (see module docstring): each
    # code gets exactly one entry, first bucket it matches wins.
    category_by_code = {c: "fixed" for c in fixed_codes}
    for key in ("group1", "group2", "te", "eb"):
        for c in cats[key]:
            category_by_code.setdefault(c, key)

    gened_count = 0
    subject_count = 0
    all_codes = set()
    with courses_jsonl_path.open(encoding="utf-8") as f:
        for line in f:
            c = json.loads(line)
            if c["parse_status"] != "ok" or c["is_alpha_parent"]:
                continue
            all_codes.add(c["code"])
            if c["code"] in relevant:
                continue
            if OPEN_GENED_TAGS.intersection(c.get("gened") or []):
                relevant.add(c["code"])
                category_by_code[c["code"]] = "gened"
                gened_count += 1
            elif c["subject"] == subject_prefix:
                relevant.add(c["code"])
                category_by_code[c["code"]] = "any_level"
                subject_count += 1

    # Not a typo check we can skip -- e.g. the check sheet's own "ECE 491"
    # (or "EE 491" pre-rename) is an alpha-parent placeholder (only the
    # 491B, 491C, ... suffixed sections are real, enrollable courses, and
    # those are already pulled in by the "any level" rule above), so it
    # never matches a real graph node. Drop anything that doesn't resolve
    # to a real course rather than ship a dead code, but say so -- a
    # genuine typo would look identical here.
    missing = relevant - all_codes
    if missing:
        print(f"NOTE: dropping {len(missing)} code(s) that don't match any real course "
              f"(expected for e.g. an alpha-parent placeholder; verify anything unexpected here): "
              f"{sorted(missing)}")
        relevant -= missing

    categories = {
        key: sorted(codes - missing) for key, codes in checksheet_categories(sheet).items()
    }
    category_by_code = {c: cat for c, cat in category_by_code.items() if c not in missing}

    # Every fixed code appears in exactly one group: the real either/or
    # alternatives it belongs to (see FIXED_OR_GROUPS), or -- for the other
    # ~27 -- a one-code group of just itself. A code dropped as "missing"
    # above is dropped from its group the same way "categories" and
    # "category_by_code" already drop it; if that empties a whole
    # either/or group (shouldn't happen -- every group is at least one
    # real, currently-offered course -- but don't ship an empty slot if it
    # somehow did), the group itself is dropped too.
    grouped_codes = set()
    fixed_groups = []
    for g in fixed_groups_for_subject(subject_prefix):
        present = [c for c in g if c in fixed_codes and c not in missing]
        if not present:
            continue
        grouped_codes.update(present)
        fixed_groups.append(present)
    for c in sorted((fixed_codes - missing) - grouped_codes):
        fixed_groups.append([c])
    fixed_groups.sort(key=lambda g: g[0])

    out = {
        "program": "EE",
        "label": "Electrical Engineering",
        "catalog_year": sheet["year"],
        "source_checksheet": str(checksheet_path.resolve().relative_to(ROOT)).replace("\\", "/"),
        "courses": sorted(relevant),
        # Sub-filters within "relevant" -- see checksheet_categories()'s own
        # docstring for why these overlap rather than partition the set.
        # group1/group2/eb are real per-year lists straight from the check
        # sheet; "te" is deliberately just the check sheet's own explicit
        # additional_eligible/case_by_case TE list, not "any EE 300+
        # course" (note 8's fuller rule) -- that broader rule already
        # overlaps group1/group2 and the any-level ECE/EE bucket, and
        # restating it here would just relabel courses already covered
        # above rather than add real information.
        "categories": categories,
        # One category per code (unlike "categories" above) -- see module
        # docstring for the priority order used to break overlaps. Every
        # key in "courses" appears here exactly once.
        "category_by_code": category_by_code,
        # Everything below is for the visualizer's "My Progress" degree-audit
        # panel, not the display-coloring filter above -- additive, and
        # never read by anything that colors the graph.
        #
        # fixed_groups: the ~34 fixed codes above (category_by_code's
        # "fixed" entries) regrouped into their real ~30 requirement slots
        # -- most are a single-code group (just that one required course),
        # three are real either/or alternatives (e.g. ["ECE 160","ECE 110"]:
        # taking either satisfies the one slot, not both). A flat count over
        # "fixed" codes would demand both ECE 160 and ECE 110 -- see
        # FIXED_OR_GROUPS's own comment in build_ece_fixture.py.
        "fixed_groups": fixed_groups,
        "track_groups": {
            tid: {
                **t,
                "group1": [c for c in t["group1"] if c not in missing],
                "group2": [c for c in t["group2"] if c not in missing],
            }
            for tid, t in checksheet_track_groups(sheet).items()
        },
        # required_credits/outside_track_credits/lab_credits are the check
        # sheet's own note 9 numbers (7 total, 3 outside track, 1 lab) --
        # true for every year 2020-2026 (see checksheets/data/*.json), so
        # hardcoded here rather than parsed from technical_electives.rule's
        # free text. The progress panel evaluates TE only against this
        # program's explicit "te" category (additional_eligible/
        # case_by_case) -- see checksheet_categories()'s own docstring for
        # why note 9's "leftover Group I/II courses may also count as TE"
        # isn't reflected here; a correct implementation needs to know
        # which Group I/II credits are already "spent" on the Major Track
        # requirement, which this data doesn't attempt to solve.
        "technical_electives": {
            "required_credits": 7,
            "outside_track_credits": 3,
            "lab_credits": 1,
        },
        "engineering_breadth": {"required_credits": 3},
        "gened_codes": sheet["gened_codes"],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(relevant)} relevant courses to {out_path}")
    print(f"  {len(fixed_codes)} fixed requirements, "
          f"{len(checksheet_codes(sheet) - fixed_codes)} track/TE/EB eligible, "
          f"{gened_count} via open gen-ed tags, {subject_count} {subject_prefix} (any level)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checksheet", type=Path, default=DEFAULT_CHECKSHEET)
    parser.add_argument("--courses", type=Path, default=DEFAULT_COURSES_JSONL)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_PATH)
    parser.add_argument("--subject-prefix", default=DEFAULT_SUBJECT_PREFIX,
                         help="Department's own course prefix in this catalog year "
                              "(default ECE; use EE for any pre-2024 catalog)")
    args = parser.parse_args()
    build(args.checksheet, args.courses, args.out, args.subject_prefix)


if __name__ == "__main__":
    main()
