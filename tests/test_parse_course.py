import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import parse_course

ROOT = Path(__file__).resolve().parent.parent
PAGES_DIR = ROOT / "pages"
GOLDEN = json.loads((ROOT / "tests" / "golden.json").read_text(encoding="utf-8"))


def _page_html(subject_file):
    path = PAGES_DIR / f"{subject_file}.html"
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _courses_by_code(subject_file):
    html = _page_html(subject_file)
    if html is None:
        return None
    return {c["code"]: c for c in parse_course.parse_subject_page(html)}


@pytest.mark.parametrize("entry", GOLDEN["courses"], ids=lambda e: e["code"])
def test_golden_course(entry):
    html = _page_html(entry["subject_file"])
    if html is None:
        pytest.skip(f"pages/{entry['subject_file']}.html not captured yet")

    by_code = _courses_by_code(entry["subject_file"])
    course = by_code.get(entry["code"])
    assert course is not None, f"{entry['code']} not found in {entry['subject_file']}.html"

    for field, expected in entry["expect"].items():
        actual = course.get(field)
        assert actual == expected, (
            f"{entry['code']}.{field}: expected {expected!r}, got {actual!r}"
        )


@pytest.mark.parametrize("subject_file", sorted(p.stem for p in PAGES_DIR.glob("*.html")) if PAGES_DIR.exists() else [])
def test_every_course_block_parses(subject_file):
    """No course silently dropped: one parsed course per <h3> heading in the page."""
    html = (PAGES_DIR / f"{subject_file}.html").read_text(encoding="utf-8")
    h3_count = len(re.findall(r"<h3>", html))
    courses = parse_course.parse_subject_page(html)
    assert len(courses) == h3_count, (
        f"{subject_file}: {h3_count} <h3> tags but only {len(courses)} courses parsed"
    )


@pytest.mark.parametrize("subject_file", sorted(p.stem for p in PAGES_DIR.glob("*.html")) if PAGES_DIR.exists() else [])
def test_no_empty_required_fields(subject_file):
    html = (PAGES_DIR / f"{subject_file}.html").read_text(encoding="utf-8")
    for c in parse_course.parse_subject_page(html):
        # Description can legitimately be empty (e.g. some directed-reading/
        # independent-study courses have no prose at all in the source, only
        # Credits + Repeatable/Restrictions) -- only subject/number/title are
        # guaranteed present.
        assert c["subject"] and c["number"], f"missing subject/number: {c}"
        assert c["title"], f"missing title for {c['code']}"
