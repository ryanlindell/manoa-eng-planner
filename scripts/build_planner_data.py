"""Builds web/data/planner_data.json -- everything the EE Degree Planner
(web/) needs from the catalog and the check sheet, in one small file.

The planner used to read contracts/fixtures/courses.json: ~34 real courses
plus hand-labeled placeholders for every open slot (FG, EB, TE, Focus...).
To let a student pick the actual course for each of those slots it needs the
whole undergraduate catalog -- titles, credits, gen-ed tags, Focus letters,
prereq/coreq trees -- but visualizer/data/prereq_graph.json is ~9 MB (course
descriptions, graduate courses, edges, source URLs), far more than a planner
page should download. This writes a slimmed copy:

  * courses: every in-catalog course numbered below 500, plus every ECE, ME
    and CEE course at any level (their graduate courses can count as
    technical electives). Short
    keys, nulls dropped:
        t  title              c  [credits_min, credits_max]
        g  gen-ed tags        f  Focus letters (from STAR, see build_star_focus.py)
        p  prereq tree        q  coreq tree
        pr prereq text        qr coreq text        r  restrictions text
        u  1 when the prereq tree can't be fully trusted: part of the text
           didn't parse, or scripts/audit_prereq_risk.py flagged its and/or
           grouping as ambiguous (data/prereq_risk_flagged.json). The
           planner reports a failed check on these as "couldn't confirm",
           not as an error.
    Trees keep only what the planner evaluates: course / concurrent / op /
    n / children / type. The raw text is what gets shown to the student.
  * program: the EE requirement lists, from the same two files the
    visualizer's major filter uses (visualizer/data/ee_relevant_EE.json and
    checksheets/data/<year>.json), so the planner can't drift from them.

Always the newest catalog (data/, catoid 4 = 2026-27) and its check sheet.
STAR's section history is NOT copied here: the planner reads
visualizer/data/star_sections.json directly.

Usage:
    python scripts/build_planner_data.py
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAPH_JSON = ROOT / "data" / "prereq_graph.json"
RELEVANT_JSON = ROOT / "visualizer" / "data" / "ee_relevant_EE.json"
CHECKSHEET_JSON = ROOT / "checksheets" / "data" / "2026.json"
RISK_JSON = ROOT / "data" / "prereq_risk_flagged.json"
OUT_PATH = ROOT / "web" / "data" / "planner_data.json"

CATALOG_LABEL = "2026–2027"
MAX_UNDERGRAD_NUMBER = 499
# Departments whose graduate courses can count as technical electives (EE and
# Computer: "ECE 300 or above"; Mechanical: one ME 600-level course; Civil:
# "any 400 or 600 level CEE course").
ALL_LEVELS_SUBJECTS = {"ECE", "ME", "CEE"}
# Note 8 of the check sheet: "a CEE, ME, OE, or BE course at the 300 level or
# higher". Ocean Engineering's catalog prefix is ORE.
EB_SUBJECTS = ["CEE", "ME", "ORE", "BE"]
TREE_KEYS = ("course", "concurrent", "op", "n", "type")


def course_number(code):
    """'ECE 323L' -> 323; 0 if the code has no number."""
    m = re.search(r"\s(\d+)", code)
    return int(m.group(1)) if m else 0


def slim_tree(tree):
    """Drop everything the planner doesn't evaluate (grade notes, free text)."""
    if not tree:
        return None
    out = {k: tree[k] for k in TREE_KEYS if tree.get(k) not in (None, False)}
    if tree.get("children"):
        out["children"] = [slim_tree(c) for c in tree["children"]]
    return out


def has_unparsed(tree):
    if not tree:
        return False
    return tree.get("type") == "unparsed" or any(has_unparsed(c) for c in tree.get("children") or [])


def wanted(code, node):
    if not node.get("in_catalog"):
        return False
    return node.get("subject") in ALL_LEVELS_SUBJECTS or course_number(code) <= MAX_UNDERGRAD_NUMBER


def slim_course(node, risky=False):
    out = {"t": node.get("title") or ""}
    if risky or has_unparsed(node.get("prereq_tree")) or has_unparsed(node.get("coreq_tree")):
        out["u"] = 1
    if node.get("credits_min") is not None:
        lo, hi = node["credits_min"], node.get("credits_max")
        hi = lo if hi is None else hi
        out["c"] = [int(lo) if lo == int(lo) else lo, int(hi) if hi == int(hi) else hi]
    for short, key in (("g", "gened"), ("f", "focus"), ("pr", "prereq_raw"), ("qr", "coreq_raw"), ("r", "restrictions_raw")):
        if node.get(key):
            out[short] = node[key]
    for short, key in (("p", "prereq_tree"), ("q", "coreq_tree")):
        tree = slim_tree(node.get(key))
        if tree:
            out[short] = tree
    return out


def build_program(relevant, checksheet):
    tracks = {}
    for key, track in relevant["track_groups"].items():
        tracks[key] = dict(track)
        tracks[key]["areas"] = checksheet["tracks"][key]["areas"]
    te = dict(relevant["technical_electives"])
    te["additional_eligible"] = checksheet["technical_electives"]["additional_eligible"]
    te["case_by_case"] = checksheet["technical_electives"]["case_by_case"]
    eb = dict(relevant["engineering_breadth"])
    eb["named_eligible"] = checksheet["engineering_breadth"]["named_eligible"]
    eb["subjects"] = EB_SUBJECTS
    return {
        "label": relevant["label"],
        "checksheet_year": checksheet["year"],
        "checksheet_effective": checksheet["catalog_effective"],
        "fixed_groups": relevant["fixed_groups"],
        "tracks": tracks,
        "technical_electives": te,
        "engineering_breadth": eb,
        "major_track_minimum": checksheet["credit_totals"]["major_track_minimum"],
    }


def build(graph, relevant, checksheet, risky_codes=frozenset()):
    courses = {
        code: slim_course(node, code in risky_codes)
        for code, node in sorted(graph["nodes"].items()) if wanted(code, node)
    }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "catalog": CATALOG_LABEL,
        "program": build_program(relevant, checksheet),
        "courses": courses,
    }


def main():
    graph = json.loads(GRAPH_JSON.read_text(encoding="utf-8"))
    relevant = json.loads(RELEVANT_JSON.read_text(encoding="utf-8"))
    checksheet = json.loads(CHECKSHEET_JSON.read_text(encoding="utf-8"))
    risk = json.loads(RISK_JSON.read_text(encoding="utf-8")) if RISK_JSON.exists() else {}
    risky_codes = frozenset(row["code"] for rows in risk.values() if isinstance(rows, list) for row in rows)
    data = build(graph, relevant, checksheet, risky_codes)

    named = set()
    for group in data["program"]["fixed_groups"]:
        named.update(group)
    for track in data["program"]["tracks"].values():
        named.update(track["group1"], track["group2"])
    named.update(data["program"]["technical_electives"]["additional_eligible"])
    named.update(data["program"]["engineering_breadth"]["named_eligible"])
    missing = sorted(named - set(data["courses"]))
    if missing:
        print(f"note: on the check sheet but not in the {CATALOG_LABEL} catalog: {missing}")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {len(data['courses'])} courses to {OUT_PATH} ({OUT_PATH.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
