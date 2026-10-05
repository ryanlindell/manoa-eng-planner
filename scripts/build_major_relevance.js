// Builds the prereq map's major-filter data for Computer, Mechanical and Civil
// Engineering: visualizer/data/relevant_<ID>.json, one per major, for the
// newest catalog (2026-27 -- the only year these three have a check sheet
// transcribed for).
//
// Electrical Engineering's file (ee_relevant_EE*.json) is built by
// scripts/build_ee_relevant_courses.py from checksheets/data/<year>.json and
// is left alone. These three come from web/programs.js instead -- the Degree
// Planner's transcription of each August 2026 check sheet -- so the map and
// the planner can't disagree about what a major requires.
//
// Same file shape as EE's, so everything that only colors or filters the
// graph works unchanged:
//   courses           every course relevant to the major
//   category_by_code  one requirement category per course (fixed / te / eb /
//                     group2 / gened / any_level -- the map's color keys)
//   category_labels   what those colors mean for THIS major (Civil reuses
//                     the "eb" color for its sustainability electives)
//   categories        per-category lists, for the Compare page's sub-filter
//   fixed_groups      the required courses, either/or alternatives grouped
//   gened_codes       which gen-ed tags the sheet tracks
// plus, in place of EE's track_groups / technical_electives /
// engineering_breadth (which describe EE's Group I/II structure):
//   pools             the elective requirements: {id, name, label, need
//                     (credits), cat, hint, greedy, codes, limits}
//   tracks            Civil only: per senior-year track, its own
//                     fixed_groups and pools (the top-level ones are the
//                     standard senior year's)
// app.js's genericAudit() reads those for My Progress, Checklist and the
// Graduation Map.
//
// Usage:
//   node scripts/build_major_relevance.js
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GRAPH_JSON = path.join(ROOT, "data", "prereq_graph.json");
const PLANNER_JSON = path.join(ROOT, "web", "data", "planner_data.json");
const CHECKSHEET_JSON = path.join(ROOT, "checksheets", "data", "2026.json");
const OUT_DIR = path.join(ROOT, "visualizer", "data");

// Per major: the check sheet it came from, the subject whose other courses
// are shown as "also yours" (EE's any_level bucket), and what each color
// means on its legend.
const MAJORS = {
  CENG: {
    source: "checksheets/2026 CENG.pdf", subjects: ["ECE"],
    labels: { te: "Technical Electives (TE)", any_level: "Other ECE courses" },
  },
  ME: {
    source: "checksheets/2026 ME.pdf", subjects: ["ME"],
    labels: { te: "Technical Electives (TE)", any_level: "Other ME courses (incl. graduate)" },
  },
  CE: {
    source: "checksheets/2026 CE.pdf", subjects: ["CEE"],
    labels: {
      te: "Technical Electives (TE)", eb: "Sustainability electives (TES)", group2: "Structural math elective (SME)",
      any_level: "Other CEE courses (incl. graduate)",
    },
  },
};
// The open gen-ed slots every engineering sheet has: any course carrying one
// of these tags could be the one that fills them.
const OPEN_GENED_TAGS = ["FGA", "FGB", "FGC", "DH", "DL", "DS"];
// Pool categories that aren't map colors of their own.
const CATEGORY_PRIORITY = ["fixed", "group1", "group2", "te", "eb", "gened", "any_level"];

function loadPrograms() {
  global.window = {};
  require(path.join(ROOT, "web", "programs.js"));
  const plannerData = JSON.parse(fs.readFileSync(PLANNER_JSON, "utf8"));
  return global.window.buildPrograms(plannerData);
}

function fixedGroupsOf(grid) {
  const groups = [];
  grid.forEach((sem) => sem.forEach((it) => {
    const group = it.code ? [it.code] : it.alt ? it.alt.slice() : null;
    if (group && !groups.some((g) => g.join() === group.join())) {
      groups.push(group);
    }
  }));
  return groups;
}

