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


def test_elliptical_comma_list_resolved_by_trailing_or():
    """"A, B, or C" is a flat 3-way OR with no ambiguity at all -- every
    comma but the last one is "elliptical" (standing in for a repeated
    "or"). Regression test for a real bug found via the risk-audit script:
    the parser used to only check the token immediately after a comma for
    a literal "or", so it treated every comma before the last one as an
    implicit AND instead of resolving the whole list by its one real
    connector -- e.g. "CAM 102, CAM 106, or CAM 112; or consent." parsed as
    AND(CAM 102, CAM 106) OR CAM 112, wrongly requiring CAM 102 and CAM 106
    together despite the raw text never containing the word "and" at all."""
    tree, status = parse_prereq.parse_prereq("AB 102 , AB 106 , or AB 112 ; or consent.", "AB")
    assert status == "clean"
    assert tree == {
        "op": "OR",
        "children": [
            {"course": "AB 102"},
            {"course": "AB 106"},
            {"course": "AB 112"},
            {"type": "consent"},
        ],
    }


def test_elliptical_comma_list_resolved_by_trailing_and():
    """Mirror of the OR case -- "A, B, and C" is a flat 3-way AND, and an
    elliptical comma must still resolve to AND (not get swept into the new
    OR-list handling) when that's what the list's one real connector says."""
    tree, status = parse_prereq.parse_prereq("AB 102 , AB 106 , and AB 112 .", "AB")
    assert status == "clean"
    assert tree == {
        "op": "AND",
        "children": [{"course": "AB 102"}, {"course": "AB 106"}, {"course": "AB 112"}],
    }


def test_comma_and_before_later_or_scopes_across_the_whole_alternation():
    """"X, and Y or Z" -- the comma marks "and" as starting a new list item,
    not a tight X-and-Y pairing, so its scope has to reach the "or" that
    follows: X AND (Y OR Z), not OR[AND(X, Y), Z]. Regression test for a
    real bug found via the risk-audit script and confirmed against real
    catalog data: ECE 213's actual prereq string has this exact shape, and
    its old (wrong) tree would have let ECE 211 alone satisfy the
    requirement as if it were an alternative to MATH 253A."""
    tree, status = parse_prereq.parse_prereq("AB 100 , and AB 200 or AB 300 ; or consent.", "AB")
    assert status == "clean"
    assert tree == {
        "op": "OR",
        "children": [
            {
                "op": "AND",
                "children": [
                    {"course": "AB 100"},
                    {"op": "OR", "children": [{"course": "AB 200"}, {"course": "AB 300"}]},
                ],
            },
            {"type": "consent"},
        ],
    }


def test_or_then_comma_and_scopes_back_across_the_whole_alternation():
    """Mirror of the above with the "and" on the other side -- "X or Y, and
    Z" means (X OR Y) AND Z, not X OR (Y AND Z). Regression test confirmed
    against real catalog data: ECE 211's actual prereq string has this
    shape (two equivalent-track math alternatives, then a genuinely
    separate physics corequisite), and its old (wrong) tree would have let
    the math course alone satisfy the requirement without the physics
    course at all."""
    tree, status = parse_prereq.parse_prereq("AB 100 or AB 200 , and AB 300 ; or consent.", "AB")
    assert status == "clean"
    assert tree == {
        "op": "OR",
        "children": [
            {
                "op": "AND",
                "children": [
                    {"op": "OR", "children": [{"course": "AB 100"}, {"course": "AB 200"}]},
                    {"course": "AB 300"},
                ],
            },
            {"type": "consent"},
        ],
    }


def test_comma_and_of_a_multi_course_bundle_stays_flat_and_unfolded():
    """Contrast case: when the comma+"and" RHS is itself a whole bundle of
    courses (not a single plain leaf), it must NOT get folded backward into
    an earlier OR-alternative -- that bundle is what accompanies THIS
    alternative specifically, not a universal extra shared by every
    alternative. Regression test for ANSC 387's real prereq shape
    ("ANSC 200 or ANSC 201, and BIOL 171 and BIOL 171L and CHEM 161")."""
    tree, status = parse_prereq.parse_prereq(
        "AB 100 or AB 200 , and AB 300 and AB 301 and AB 302 .", "AB"
    )
    assert status == "clean"
    assert tree == {
        "op": "OR",
        "children": [
            {"course": "AB 100"},
            {
                "op": "AND",
                "children": [
                    {"course": "AB 200"},
                    {"course": "AB 300"},
                    {"course": "AB 301"},
                    {"course": "AB 302"},
                ],
            },
        ],
    }
