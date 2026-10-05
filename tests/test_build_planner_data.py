"""Tests for scripts/build_planner_data.py -- the slim catalog + requirement
file the web planner loads."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from build_planner_data import course_number, has_unparsed, slim_course, slim_tree, wanted  # noqa: E402


def test_course_number():
    assert course_number("ECE 323L") == 323
    assert course_number("MATH 251A") == 251
    assert course_number("XYZ") == 0


def test_wanted_keeps_undergrad_and_all_ece():
    assert wanted("HIST 151", {"in_catalog": True, "subject": "HIST"})
    assert not wanted("HIST 602", {"in_catalog": True, "subject": "HIST"})
    assert wanted("ECE 602", {"in_catalog": True, "subject": "ECE"})
    assert not wanted("ECE 101", {"in_catalog": False, "subject": "ECE"})


def test_slim_tree_drops_grade_notes_and_text():
    tree = {"op": "OR", "children": [
        {"course": "MATH 244", "concurrent": True, "min_grade": "C"},
        {"type": "unparsed", "text": "placement exam"},
    ]}
    assert slim_tree(tree) == {"op": "OR", "children": [
        {"course": "MATH 244", "concurrent": True},
        {"type": "unparsed"},
    ]}
    assert slim_tree(None) is None


def test_slim_course_short_keys_and_no_nulls():
    node = {
        "title": "Basic Circuit Analysis II", "credits_min": 4.0, "credits_max": 4.0, "gened": ["DP"],
        "prereq_raw": "ECE 211", "prereq_tree": {"course": "ECE 211"}, "coreq_raw": None, "coreq_tree": None,
        "restrictions_raw": None, "description": "long text that must not be copied",
    }
    assert slim_course(node) == {"t": "Basic Circuit Analysis II", "c": [4, 4], "g": ["DP"], "pr": "ECE 211", "p": {"course": "ECE 211"}}


def test_uncertain_flag():
    unparsed = {"title": "X", "prereq_tree": {"op": "OR", "children": [{"course": "A 1"}, {"type": "unparsed", "text": "?"}]}}
    assert has_unparsed(unparsed["prereq_tree"])
    assert slim_course(unparsed)["u"] == 1
    assert slim_course({"title": "Y", "prereq_tree": {"course": "A 1"}}, risky=True)["u"] == 1
    assert "u" not in slim_course({"title": "Z", "prereq_tree": {"course": "A 1"}})
