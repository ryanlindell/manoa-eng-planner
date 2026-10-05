"""Work out which courses carry a Focus designation and embed it in the catalog data.

Focus (W / H / E / O) is assigned per course *section* at registration time, so
it isn't in the catalog. STAR's class-availability data does carry it, as the
section's `attributes` string (e.g. "NI, WI"). This script reads every STAR term
capture in data_star/ (see scripts/private/star_pull_terms.js, local only) and collapses the
per-section attributes down to one set of focus letters per course code.

Deliberate simplification, per the project's own rule: a course's focus
designations are treated as *never changing*. A course gets a letter if ANY
section in ANY captured term has it (so a course where only some sections are
writing-intensive still counts as W). That overstates a few courses and makes no
claim about years STAR doesn't cover, but it needs no per-term logic.

Department renames are the same course: Electrical Engineering's EE prefix became
ECE in Fall 2024 (Spring 2024 STAR data still says EE 496, later terms say ECE),
so focus found under either prefix is emitted under both -- the older catalogs'
graphs (2020-2024) use EE codes, the newer ones ECE.

STAR attribute -> Focus letter:
    WI  -> W   Writing Intensive
    HAP -> H   Hawaiian, Asian & Pacific Issues
    ETH -> E   Contemporary Ethical Issues
    OC  -> O   Oral Communication

Where it goes (data_star/ itself is raw captures -- student-session data, gitignored, never
committed):
  * data/star_focus.json -- the small derived course-code -> letters map (no student data).
    graph.py reads it, so re-running a catalog build keeps the focus data.
  * a "focus" list on every node of every prereq_graph*.json (data*/ and visualizer/data/), next to
    the node's "gened" tags -- which is where the visualizer reads it from.

Usage:
  python scripts/build_star_focus.py               # rebuild the map from data_star/, then embed it
  python scripts/build_star_focus.py --embed-only  # re-embed data/star_focus.json (no data_star/ needed)
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAR_DIR = ROOT / "data_star"
OUT = ROOT / "data" / "star_focus.json"
# Every catalog graph the focus list gets embedded in: each year's own data folder
# plus the copies the visualizer serves.
GRAPH_GLOBS = [(ROOT, "data*/prereq_graph.json"), (ROOT / "visualizer" / "data", "prereq_graph*.json")]

ATTRIBUTE_TO_LETTER = {"WI": "W", "HAP": "H", "ETH": "E", "OC": "O"}
LETTER_ORDER = "WHEO"
# old subject prefix -> new one (same course numbers), see the module docstring.
SUBJECT_RENAMES = {"EE": "ECE"}
TERM_FILE = re.compile(r"^\d{4}(10|30)\.json$")  # Banner term code, e.g. 202710 (Fall) / 202630 (Spring)


def focus_letters(attributes):
    """'NI, WI' -> {'W'}. Tolerates None / '' / stray whitespace."""
    letters = set()
    for attr in (attributes or "").split(","):
        letter = ATTRIBUTE_TO_LETTER.get(attr.strip())
        if letter:
            letters.add(letter)
    return letters


def course_code(section):
    """A STAR section -> the catalog-style course code ('ECE 213', 'BIOL 171L')."""
    return f"{section['name'].strip()} {str(section['number']).strip()}"


def iter_term_sections(doc):
    """Yield (term_key, section) from either capture shape: the flat
    {semester, courses} one or the nested {terms: {key: {courses}}} one."""
    if "terms" in doc:
        for key, term in doc["terms"].items():
            for section in term.get("courses", []):
                yield key, section
    else:
        for section in doc.get("courses", []):
            yield str(doc.get("semester", "")), section


def rename_aliases(code):
    """'EE 496' -> ['EE 496', 'ECE 496']; 'ECE 496' -> the same pair; anything else -> [code]."""
    subject, _, number = code.partition(" ")
    for old, new in SUBJECT_RENAMES.items():
        if subject in (old, new):
            return [f"{old} {number}", f"{new} {number}"]
    return [code]


def build(docs):
    """docs: iterable of parsed capture files -> the star_focus.json payload."""
    by_code = {}
    term_counts = {}
    for doc in docs:
        for term, section in iter_term_sections(doc):
            term_counts[term] = term_counts.get(term, 0) + 1
            letters = focus_letters(section.get("attributes"))
            if letters:
                for code in rename_aliases(course_code(section)):
                    by_code.setdefault(code, set()).update(letters)
    focus_by_code = {
        code: [l for l in LETTER_ORDER if l in letters]
        for code, letters in sorted(by_code.items())
    }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "STAR class availability (registration2/classes), Manoa",
        "terms": dict(sorted(term_counts.items())),
        "note": ("Focus treated as constant per course: a code gets a letter if any section in any "
                 "captured term had it. W=WI, H=HAP, E=ETH, O=OC."),
        "focus_by_code": focus_by_code,
    }


def graph_files():
    return sorted(p for base, pattern in GRAPH_GLOBS for p in base.glob(pattern))


def embed(focus_by_code, paths):
    """Write node["focus"] into each graph JSON (and drop it from nodes that no longer have one, so
    a re-run is idempotent). Same json.dumps settings as graph.py's export_json, so the only diff
    in these files is the focus lists."""
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        tagged = 0
        for code, node in payload["nodes"].items():
            if code in focus_by_code:
                node["focus"] = focus_by_code[code]
                tagged += 1
            else:
                node.pop("focus", None)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  {path.relative_to(ROOT)}: {tagged} of {len(payload['nodes'])} nodes have a focus")


def main():
    if "--embed-only" in sys.argv[1:]:
        payload = json.loads(OUT.read_text(encoding="utf-8"))
    else:
        files = sorted(p for p in STAR_DIR.glob("*.json") if TERM_FILE.match(p.name))
        if not files:
            sys.exit(f"no term captures (e.g. 202710.json) found in {STAR_DIR} -- use --embed-only to re-embed {OUT.name}")
        payload = build([json.loads(p.read_text(encoding="utf-8")) for p in files])
        OUT.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{len(files)} term files {payload['terms']}")
    counts = {l: sum(l in v for v in payload["focus_by_code"].values()) for l in LETTER_ORDER}
    print(f"{len(payload['focus_by_code'])} courses with a focus {counts} -> {OUT.relative_to(ROOT)}")
    embed(payload["focus_by_code"], graph_files())


if __name__ == "__main__":
    main()
