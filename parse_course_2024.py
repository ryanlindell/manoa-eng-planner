"""HTML -> course dict, for the 2024-25 catalog (manoa.hawaii.edu/catalog-2024-25/),
a completely different site from the Acalog system parse_course.py targets --
WordPress, plain-fetchable (no WAF), one <div class="post-... courses"> per
course, with the whole description/prereq/restrictions/etc. run together as
one prose paragraph instead of Acalog's separate <strong>Field:</strong>
labels. See scripts/capture_2024_catalog.py for the fetch side.

Schema note: this can't cleanly separate "restrictions" from the rest of the
description the way parse_course.py does (Acalog gives that its own labeled
field; here it's just another sentence in the same paragraph, with no
reliable delimiter). restrictions_raw is therefore best-effort here -- some
restriction sentences stay embedded in `description` rather than risk
mis-splitting a sentence that isn't actually a restriction. prereq_raw and
coreq_raw are the fields that matter for the prereq graph, and those *do*
have a reliable "Pre:" / "Co-requisite:" marker to split on -- see
split_prose below.
"""

import html as html_module
import re

GENED_CODES = {"FW", "FQ", "FGA", "FGB", "FGC", "DA", "DB", "DH", "DL", "DP", "DS", "DY"}

# Bounds each course to its own chunk using *only* this fixed, confirmed-
# universal boundary marker (verified against all 7066 posts across every
# fetched page: exactly this literal shape, every time) -- deliberately not
# matching any of a post's own inner structure here. A single whole-file
# regex that tried to match heading/dtags/body all in one pattern used to
# do that, and it was a real, severe bug: some posts' <p> tag carries a
# class attribute (Gutenberg block-editor markup, e.g.
# <p class="wp-block-paragraph">) that a literal "<p>" doesn't match, and
# when that broke the pattern mid-post, regex backtracking didn't just fail
# that one post -- it silently extended across the post boundary and
# matched a *later* post's heading/dtags/body instead, misattributing that
# real content onto the earlier, broken post's id (confirmed: CEE 220's
# post ended up carrying CEE 270's actual course data). Splitting into
# independently-bounded chunks first makes that whole failure mode
# impossible -- the worst a per-post markup quirk can now do is fail
# *that* post (see parse_course_block below), never a neighboring one.
POST_BOUNDARY_RE = re.compile(r'<div id="post-(\d+)" class="([^"]*)">')
COURSE_INNER_RE = re.compile(
    r'<h2 class="entry-title"><a href="([^"]+)"[^>]*>([^<]+)</a></h2>\s*'
    r'<div class="dtags">(.*?)</div>\s*</div>\s*'
    # The <p> is optional: a real, if unusual, slice of courses (mostly
    # graduate seminars) have a genuinely empty entry-content on the site
    # itself -- title and credits exist, there's just no description
    # written. Confirmed by hand (GEO 750/752/757/758/761/762/764, PSY
    # 701/702/722, OCN 770, HRM 200, CEE 483, ANAT 499, STE 550, COM 500):
    # entry-content goes straight to the course-tags div with nothing
    # between, not a markup break.
    r'<div class="entry-content">\s*(?:<p[^>]*>(.*?)</p>)?',
    re.S,
)


def split_into_post_blocks(html: str) -> list[tuple[str, str, str]]:
    """(post_id, classes, block_html) for every course post on the page,
    block_html running from that post's own boundary marker up to (not
    including) the next one -- or end of page for the last post."""
    boundaries = list(POST_BOUNDARY_RE.finditer(html))
    blocks = []
    for i, m in enumerate(boundaries):
        end = boundaries[i + 1].start() if i + 1 < len(boundaries) else len(html)
        blocks.append((m.group(1), m.group(2), html[m.start():end]))
    return blocks
