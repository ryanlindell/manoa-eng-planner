"""HTML -> course dict.

Operates on Playwright-captured listing pages (pages/<PREFIX>.html), i.e. HTML
as a real browser's DOM serializes it -- not the raw server response. That
matters: the live DOM normalizes the site's malformed nesting (stray </h3>
before an opening <h3>) and its own JS rewrites prerequisite links from real
hrefs into tooltip-popup anchors carrying the target coid inside `onclick`
instead of `href`. The regexes below are written against that DOM-normalized
shape, not the raw server markup.
"""

import html as html_module
import re
from dataclasses import dataclass, field

GENED_CODES = {"FW", "FQ", "FGA", "FGB", "FGC", "DA", "DB", "DH", "DL", "DP", "DS", "DY"}

# One <li> per course; Playwright's DOM serialization keeps this clean and
# un-nested (verified against every subject captured so far).
COURSE_BLOCK_RE = re.compile(r'<td class="width"><ul><li>\s*(.*?)</li></ul>', re.S)
HEADING_RE = re.compile(r"<h3>([^<]+)</h3>")
CREDITS_RE = re.compile(r"Credits:\s*([^<]+?)\s*<br>", re.S)
STRONG_FIELD_RE = re.compile(r"<strong>([^<]+?):?</strong>\s*(.*?)(?=<strong>|\Z)", re.S)
CODE_TITLE_RE = re.compile(r"^([A-Z]{1,6})\s+(\d+)([A-Za-z]*)\s*-\s*(.*)$")

# Anchors the site's JS rewrites into tooltip popups: href becomes "#ttNNN",
# and the real coid ends up inside the onclick handler instead.
REF_ANCHOR_RE = re.compile(
    r'<a\s+[^>]*?onclick="[^"]*?coid=(\d+)[^"]*?"[^>]*?aria-label="View course details for '
    r'([A-Z]{1,6}\s+\d+[A-Za-z]*)"',
    re.S,
)

# Fields with a clear, direct schema home. Anything else goes into other_notes
# rather than being silently dropped.
FIELD_MAP = {
    "prerequisites": "prereq_raw",
    "corequisites": "coreq_raw",
    "cross-listed": "crosslisted_raw",
    "repeatable": "repeatable_raw",
    "grade option": "grade_option_raw",
}
RESTRICTION_LABELS = {"major restrictions", "class standing restrictions", "restriction", "restrictions"}


def strip_tags(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment)
    text = html_module.unescape(text)
    text = text.replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def parse_credits(raw: str):
    raw = raw.strip().rstrip(".")
    if not raw:
        return None, None
    if raw.upper() == "V":
        return None, None
    m = re.match(r"^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$", raw)
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.match(r"^(\d+(?:\.\d+)?)$", raw)
    if m:
        v = float(m.group(1))
        return v, v
    return None, None


def extract_ref_coids(html: str) -> dict[str, str]:
    """Map "SUBJ NUM" -> coid for every course referenced as someone's
    prereq/coreq/cross-list anywhere in this page (not the page's own courses)."""
    refs: dict[str, str] = {}
    for coid, code in REF_ANCHOR_RE.findall(html):
        code = " ".join(code.split())
        refs.setdefault(code, coid)
    return refs


def _parse_fields(rest: str) -> dict:
    fields = {}
    other_notes = {}
    for label_raw, value_raw in STRONG_FIELD_RE.findall(rest):
        label = strip_tags(label_raw).lower()
        value = strip_tags(value_raw)
        if not value:
            continue
        if label in RESTRICTION_LABELS:
            prefix = strip_tags(label_raw)
            fields["restrictions_raw"] = (
                fields.get("restrictions_raw", "") + (" " if "restrictions_raw" in fields else "")
                + f"{prefix}: {value}"
            )
        elif label in FIELD_MAP:
            fields[FIELD_MAP[label]] = value
        else:
            other_notes[strip_tags(label_raw)] = value
    if other_notes:
        fields["other_notes"] = other_notes
    return fields


def parse_course_block(block: str) -> dict | None:
    heading_match = HEADING_RE.search(block)
    if not heading_match:
        return None
    heading = strip_tags(heading_match.group(1))
    heading = " ".join(heading.split())

    if " - " not in heading:
        return None
    code_part, title = heading.split(" - ", 1)
    title = title.strip()

    m = CODE_TITLE_RE.match(heading)
    if not m:
        return None
    subject, number, alpha_suffix, title = m.groups()
    alpha_suffix = alpha_suffix or None
    is_alpha_parent = title.strip().lower().startswith("(alpha)")

    credits_match = CREDITS_RE.search(block, heading_match.end())
    credits_raw = strip_tags(credits_match.group(1)) if credits_match else None
    credits_min, credits_max = parse_credits(credits_raw) if credits_raw else (None, None)

    desc_start = credits_match.end() if credits_match else heading_match.end()
    first_strong = re.search(r"<strong>", block[desc_start:])
    desc_end = desc_start + first_strong.start() if first_strong else len(block)
    description = strip_tags(block[desc_start:desc_end])

    fields = _parse_fields(block[desc_end:])

    gened_raw = fields.pop("gened_raw", None)
    gened_field_match = re.search(
        r"<strong>General Education Designation\(s\):?</strong>\s*(.*?)(?=<strong>|\Z)", block[desc_end:], re.S
    )
    gened = []
    if gened_field_match:
        gened_text = strip_tags(gened_field_match.group(1))
        for token in re.split(r"[,\s/]+", gened_text):
            if token in GENED_CODES:
                gened.append(token)

    course = {
        "code": f"{subject} {number}{alpha_suffix or ''}",
        "subject": subject,
        "number": number,
        "alpha_suffix": alpha_suffix,
        "title": title,
        "is_alpha_parent": is_alpha_parent,
        "description": description,
        "credits_raw": credits_raw,
        "credits_min": credits_min,
        "credits_max": credits_max,
        "gened": gened,
        "prereq_raw": fields.get("prereq_raw"),
        "coreq_raw": fields.get("coreq_raw"),
        "restrictions_raw": fields.get("restrictions_raw"),
        "crosslisted_raw": fields.get("crosslisted_raw"),
        "repeatable_raw": fields.get("repeatable_raw"),
        "grade_option_raw": fields.get("grade_option_raw"),
        "other_notes": fields.get("other_notes"),
        "coid": None,
    }
    return course


def parse_subject_page(html: str) -> list[dict]:
    courses = []
    for block_match in COURSE_BLOCK_RE.finditer(html):
        course = parse_course_block(block_match.group(1))
        if course:
            courses.append(course)

    ref_coids = extract_ref_coids(html)
    by_code = {c["code"]: c for c in courses}
    for code, coid in ref_coids.items():
        if code in by_code and by_code[code]["coid"] is None:
            by_code[code]["coid"] = coid

    return courses
