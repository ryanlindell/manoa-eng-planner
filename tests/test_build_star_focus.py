import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_star_focus as bsf  # noqa: E402


def _section(name, number, attributes):
    return {"name": name, "number": number, "attributes": attributes}


def test_focus_letters_maps_the_four_focus_attributes():
    assert bsf.focus_letters("NI, WI") == {"W"}
    assert bsf.focus_letters("DS, ETH, WI") == {"W", "E"}
    assert bsf.focus_letters("HAP,OC") == {"H", "O"}  # no space after the comma


def test_focus_letters_ignores_everything_else_and_blanks():
    assert bsf.focus_letters("DY, NI, TXT0") == set()
    assert bsf.focus_letters("") == set()
    assert bsf.focus_letters(None) == set()


def test_course_code_keeps_lab_suffix():
    assert bsf.course_code(_section("BIOL", "171L", "WI")) == "BIOL 171L"


def test_iter_term_sections_reads_both_capture_shapes():
    nested = {"terms": {"202630": {"courses": [_section("ENG", "200", "WI")]}}}
    flat = {"semester": "202710", "courses": [_section("ENG", "200", "WI")]}
    assert [t for t, _ in bsf.iter_term_sections(nested)] == ["202630"]
    assert [t for t, _ in bsf.iter_term_sections(flat)] == ["202710"]


def test_build_unions_focus_across_sections_and_terms():
    # Only one section of ENG 311 is writing-intensive, and E shows up only in a
    # later term -- "focus never changes" means the course ends up with both.
    docs = [
        {"terms": {"202630": {"courses": [
            _section("ENG", "311", "WI"), _section("ENG", "311", ""), _section("MATH", "241", "FQ"),
        ]}}},
        {"semester": "202710", "courses": [_section("ENG", "311", "ETH")]},
    ]
    payload = bsf.build(docs)
    assert payload["focus_by_code"] == {"ENG 311": ["W", "E"]}  # MATH 241 has none -> absent
    assert payload["terms"] == {"202630": 3, "202710": 1}


def test_build_letters_are_in_fixed_order():
    payload = bsf.build([{"semester": "x", "courses": [_section("ENG", "9", "OC, ETH, HAP, WI")]}])
    assert payload["focus_by_code"]["ENG 9"] == ["W", "H", "E", "O"]


def test_ee_ece_rename_shares_focus_both_ways():
    # Spring 2024 said EE 496; later terms say ECE. Same course, so both codes get it.
    payload = bsf.build([{"semester": "x", "courses": [_section("EE", "496", "OC, WI"), _section("ECE", "495", "ETH")]}])
    assert payload["focus_by_code"]["EE 496"] == ["W", "O"]
    assert payload["focus_by_code"]["ECE 496"] == ["W", "O"]
    assert payload["focus_by_code"]["ECE 495"] == ["E"]
    assert payload["focus_by_code"]["EE 495"] == ["E"]


def test_rename_aliases_leaves_other_subjects_alone():
    assert bsf.rename_aliases("ENG 200") == ["ENG 200"]
    assert bsf.rename_aliases("EE 496") == ["EE 496", "ECE 496"]
    assert bsf.rename_aliases("ECE 496") == ["EE 496", "ECE 496"]


def test_embed_writes_focus_onto_nodes_and_is_idempotent(tmp_path, monkeypatch):
    import json
    monkeypatch.setattr(bsf, "ROOT", tmp_path)
    graph = tmp_path / "prereq_graph.json"
    graph.write_text(json.dumps({"nodes": {
        "ENG 200": {"gened": []}, "ACC 200": {"gened": [], "focus": ["W"]},  # stale focus gets dropped
    }, "edges": []}), encoding="utf-8")
    bsf.embed({"ENG 200": ["W"]}, [graph])
    first = graph.read_text(encoding="utf-8")
    nodes = json.loads(first)["nodes"]
    assert nodes["ENG 200"]["focus"] == ["W"]
    assert "focus" not in nodes["ACC 200"]
    bsf.embed({"ENG 200": ["W"]}, [graph])
    assert graph.read_text(encoding="utf-8") == first