TAG_ANCHOR_RE = re.compile(r'>([A-Z]{1,4})<')
# The closing ")" on the credits value is missing on a real, recurring slice
# of courses on this site (confirmed by hand: CHEM 131, KRS 113, COMG 251,
# COMG 321, MICR 351L, ... -- a source-side markup defect, not something
# specific to one department), so it's optional here rather than a hard
# failure losing otherwise-good data.
# The optional "/SECOND" group handles a genuine joint subject code, e.g.
# "CINE/ACM 210" -- confirmed by hand this is how the *entire* Cinematic and
# Digital Arts department was coded in the 2023-24 catalog (retired to a
# plain "CINE" subject by 2024-25, the same rename pattern as EE -> ECE).
# Only the primary (first) subject is kept as this course's `subject`/`code`
# below; the second is folded into crosslisted_raw instead of joined into
# `subject` itself, since the rest of the pipeline (own_subject fallback
# resolution in parse_prereq.py, "is this an X course" checks) assumes a
# single bare subject code.
HEADING_RE = re.compile(r"^([A-Z]{2,6})(?:/([A-Z]{2,6}))?\s+(\d+)([A-Za-z]*)\s+(.*?)\s*\(([^()]*?)\)?\s*$")
LEC_LAB_RE = re.compile(r"^\((\d+(?:\s*-\s*\d+)?\s*Lec[^)]*)\)\s*")
CROSSLISTED_RE = re.compile(r"\(Cross-?[- ]?listed as ([^)]+)\)", re.I)
OFFERED_RE = re.compile(r"\((Fall|Spring|Summer) only\)", re.I)
# Scheduling metadata ("this alternates years"), not part of the actual
# requirement -- but unlike OFFERED_RE's target, this one often lands
# *inside* the captured Pre:/Co-requisite: tail (it trails the actual
# course list within that same sentence), so it needs its own strip after
# those are pulled out rather than a single upfront pass over the whole body.
ALT_YEARS_RE = re.compile(r"\.?\s*\(Alt\.?\s*(?:even|odd)?\s*years?(?::\s*\w+)?\)\s*$", re.I)
COREQ_RE = re.compile(r"\bCo-?requisites?:\s*(.+?)\s*$", re.S)
PRE_RE = re.compile(r"(?:^|(?<=[.\s]))Pre(?:-?requisites?)?:\s*(.+)$", re.S)
RECOMMENDED_RE = re.compile(r"\bRecommended:\s*(.+?)\s*$", re.S)
REPEATABLE_RE = re.compile(r"(Repeatable[^.]*\.)", re.I)
GRADE_OPTION_RE = re.compile(r"\b(A-F only|CR/NC only|CR/NC or A-F(?: option)?)\.", re.I)
# Explicitly labeled "Pre:"/"Co-requisite:" text always goes through
# parse_prereq.py unchanged. These two don't carry a label at all -- a bare
# "Senior standing or higher." or "Consent." sentence *is* the entire
# prerequisite, just phrased without the word "Pre:" -- and parse_prereq.py's
# grammar already understands both (STANDING/CONSENT tokens), so routing them
# there (only when no labeled "Pre:" was found at all) gets a real parse
# instead of leaving a plain-English sentence stuck in the description.
IMPLICIT_PREREQ_RE = re.compile(
    r"^((?:Freshman|Sophomore|Junior|Senior|Graduate|Undergraduate)\s+standing"
    r"(?:\s+or\s+higher)?|(?:Requires\s+)?(?:departmental|instructor|faculty|program|chair|department)?"
    r"\s*(?:consent|permission|approval))\.?$",
    re.I,
)
# "Majors only" restrictions are the opposite case: common and mechanically
# regular (a short, self-contained sentence naming who may enroll), but
# parse_prereq.py's grammar has no MAJOR_RESTRICTION token at all (the
# {"type": "major_restriction", ...} leaf in its own docstring is
# aspirational, never actually produced) -- so these go to restrictions_raw
# as plain extracted text, the same "kept separate, never tree-parsed" role
# restrictions_raw already has for the Acalog-sourced catalog years.
MAJORS_ONLY_RE = re.compile(
    r"^((?:[A-Z][\w./]*(?:[,&]|,?\s+and)\s*)*[A-Z][\w./]*\s+majors?\s+only"
    r"|(?:For|Intended (?:primarily )?for)\s+[\w\s,]+?\s+majors?"
    r"|No credit for [\w\s,]+?\s+majors?)\.?$",
    re.I,
)


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


def split_prose(body: str) -> dict:
    """Pulls the reliably-delimited fields (Pre:, Co-requisite:, cross-listed,
    offered-semester, repeatable, grade option) out of one prose paragraph,
    in that priority order (each strips its match off the *end* of what's
    left before the next one looks) -- everything left over is description."""
    text = body
    out = {"coreq_raw": None, "prereq_raw": None, "recommended_raw": None, "crosslisted_raw": None,
           "repeatable_raw": None, "grade_option_raw": None, "credits_format_raw": None, "restrictions_raw": None}

    lec_lab = LEC_LAB_RE.match(text)
    if lec_lab:
        out["credits_format_raw"] = lec_lab.group(1).strip()
        text = text[lec_lab.end():]

    m = CROSSLISTED_RE.search(text)
    if m:
        out["crosslisted_raw"] = strip_tags(m.group(1))
        text = (text[:m.start()] + text[m.end():]).strip()

    m = OFFERED_RE.search(text)
    if m:
        text = (text[:m.start()] + text[m.end():]).strip()

    # Co-requisite is always its own trailing sentence, after Pre: if any --
    # pull it first so PRE_RE's "rest of the string" capture doesn't swallow it.
    m = COREQ_RE.search(text)
    if m:
        out["coreq_raw"] = ALT_YEARS_RE.sub("", m.group(1)).strip().rstrip(".")
        text = text[:m.start()].strip()

    m = PRE_RE.search(text)
    if m:
        out["prereq_raw"] = ALT_YEARS_RE.sub("", m.group(1)).strip().rstrip(".")
        text = text[:m.start()].strip()

    m = RECOMMENDED_RE.search(text)
    if m:
        out["recommended_raw"] = m.group(1).strip().rstrip(".")
        text = text[:m.start()].strip()

    m = REPEATABLE_RE.search(text)
    if m:
        out["repeatable_raw"] = m.group(1).strip().rstrip(".")
        text = (text[:m.start()] + text[m.end():]).strip()

    m = GRADE_OPTION_RE.search(text)
    if m:
        out["grade_option_raw"] = m.group(1).strip()
        text = (text[:m.start()] + text[m.end():]).strip()

    # Whatever's left is sentence-split so the two remaining patterns (a bare
    # standing/consent sentence, several possible "majors only" sentences)
    # can be matched and pulled per-sentence rather than trying to regex the
    # whole remaining paragraph at once -- both patterns are only reliable
    # when they're a *whole* sentence on their own, not a fragment of a
    # longer one.
    sentences = re.split(r"(?<=[.])\s+", text)
    kept = []
    restrictions = []
    for sent in sentences:
        s = sent.strip()
        if not s:
            continue
        if out["prereq_raw"] is None and IMPLICIT_PREREQ_RE.match(s):
            out["prereq_raw"] = s.rstrip(".")
            continue
        if MAJORS_ONLY_RE.match(s):
            restrictions.append(s if s.endswith(".") else s + ".")
            continue
        kept.append(s)
    out["restrictions_raw"] = " ".join(restrictions) if restrictions else None

    out["description"] = re.sub(r"\s+", " ", " ".join(kept)).strip()
    return out


