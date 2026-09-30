# 2024-25 catalog: source notes

This catalog year isn't in the same system as every other year in this repo.
`catalog.manoa.hawaii.edu` (the Acalog/CourseLeaf system `capture_playwright.py`,
`fetch.py`, `parse_course.py`, and `config.py`'s `CATOID`/`CATALOGS` are all built
around) only goes back to 2025-26. The 2024-25 catalog lives at a completely
different site, `manoa.hawaii.edu/catalog-2024-25/` -- a plain WordPress
install, not Acalog. None of the WAF-bypass machinery in this repo applies to
it, and neither does its parser, so it has its own small pipeline instead:

- `scripts/scrape_2024_catalog.py` -- fetches every subject's course-listing
  page. Plain `requests`, no Playwright/browser automation needed (confirmed
  by hand: no WAF, no bot challenge, no login wall -- a bare `curl` gets a
  clean 200). Raw HTML is cached to `pages_2024_raw/` (gitignored, same
  treatment as `pages/` and `pages_catoid*/` -- large and fully reproducible).
  `robots.txt` for this host declares `Crawl-delay: 3` (much more lenient
  than `catalog.manoa.hawaii.edu`'s 120) -- `--workers N` runs N threads in
  parallel, each individually respecting that 3s delay between its own
  requests, so the aggregate rate scales with N. Used 10 workers for the
  full run.

- `parse_course_2024.py` -- HTML -> course dict, replacing `parse_course.py`
  for this source. The markup is genuinely different: one
  `<div class="post-... courses">` per course, with description, restrictions,
  prerequisites, etc. all run together as one prose paragraph instead of
  Acalog's separate `<strong>Field:</strong>` labels. Splitting that prose
  apart is most of what this module does -- see its own docstring and
  `split_prose()` for the exact rules and priority order.

- `scripts/build_2024.py` -- combines every fetched page into
  `data_2024/courses.jsonl`, running each course's extracted `prereq_raw`/
  `coreq_raw` through the *same* `parse_prereq.py` grammar every other
  catalog year uses. Same schema/columns as `data/courses.jsonl` except
  `coid` (this source has no coid system; kept null for schema parity) plus
  two additions: `credits_format_raw` (e.g. "3 Lec, 1 3-hr Lab") and
  `post_id` (this source's own stable identifier, used for de-duplication).

## Subject discovery

174 leaf subject pages, found by crawling the site's own
`courses-overview/` page and filtering its ~214 category links down to the
"leaf" ones: a URL counts as a leaf only if no *other* listed URL extends it
as a path prefix (e.g. `.../engineering/` is a parent of
`.../engineering/ece/` and gets excluded; `.../engineering/ece/` has nothing
extending it, so it's kept). Confirmed by hand that this really is a
hierarchy, not independent overlapping listings: a parent category's own
page shows exactly the union of its leaves' courses (Engineering: 337 posts
== CEE 96 + ECE 125 + ME 106 + ENGR 10).

## Duplicate courses (not a bug)

Deduplicated by WordPress post ID when combining -- 78 duplicate posts
skipped across the full scrape. All confirmed genuine, not a scraping
error:

- The site's "Honors" page (`oaa/hon/`) deliberately re-lists honors
  sections that already belong to their real department (e.g. "AMST 150A"
  appears under both `arts-languages-letters/amst/` and `oaa/hon/`) -- a
  real WordPress multi-category membership, most of the 78.
- A few genuine URL-slug aliases for the same category (e.g.
  `jabsom/caam/` and `jabsom/complementary-and-alternative-medicine/` are
  the same department under two different permalinks).

Separately, **5 course codes appear twice even after de-duplication**
(`DNCE 240`, `THEA 680`, `NAVL 202`, `TIM 399`, `LWPA 569`) -- checked one
by hand (`DNCE 240`, post IDs 3727 and 26654): two genuinely different
WordPress posts, identical title and credits. This looks like an actual
accidental duplicate posting on the university's own site, not a
parsing issue. Negligible at 5/6568 courses; whichever copy is processed
last just wins in the combined output.

## Schema differences from the Acalog-sourced catalogs

- **`restrictions_raw` is best-effort, not exhaustive.** Acalog gives
  restrictions their own labeled field; here it's just another sentence in
  the same paragraph with no universal delimiter. Only the mechanically
  regular "`<CODE, CODE, ...> majors only.`" / "For non-science majors." /
  "No credit for ... majors." shapes are extracted (`MAJORS_ONLY_RE`); a
  restriction phrased less predictably stays embedded in `description`
  rather than risk mis-splitting a sentence that isn't actually one. 606 of
  6568 real courses got a `restrictions_raw` this way.
- **A bare, unlabeled standing/consent sentence becomes `prereq_raw`, not a
  restriction.** Some courses state "Senior standing or higher." as their
  *entire* prerequisite, with no "Pre:" label at all. `parse_prereq.py`'s
  grammar already has full support for standing/consent as leaf types (it's
  what handles the labeled "Pre: senior standing" case too), so routing
  these there gets a real parse (`{"type": "standing", "level": "senior",
  "or_higher": true}`, status `clean`) instead of leaving a plain-English
  sentence stuck in the description.
  `major_restriction` -- the other non-course leaf type named in
  `parse_prereq.py`'s own schema docstring -- has no such support (it's
  documented but never actually implemented in the grammar), which is why
  "majors only" text goes to `restrictions_raw` instead of `prereq_raw`:
  feeding it through the grammar would just produce parse failures.
- **New field: `recommended_raw`**, folded into `other_notes` (e.g.
  `{"Recommended": "472 or 474, or consent"}`) -- a labeled "Recommended:"
  clause distinct from a hard "Pre:" prerequisite, which doesn't exist as a
  concept in the other catalog years' schema.
- **New field: `credits_format_raw`** (e.g. "3 Lec, 1 3-hr Lab") -- this
  source states lecture/lab format inline in a way Acalog doesn't
  consistently expose the same way.

## A source-side markup defect, not a parser bug

A real, recurring slice of courses have their title's closing `)` on the
credits value simply missing from the HTML (`CHEM 131 Preparation for
General Chemistry (3`, `KRS 113 Human Physiology and Anatomy (5`, `COMG
251 ... (3`, `COMG 321 ... (3`, `MICR 351L ... (2`, and others) -- confirmed
by hand this isn't isolated to one department. `HEADING_RE` treats the
closing paren as optional to recover these (11 failed headings -> 6 without
it).

## Known, permanent parse failures (6 of 6860 course blocks)

Checked each by hand; none of these are parser bugs:

- **2x `PHIL 100A`** (once from its real department page, once via the
  Honors cross-listing) -- a genuinely incomplete duplicate post on the
  site: title is truncated to "Introduction to Philosophy:" with no
  subtitle and no credits at all. A separate, complete `PHIL 100A
  Introduction to Philosophy: Survey of Problems (3)` post exists and
  parses fine -- this looks like an abandoned duplicate someone forgot to
  finish editing, not data this parser could recover.
- **`HWST 312 Ke Haʻa Lā: Intermediate Hula`** -- no credits value in
  parentheses anywhere in the source at all.
- **`CINE/ACM 318 Classical 2D Full Animation`** -- a genuine dual/joint
  subject code (`CINE/ACM`). Not handled -- storing a slash-joined string in
  `subject` would need the rest of the pipeline (the "is this an ECE
  course" checks, code-format assumptions elsewhere) to expect that shape
  too, and this is the only course on the entire site written this way.
- **`FIL 462 ... (3)1`** -- a stray digit stuck onto the end of the
  heading after a well-formed `(3)`, looks like a footnote marker that
  bled into the title text on the source page.
- **`MBIO 691(Alpha) Seminar in Marine Biology (1)`** -- missing the space
  between the course number and `(Alpha)` that every other alpha-parent
  heading on the site has. Single occurrence; not worth loosening the
  regex for the risk of it mis-parsing something else.

## Final numbers (this build)

- 174/174 subject pages fetched, 0 errors
- 6,860 course blocks seen (78 duplicates skipped) -> 6,854 parsed OK (99.9%)
  -> 6,568 real courses + 286 alpha-parent placeholders
- prereq_raw present on 4,605/6,568 real courses -- clean 3,159 (68.6%),
  partial 1,256 (27.3%), failed 190 (4.1%) -- in line with the 2026-27
  catalog's own baseline (67.5% / 26.1% / 6.4%)
- coreq_raw present on 222/6,568 -- clean 193, partial 27, failed 2
- restrictions_raw extracted on 606/6,568 (best-effort, see above)

Re-run `python scripts/build_2024.py` any time (idempotent, reads from the
already-fetched `pages_2024_raw/`); re-run
`python scripts/scrape_2024_catalog.py --workers N` first if you need to
refresh the raw pages themselves.
