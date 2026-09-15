# Claude Code Prompt: UH Mānoa Course Dataset (Phase 1 of 2)

Paste everything below the line into Claude Code from an empty project folder.

---

## Project

Build a scraper and dataset of every course in the UH Mānoa catalog. This is **phase 1 of 2**. Phase 2 (not now) is a web app modeled on BU's Program Planning tool: a semester-by-semester drag-and-drop degree planner that validates prerequisite ordering and requirement fulfillment. Design phase 1's output as the data layer that app will consume.

## What to produce

A JSON/SQLite dataset where each course has:

- `code` (e.g. `"EE 211"`), `subject` (`"EE"`), `number` (`"211"`), `alpha_suffix` (e.g. `"B"` in `ACC 465B`, else null)
- `title`
- `description` (full text)
- `credits_raw` (e.g. `"3"`, `"1-3"`, `"V"`) and parsed `credits_min` / `credits_max`
- `gened` (array of designation codes found)
- `prereq_raw` (the untouched prose)
- `prereq_tree` (structured, see below) and `prereq_parse_status`
- `coreq_tree`, `restrictions_raw`, `crosslisted_raw`, `repeatable`
- `catoid`, `coid`, `source_url`, `scraped_at`

Plus a prerequisite graph derived from the above.

## Data source

UH Mānoa's catalog runs on **Acalog** at `catalog.manoa.hawaii.edu`. Relevant IDs: `catoid=4` is the current 2026-2027 catalog, `navoid=949` is the Course Descriptions page. `catoid=2` / `navoid=420` is 2025-2026, archived. Make the catalog ID a config constant, not a literal scattered through the code.

The listing endpoint is `content.php` with these query params:

```
catoid=4
navoid=949
cur_cat_oid=4
filter[27]=<SUBJECT_PREFIX>   # or -1 for all subjects
filter[29]=                    # course number filter, leave empty
filter[keyword]=
filter[32]=1
filter[cpage]=<N>              # 1-indexed page
search_database=Filter
expand=1                       # inlines full descriptions
print=                         # strips site nav
```

**Strategy: iterate over subject prefixes, not over global pages.** Harvest the prefix list from the `<option>` values of the `filter[27]` dropdown (roughly 130 of them). This gives natural checkpoints and small responses. Note that a single subject can still span multiple `cpage` values, so page until a request returns no new course links.

Course links in the listing look like `preview_course_nopop.php?catoid=4&coid=NNNNN`. If the expanded listing turns out to be unreliable or truncated, Acalog exposes a per-course AJAX endpoint along the lines of `ajax/preview_course.php?catoid=4&coid=<coid>&show`. Confirm the exact query string against a live request before depending on it. Use the listing for discovery and this for detail if the two disagree.

### General Education designations

The catalog prints these at the **end of the course description**:

| Foundations | Diversification |
|---|---|
| `FW` Written Communication | `DA` Arts |
| `FQ` Quantitative Reasoning | `DB` Biological Science |
| `FGA` `FGB` `FGC` Global & Multicultural | `DH` Humanities |
| | `DL` Literatures |
| | `DP` Physical Science |
| | `DS` Social Science |
| | `DY` Laboratory (science) |

**Focus designations (`WI`, `OC`, `ETH`, `HAP`) are deliberately NOT in the catalog** because they are properties of a *section* and rotate every semester. They live in Banner Browse Classes instead. That is explicitly out of scope for phase 1, but include a nullable `focus` field in the schema and leave a clearly marked integration seam so it can be joined in later on `(subject, number)`.

## Do this first, before writing the parser

Stage 0, and do not skip it: fetch **one** subject's expanded page (use `EE`), write the raw HTML to `debug/EE_raw.html`, and show me the structure of a single course block. I want to see the actual markup before you commit to selectors.

Then hand-verify your extraction against this golden set and write it to `tests/golden.json` as expected values. Do not scale up until every one passes:

- `EE 211`, `EE 324` (engineering, numeric prereqs)
- `PHIL 100` (expect `DH`), `BIOL 171` (`DB`), `BIOL 171L` (`DY`), `PHYS 151` (`DP`)
- `ENG 100` (expect `FW`), `MATH 241`
- `ACC 465B` (alpha-suffixed course)
- One course with variable credits and one with `Pre: consent` only

Report your coverage numbers honestly at the end: how many courses parsed cleanly, how many fell back, which subjects had the most failures.

## Known traps

These will bite you, so handle them explicitly:

1. **Bare-number prerequisites.** UH states same-subject prereqs as numbers alone: `Pre: 211 and 213`. Resolve bare numbers against the course's own subject prefix. This is the single biggest source of silent errors.
2. **`DH` is also a subject prefix** (Dental Hygiene). A naive `\bDH\b` regex will match course codes and department names, not just the Humanities designation. Anchor designation extraction to its actual position and markup in the description block, and validate against the golden set rather than trusting the regex.
3. **Alpha suffixes**: `ACC 465 (Alpha)` is a parent, `ACC 465B` / `ACC 465C` are real distinct courses.
4. **Lab pairings**: `BIOL 171` and `BIOL 171L` are separate rows and usually carry different designations.
5. **Variable and range credits**: `1-3`, `V`, `(3 credits)` embedded in prose.
6. **Cross-listings**: descriptions often say the course is the same as another. Capture the raw text; do not try to merge records.
7. **Pagination** within a subject, as noted above.

## Prerequisite parsing

Parse `prereq_raw` into a boolean tree. Target shape:

```json
{
  "op": "AND",
  "children": [
    {"course": "EE 211", "min_grade": "C", "concurrent": false},
    {"op": "OR", "children": [
      {"course": "MATH 242"},
      {"course": "MATH 252A"}
    ]},
    {"type": "consent"}
  ]
}
```

Leaf types to support: `course`, `consent` (instructor or department), `standing` (e.g. junior standing), `major_restriction`, and `unparsed` carrying the residual text.

Requirements for this component:

- Handle `Pre:`, `Co:`, `Coreq`, `and`, `or`, `or concurrent`, `with a grade of C or better`, `consent`, `Restriction:`, and nested parentheses.
- Set `prereq_parse_status` to `clean`, `partial`, or `failed`. **Never silently drop text.** Anything unconsumed goes into an `unparsed` leaf so it's visible downstream.
- Write unit tests over the real prereq strings you actually encounter, not invented ones. Sample 30 real strings across departments into a fixture file first, then write the parser against them.
- Prefer a small explicit tokenizer plus recursive descent over one enormous regex. The grammar is irregular enough that regex will become unmaintainable, and phase 2's correctness depends on this component.

## Prerequisite graph

Build a directed graph with `networkx`: an edge from each prerequisite course to the course requiring it. Then:

- Detect and report cycles. Real ones exist in catalogs and they will break the planner, so surface them rather than crashing.
- Report edges pointing at course codes that do not exist in the dataset (typos, retired courses, cross-campus references).
- Compute a topological depth per course. Phase 2 uses this to suggest which semester a course can earliest be taken.
- Export the graph as JSON adjacency alongside the pickle so the web app can read it without Python.

## Project setup

- Python, `.venv` in the project root, `requirements.txt` committed
- `requests`, `beautifulsoup4`, `lxml`, `networkx`, `pytest`
- `.gitignore` covering `.venv/`, `__pycache__/`, `cache/`, `debug/`

Structure it roughly as:

```
config.py          # catoid, base URLs, rate limit
fetch.py           # HTTP + disk cache
parse_course.py    # HTML -> course dict
parse_prereq.py    # prose -> tree
graph.py           # networkx build + analysis
build.py           # orchestrates, writes outputs
tests/
data/courses.jsonl
data/courses.db
data/prereq_graph.json
```

## Scraping conduct

- One request at a time, one-second sleep between them
- Descriptive User-Agent identifying it as a personal academic planning tool
- **Cache every response to `cache/` keyed by URL.** Re-parsing must cost zero requests. This matters more than anything else here, because you will iterate on the parser many times.
- Resumable: re-running skips subjects already cached
- Check `robots.txt` and report what it says before the first bulk run
- Roughly 5,000 courses total, so this is a small, polite job. It should not be parallelized.

## Working style

Build it in stages and stop for my review at each one:

1. Fetch + cache layer, plus the raw HTML dump for `EE`
2. Course parser passing the golden set
3. Full scrape of all subjects, with a coverage report
4. Prereq parser against the real-string fixture
5. Graph build and anomaly report

Do not write all five at once. If the catalog markup contradicts anything I've stated above, tell me rather than working around it silently. I care more about knowing where the data is wrong than about a clean-looking run.

## Out of scope for phase 1

- Focus designations and anything touching Banner
- The planner UI
- Degree requirement rules (EE BS curriculum, Gen Ed credit minimums). Those get encoded by hand in phase 2.