def _failed_block(post_id: str, raw_heading: str | None, snippet: str) -> dict:
    return {"parse_status": "failed_heading", "code": None, "post_id": post_id,
            "raw_heading": raw_heading, "raw_block_snippet": snippet[:300]}


def parse_course_block(post_id: str, classes: str, block_html: str) -> dict:
    inner = COURSE_INNER_RE.search(block_html)
    if not inner:
        # This post's own inner structure didn't match at all (some markup
        # variant not yet seen) -- since block_html is already bounded to
        # just this post (see split_into_post_blocks), that's *all* this
        # can affect; it can't consume a neighboring post's content the way
        # the old whole-file regex did.
        return _failed_block(post_id, None, strip_tags(block_html))
    url, heading_raw, dtags_html, body_html = inner.groups()

    heading = strip_tags(heading_raw)
    m = HEADING_RE.match(heading)
    if not m:
        return _failed_block(post_id, heading, heading)
    subject, dual_subject, number, alpha_suffix, title, credits_raw = m.groups()
    alpha_suffix = alpha_suffix or None
    credits_raw = credits_raw.strip()
    is_alpha_parent = title.strip().lower().startswith("(alpha)")
    credits_min, credits_max = parse_credits(credits_raw)

    body = strip_tags(body_html) if body_html else ""
    fields = split_prose(body)
    if dual_subject:
        dual_code = f"{dual_subject} {number}{alpha_suffix or ''}"
        fields["crosslisted_raw"] = (
            f"{fields['crosslisted_raw']}; {dual_code}" if fields["crosslisted_raw"] else dual_code
        )

    # gened tags come from the "gened-tags-<code>" classes on the post div
    # (confirmed against the .dtags anchor text too, which carries the same
    # codes -- classes are used since they're already tokenized).
    gened = sorted({
        tok.split("-")[-1].upper() for tok in classes.split() if tok.startswith("gened-tags-")
    } & GENED_CODES)
    # .dtags may carry codes the class list doesn't cleanly tokenize (a
    # multi-code class like gened-tags-dp-dy would only yield "DY" above) --
    # fall back to reading the tag anchors' own text too.
    for tag in TAG_ANCHOR_RE.findall(dtags_html):
        if tag in GENED_CODES:
            gened.append(tag)
    gened = sorted(set(gened))

    return {
        "parse_status": "ok",
        "code": f"{subject} {number}{alpha_suffix or ''}",
        "subject": subject,
        "number": number,
        "alpha_suffix": alpha_suffix,
        "title": title.strip(),
        "is_alpha_parent": is_alpha_parent,
        "description": fields["description"],
        "credits_raw": credits_raw,
        "credits_min": credits_min,
        "credits_max": credits_max,
        "credits_format_raw": fields["credits_format_raw"],
        "gened": gened,
        "focus": None,
        "prereq_raw": fields["prereq_raw"],
        "coreq_raw": fields["coreq_raw"],
        # Best-effort, not exhaustive -- only the mechanically regular
        # "X, Y majors only." / "For non-science majors." shapes are pulled
        # out (see MAJORS_ONLY_RE); any restriction phrased less
        # predictably stays embedded in `description` rather than risk
        # mis-splitting a sentence that isn't actually a restriction.
        "restrictions_raw": fields["restrictions_raw"],
        "crosslisted_raw": fields["crosslisted_raw"],
        "repeatable_raw": fields["repeatable_raw"],
        "grade_option_raw": fields["grade_option_raw"],
        "other_notes": {"Recommended": fields["recommended_raw"]} if fields["recommended_raw"] else None,
        "coid": None,
        "source_url": url,
        "post_id": post_id,
    }


def parse_subject_page(html: str) -> list[dict]:
    courses = []
    for post_id, classes, block_html in split_into_post_blocks(html):
        courses.append(parse_course_block(post_id, classes, block_html))
    return courses
