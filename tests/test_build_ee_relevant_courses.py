import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_ee_relevant_courses as bec  # noqa: E402


def _sheet(**overrides):
    sheet = {
        "year": 2099,
        "gened_codes": {"FW": "Foundations: Written Communication"},
        "tracks": {
            "EP": {
                "name": "Electro-Physics (EP) Track",
                "group1_required_credits": 11,
                "group2_required_credits": 6,
                "areas": {
                    "Circuits": {"group1": ["ECE 326"], "group2": ["ECE 422"]},
                    "Devices": {"group1": ["ECE 327"], "group2": []},
                },
            },
            "SDS": {
                "name": "Systems & Data Sciences (SDS) Track",
                "group1_required_credits": 12,
                "group2_required_credits": 6,
                "areas": {
                    "Controls": {"group1": ["ECE 351"], "group2": ["ECE 422"]},
                },
            },
        },
        "technical_electives": {"additional_eligible": ["ECE 205"], "case_by_case": []},
        "engineering_breadth": {"named_eligible": ["CEE 270"]},
    }
    sheet.update(overrides)
    return sheet


def test_track_groups_shape_and_passthrough():
    groups = bec.checksheet_track_groups(_sheet())
    assert set(groups) == {"EP", "SDS"}
    assert groups["EP"]["name"] == "Electro-Physics (EP) Track"
    assert groups["EP"]["group1_required_credits"] == 11
    assert groups["EP"]["group2_required_credits"] == 6
    assert groups["EP"]["group1"] == ["ECE 326", "ECE 327"]
    assert groups["EP"]["group2"] == ["ECE 422"]
    assert groups["SDS"]["group1"] == ["ECE 351"]


def test_course_shared_across_tracks_appears_in_both():
    groups = bec.checksheet_track_groups(_sheet())
    # ECE 422 is a Group II course in both EP's Circuits area and SDS's
    # Controls area -- it must show up in both tracks' own list, not get
    # deduped away by the flattening checksheet_categories() does.
    assert "ECE 422" in groups["EP"]["group2"]
    assert "ECE 422" in groups["SDS"]["group2"]


def _write_courses_jsonl(path, codes):
    with path.open("w", encoding="utf-8") as f:
        for code in codes:
            subject, number = code.split(" ", 1)
            f.write(json.dumps({
                "parse_status": "ok", "is_alpha_parent": False,
                "code": code, "subject": subject, "number": number,
                "title": f"Title {code}", "credits_min": 3.0, "gened": [],
            }) + "\n")


def test_missing_codes_stripped_from_track_groups(tmp_path):
    # ECE 327 (EP Group I) is never in the course catalog -- build() should
    # drop it from "relevant"/"category_by_code" *and* from track_groups,
    # the same way it already does for "categories". build() requires its
    # checksheet path to live under ROOT (for the "source_checksheet"
    # relative path it writes), so the fake sheet goes in a scratch file
    # under checksheets/data rather than pytest's tmp_path -- cleaned up in
    # the finally block below.
    sheet_path = ROOT / "checksheets" / "data" / "_test_scratch_missing_codes.json"
    try:
        sheet_path.write_text(json.dumps(_sheet()), encoding="utf-8")
        courses_path = tmp_path / "courses.jsonl"
        _write_courses_jsonl(courses_path, ["ECE 326", "ECE 351", "ECE 422", "ECE 205", "CEE 270"])
        out_path = tmp_path / "out.json"

        bec.build(sheet_path, courses_path, out_path, subject_prefix="ECE")

        out = json.loads(out_path.read_text(encoding="utf-8"))
        assert "ECE 327" not in out["track_groups"]["EP"]["group1"]
        assert "ECE 327" not in out["courses"]
        assert "ECE 326" in out["track_groups"]["EP"]["group1"]
    finally:
        sheet_path.unlink(missing_ok=True)