// One pool as plain data: every catalog course it takes, by its own core
// list, minus the courses the sheet already requires by name.
function poolData(pool, catalogCodes, fixedCodes) {
  const takes = pool.core || pool.eligible || ((code) => pool.codes.includes(code));
  const codes = catalogCodes.filter((code) => takes(code) && !fixedCodes.has(code));
  return {
    id: pool.id, name: pool.name, label: pool.label, need: pool.need, cat: pool.cat,
    hint: pool.hint, greedy: !!pool.greedy, codes,
    limits: (pool.limits || []).map((limit) => ({ label: limit.label, count: limit.count, codes: codes.filter(limit.test) }))
      .filter((limit) => limit.codes.length),
  };
}

function build(program, nodes, genedCodes) {
  const meta = MAJORS[program.id];
  const catalogCodes = Object.keys(nodes).filter((code) => nodes[code].in_catalog).sort();
  const inCatalog = new Set(catalogCodes);
  const dropped = new Set();
  const keep = (groups) => groups.map((g) => g.filter((code) => {
    if (!inCatalog.has(code)) {
      dropped.add(code);
    }
    return inCatalog.has(code);
  })).filter((g) => g.length);

  const trackKeys = program.tracks ? Object.keys(program.tracks) : [null];
  const perTrack = {};
  trackKeys.forEach((key) => {
    const fixed = keep(fixedGroupsOf(program.grid(key)));
    const fixedCodes = new Set([].concat(...fixed));
    perTrack[key] = {
      name: key ? program.tracks[key].name : null,
      fixed_groups: fixed,
      pools: program.pools(key).filter((pool) => pool.kind === "credits").map((pool) => poolData(pool, catalogCodes, fixedCodes)),
    };
  });
  const main = perTrack[program.tracks ? program.defaultTrack : null];

  // One category per course, by the same priority EE's file uses: a required
  // course is "fixed" even if it could also be someone's elective.
  const category = {};
  const claim = (code, cat) => {
    if (!category[code] || CATEGORY_PRIORITY.indexOf(cat) < CATEGORY_PRIORITY.indexOf(category[code])) {
      category[code] = cat;
    }
  };
  trackKeys.forEach((key) => perTrack[key].fixed_groups.forEach((g) => g.forEach((code) => claim(code, "fixed"))));
  trackKeys.forEach((key) => perTrack[key].pools.forEach((pool) => pool.codes.forEach((code) => claim(code, pool.cat))));
  catalogCodes.forEach((code) => {
    const node = nodes[code];
    if ((node.gened || []).some((tag) => OPEN_GENED_TAGS.includes(tag))) {
      claim(code, "gened");
    } else if (meta.subjects.includes(node.subject)) {
      claim(code, "any_level");
    }
  });

  const categories = {};
  Object.keys(category).forEach((code) => {
    const cat = category[code];
    if (cat !== "fixed" && cat !== "gened" && cat !== "any_level") {
      (categories[cat] = categories[cat] || []).push(code);
    }
  });
  Object.keys(categories).forEach((cat) => categories[cat].sort());

  const out = {
    program: program.id,
    label: program.name,
    catalog_year: 2026,
    source_checksheet: meta.source,
    courses: Object.keys(category).sort(),
    categories,
    category_by_code: category,
    category_labels: Object.assign({ fixed: "Class Requirements", gened: "General Education Core" }, meta.labels),
    fixed_groups: main.fixed_groups,
    pools: main.pools,
    gened_codes: genedCodes,
  };
  if (program.tracks) {
    out.tracks = {};
    trackKeys.forEach((key) => {
      out.tracks[key] = perTrack[key];
    });
  }
  if (dropped.size) {
    console.log(`  note: on the ${program.id} sheet but not in the 2026-27 catalog: ${Array.from(dropped).sort().join(", ")}`);
  }
  return out;
}

function main() {
  const nodes = JSON.parse(fs.readFileSync(GRAPH_JSON, "utf8")).nodes;
  const genedCodes = JSON.parse(fs.readFileSync(CHECKSHEET_JSON, "utf8")).gened_codes;
  const programs = loadPrograms();
  Object.keys(MAJORS).forEach((id) => {
    const data = build(programs.byId[id], nodes, genedCodes);
    const file = path.join(OUT_DIR, `relevant_${id}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
    const pools = data.pools.map((pool) => `${pool.id} ${pool.codes.length}`).join(", ");
    console.log(`wrote ${path.relative(ROOT, file)}: ${data.courses.length} courses, ${data.fixed_groups.length} required, pools: ${pools}`);
  });
}

main();
