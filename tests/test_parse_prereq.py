import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import parse_prereq

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = json.loads((ROOT / "tests" / "prereq_golden.json").read_text(encoding="utf-8"))
ALL_FIXTURES = json.loads((ROOT / "tests" / "prereq_fixtures_raw.json").read_text(encoding="utf-8"))

# Independent of the parser's own tokenizer -- a plain sanity regex for "does
# this look like a course code" so the no-data-loss test isn't just checking
# the parser against itself.
COURSE_LIKE_RE = re.compile(r"\b[A-Z]{2,6}\s?\d{2,4}[A-Za-z]?\b")


@pytest.mark.parametrize("entry", GOLDEN, ids=lambda e: e["code"])
def test_golden_prereq_tree(entry):
    tree, status = parse_prereq.parse_prereq(entry["prereq_raw"], entry["own_subject"])
    assert tree == entry["expected_tree"], f"{entry['code']}: tree mismatch"
    assert status == entry["expected_status"], f"{entry['code']}: status mismatch"


@pytest.mark.parametrize("entry", ALL_FIXTURES, ids=lambda e: e["code"])
def test_no_silent_data_loss(entry):
    """Every course-code-shaped token in the raw text must survive somewhere
    in the tree -- either as a real 'course' leaf or inside 'unparsed' text.
    This is the property that matters most for the messy real-world strings
    that don't parse cleanly."""
    subject = entry["code"].split()[0]
    tree, status = parse_prereq.parse_prereq(entry["prereq_raw"], subject)
    assert status in ("clean", "partial", "failed")

    if tree is None:
        assert not entry["prereq_raw"].strip()
        return

    serialized = json.dumps(tree)
    raw_courses = COURSE_LIKE_RE.findall(entry["prereq_raw"])
    # Bare numbers (resolved against own_subject) won't match COURSE_LIKE_RE
    # in the raw text directly -- that's expected, skip those.
    for code in raw_courses:
        normalized = " ".join(code.split())
        assert normalized in serialized, (
            f"{entry['code']}: {normalized!r} from raw text not found anywhere in tree {serialized}"
        )


def test_empty_prereq_is_clean_none():
    tree, status = parse_prereq.parse_prereq(None, "ECE")
    assert tree is None and status == "clean"
    tree, status = parse_prereq.parse_prereq("   ", "ECE")
    assert tree is None and status == "clean"


def test_bare_number_resolves_to_own_subject():
    tree, status = parse_prereq.parse_prereq("230", "COA")
    assert tree == {"course": "COA 230"}
    assert status == "clean"


def test_n_of_pattern():
    tree, status = parse_prereq.parse_prereq(
        "Two of the following: ART 230 , ART 234 , ART 303 , ART 306 .", "ART"
    )
    assert tree["op"] == "N_OF"
    assert tree["n"] == 2
    assert len(tree["children"]) == 4


def test_either_scopes_over_the_whole_or_chain_not_one_atom():
    """"X and either Y or Z" means X AND (Y OR Z) -- "either" has to scope
    over the entire Y-or-Z-or-... chain that follows it, not just the one
    atom immediately after "either". Regression test for a real bug: this
    used to parse as OR[AND(X, Y), Z] (Z landing as a bare top-level
    alternative to X-and-Y, instead of inside the Y/Z alternative pair) --
    found via the prereq-graph visualizer showing X, Y, and Z as three
    equal "pick one of" alternatives when only Y and Z actually are."""
    tree, status = parse_prereq.parse_prereq(
        "ECE 315 (or concurrent) and either MATH 244 or MATH 253A ; or consent.", "ECE"
    )
    assert status == "clean"
    assert tree == {
        "op": "OR",
        "children": [
            {
                "op": "AND",
                "children": [
                    {"course": "ECE 315", "concurrent": True},
                    {"op": "OR", "children": [{"course": "MATH 244"}, {"course": "MATH 253A"}]},
                ],
            },
            {"type": "consent"},
        ],
    }


def test_either_chain_stops_at_semicolon():
    """The "either" chain must not swallow a later "; or X" -- that
    semicolon always introduces a new top-level alternative, never part of
    what "either" was scoping over."""
    tree, status = parse_prereq.parse_prereq("either AB 100 or AB 200; or consent.", "AB")
    assert tree == {
        "op": "OR",
        "children": [
            {"op": "OR", "children": [{"course": "AB 100"}, {"course": "AB 200"}]},
            {"type": "consent"},
        ],
    }
