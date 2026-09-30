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

- `scripts/graph_2024.py` -- `graph.py`'s own `build()`, pointed at
  `data_2024/` instead of the `CATOID`/`DATA_DIR`-keyed paths its `main()`
  uses by default (this catalog isn't a catoid at all). Writes
  `visualizer/data/prereq_graph_2024.json`, matching the `"2024"` entry in
  `visualizer/app.js`'s `CATALOGS`.

## A severe parsing bug this caught, and how it was found

A user checking the freshly-added catalog in the visualizer flagged three
courses with visibly wrong data: **BIOL 172**'s prereqs looked mislabeled,
**GES 401**'s prereq tree had wrong course codes in it, and **CEE 270**
didn't exist in the graph at all despite clearly being a real course.
Investigating all three surfaced one root cause plus two narrower grammar
gaps:

**The real bug (parse_course_2024.py):** `COURSE_BLOCK_RE` was a single
regex matching a whole course's heading + tags + body in one pass across
the *entire page*. Some courses' `<p>` tag carries a class attribute from
the WordPress block editor (`<p class="wp-block-paragraph">`) that a literal
`"<p>"` in the pattern didn't match. When that broke the pattern mid-post,
regex backtracking didn't just fail that one post -- it silently extended
across the post boundary and completed the match using a *later* post's
heading/tags/body instead, misattributing that later post's real content
onto the earlier, broken post's id. Confirmed directly: `CEE 220`'s post
ended up carrying `CEE 270`'s actual course data, and `CEE 270` itself
simply didn't exist in the output. This affected 60 of 174 subject pages
(128 posts silently missing or misattributed) -- a category of bug where
the symptom (a missing or wrong-looking course) doesn't point at all
clearly to the mechanism (a regex backtracking across an unrelated
post's boundary), which is why it wasn't caught earlier.

**The fix:** split each page into independently-bounded chunks *first*
(`split_into_post_blocks`, using only the post's own fixed, confirmed-
universal boundary marker `<div id="post-N" class="...">` -- verified
against all 7066 posts on the site, no exceptions), then parse each
chunk's inner structure separately. A markup quirk inside one post can
now only ever fail *that* post; it can no longer consume a neighbor's
content. Also made the `<p>` tag's class attribute (any/none) and even
its presence entirely optional -- a further, unrelated slice of courses
(mostly graduate seminars: `GEO 750/752/757/758/761/762/764`,
`PSY 701/702/722`, `OCN 770`, `HRM 200`, `CEE 483`, `ANAT 499`, `STE 550`,
`COM 500`) have a genuinely empty `entry-content` on the site itself --
title and credits exist, there's just no description written -- and used
to fail entirely rather than being recovered with an empty description.

**Two further, narrower issues in `parse_prereq.py` itself** (the grammar
shared by every catalog year, not specific to this source) surfaced once
the extraction itself was correct:

1. `BIOL 172`'s real prereq text is `"CHEM (131, 151, 161, 171, or 181A)
   or concurrent, and BIOL 172L (or concurrent), or consent"` -- a single
   subject prefix scoping over a whole parenthesized list of bare numbers.
   Every Acalog-sourced catalog year spells the subject out per item
   instead ("CHEM 131, CHEM 151, ..."), so the grammar had never needed to
   handle this compact form; it was choking on the "CHEM (" fragment and
   defaulting the bare numbers inside to `BIOL` (this course's own
   subject) instead of `CHEM`. Fixed with a text-level rewrite
   (`_expand_subject_groups`) into the already-correctly-handled
   explicit-subject-per-item form, rather than teaching the tokenizer a
   new construct -- lower risk of disturbing the existing grammar.
2. A bare number's subject fallback defaulted unconditionally to
   `own_subject` (whichever course the whole prereq text belongs to).
   That's right when no other subject has been named ("160 or consent" in
   an ECE course's own text correctly means ECE 160), but wrong the
   moment a *different* subject was just stated explicitly:
   `GES 401`'s "BIOL 172/172L" was becoming `BIOL 172 OR GES 172L`
   instead of `BIOL 172 AND BIOL 172L` (own_subject "GES" leaking into a
   BIOL reference, which also broke the code's own same-subject-lab-pair
   detection, compounding an OR where an AND belonged), and separately
   `CEE 270`'s "MATH 242 or 252A" was silently becoming `CEE 252A` -- a
   real, wrong course reference, not just an unparsed gap. Fixed by
   tracking the most recently stated explicit subject as parser state and
   preferring that over `own_subject` as the fallback.

Both `parse_prereq.py` fixes are shared grammar, so their effect on the
**already-committed** `data/` (2026-27) and `data_catoid2/` (2025-26,
archived) catalogs was checked directly (re-parsing every stored
`prereq_raw`/`coreq_raw` against the fixed grammar and diffing the
result) before touching this catalog's data at all: the subject-group
expansion changed nothing for either (that compact form simply doesn't
appear in Acalog's prose style), and the subject-fallback fix corrected
7 courses in each (`EDEP 612`, `SOC 318`, `SOC 367`, `SOC 435`,
`SOC 446`, `SOC 452`, `SUST 367`) -- notably `EDEP 612` used to list
*itself* as its own prerequisite (`EDEP 604, PSY 610, EDEP 612 (with a
minimum grade...)`, own_subject leaking into a bare "612" that should
have inherited `PSY` from the immediately preceding `PSY 610`), now
correctly `PSY 612`. Re-parsed those two catalogs' `courses.jsonl` in
place with `scripts/reparse_prereqs.py` (no re-scrape needed -- the
grammar changed, not the scraped text) and rebuilt their graphs, rather
than leave a known-wrong prereq live on the already-published catalogs.
Full existing `tests/test_parse_prereq.py` suite still passes (same one
pre-existing, unrelated failure as before either fix).

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

Deduplicated by WordPress post ID when combining -- 81 duplicate posts
skipped across the full scrape. All confirmed genuine, not a scraping
error:

- The site's "Honors" page (`oaa/hon/`) deliberately re-lists honors
  sections that already belong to their real department (e.g. "AMST 150A"
  appears under both `arts-languages-letters/amst/` and `oaa/hon/`) -- a
  real WordPress multi-category membership, most of the 81.
- A few genuine URL-slug aliases for the same category (e.g.
  `jabsom/caam/` and `jabsom/complementary-and-alternative-medicine/` are
  the same department under two different permalinks).

Separately, **6 course codes appear twice even after de-duplication**
(`CINE 322`, `DNCE 240`, `THEA 680`, `NAVL 202`, `TIM 399`, `LWPA 569`) --
checked one by hand (`DNCE 240`, post IDs 3727 and 26654): two genuinely
different WordPress posts, identical title and credits. This looks like an
actual accidental duplicate posting on the university's own site, not a
parsing issue. Negligible at 6/6690 courses; whichever copy is processed
last just wins in the combined output.

## Schema differences from the Acalog-sourced catalogs

- **`restrictions_raw` is best-effort, not exhaustive.** Acalog gives
  restrictions their own labeled field; here it's just another sentence in
  the same paragraph with no universal delimiter. Only the mechanically
  regular "`<CODE, CODE, ...> majors only.`" / "For non-science majors." /
  "No credit for ... majors." shapes are extracted (`MAJORS_ONLY_RE`); a
  restriction phrased less predictably stays embedded in `description`
  rather than risk mis-splitting a sentence that isn't actually one. 627 of
  6690 real courses got a `restrictions_raw` this way.
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
closing paren as optional to recover these.

## Known, permanent parse failures (6 of 6985 course blocks)

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
- 6,985 course blocks seen (81 duplicates skipped) -> 6,979 parsed OK
  (99.9%) -> 6,690 real courses + 289 alpha-parent placeholders
- prereq_raw present on 4,662/6,690 real courses -- clean 3,202 (68.7%),
  partial 1,268 (27.2%), failed 192 (4.1%) -- in line with the 2026-27
  catalog's own baseline
- coreq_raw present on 224/6,690 -- clean 195, partial 27, failed 2
- restrictions_raw extracted on 627/6,690 (best-effort, see above)
- Graph: 6,882 nodes, 5,914 edges, 6 cycles (the same familiar co-listed
  pairs seen in the other two catalog years -- BIOL 171/171L, BIOL
  172/172L, BIOL 301/301L, GEO 400-402/405 -- plus KRS 775/776 and
  ICS 141/241, specific to this year), 198 dangling references

Re-run `python scripts/build_2024.py` any time (idempotent, reads from the
already-fetched `pages_2024_raw/`) followed by `python scripts/graph_2024.py`;
re-run `python scripts/scrape_2024_catalog.py --workers N` first if you need
to refresh the raw pages themselves.