def test_fixed_groups_cover_all_codes_with_three_or_alternatives(tmp_path):
    # Every REAL_CODES_CATEGORY code present in the catalog should land in
    # exactly one fixed_groups entry -- a lone-code group for most of them,
    # and the three real either/or alternatives (see FIXED_OR_GROUPS in
    # build_ece_fixture.py) grouped together instead of counted as two/three
    # separate always-required courses.
    sheet_path = ROOT / "checksheets" / "data" / "_test_scratch_fixed_groups.json"
    try:
        sheet_path.write_text(json.dumps(_sheet()), encoding="utf-8")
        courses_path = tmp_path / "courses.jsonl"
        all_fixed = sorted(bec.fixed_codes_for_subject("ECE"))
        _write_courses_jsonl(courses_path, all_fixed + ["ECE 205", "CEE 270"])
        out_path = tmp_path / "out.json"

        bec.build(sheet_path, courses_path, out_path, subject_prefix="ECE")

        out = json.loads(out_path.read_text(encoding="utf-8"))
        groups = out["fixed_groups"]
        assert sum(len(g) for g in groups) == len(all_fixed)
        multi = [g for g in groups if len(g) > 1]
        assert sorted(multi) == sorted(bec.fixed_groups_for_subject("ECE"))
        assert len(groups) == len(all_fixed) - sum(len(g) - 1 for g in multi)
    finally:
        sheet_path.unlink(missing_ok=True)


def test_fixed_group_shrinks_when_one_alternative_is_missing(tmp_path):
    # ECE 110 (one half of the "ECE 160 or ECE 110" slot) isn't in the
    # catalog here -- the group should shrink to just ["ECE 160"], not
    # disappear or keep a dangling reference to a course that was stripped
    # from "courses" as missing.
    sheet_path = ROOT / "checksheets" / "data" / "_test_scratch_partial_group.json"
    try:
        sheet_path.write_text(json.dumps(_sheet()), encoding="utf-8")
        courses_path = tmp_path / "courses.jsonl"
        all_fixed = sorted(bec.fixed_codes_for_subject("ECE") - {"ECE 110"})
        _write_courses_jsonl(courses_path, all_fixed + ["ECE 205", "CEE 270"])
        out_path = tmp_path / "out.json"

        bec.build(sheet_path, courses_path, out_path, subject_prefix="ECE")

        out = json.loads(out_path.read_text(encoding="utf-8"))
        assert ["ECE 160"] in out["fixed_groups"]
        assert ["ECE 160", "ECE 110"] not in out["fixed_groups"]
        assert "ECE 110" not in out["courses"]
    finally:
        sheet_path.unlink(missing_ok=True)


def test_2020_checksheet_values_roundtrip(tmp_path):
    # 2020 is the one year with different ABET/track credit numbers than
    # every other year (see checksheets/data/2020.json's own "note" field)
    # -- confirm build() carries them through unchanged, not silently
    # normalized to the 2021+ values.
    checksheet_path = ROOT / "checksheets" / "data" / "2020.json"
    sheet = json.loads(checksheet_path.read_text(encoding="utf-8"))
    assert sheet["credit_totals"]["abet_math_and_basic_sciences_minimum"] == 32
    assert sheet["credit_totals"]["abet_engineering_topics_minimum"] == 48
    assert sheet["tracks"]["SDS"]["group1_required_credits"] == 11

    courses_path = tmp_path / "courses.jsonl"
    all_codes = bec.checksheet_codes(sheet) | set(bec.fixed_codes_for_subject("EE"))
    _write_courses_jsonl(courses_path, sorted(all_codes))
    out_path = tmp_path / "out.json"

    bec.build(checksheet_path, courses_path, out_path, subject_prefix="EE")

    out = json.loads(out_path.read_text(encoding="utf-8"))
    assert out["track_groups"]["SDS"]["group1_required_credits"] == 11
    assert out["track_groups"]["EP"]["group1_required_credits"] == 11
