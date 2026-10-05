import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_star_offerings as bso  # noqa: E402


def _section(name, number, cap, avail, closed=True, term="202710"):
    return {"name": name, "number": number, "maxEnrollment": str(cap), "availableSeats": avail,
            "addPeriodClosed": closed, "semester": {"name": "x", "key": term}}


def test_term_name_uses_the_calendar_year():
    assert bso.term_name("202710") == "Fall 2026"
    assert bso.term_name("202630") == "Spring 2026"
    assert bso.term_name("202640") == "Summer 2026"


def test_build_sums_sections_seats_and_taken_per_term():
    docs = [{"captured": "2026-09-30T18:00:00Z", "terms": {"202630": {"courses": [
        _section("ECE", "213", 22, 0, term="202630"), _section("ECE", "213", 22, 4, term="202630"),
    ]}}}]
    payload = bso.build(docs)
    assert payload["offerings"]["ECE 213"] == {"202630": [2, 44, 40]}
    assert payload["terms"] == [{"key": "202630", "name": "Spring 2026", "season": "Spring",
                                 "captured": "2026-09-30", "status": "final"}]


def test_flat_capture_shape_reads_the_term_from_the_section():
    # 202710.json is the flat {semester: {...}, courses} shape.
    doc = {"captured": "2026-09-30", "semester": {"name": "Fall 2026", "key": "202710"},
           "courses": [_section("MATH", "241", 30, 10)]}
    payload = bso.build([doc])
    assert payload["offerings"]["MATH 241"] == {"202710": [1, 30, 20]}
    assert payload["terms"][0]["key"] == "202710"


def test_zero_capacity_sections_are_skipped():
    payload = bso.build([{"semester": "202710", "courses": [_section("ACC", "602", 0, 0), _section("ENG", "100", 20, 0)]}])
    assert "ACC 602" not in payload["offerings"]
    assert payload["offerings"]["ENG 100"] == {"202710": [1, 20, 20]}


def test_term_is_live_until_most_sections_close():
    open_term = [_section("ENG", "100", 20, 5, closed=False)] * 3 + [_section("ENG", "100", 20, 5)]
    assert bso.build([{"semester": "202730", "courses": open_term}])["terms"][0]["status"] == "live"
    # A few late-start sections still open don't make a finished term look live.
    mostly = [_section("ENG", "100", 20, 5)] * 19 + [_section("ENG", "100", 20, 5, closed=False)]
    assert bso.build([{"semester": "202630", "courses": mostly}])["terms"][0]["status"] == "final"


def test_ee_ece_rename_records_both_codes():
    payload = bso.build([{"semester": "202430", "courses": [_section("EE", "496", 40, 10, term="202430")]}])
    assert payload["offerings"]["EE 496"] == payload["offerings"]["ECE 496"] == {"202430": [1, 40, 30]}


def _full(name, number, cap, avail, term, **extra):
    s = _section(name, number, cap, avail, term=term)
    s.update({"title": "T", "instructionalType": "standard", "attributes": "", "credits": {"value": "3"},
              "dayTimeLocations": [], "partOfTermCode": "MAN"})
    s.update(extra)
    return s


def test_analysis_rows_encode_each_section():
    terms = [{"key": "202630"}, {"key": "202710"}]
    sec = _full("ECE", "213", 22, 2, "202710", instructionalType="Hybrid - In Person & Online",
                attributes="DS, WI", specialApproval="Instructor Approval", partOfTermCode="1",
                restrictions=" (Include Majors of  :  Electrical Engineering : )",
                dayTimeLocations=[{"days": "TR ", "startTime": "1:30 PM", "endTime": "2:45 PM", "location": "UHM POST 214"},
                                  {"days": "TBA", "startTime": None, "endTime": None, "location": "ONLINE ASYNC"}])
    payload = bso.build_analysis([{"semester": "202710", "courses": [sec]}], terms)
    row = dict(zip(payload["columns"], payload["rows"][0]))
    assert payload["codes"][row["code"]] == "ECE 213" and row["term"] == 1
    assert (row["seats"], row["taken"], row["credits"]) == (22, 20, 3)
    assert payload["modalities"][row["modality"]] == "Hybrid"
    assert {a for i, a in enumerate(payload["attrs"]) if row["attrs"] >> i & 1} == {"DS", "WI"}
    assert row["meetings"] == "TR 1330-1445"  # the TBA online part is dropped
    assert payload["buildings"][row["building"]] == "POST"
    # Instructor approval + majors-only; part-of-term "1" is the old full-term code, so no part-term flag.
    assert row["flags"] == bso.FLAG_INSTRUCTOR_OK | bso.FLAG_MAJORS_ONLY


def test_analysis_folds_ee_into_ece_and_skips_cancelled():
    terms = [{"key": "202430"}]
    secs = [_full("EE", "496", 40, 10, "202430"), _full("ACC", "602", 0, 0, "202430")]
    payload = bso.build_analysis([{"semester": "202430", "courses": secs}], terms)
    assert payload["codes"] == ["ECE 496"]
    assert len(payload["rows"]) == 1


def test_clock_handles_noon_and_midnight():
    assert bso.clock("12:00 PM") == "1200"
    assert bso.clock("12:30 AM") == "0030"
    assert bso.clock("7:30 AM") == "0730"
    assert bso.clock(None) is None


def test_weird_seat_values_dont_go_negative():
    payload = bso.build([{"semester": "202710", "courses": [_section("ENG", "100", 20, -3), _section("ENG", "200", 20, None)]}])
    assert payload["offerings"]["ENG 100"]["202710"] == [1, 20, 20]
    assert payload["offerings"]["ENG 200"]["202710"] == [1, 20, 20]
