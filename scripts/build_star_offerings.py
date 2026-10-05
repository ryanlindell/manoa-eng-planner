"""Work out when each course is offered, and how big and how full it gets, from STAR.

Reads every STAR term capture in data_star/ (see scripts/private/star_pull_terms.js, local only; the
same captures build_star_focus.py reads) and collapses the per-section rows into,
per course code and term: how many sections ran, total seats (capacity), and how
many of those seats were taken (capacity minus open seats at capture time).

What the seat numbers mean depends on *when* the term was captured -- a capture
is a snapshot, not a history:
  * a term whose add period had closed when it was captured (registration over,
    the drop-without-a-W deadline passed) has effectively final enrollment. Every
    term captured so far, Spring 2024 through Fall 2026, is like this.
  * a term captured while registration is still open (e.g. next semester, pulled
    as soon as STAR lists it) is "live" -- its open-seat count is only as of the
    capture date and will keep moving.
A term is called final once at least FINAL_SHARE of its sections report the add
period closed. Not 100%: even long-finished terms keep a few late-start / part-
of-term sections flagged open (~4-6% of them), and that shouldn't make a whole
term look live.

Sections with zero capacity are skipped -- they're cancelled or placeholder
sections, and counting them would turn "cancelled" into "offered".

Department renames are the same course: EE became ECE in Fall 2024 (see
build_star_focus.py), so each term's numbers are recorded under both prefixes --
older catalog years' graphs use EE codes, newer ones ECE.

Deliberately left out: instructors, meeting times, rooms -- counts only.

Output (derived, no student data -- data_star/ itself stays gitignored):
  * visualizer/data/star_offerings.json -- per course per term counts. The
    course graph fetches it once and works out each course's offering pattern
    ("Fall only", ...) from it.
  * visualizer/data/star_sections.json -- one compact row per section (seats,
    taken, modality, Gen-ed/Focus attributes, meeting days/times, credits,
    building, a few flags), for the STAR analyzer tab of analysis.html. See
    build_analysis().

Usage:
  python scripts/build_star_offerings.py
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_star_focus import STAR_DIR, course_code, iter_term_sections, rename_aliases  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "visualizer" / "data" / "star_offerings.json"
FINAL_SHARE = 0.9
SEASONS = {"10": "Fall", "30": "Spring", "40": "Summer"}  # Banner term code suffix


def term_name(key):
    """'202710' -> 'Fall 2026'. Banner keys name the *academic* year's end: Fall 2026 is 2027-10,
    while Spring/Summer 2026 are 2026-30/40."""
    year, suffix = int(key[:4]), key[4:]
    season = SEASONS.get(suffix, "Term " + suffix)
    return f"{season} {year - 1 if suffix == '10' else year}"


def as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def build(docs):
    """docs: iterable of parsed capture files -> the star_offerings.json payload."""
    # code -> term -> [sections, capacity, taken]
    by_code = {}
    terms = {}
    for doc in docs:
        captured = doc.get("captured")
        for term, section in iter_term_sections(doc):
            # The flat capture shape stores its semester as {"name", "key"}, which
            # iter_term_sections() hands back stringified -- take the section's own key.
            if not term.isdigit():
                term = str((section.get("semester") or {}).get("key", term))
            info = terms.setdefault(term, {"key": term, "name": term_name(term), "captured": captured,
                                           "sections": 0, "closed": 0})
            info["sections"] += 1
            info["closed"] += bool(section.get("addPeriodClosed"))
            capacity = as_int(section.get("maxEnrollment"))
            if capacity <= 0:
                continue
            taken = max(0, capacity - max(0, as_int(section.get("availableSeats"))))
            for code in rename_aliases(course_code(section)):
                row = by_code.setdefault(code, {}).setdefault(term, [0, 0, 0])
                row[0] += 1
                row[1] += capacity
                row[2] += taken
    term_list = []
    for key in sorted(terms):
        t = terms[key]
        term_list.append({
            "key": key, "name": t["name"], "season": SEASONS.get(key[4:], ""),
            "captured": (t["captured"] or "")[:10],
            "status": "final" if t["closed"] >= FINAL_SHARE * t["sections"] else "live",
        })
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "STAR class availability (registration2/classes), Manoa",
        "note": ("offerings[code][term] = [sections, seats, seats taken]. Taken = capacity minus open "
                 "seats when captured: final for a term captured after its add period closed, a "
                 "snapshot for a 'live' one. Zero-capacity (cancelled) sections are skipped."),
        "terms": term_list,
        "offerings": {code: dict(sorted(rows.items())) for code, rows in sorted(by_code.items())},
    }


# ---------- section-level dataset for the STAR analyzer (analysis.html) ----------
# One compact row per (non-cancelled) section, so the analyzer can slice by
# anything -- subject, level, Gen-ed/Focus, modality, meeting time -- without
# this script having to guess every aggregation up front. Still no instructors
# and no room numbers: only the building, for the "where" chart.
ANALYSIS_OUT = ROOT / "visualizer" / "data" / "star_sections.json"
MODALITIES = ["In person", "Online", "Hybrid"]
# Bit order of a row's attribute mask. Gen-ed tags first, then the four Focus
# attributes (WI/HAP/ETH/OC = W/H/E/O Focus).
ATTRS = ["FW", "FQ", "FGA", "FGB", "FGC", "DA", "DB", "DH", "DL", "DP", "DS", "DY", "WI", "HAP", "ETH", "OC"]
FLAG_HONORS, FLAG_INSTRUCTOR_OK, FLAG_DEPT_OK, FLAG_MAJORS_ONLY, FLAG_PART_TERM = 1, 2, 4, 8, 16
ROW_COLUMNS = ["term", "code", "seats", "taken", "modality", "attrs", "meetings", "credits", "flags", "building"]


def modality(section):
    kind = (section.get("instructionalType") or "").lower()
    if "online" in kind and "hybrid" not in kind:
        return 1
    if "hybrid" in kind:
        return 2
    return 0


def attr_mask(attributes):
    mask = 0
    for attr in (attributes or "").split(","):
        attr = attr.strip()
        if attr in ATTRS:
            mask |= 1 << ATTRS.index(attr)
    return mask


def clock(text):
    """'1:30 PM' -> '1330'; None/garbage -> None."""
    try:
        hm, ampm = text.strip().split(" ")
        h, m = (int(x) for x in hm.split(":"))
    except (AttributeError, ValueError):
        return None
    if ampm.upper() == "PM" and h != 12:
        h += 12
    if ampm.upper() == "AM" and h == 12:
        h = 0
    return f"{h:02d}{m:02d}"


def meetings(section):
    """Scheduled meetings as 'TR 1330-1445|R 0730-1015' (TBA / online-async ones dropped)."""
    out = []
    for m in section.get("dayTimeLocations") or []:
        days = (m.get("days") or "").strip()
        start, end = clock(m.get("startTime")), clock(m.get("endTime"))
        if not days or days == "TBA" or not start or not end:
            continue
        item = f"{days} {start}-{end}"
        if item not in out:
            out.append(item)
    return "|".join(out)


def building(section):
    """'UHM POST 214' -> 'POST'; online / TBA / off-campus -> ''."""
    for m in section.get("dayTimeLocations") or []:
        parts = (m.get("location") or "").split()
        if len(parts) >= 2 and parts[0] == "UHM":
            return parts[1]
    return ""


def flags(section):
    f = 0
    if section.get("isHonors"):
        f |= FLAG_HONORS
    approval = section.get("specialApproval") or ""
    if approval.startswith("Instructor"):
        f |= FLAG_INSTRUCTOR_OK
    elif approval:
        f |= FLAG_DEPT_OK
    if "Include Majors" in (section.get("restrictions") or ""):
        f |= FLAG_MAJORS_ONLY
    # The full-term code was "1" through Fall 2025 and "MAN" from Spring 2026 on.
    if (section.get("partOfTermCode") or "MAN") not in ("MAN", "1"):
        f |= FLAG_PART_TERM
    return f


def credits(section):
    value = str((section.get("credits") or {}).get("value", "")).strip()
    try:
        return int(value)
    except ValueError:
        return value  # a range like "1-6" stays as printed


def canonical(code):
    """Old prefixes fold into the new one, so a course's trend line doesn't break at a rename."""
    return rename_aliases(code)[-1]


def build_analysis(docs, terms):
    """docs + build()'s term list -> the star_sections.json payload."""
    term_index = {t["key"]: i for i, t in enumerate(terms)}
    codes, titles, buildings, rows = {}, {}, {"": 0}, []
    for doc in docs:
        for term, section in iter_term_sections(doc):
            if not term.isdigit():
                term = str((section.get("semester") or {}).get("key", term))
            capacity = as_int(section.get("maxEnrollment"))
            if capacity <= 0 or term not in term_index:
                continue
            code = canonical(course_code(section))
            # Titles change now and then; keep the newest term's.
            prev = titles.get(code)
            if prev is None or term >= prev[0]:
                titles[code] = (term, (section.get("title") or "").strip())
            codes.setdefault(code, None)
            b = building(section)
            buildings.setdefault(b, len(buildings))
            taken = max(0, capacity - max(0, as_int(section.get("availableSeats"))))
            rows.append([term_index[term], code, capacity, taken, modality(section), attr_mask(section.get("attributes")),
                         meetings(section), credits(section), flags(section), buildings[b]])
    code_list = sorted(codes)
    code_index = {c: i for i, c in enumerate(code_list)}
    for row in rows:
        row[1] = code_index[row[1]]
    rows.sort(key=lambda r: (r[0], r[1]))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "STAR class availability (registration2/classes), Manoa",
        "note": ("One row per section (cancelled zero-seat sections skipped); see 'columns'. code indexes "
                 "'codes'/'titles', term indexes 'terms', building indexes 'buildings', modality indexes "
                 "'modalities'; attrs is a bitmask over 'attrs'; flags bits: 1 honors, 2 instructor approval, "
                 "4 department approval, 8 majors-only, 16 part-of-term session. EE codes are folded into ECE."),
        "columns": ROW_COLUMNS,
        "terms": terms,
        "modalities": MODALITIES,
        "attrs": ATTRS,
        "buildings": sorted(buildings, key=buildings.get),
        "codes": code_list,
        "titles": [titles[c][1] for c in code_list],
        "rows": rows,
    }


def main():
    files = sorted(p for p in STAR_DIR.glob("*.json") if p.stem.isdigit() and len(p.stem) == 6)
    if not files:
        sys.exit(f"no term captures (e.g. 202710.json) found in {STAR_DIR}")
    docs = [json.loads(p.read_text(encoding="utf-8")) for p in files]
    payload = build(docs)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    for t in payload["terms"]:
        print(f"  {t['key']} {t['name']:12} captured {t['captured']}  {t['status']}")
    print(f"{len(payload['offerings'])} course codes, {OUT.stat().st_size // 1024} KB -> {OUT.relative_to(ROOT)}")
    analysis = build_analysis(docs, payload["terms"])
    ANALYSIS_OUT.write_text(json.dumps(analysis, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(analysis['rows'])} sections, {ANALYSIS_OUT.stat().st_size // 1024} KB -> {ANALYSIS_OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
