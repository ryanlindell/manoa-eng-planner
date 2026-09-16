import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import graph


def _course(code, prereq_tree=None, prereq_status="ok", coreq_tree=None):
    subject = code.split()[0]
    return {
        "code": code,
        "subject": subject,
        "title": f"Title {code}",
        "credits_raw": "3",
        "credits_min": 3,
        "credits_max": 3,
        "gened": [],
        "description": "",
        "parse_status": "ok",
        "is_alpha_parent": False,
        "prereq_raw": "x" if prereq_tree is not None else None,
        "prereq_tree": prereq_tree,
        "prereq_parse_status": prereq_status,
        "coreq_raw": "x" if coreq_tree is not None else None,
        "coreq_tree": coreq_tree,
        "restrictions_raw": None,
        "source_url": f"https://example.invalid/{code}",
    }


def test_depth_no_prereq():
    courses = {"A": _course("A")}
    depths, status = graph.compute_depths(courses)
    assert depths["A"] == 0
    assert status["A"] == "no_prereq"


def test_depth_single_course_chain():
    courses = {
        "A": _course("A"),
        "B": _course("B", {"course": "A"}),
    }
    depths, status = graph.compute_depths(courses)
    assert depths["A"] == 0
    assert depths["B"] == 1
    assert status["B"] == "ok"


def test_depth_or_takes_min():
    courses = {
        "A": _course("A"),  # depth 0
        "B": _course("B", {"course": "A"}),  # depth 1
        "C": _course("C", {"op": "OR", "children": [{"course": "A"}, {"course": "B"}]}),
    }
    depths, _ = graph.compute_depths(courses)
    # C needs A (depth 0 -> 1) OR B (depth 1 -> 2); OR takes the min => 1
    assert depths["C"] == 1


def test_depth_and_takes_max():
    courses = {
        "A": _course("A"),
        "B": _course("B", {"course": "A"}),
        "D": _course("D", {"op": "AND", "children": [{"course": "A"}, {"course": "B"}]}),
    }
    depths, _ = graph.compute_depths(courses)
    # D needs A (-> 1) AND B (-> 2); AND takes the max => 2
    assert depths["D"] == 2


def test_depth_n_of_takes_nth_smallest():
    courses = {
        "A": _course("A"),  # 0
        "B": _course("B", {"course": "A"}),  # 1
        "C": _course("C", {"op": "OR", "children": [{"course": "A"}, {"course": "B"}]}),  # 1
        "E": _course("E", {
            "op": "N_OF", "n": 2,
            "children": [{"course": "A"}, {"course": "B"}, {"course": "C"}],
        }),
    }
    depths, _ = graph.compute_depths(courses)
    # child depths via leaf resolution: A->1, B->2, C->2 ; 2nd smallest of [1,2,2] = 2
    assert depths["E"] == 2


def test_or_prefers_course_bearing_over_consent():
    courses = {
        "A": _course("A"),
        "B": _course("B", {"course": "A"}),  # depth 1
        "C": _course("C", {"op": "OR", "children": [{"course": "B"}, {"type": "consent"}]}),
    }
    depths, _ = graph.compute_depths(courses)
    # Without the course-bearing preference this would collapse to 0 via consent.
    assert depths["C"] == 2


def test_cycle_detected_and_depth_none():
    courses = {
        "F": _course("F", {"course": "G"}),
        "G": _course("G", {"course": "F"}),
    }
    depths, status = graph.compute_depths(courses)
    assert depths["F"] is None
    assert depths["G"] is None
    assert status["F"] == "cycle"
    assert status["G"] == "cycle"

    g = graph.build_graph(courses)
    cycles = graph.find_cycles(g)
    assert len(cycles) == 1
    assert set(cycles[0]) == {"F", "G"}


def test_external_reference_depth_zero_and_dangling():
    courses = {
        "H": _course("H", {"course": "ZZZ 999"}),
    }
    depths, status = graph.compute_depths(courses)
    assert depths["H"] == 1

    g = graph.build_graph(courses)
    assert g.nodes["ZZZ 999"]["in_catalog"] is False

    dangling = graph.find_dangling_refs(g, courses)
    assert "ZZZ 999" in dangling
    assert dangling["ZZZ 999"] == ["H"]


def test_unresolved_prereq_status_when_parse_failed_but_raw_present():
    courses = {
        "I": _course("I", {"type": "unparsed", "text": "audition"}, prereq_status="failed"),
    }
    depths, status = graph.compute_depths(courses)
    assert depths["I"] == 0
    assert status["I"] == "unresolved_prereq"


def test_coreq_edge_does_not_trigger_cycle_detection():
    """A lecture/lab coreq pair (each requires the other concurrently) is
    normal, not a genuine ordering cycle -- find_cycles only looks at prereq
    edges."""
    courses = {
        "X": _course("X", coreq_tree={"course": "Y"}),
        "Y": _course("Y", coreq_tree={"course": "X"}),
    }
    g = graph.build_graph(courses)
    assert graph.find_cycles(g) == []
