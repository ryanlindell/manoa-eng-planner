// Shared between app.js (the course graph) and compare.js (the catalog-diff
// tool) -- the single source of truth for which catalog years and majors
// this site knows about, so the two pages can't drift out of sync with each
// other the way two hand-kept copies would. Load this before either page
// script. Not wrapped in an IIFE -- CATALOGS/PROGRAMS need to land as plain
// globals both other scripts can see.
//
// Published as an Artifact, files are served relative to index.html itself
// with no parent to go up to -- a "../" path 404s there even though it's
// the right relative path for local static-file serving (where visualizer/
// and data/ are real sibling folders on disk). Using "data/..." here
// (matching the Artifact's published path) means a local copy has to live
// under visualizer/data/ too -- see graph.py, which writes both copies of
// each catalog year together so they can't drift.
//
// One entry per catalog year the site can show. `id` is usually that
// year's catoid as a string (config.py's CATALOGS, since a <select value>
// is always a string) -- except 2024-25, which isn't in the Acalog/catoid
// system at all (a completely different site; see data_2024/README.md),
// so its id is just "2024" and it has no config.py counterpart. Keep this
// in sync by hand with whatever graph.py (or scripts/graph_<year>.py) has
// actually written to visualizer/data/ -- the default catalog's file is
// prereq_graph.json, catoid-based years are prereq_graph_catoid<N>.json,
// and every year-numbered one (2020-2024) is prereq_graph_<year>.json. Add
// a row here each time a new year gets scraped and committed, not before.
var CATALOGS = [
  { id: "4", label: "2026–2027", url: "data/prereq_graph.json" },
  { id: "2", label: "2025–2026 (archived)", url: "data/prereq_graph_catoid2.json" },
  { id: "2024", label: "2024–2025 (archived)", url: "data/prereq_graph_2024.json" },
  { id: "2023", label: "2023–2024 (archived)", url: "data/prereq_graph_2023.json" },
  { id: "2022", label: "2022–2023 (archived)", url: "data/prereq_graph_2022.json" },
  { id: "2021", label: "2021–2022 (archived)", url: "data/prereq_graph_2021.json" },
  { id: "2020", label: "2020–2021 (archived)", url: "data/prereq_graph_2020.json" },
];
// One entry per major this site can filter down to. `urls` maps a CATALOGS
// id to that catalog's own relevance data (see
// scripts/build_ee_relevant_courses.py) -- a major can cover more than one
// catalog year, since the check sheet rarely changes year to year, but each
// year still needs its *own* file (computed against that year's actual
// course list -- e.g. gen-ed tags differ, courses get added or retired). A
// catalog id missing from `urls` just means nobody's built that year's
// relevance data yet; both app.js and compare.js disable the option rather
// than show it against the wrong catalog's courses. Keep in sync by hand
// with checksheets/data/ the same way CATALOGS is kept in sync with
// visualizer/data/: add a urls entry here each time another catalog year's
// relevance data gets built, and a new top-level entry each time another
// major's check sheet gets extracted at all.
var PROGRAMS = [
  {
    id: "EE", label: "Electrical Engineering",
    urls: {
      "4": "data/ee_relevant_EE.json",
      "2": "data/ee_relevant_EE_catoid2.json",
      "2024": "data/ee_relevant_EE_2024.json",
      "2023": "data/ee_relevant_EE_2023.json",
      "2022": "data/ee_relevant_EE_2022.json",
      "2021": "data/ee_relevant_EE_2021.json",
      "2020": "data/ee_relevant_EE_2020.json",
    },
  },
  // The other engineering majors, for the newest catalog only -- the one
  // year each has a check sheet transcribed (checksheets/"2026 <major>.pdf",
  // via web/programs.js). Built by scripts/build_major_relevance.js; an
  // older catalog just shows these options disabled, same as any program
  // with no data for that year.
  { id: "CENG", label: "Computer Engineering", urls: { "4": "data/relevant_CENG.json" } },
  { id: "ME", label: "Mechanical Engineering", urls: { "4": "data/relevant_ME.json" } },
  { id: "CE", label: "Civil Engineering", urls: { "4": "data/relevant_CE.json" } },
];
