"""Flags prereq/coreq trees at risk of the comma-precedence mis-scoping bug
found in ECE 342 and ECE 213 (see parse_prereq.py's EITHER handling and the
"X, and Y or Z" class of ambiguity it doesn't fully solve).

This is NOT the same thing as prereq_parse_status (clean/partial/failed) --
that only tells you whether every character got consumed into *some*
structure. A course can report "clean" while still being mis-grouped, if
the mis-grouping didn't leave any text behind (exactly what happened with
ECE 213: OR[AND(ECE 211, MATH 244), MATH 253A, consent] consumed every
token, so it's "clean", but ECE 211 is wrongly bundled in as if it were an
alternative to MATH 253A rather than separately required).

The detectable shape: an OR node whose children MIX a bare course/leaf with
a complex AND subtree. A well-formed alternative-of-equals list doesn't
produce that shape from a flat "A or B or C" reading; a mis-scoped
"X, and Y or Z" does, every time. It's a real signal, not a proof -- "either
X, or both Y and Z" is a legitimate requirement that produces the same
shape, so this is a *risk* flag for manual review, not an error list.
"""

import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IN_JSONL = ROOT / "data" / "courses.jsonl"
OUT_REPORT = ROOT / "data" / "prereq_risk_report.txt"
OUT_JSON = ROOT / "data" / "prereq_risk_flagged.json"


def find_mixed_or_nodes(node, hits):
    """Recursively finds every OR node (anywhere in the tree) whose children
    mix a bare course/leaf with a complex (AND) subtree, and appends each
    one found to `hits`."""
    if not isinstance(node, dict):
        return
    children = node.get("children")
    if node.get("op") == "OR" and children:
        # A bare course leaf sibling to an AND subtree is the risky shape --
        # NOT a consent/standing leaf sibling to one, which is the extremely
        # common and normally-correct "...requirement...; or consent" escape
        # hatch (excluding it avoids flooding the report with non-findings).
        has_simple_course = any("course" in c for c in children)
        has_complex_and = any(c.get("op") == "AND" for c in children)
        if has_simple_course and has_complex_and:
            hits.append(node)
    if children:
        for c in children:
            find_mixed_or_nodes(c, hits)


def audit_field(courses, field_raw, field_tree, field_status):
    flagged = []
    for c in courses:
        tree = c.get(field_tree)
        if not tree:
            continue
        hits = []
        find_mixed_or_nodes(tree, hits)
        if hits:
            flagged.append({
                "code": c["code"],
                "subject": c["subject"],
                "raw": c[field_raw],
                "status": c.get(field_status),
                "risky_subtrees": hits,
            })
    return flagged


def build_report(label, applicable_count, flagged) -> list[str]:
    lines = []
    lines.append(f"--- {label} ---")
    lines.append(f"Real courses with {label.lower()}: {applicable_count}")
    lines.append(f"Flagged as at-risk (mixed OR shape): {len(flagged)} "
                 f"({100 * len(flagged) / applicable_count:.1f}%)" if applicable_count else "n/a")

    by_status = defaultdict(int)
    for f in flagged:
        by_status[f["status"]] += 1
    lines.append("  by current parse status (the scary bucket is 'clean' -- looks fine, isn't necessarily):")
    for status in ("clean", "partial", "failed"):
        lines.append(f"    {status}: {by_status.get(status, 0)}")

    by_subject = defaultdict(int)
    for f in flagged:
        by_subject[f["subject"]] += 1
    top_subjects = sorted(by_subject.items(), key=lambda kv: -kv[1])[:10]
    lines.append("  worst subjects: " + str(top_subjects))

    clean_flagged = [f for f in flagged if f["status"] == "clean"]
    if clean_flagged:
        lines.append(f"  sample of 'clean'-but-flagged courses (worth a manual look, {len(clean_flagged)} total):")
        for f in clean_flagged[:15]:
            lines.append(f"    {f['code']}: {f['raw']!r}")

    lines.append("")
    return lines


def main():
    courses = [json.loads(line) for line in IN_JSONL.open(encoding="utf-8")]
    real = [c for c in courses if c["parse_status"] == "ok" and not c["is_alpha_parent"]]

    prereq_applicable = [c for c in real if c.get("prereq_raw")]
    coreq_applicable = [c for c in real if c.get("coreq_raw")]

    prereq_flagged = audit_field(real, "prereq_raw", "prereq_tree", "prereq_parse_status")
    coreq_flagged = audit_field(real, "coreq_raw", "coreq_tree", "coreq_parse_status")

    lines = ["=== UH Manoa Catalog -- Prereq/Coreq Grouping-Risk Audit ===", ""]
    lines += build_report("Prerequisites", len(prereq_applicable), prereq_flagged)
    lines += build_report("Corequisites", len(coreq_applicable), coreq_flagged)

    report = "\n".join(lines) + "\n"
    OUT_REPORT.write_text(report, encoding="utf-8")

    OUT_JSON.write_text(json.dumps({
        "prereq": [{"code": f["code"], "raw": f["raw"], "status": f["status"]} for f in prereq_flagged],
        "coreq": [{"code": f["code"], "raw": f["raw"], "status": f["status"]} for f in coreq_flagged],
    }, indent=2, ensure_ascii=False), encoding="utf-8")

    print(report)
    print(f"Full flagged-subtree detail: {OUT_REPORT}")
    print(f"Flagged course-code list (for programmatic use): {OUT_JSON}")


if __name__ == "__main__":
    main()
