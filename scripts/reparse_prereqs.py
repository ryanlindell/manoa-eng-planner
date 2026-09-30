"""Re-runs parse_prereq.py over an already-built courses.jsonl's stored
prereq_raw/coreq_raw, in place -- for when the *grammar* changes (not the
scraped text), so a fix doesn't need a full re-scrape to reach data that's
already on disk. Leaves every other field untouched.

Usage: python scripts/reparse_prereqs.py data/courses.jsonl
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import parse_prereq  # noqa: E402


def main():
    path = Path(sys.argv[1])
    rows = [json.loads(line) for line in path.open(encoding="utf-8")]

    changed = []
    for c in rows:
        if c["parse_status"] != "ok":
            continue
        for raw_field, tree_field, status_field in [
            ("prereq_raw", "prereq_tree", "prereq_parse_status"),
            ("coreq_raw", "coreq_tree", "coreq_parse_status"),
        ]:
            if not c.get(raw_field):
                continue
            new_tree, new_status = parse_prereq.parse_prereq(c[raw_field], c["subject"])
            if new_tree != c.get(tree_field) or new_status != c.get(status_field):
                changed.append((c["code"], raw_field, c.get(status_field), new_status))
                c[tree_field] = new_tree
                c[status_field] = new_status

    with path.open("w", encoding="utf-8") as f:
        for c in rows:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    print(f"{path}: {len(changed)} course(s) changed")
    for code, field, old, new in changed:
        print(f"  {code} ({field}): {old} -> {new}")


if __name__ == "__main__":
    main()
