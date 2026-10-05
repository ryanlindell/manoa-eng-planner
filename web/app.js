// Engineering Degree Planner. Everything is read in the browser:
//   * programs.js -- the majors (EE, Computer, Mechanical, Civil), each one
//     its August 2026 check sheet written out as data: the recommended 8
//     semesters, the elective requirements, the substitution notes.
//   * data/planner_data.json -- the newest catalog (titles, credits, gen-ed
//     tags, Focus letters, prereq/coreq trees). Built by
//     scripts/build_planner_data.py.
//   * ../visualizer/data/star_sections.json -- STAR's section history: which
//     terms each course actually ran, how full, and when it met. Optional:
//     without it the planner still works, minus the "when it runs" and
//     time-conflict checks.
const DATA_URL = "data/planner_data.json";
const STAR_URL = "../visualizer/data/star_sections.json";
// Every saved plan: {active: <plan id>, plans: [{id, name, plan}]}.
// Local only: how hard reviewers rate each course, built from Rate My
// Professors by scripts/private/build_planner_difficulty.py into a gitignored
// folder. Only ever requested on localhost (see init()), so the published
// planner has none of it and every difficulty feature below stays switched off.
const DIFFICULTY_URL = "private/difficulty.json";
const PLANS_KEY = "eePlanner.plans.v1";
// Where the single plan lived before there could be several; read once, to
// carry an existing plan over.
const STORAGE_KEY = "eePlanner.v2";
// The prereq map's (../visualizer/app.js) own browser storage: the courses a
// student marked taken there -- a JSON array of codes, plus synthetic "__..."
// keys for its manual "satisfied another way" checkboxes -- and their track.
// Same site, so the same localStorage; see syncFromVisualizer().
const VIZ_TAKEN_KEY = "prereqMapTaken";
const VIZ_TRACK_KEY = "prereqMapTrack";

const TERM_NAME_PATTERN = /^(Fall|Spring|Summer) (\d{4})$/;
const SEASON_ORDER = { Spring: 1, Summer: 2, Fall: 3 };
const DEFAULT_START = "Fall 2026";
const TRANSFER_NAME = "Transfer / AP / already completed";

// ECE 296/396/496 (and the ENGR equivalents) are project courses the
// department arranges -- they barely appear in STAR's class listings, which
// must not be read as "never offered".
const ARRANGED = /^(ECE|ENGR) [1-4]96$/;
// Courses a student normally repeats for credit: those project courses, and
// directed reading/research (x99). Having one in the plan twice is expected.
const REPEATABLE = /^(?:(?:ECE|ENGR) [1-4]96|[A-Z]+ [1-6]99[A-Z]?)$/;

// The gen-ed requirements every engineering check sheet leaves open: a
// placeholder tile in the plan until the student picks the real course. Each
// major adds its own (technical electives, track courses...) through its
// pools in programs.js. Focus (W/O/E/H) is deliberately not here -- it's an
// overlay on courses already in the plan, not a course of its own.
const GENED_SLOTS = {
  FG: { label: "FG", title: "Foundations: Global & Multicultural", credits: 3, cat: "gened" },
  DHDL: { label: "DH or DL", title: "Diversification: Humanities or Literatures", credits: 3, cat: "gened" },
  DS: { label: "DS", title: "Diversification: Social Sciences", credits: 3, cat: "gened" },
};

// The picker's requirement filters that are the same for every major; the
// major's own come from its pools (see presets()).
const BASE_PRESETS = [
  { id: "all", label: "Any course", hint: "Every undergraduate course in the catalog. Type to search." },
  { id: "fixed", label: "Required courses", hint: "The courses the check sheet names outright. Either/or pairs need only one." },
];
const COMMON_PRESETS = [
  { id: "FG", label: "FG", hint: "Two courses, from two different groups (FGA, FGB, FGC)." },
  { id: "DHDL", label: "DH or DL", hint: "One Humanities or Literatures course." },
  { id: "DS", label: "DS", hint: "One Social Sciences course besides the required ECON course, from a different subject." },
  { id: "PM", label: "Pre-med", premed: true, hint: "Courses that fill JABSOM's admission prerequisites (biology, physics, general and organic chemistry, biochemistry), plus the subjects it recommends." },
  { id: "W", label: "W Focus", hint: "Writing Intensive: 5 courses, at least 2 at the 300 level or higher. Focus belongs to a section, not a course: register for a section that carries it." },
  { id: "O", label: "O Focus", hint: "Oral Communication: 1 course." },
  { id: "E", label: "E Focus", hint: "Contemporary Ethical Issues: 1 course." },
  { id: "H", label: "H Focus", hint: "Hawaiian, Asian & Pacific Issues: 1 course. Never an engineering course, so pick one that also fills DH/DL, DS or FG." },
];
const FOCUS_LETTERS = ["W", "O", "E", "H"];
const FOCUS_ATTR = { W: "WI", O: "OC", E: "ETH", H: "HAP" };
const FOCUS_NAME = { W: "Writing Intensive", O: "Oral Communication", E: "Contemporary Ethical Issues", H: "Hawaiian, Asian & Pacific Issues" };
const FOCUS_NEED = { W: 5, O: 1, E: 1, H: 1 };
const W_UPPER_NEED = 2;

// Pre-med: the John A. Burns School of Medicine's admission requirements
// (PREMED.source, read October 2026), turned on per plan under "Advanced
// options". JABSOM states them as subjects ("General Biology with Lab: one
// academic year"), not course numbers -- the Manoa courses in each slot are
// this planner's mapping of those subjects onto the catalog, so a slot lists
// every course that fills it and any one of them will do. A course counts
// here whether or not it also counts toward the EE degree (PHYS 170 does both).
const PREMED = {
  source: "https://admissions.jabsom.hawaii.edu/apply/admission-requirements/index.html",
  credits: 90,
  groups: [
    { name: "General Biology with lab", detail: "one academic year", slots: [["BIOL 171"], ["BIOL 171L"], ["BIOL 172"], ["BIOL 172L"]] },
    { name: "General Physics with lab", detail: "one academic year", slots: [["PHYS 170", "PHYS 151"], ["PHYS 170L", "PHYS 151L"], ["PHYS 272", "PHYS 152"], ["PHYS 272L", "PHYS 152L"]] },
    { name: "General Chemistry with lab", detail: "one academic year", slots: [["CHEM 161", "CHEM 171", "CHEM 181A"], ["CHEM 161L", "CHEM 171L", "CHEM 181L"], ["CHEM 162", "CHEM 171", "CHEM 181A"], ["CHEM 162L", "CHEM 171L", "CHEM 181L"]] },
    { name: "Organic Chemistry with lab", detail: "one academic year", slots: [["CHEM 272"], ["CHEM 272L"], ["CHEM 273"], ["CHEM 273L"]] },
    { name: "Biochemistry", detail: "one course, no lab required", slots: [["BIOC 441", "BIOL 402", "MBBE 402", "MBBE 375", "BIOC 341"]] },
  ],
  // "Recommended (not required)" on JABSOM's page.
  recommended: [
    { name: "Anatomy", codes: ["PHYL 141", "PHYL 142", "PHYL 301", "PHYL 302"] },
    { name: "Calculus", codes: ["MATH 241", "MATH 251A"] },
    { name: "Cell and Molecular Biology", codes: ["BIOL 275", "BIOL 407"] },
    { name: "Genetics", codes: ["BIOL 375"] },
    { name: "Immunology", codes: ["MICR 461"] },
    { name: "Microbiology", codes: ["MICR 351", "MICR 130"] },
    { name: "Physiology", codes: ["PHYL 141", "PHYL 142", "PHYL 301", "PHYL 302"] },
    { name: "Statistics", codes: ["ECE 342", "MATH 372", "BIOL 220", "ECON 321", "PSY 225", "SOCS 225"] },
  ],
};
// One-semester accelerated general chemistry: whether it is "one academic
// year" is JABSOM's call, so it's accepted with a caution.
const PREMED_ACCELERATED_CHEM = ["CHEM 171", "CHEM 171L", "CHEM 181A", "CHEM 181L"];
const PREMED_CALC_PHYSICS = ["PHYS 170", "PHYS 272"];

const CATEGORY_LABEL = {
  fixed: "Required", group1: "Group I", group2: "Group II", te: "Tech elective",
  eb: "Eng. breadth", gened: "Gen-ed", premed: "Pre-med", extra: "Elective",
};

// Credits needed to reach each class standing (UH Manoa).
const STANDING_CREDITS = { sophomore: 25, junior: 55, senior: 89 };
const FULL_TIME_CREDITS = 12;
const HEAVY_CREDITS = 18;
const MAX_CREDITS = 19;
const PICKER_ROW_LIMIT = 150;
// Difficulty is a 1-5 average of self-selected reviews. Fewer reviews than
// DIFF_MIN_REVIEWS and a course counts as unrated. About a quarter of rated
// courses sit at DIFF_HARD or above.
const DIFF_MIN_REVIEWS = 5;
const DIFF_LIGHT = 2.8;
const DIFF_HARD = 3.7;
const DIFF_VERY_HARD = 4.2;
const DIFF_BAND_LABEL = { light: "lighter than most", typical: "typical", hard: "hard", vhard: "very hard" };
// A semester is flagged once this many credits of hard-rated courses pile up
// in it (or three such courses, whatever their credits).
const DIFF_HARD_CREDITS = 10;
// Course-level filters in the picker. Graduate courses (only ECE's are in
// the planner's data) share one "500+" chip.
const LEVELS = [[1, "100"], [2, "200"], [3, "300"], [4, "400"], [5, "500+"]];

// 1 for a 100-level course ... 5 for anything numbered 500 or above.
function levelOf(code) {
  return Math.min(5, Math.max(1, Math.floor(courseNumber(code) / 100)));
}

let data = null;
// Every major, from programs.js (built once the catalog has loaded).
let programs = null;
let star = null;
let difficulty = null;
let plan = null;
// The saved plans; `plan` is always the active entry's.
let library = null;
let checkOn = false;
let picker = null;
let detailItemId = null;
let lastSemesterId = null;
let dragItemId = null;
// The visualizer's "__..." keys (manual Focus / EB / gen-ed checkboxes).
let vizManual = new Set();

// ---------- small helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

function $(id) {
  return document.getElementById(id);
}

function courseNumber(code) {
  const m = /\s(\d+)/.exec(code);
  return m ? Number(m[1]) : 0;
}

function subjectOf(code) {
  return code.split(" ")[0];
}

function isLab(code) {
  return /\dL$/.test(code);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---------- terms ----------

function parseTerm(name) {
  const m = TERM_NAME_PATTERN.exec(name || "");
  return m ? { season: m[1], year: Number(m[2]) } : null;
}

function termSortKey(name) {
  const t = parseTerm(name);
  return t.year * 10 + SEASON_ORDER[t.season];
}

function nextRegularTerm(name) {
  const t = parseTerm(name);
  return t.season === "Fall" ? `Spring ${t.year + 1}` : `Fall ${t.year}`;
}

function regularTermsFrom(start, count) {
  const out = [start];
  while (out.length < count) {
    out.push(nextRegularTerm(out[out.length - 1]));
  }
  return out;
}

// Fall/Spring terms on one number line (Spring Y = 2Y, Fall Y = 2Y + 1), with
// Summer Y halfway between Spring Y and Fall Y.
function termIndex(name) {
  const t = parseTerm(name);
  return t.year * 2 + { Spring: 0, Summer: 0.5, Fall: 1 }[t.season];
}

function termFromIndex(n) {
  if (Number.isInteger(n)) {
    return `${n % 2 ? "Fall" : "Spring"} ${Math.floor(n / 2)}`;
  }
  // A summer: the one that follows the regular term just before it.
  return `Summer ${Math.floor((n + 0.5) / 2)}`;
}

// The term in progress today; anything before it is a finished semester.
function currentTermKey() {
  const now = new Date();
  const month = now.getMonth();
  const season = month <= 4 ? "Spring" : month <= 6 ? "Summer" : "Fall";
  return now.getFullYear() * 10 + SEASON_ORDER[season];
}

function isCompleted(sem) {
  return sem.transfer || termSortKey(sem.term) < currentTermKey();
}

// ---------- plan state ----------

function newId() {
  return `i${plan.nextId++}`;
}

function emptyPlan() {
  return { version: 2, program: "EE", track: "EP", layout: "horizontal", nextId: 1, semesters: [], custom: {} };
}

function makeSemester(term) {
  return { id: newId(), term: term || null, transfer: !term, items: [] };
}

function sortSemesters() {
  plan.semesters.sort((a, b) => {
    if (a.transfer !== b.transfer) {
      return a.transfer ? -1 : 1;
    }
    return a.transfer ? 0 : termSortKey(a.term) - termSortKey(b.term);
  });
}

function semesterById(id) {
  return plan.semesters.find((s) => s.id === id) || null;
}

function semesterName(sem) {
  return sem.transfer ? TRANSFER_NAME : sem.term;
}

function findItem(itemId) {
  for (const sem of plan.semesters) {
    const item = sem.items.find((it) => it.id === itemId);
    if (item) {
      return { sem, item };
    }
  }
  return null;
}

// Every course the plan says is behind the student: the completed bucket
// plus any semester before the current term.
function completedCodes() {
  const codes = new Set();
  plan.semesters.filter(isCompleted).forEach((sem) => sem.items.forEach((it) => it.code && codes.add(it.code)));
  return Array.from(codes);
}

function readVizTaken() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIZ_TAKEN_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((c) => typeof c === "string") : [];
  } catch (err) {
    return [];
  }
}

// Older catalogs call the department EE; this one calls it ECE.
function planCode(code) {
  const ece = code.replace(/^EE /, "ECE ");
  return !data.courses[code] && data.courses[ece] ? ece : code;
}

// Pulls in what the prereq map knows. A course marked taken there lands in
// the completed bucket here (moved out of a future semester if the plan had
// it there); one un-marked there since the last sync leaves the bucket. The
// map's track is used too. Returns how many courses came in.
function syncFromVisualizer() {
  const stored = readVizTaken();
  vizManual = new Set(stored.filter((c) => c.indexOf("__") === 0));
  const taken = new Set(stored.filter((c) => c.indexOf("__") !== 0).map(planCode));
  let storedTrack = null;
  try {
    storedTrack = localStorage.getItem(VIZ_TRACK_KEY);
  } catch (err) {
    storedTrack = null;
  }
  // The prereq map's track is an EE track; it means nothing for other majors.
  if (plan.program === "EE" && storedTrack && prog().tracks[storedTrack]) {
    plan.track = storedTrack;
  }

  const before = new Set(plan.syncedTaken || []);
  let bucket = plan.semesters.find((sem) => sem.transfer);
  if (bucket) {
    bucket.items = bucket.items.filter((it) => !(it.code && before.has(it.code) && !taken.has(it.code)));
  }
  const done = new Set(completedCodes());
  let added = 0;
  taken.forEach((code) => {
    if (done.has(code)) {
      return;
    }
    if (!bucket) {
      bucket = makeSemester(null);
      plan.semesters.unshift(bucket);
    }
    const planned = plan.semesters.map((sem) => sem.items.find((it) => it.code === code)).find(Boolean);
    if (planned) {
      moveItem(planned.id, bucket.id);
    } else {
      addCourseTo(bucket, code);
    }
    added++;
  });
  return added;
}

// The other direction: the plan's completed courses become the prereq map's
// taken list. Its "__..." keys are read fresh and passed through untouched.
function syncToVisualizer() {
  const codes = completedCodes();
  plan.syncedTaken = codes;
  try {
    const manual = readVizTaken().filter((c) => c.indexOf("__") === 0);
    localStorage.setItem(VIZ_TAKEN_KEY, JSON.stringify(manual.concat(codes)));
    if (plan.program === "EE") {
      localStorage.setItem(VIZ_TRACK_KEY, plan.track);
    }
  } catch (err) {
    console.warn("Could not share the plan with the prereq map", err);
  }
}

// Re-times the whole plan so its first Fall/Spring semester is `start`:
// every semester moves by the same number of terms, courses and all. This is
// how a junior or senior lines the plan up with when they actually started.
function setStartTerm(start) {
  const terms = plan.semesters.filter((sem) => !sem.transfer);
  if (!terms.length) {
    regularTermsFrom(start, pv().grid.length).forEach(addSemester);
    return;
  }
  const first = terms.find((sem) => parseTerm(sem.term).season !== "Summer") || terms[0];
  const delta = termIndex(start) - Math.ceil(termIndex(first.term));
  terms.forEach((sem) => {
    sem.term = termFromIndex(termIndex(sem.term) + delta);
  });
  sortSemesters();
}

// A gap semester: a term the student sits out. Turning it on for a semester
// that has courses doesn't drop them -- that semester and everything after
// it move one Fall/Spring term later, and an empty gap takes its place.
function setGap(sem, on) {
  if (!on) {
    delete sem.gap;
    return;
  }
  if (!sem.items.length) {
    sem.gap = true;
    return;
  }
  const at = sem.term;
  plan.semesters.filter((s) => !s.transfer && termSortKey(s.term) >= termSortKey(at)).forEach((s) => {
    s.term = termFromIndex(termIndex(s.term) + 1);
  });
  const gap = makeSemester(at);
  gap.gap = true;
  plan.semesters.push(gap);
  sortSemesters();
}

// Semesters a course can go in.
function openSemesters() {
  return plan.semesters.filter((sem) => !sem.gap);
}

function startTerm() {
  const terms = plan.semesters.filter((sem) => !sem.transfer);
  const first = terms.find((sem) => parseTerm(sem.term).season !== "Summer") || terms[0];
  return first ? first.term : null;
}

function savePlan() {
  syncToVisualizer();
  activeEntry().plan = plan;
  try {
    localStorage.setItem(PLANS_KEY, JSON.stringify(library));
  } catch (err) {
    console.warn("Could not save the plan in this browser", err);
  }
}

// ---------- several plans ----------

function activeEntry() {
  return library.plans.find((entry) => entry.id === library.active);
}

function newPlanId() {
  let n = library.plans.length + 1;
  while (library.plans.some((entry) => entry.id === `p${n}`)) {
    n++;
  }
  return `p${n}`;
}

// "Plan 2", or "EP option copy 2": the first name nothing else is using.
function freeName(base) {
  const taken = new Set(library.plans.map((entry) => entry.name));
  if (!taken.has(base)) {
    return base;
  }
  let n = 2;
  while (taken.has(`${base} ${n}`)) {
    n++;
  }
  return `${base} ${n}`;
}

// Reads the saved plans, carrying over a plan saved before there could be
// more than one. Returns false on a first visit (nothing saved at all).
function loadLibrary() {
  library = { active: "p1", plans: [] };
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(PLANS_KEY));
  } catch (err) {
    raw = null;
  }
  if (raw && Array.isArray(raw.plans)) {
    raw.plans.forEach((entry) => {
      const clean = sanitizePlan(entry && entry.plan);
      if (clean && typeof entry.id === "string" && !library.plans.some((e) => e.id === entry.id)) {
        library.plans.push({ id: entry.id, name: String(entry.name || "My plan").slice(0, 60), plan: clean });
      }
    });
    library.active = raw.active;
  }
  if (!library.plans.length) {
    const old = loadSavedPlan();
    if (old) {
      library.plans.push({ id: "p1", name: "My plan", plan: old });
    }
  }
  const found = library.plans.length > 0;
  if (!found) {
    library.plans.push({ id: "p1", name: "My plan", plan: emptyPlan() });
  }
  if (!activeEntry()) {
    library.active = library.plans[0].id;
  }
  plan = activeEntry().plan;
  return found;
}

function switchPlan(id) {
  if (!library.plans.some((entry) => entry.id === id)) {
    return;
  }
  library.active = id;
  plan = activeEntry().plan;
  resetHistory();
  lastSemesterId = null;
  renderAll();
}

function addPlan(name, newPlan) {
  const entry = { id: newPlanId(), name: freeName(name.trim().slice(0, 60) || "Plan"), plan: newPlan };
  library.plans.push(entry);
  switchPlan(entry.id);
}

// A fresh check-sheet plan on the same track and start term, keeping what
// the current plan has under "already completed".
function createPlan(name) {
  const layout = plan.layout;
  const track = plan.track;
  const program = plan.program;
  const premed = !!plan.premed;
  const start = startTerm() || DEFAULT_START;
  const done = (plan.semesters.find((sem) => sem.transfer) || { items: [] }).items;
  const custom = plan.custom;
  const fresh = emptyPlan();
  fresh.layout = layout;
  fresh.program = program;
  fresh.premed = premed;
  fresh.custom = JSON.parse(JSON.stringify(custom));
  const previous = plan;
  plan = fresh;
  const bucket = makeSemester(null);
  done.forEach((it) => bucket.items.push(Object.assign({}, it, { id: newId() })));
  plan.semesters.push(bucket);
  fillFromCheckSheet(start, track);
  plan = previous;
  addPlan(name, fresh);
}

function duplicatePlan() {
  addPlan(`${activeEntry().name} copy`, sanitizePlan(JSON.parse(JSON.stringify(plan))));
}

function deletePlan() {
  if (library.plans.length < 2) {
    return;
  }
  const gone = library.active;
  library.plans = library.plans.filter((entry) => entry.id !== gone);
  switchPlan(library.plans[0].id);
}

function renderPlanSelect() {
  const sel = $("plan-select");
  if (!sel) {
    return;
  }
  sel.innerHTML = "";
  library.plans.forEach((entry) => {
    const opt = el("option", null, entry.name);
    opt.value = entry.id;
    sel.appendChild(opt);
  });
  const manage = el("optgroup");
  manage.label = "Manage plans";
  [["+new", "New plan…"], ["+copy", "Duplicate this plan"], ["+rename", "Rename this plan…"], ["+delete", "Delete this plan"]].forEach((pair) => {
    const opt = el("option", null, pair[1]);
    opt.value = pair[0];
    opt.disabled = pair[0] === "+delete" && library.plans.length < 2;
    manage.appendChild(opt);
  });
  sel.appendChild(manage);
  sel.value = library.active;
}

function onPlanSelect(value) {
  const name = activeEntry().name;
  if (value === "+new") {
    askText("Name the new plan", freeName(`Plan ${library.plans.length + 1}`), "Create", createPlan);
  } else if (value === "+copy") {
    duplicatePlan();
  } else if (value === "+rename") {
    askText("Rename this plan", name, "Rename", (text) => {
      const entry = activeEntry();
      entry.name = "";
      entry.name = freeName(text.trim().slice(0, 60) || name);
      renderAll();
    });
  } else if (value === "+delete") {
    askConfirm(`Delete “${name}”? This can't be undone.`, deletePlan);
  } else {
    switchPlan(value);
  }
  // Whatever was picked, the box goes back to showing the active plan.
  renderPlanSelect();
}

// Accepts whatever a saved or imported plan holds and keeps only what this
// version understands, so a hand-edited or older file can't break rendering.
function sanitizePlan(raw) {
  if (!raw || !Array.isArray(raw.semesters)) {
    return null;
  }
  const out = emptyPlan();
  // A plan saved before there was more than one major is an EE plan.
  out.program = programs.byId[raw.program] ? raw.program : "EE";
  out.track = trackFor(programs.byId[out.program], raw.track);
  out.layout = raw.layout === "vertical" ? "vertical" : "horizontal";
  out.custom = raw.custom && typeof raw.custom === "object" ? raw.custom : {};
  out.hideCompleted = !!raw.hideCompleted;
  out.premed = !!raw.premed;
  if (Array.isArray(raw.syncedTaken)) {
    out.syncedTaken = raw.syncedTaken.filter((c) => typeof c === "string");
  }
  let n = 1;
  let hasTransfer = false;
  raw.semesters.forEach((sem) => {
    const isTransfer = !!sem.transfer;
    if ((isTransfer && hasTransfer) || (!isTransfer && !parseTerm(sem.term))) {
      return;
    }
    hasTransfer = hasTransfer || isTransfer;
    const clean = { id: `i${n++}`, term: isTransfer ? null : sem.term, transfer: isTransfer, items: [] };
    if (sem.gap && !isTransfer) {
      clean.gap = true;
      out.semesters.push(clean);
      return;
    }
    (sem.items || []).forEach((it) => {
      const item = { id: `i${n++}` };
      if (typeof it.slot === "string" && /^[A-Za-z0-9]{1,12}$/.test(it.slot)) {
        item.slot = it.slot;
      } else if (typeof it.code === "string" && it.code) {
        item.code = it.code;
        if (typeof it.credits === "number") {
          item.credits = it.credits;
        }
        if (Array.isArray(it.focus)) {
          item.focus = it.focus.filter((f) => FOCUS_LETTERS.includes(f));
        }
        if (typeof it.as === "string" && /^[A-Za-z0-9]{1,12}$/.test(it.as)) {
          item.as = it.as;
        }
      } else {
        return;
      }
      clean.items.push(item);
    });
    out.semesters.push(clean);
  });
  out.nextId = n;
  return out;
}

function loadSavedPlan() {
  try {
    return sanitizePlan(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch (err) {
    return null;
  }
}

// ---------- undo / redo ----------

// Every render compares the plan with how it looked at the last one; a
// difference means the student just changed something, and the earlier
// version goes on the undo stack. So every kind of edit -- adding, moving,
// removing, a gap, a new start term, a check-sheet fill, an import -- is
// undoable without each one having to say so. The layout choice isn't part
// of it: flipping Vertical/Horizontal is a view, not an edit. History lasts
// for the visit, not across reloads.
const HISTORY_LIMIT = 100;
const undoStack = [];
const redoStack = [];
let lastSnapshot = null;
let restoring = false;

function snapshotPlan() {
  const copy = Object.assign({}, plan);
  delete copy.layout;
  delete copy.syncedTaken;
  return JSON.stringify(copy);
}

function trackHistory() {
  const now = snapshotPlan();
  if (lastSnapshot !== null && now !== lastSnapshot && !restoring) {
    undoStack.push(lastSnapshot);
    if (undoStack.length > HISTORY_LIMIT) {
      undoStack.shift();
    }
    redoStack.length = 0;
  }
  lastSnapshot = now;
  restoring = false;
}

// Undo history belongs to one plan: switching plans starts it over.
function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  lastSnapshot = null;
}

function restorePlan(json) {
  plan = Object.assign(JSON.parse(json), { layout: plan.layout, syncedTaken: plan.syncedTaken });
  restoring = true;
  renderAll();
  if (detailItemId) {
    renderDetail();
  }
  if (picker) {
    closeModal("picker-modal");
  }
}

function undo() {
  if (undoStack.length) {
    redoStack.push(snapshotPlan());
    restorePlan(undoStack.pop());
  }
}

function redo() {
  if (redoStack.length) {
    undoStack.push(snapshotPlan());
    restorePlan(redoStack.pop());
  }
}

// ---------- the major ----------

function prog() {
  return programs.byId[plan.program] || programs.byId.EE;
}

// The track a plan is really on: its own if the major has it, else the
// major's default (null for a major with no tracks).
function trackFor(program, trackKey) {
  return program.tracks ? (program.tracks[trackKey] ? trackKey : program.defaultTrack) : null;
}

// Everything derived from a major + track, worked out once: the grid, the
// required courses (every course the grid names), the elective pools, and
// the placeholder slots those pools define.
const programViews = new Map();
function programView(programId, trackKey) {
  const program = programs.byId[programId] || programs.byId.EE;
  const track = trackFor(program, trackKey);
  const key = `${program.id}:${track}`;
  if (programViews.has(key)) {
    return programViews.get(key);
  }
  const grid = program.grid(track);
  const fixedGroups = [];
  grid.forEach((sem) => sem.forEach((it) => {
    const group = it.code ? [it.code] : it.alt ? it.alt.slice() : null;
    if (group && !fixedGroups.some((g) => g.join() === group.join())) {
      fixedGroups.push(group);
    }
  }));
  const pools = program.pools(track);
  const slots = Object.assign({}, GENED_SLOTS);
  pools.forEach((pool) => Object.keys(pool.slots || {}).forEach((id) => {
    slots[id] = Object.assign({ cat: pool.cat, pool }, pool.slots[id]);
  }));
  const out = {
    program, track, grid, fixedGroups, pools, slots,
    fixedCodes: new Set([].concat(...fixedGroups)),
    minima: program.minima ? program.minima(track) : [],
  };
  programViews.set(key, out);
  return out;
}

function pv() {
  return programView(plan.program, plan.track);
}

function poolTakes(pool, code) {
  return pool.eligible ? pool.eligible(code) : pool.codes.includes(code);
}

// A placeholder slot's label, title, credits and color. A slot left over
// from another major (the plan was switched) still renders, from any major
// that defines it.
function slotDef(id) {
  const mine = pv().slots[id];
  if (mine) {
    return mine;
  }
  for (const program of programs.list) {
    for (const track of program.tracks ? Object.keys(program.tracks) : [null]) {
      const def = programView(program.id, track).slots[id];
      if (def) {
        return def;
      }
    }
  }
  return null;
}

// The picker's requirement filters for the active major. `chip: false` ones
// only open from a placeholder tile.
function presets() {
  const out = BASE_PRESETS.slice();
  pv().pools.forEach((pool) => Object.keys(pool.slots || {}).forEach((id) => {
    const slot = pool.slots[id];
    out.push({ id, label: slot.chipLabel || slot.label, hint: slot.hint || pool.hint, chip: slot.chip });
  }));
  return out.concat(COMMON_PRESETS);
}

// What a course can be set to count toward.
function asOptions() {
  return [["", "Automatic"]]
    .concat(pv().pools.filter((pool) => pool.kind === "credits").map((pool) => [pool.id, pool.name]))
    .concat([["FG", "FG"], ["DHDL", "DH or DL"], ["DS", "DS"], ["premed", "Pre-med"], ["none", "Nothing (free elective)"]]);
}

// ---------- catalog lookups ----------

function course(code) {
  return data.courses[code] || plan.custom[code] || null;
}

function titleOf(code) {
  const c = course(code);
  return c ? c.t : "Not in the 2026–2027 catalog";
}

function isVariableCredit(code) {
  const c = course(code);
  return !!c && !!c.c && c.c[0] !== c.c[1];
}

function creditsOf(item) {
  if (item.slot) {
    return slotDef(item.slot) ? slotDef(item.slot).credits : 3;
  }
  if (item.credits != null) {
    return item.credits;
  }
  if (prog().gridCredits[item.code]) {
    return prog().gridCredits[item.code];
  }
  const c = course(item.code);
  return c && c.c ? c.c[0] : 3;
}

function genedOf(code) {
  const c = course(code);
  return (c && c.g) || [];
}

// The FG group a course belongs to ("FGA" / "FGB" / "FGC"), or null.
function fgGroup(code) {
  return genedOf(code).find((g) => /^FG[ABC]$/.test(g)) || null;
}

// Focus letters this plan counts for an item: the student's own choice if
// they've set one, else every letter STAR has ever shown on the course.
function focusOf(item) {
  if (item.focus) {
    return item.focus;
  }
  const c = course(item.code);
  return (c && c.f) || [];
}

// The subject of the check sheet's own named DS course ("ECON 120, 130 or
// 131"). The second DS has to come from a different subject, so a course
// from this one can never fill the open DS slot.
function requiredDsSubjects() {
  const subjects = new Set();
  pv().fixedGroups.forEach((group) => group.forEach((code) => {
    if (genedOf(code).includes("DS")) {
      subjects.add(subjectOf(code));
    }
  }));
  return subjects;
}

function countsAsSecondDs(code) {
  return genedOf(code).includes("DS") && !requiredDsSubjects().has(subjectOf(code));
}

// ---------- STAR lookups ----------

function prepareStar(raw) {
  const index = new Map(raw.codes.map((code, i) => [code, i]));
  const per = raw.codes.map(() => null);
  raw.rows.forEach((r) => {
    const terms = per[r[1]] || (per[r[1]] = raw.terms.map(() => null));
    const a = terms[r[0]] || (terms[r[0]] = { sections: 0, seats: 0, taken: 0, mask: 0, rows: [] });
    a.sections++;
    a.seats += r[2];
    a.taken += r[3];
    a.mask |= r[5];
    a.rows.push(r);
  });
  const seasonTerms = { Fall: [], Spring: [], Summer: [] };
  raw.terms.forEach((t, i) => seasonTerms[t.season].push(i));
  return { terms: raw.terms, attrs: raw.attrs, index, per, seasonTerms, cache: new Map() };
}

function starPer(code) {
  if (!star) {
    return null;
  }
  const i = star.index.get(code);
  return i == null ? null : star.per[i];
}

// How a course has run across the terms STAR covers: per-season counts and a
// label like "Fall only" or "Fall 2/3, Spring".
function offering(code) {
  if (!star) {
    return { known: false, arranged: false, label: "" };
  }
  if (star.cache.has(code)) {
    return star.cache.get(code);
  }
  const per = starPer(code);
  const by = { Fall: { n: 0, of: 0 }, Spring: { n: 0, of: 0 }, Summer: { n: 0, of: 0 } };
  star.terms.forEach((t, i) => {
    by[t.season].of++;
    if (per && per[i]) {
      by[t.season].n++;
    }
  });
  const arranged = ARRANGED.test(code);
  const level = (s) => (!s.n ? "never" : s.n === s.of ? "always" : "some");
  const f = level(by.Fall);
  const sp = level(by.Spring);
  let label;
  if (arranged) {
    label = "Arranged by the department";
  } else if (!per) {
    label = "Not in STAR";
  } else if (f === "always" && sp === "always") {
    label = "Fall & Spring";
  } else if (f === "always" && sp === "never") {
    label = "Fall only";
  } else if (sp === "always" && f === "never") {
    label = "Spring only";
  } else if (f === "never" && sp === "never") {
    label = "Summer only";
  } else {
    label = ["Fall", "Spring"].filter((s) => by[s].n).map((s) => (by[s].n === by[s].of ? s : `${s} ${by[s].n}/${by[s].of}`)).join(", ");
  }
  if (per && !arranged && by.Summer.n && label !== "Summer only") {
    label += " + Summer";
  }
  const out = { known: !!per && !arranged, arranged, by, label, per };
  star.cache.set(code, out);
  return out;
}

// "yes" ran every captured term of that season / "some" / "no" / "unknown"
// (arranged, or no STAR history at all -- never treated as a hard no).
function seasonStatus(code, season) {
  const o = offering(code);
  if (!o.known) {
    return "unknown";
  }
  const s = o.by[season];
  return !s.n ? "no" : s.n === s.of ? "yes" : "some";
}

// Of every section STAR has for a course, how many carried a Focus letter.
function focusShare(code, letter) {
  const per = starPer(code);
  if (!per) {
    return null;
  }
  const bit = 1 << star.attrs.indexOf(FOCUS_ATTR[letter]);
  let total = 0;
  let withIt = 0;
  per.forEach((a) => {
    if (!a) {
      return;
    }
    a.rows.forEach((r) => {
      total++;
      if (r[5] & bit) {
        withIt++;
      }
    });
  });
  return { total, withIt };
}

function parseMeetings(str) {
  return (str || "").split("|").filter(Boolean).map((m) => {
    const parts = m.split(" ");
    const span = (parts[1] || "").split("-");
    const mins = (x) => parseInt(x.slice(0, 2), 10) * 60 + parseInt(x.slice(2), 10);
    return { days: parts[0], s: mins(span[0] || "0000"), e: mins(span[1] || "0000") };
  });
}

function prettyMeeting(str) {
  const clock = (v) => {
    const h = Math.floor(v / 60);
    return `${h % 12 || 12}:${`0${v % 60}`.slice(-2)}${h < 12 ? "a" : "p"}`;
  };
  return parseMeetings(str).map((x) => `${x.days} ${clock(x.s)}–${clock(x.e)}`).join("; ") || "no set time";
}

function sectionsOf(code, termIndex) {
  const per = starPer(code);
  if (!per || !per[termIndex] || ARRANGED.test(code)) {
    return [];
  }
  return per[termIndex].rows.map((r) => ({ code, r, m: parseMeetings(r[6]) }));
}

// Part-of-term sections (flag 16: summer sessions, half-semester sections)
// can share a weekday and hour without ever meeting in the same weeks, so
// they're never counted as clashing.
function sectionsClash(a, b) {
  if ((a.r[8] & 16) || (b.r[8] & 16)) {
    return false;
  }
  return a.m.some((x) => b.m.some((y) => x.s < y.e && y.s < x.e && x.days.split("").some((d) => y.days.includes(d))));
}

// Could one section of every course have been taken together in that term?
// Courses with no sections that term are left out. Returns the pairs that
// clash in every combination when the answer is no.
function timetableCheck(codes, termIndex) {
  const cand = codes.map((code) => ({ code, secs: sectionsOf(code, termIndex) })).filter((c) => c.secs.length);
  cand.sort((a, b) => a.secs.length - b.secs.length);
  let steps = 0;
  let found = cand.length < 2;
  const chosen = [];
  (function search(i) {
    if (found || steps > 60000) {
      return;
    }
    if (i === cand.length) {
      found = true;
      return;
    }
    for (const sec of cand[i].secs) {
      steps++;
      if (chosen.some((c) => sectionsClash(c, sec))) {
        continue;
      }
      chosen.push(sec);
      search(i + 1);
      chosen.pop();
      if (found) {
        return;
      }
    }
  })(0);
  if (found || steps > 60000) {
    return { ok: true, compared: cand.length };
  }
  const blockers = [];
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      if (cand[i].secs.every((a) => cand[j].secs.every((b) => sectionsClash(a, b)))) {
        blockers.push({ a: cand[i].code, b: cand[j].code, at: prettyMeeting(cand[i].secs[0].r[6]), bt: prettyMeeting(cand[j].secs[0].r[6]) });
      }
    }
  }
  return { ok: false, compared: cand.length, blockers };
}

// ---------- difficulty (local only) ----------

function diffOf(code) {
  return (difficulty && code && difficulty.courses[code]) || null;
}

// The course's numbers, or null when too few reviews back them.
function diffRated(code) {
  const d = diffOf(code);
  return d && d.n >= DIFF_MIN_REVIEWS ? d : null;
}

function diffBand(d) {
  return d >= DIFF_VERY_HARD ? "vhard" : d >= DIFF_HARD ? "hard" : d < DIFF_LIGHT ? "light" : "typical";
}

function diffLine(code, d) {
  return `${code}: difficulty ${d.d.toFixed(1)} of 5 (${DIFF_BAND_LABEL[diffBand(d.d)]}), from ${plural(d.n, "review")}`;
}

// A tooltip: the course's rating, or why there isn't one.
function diffTip(code) {
  const d = diffOf(code);
  if (!d || !d.n) {
    return "No Rate My Professors reviews collected for this course.";
  }
  if (d.n < DIFF_MIN_REVIEWS) {
    return `Only ${plural(d.n, "review")} (difficulty ${d.d.toFixed(1)}): too few to rate.`;
  }
  const recent = d.by.filter((b) => b.taught && !b.overall && b.n >= 3).slice(0, 3)
    .map((b) => `  ${b.name}: ${b.d.toFixed(1)} (${b.n}), last taught ${b.taught}`);
  return [`Difficulty ${d.d.toFixed(1)} of 5: ${DIFF_BAND_LABEL[diffBand(d.d)]}`,
    `${plural(d.n, "review")}, ${d.first}–${d.last} · ${Math.round(d.hard * 100)}% rated it 4 or 5 · quality ${d.q.toFixed(1)}`]
    .concat(recent.length ? ["By instructor:"].concat(recent) : []).join("\n");
}

// How a semester adds up: its rated courses, their credit-weighted average,
// and the hard ones. level is "high" when the hard courses pile up, "mid"
// for two of them or a hard average, otherwise "low". Null when nothing in it is rated.
function semesterDifficulty(sem) {
  if (!difficulty || sem.transfer || sem.gap) {
    return null;
  }
  const rated = [];
  const seen = new Set();
  let unrated = 0;
  sem.items.forEach((item) => {
    const d = item.code && !seen.has(item.code) ? diffRated(item.code) : null;
    if (item.code) {
      seen.add(item.code);
    }
    if (d) {
      rated.push({ code: item.code, d, credits: creditsOf(item) });
    } else {
      unrated += 1;
    }
  });
  if (!rated.length) {
    return null;
  }
  const credits = rated.reduce((sum, r) => sum + r.credits, 0);
  const avg = credits
    ? rated.reduce((sum, r) => sum + r.d.d * r.credits, 0) / credits
    : rated.reduce((sum, r) => sum + r.d.d, 0) / rated.length;
  const hard = rated.filter((r) => r.d.d >= DIFF_HARD).sort((a, b) => b.d.d - a.d.d);
  const hardCredits = hard.reduce((sum, r) => sum + r.credits, 0);
  const level = hard.length >= 3 || hardCredits >= DIFF_HARD_CREDITS ? "high" : hard.length === 2 || (rated.length >= 2 && avg >= DIFF_HARD) ? "mid" : "low";
  return { rated, unrated, avg, hard, hardCredits, level };
}

// The course-details block: the course's numbers, then who teaches it.
function difficultyNode(code) {
  const d = diffOf(code);
  const wrap = el("div", "diff-detail");
  if (!d || !d.n) {
    wrap.appendChild(el("div", "detail-note", "No reviews collected for this course."));
  } else {
    const head = el("div", "diff-head");
    head.appendChild(el("span", `tag tag-diff band-${d.n >= DIFF_MIN_REVIEWS ? diffBand(d.d) : "none"}`, `${d.d.toFixed(1)} of 5`));
    head.appendChild(document.createTextNode(d.n >= DIFF_MIN_REVIEWS
      ? ` ${DIFF_BAND_LABEL[diffBand(d.d)]} · ${Math.round(d.hard * 100)}% of ${plural(d.n, "review")} rated it 4 or 5 · quality ${d.q.toFixed(1)} · ${Math.round(d.again * 100)}% would take it again · ${d.first}–${d.last}`
      : ` from only ${plural(d.n, "review")}: too few to read much into`));
    wrap.appendChild(head);
  }
  const all = (d && d.by) || [];
  const by = all.slice(0, 8);
  if (by.length) {
    const table = el("table", "diff-table");
    const hr = el("tr");
    ["Instructor", "Last taught it", "Difficulty", "Quality", "Reviews"].forEach((h) => hr.appendChild(el("th", null, h)));
    table.appendChild(hr);
    by.forEach((b) => {
      const tr = el("tr", b.n < 3 ? "thin" : null);
      tr.appendChild(el("td", null, b.name));
      tr.appendChild(el("td", null, b.taught || `not since ${difficulty.star_terms[0]}`));
      tr.appendChild(el("td", null, b.d.toFixed(1)));
      tr.appendChild(el("td", null, b.q.toFixed(1)));
      tr.appendChild(el("td", null, b.overall ? `${b.n}, none for this course` : String(b.n)));
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    if (all.length > by.length) {
      wrap.appendChild(el("div", "detail-note", `…and ${all.length - by.length} more.`));
    }
  }
  const note = el("div", "detail-note");
  note.appendChild(document.createTextNode(`Rate My Professors, collected ${difficulty.collected}. Self-selected reviews: read the count before the score. Local only. `));
  const link = el("a", null, "Comments and themes");
  link.href = "../visualizer/analysis.html#profs";
  link.target = "_blank";
  link.rel = "noopener";
  note.appendChild(link);
  wrap.appendChild(note);
  return wrap;
}

// ---------- prerequisites ----------

// Where each course sits in the plan: -1 for the transfer bucket, else the
// semester's index. A substitute (MATH 253A for 243/244) also registers under
// the course it stands in for.
function buildPositions(semesters) {
  const pos = new Map();
  const note = (code, index) => {
    if (!pos.has(code) || pos.get(code) > index) {
      pos.set(code, index);
    }
  };
  semesters.forEach((sem, i) => {
    const index = sem.transfer ? -1 : i;
    sem.items.forEach((item) => {
      if (item.code) {
        note(item.code, index);
      }
    });
  });
  // A substitute stands in from the semester it's finished: for a set that
  // substitutes together (ICS 141 and 241 for ECE 362), the later of them.
  const direct = new Map(pos);
  const subs = prog().substitutes || {};
  Object.keys(subs).forEach((orig) => subs[orig].forEach((alt) => {
    const parts = Array.isArray(alt) ? alt : [alt];
    if (parts.every((code) => direct.has(code))) {
      note(orig, Math.max(...parts.map((code) => direct.get(code))));
    }
  }));
  // The same course under two department prefixes: whichever was taken
  // counts for both.
  (prog().equivalents || []).forEach((group) => {
    const have = group.filter((code) => pos.has(code)).map((code) => pos.get(code));
    if (have.length) {
      group.forEach((code) => note(code, Math.min(...have)));
    }
  });
  return pos;
}

// true = met, false = not met, null = can't tell (the catalog's text has a
// condition that isn't a course: a placement exam, a grade, class standing).
// Consent alone is "not met": the plan can't assume it.
function evalTree(tree, when, pos, forceConcurrent) {
  if (!tree) {
    return true;
  }
  if (tree.course) {
    const p = pos.get(tree.course);
    if (p === undefined) {
      return false;
    }
    return forceConcurrent || tree.concurrent ? p <= when : p < when;
  }
  if (tree.type) {
    return tree.type === "consent" ? false : null;
  }
  const vals = (tree.children || []).map((c) => evalTree(c, when, pos, forceConcurrent));
  if (tree.op === "AND") {
    return vals.includes(false) ? false : vals.includes(null) ? null : true;
  }
  if (tree.op === "OR") {
    return vals.includes(true) ? true : vals.includes(null) ? null : false;
  }
  if (tree.op === "N_OF") {
    const need = tree.n || vals.length;
    const yes = vals.filter((v) => v === true).length;
    const maybe = vals.filter((v) => v === null).length;
    return yes >= need ? true : yes + maybe >= need ? null : false;
  }
  return null;
}

// Every course code a prereq/coreq tree names.
function courseLeaves(tree, out) {
  out = out || [];
  if (!tree) {
    return out;
  }
  if (tree.course) {
    out.push(tree.course);
  }
  (tree.children || []).forEach((child) => courseLeaves(child, out));
  return out;
}

function mentionsCourse(tree) {
  return !!tree && (!!tree.course || (tree.children || []).some(mentionsCourse));
}

// The shortest list of courses that would have to come first. For an OR,
// the alternative that's closest to done.
function missingCourses(tree, when, pos, forceConcurrent) {
  if (!tree) {
    return [];
  }
  if (tree.course) {
    return evalTree(tree, when, pos, forceConcurrent) ? [] : [tree.course];
  }
  if (!tree.op) {
    return [];
  }
  const kids = (tree.children || []).filter(mentionsCourse).map((k) => missingCourses(k, when, pos, forceConcurrent));
  if (tree.op === "OR") {
    // Fewest courses first; between equals, the one already in the plan
    // (just scheduled too late) over one the student would have to add.
    const absent = (list) => list.filter((code) => !pos.has(code)).length;
    return kids.length ? kids.slice().sort((a, b) => a.length - b.length || absent(a) - absent(b))[0] : [];
  }
  return Array.from(new Set([].concat(...kids)));
}

function isSummer(sem) {
  return !!sem && !sem.transfer && parseTerm(sem.term).season === "Summer";
}

// {ok, missing, consentOnly} for a course placed in semester `when`.
//
// `splitTerm` is for summers, which run as two sessions back to back: a
// prerequisite in the same summer can be finished in the first session
// before the course starts in the second (CHEM 272 then CHEM 273). When
// that's what makes the prerequisite work, `backToBack` lists the courses
// that have to come in the earlier session.
function prereqStatus(code, when, pos, splitTerm) {
  const strict = prereqStatusIn(code, when, pos, false);
  if (!splitTerm || strict.ok !== false) {
    return strict;
  }
  const relaxed = prereqStatusIn(code, when, pos, true);
  if (relaxed.ok === false) {
    return strict;
  }
  relaxed.backToBack = strict.missing.filter((m) => pos.get(m) === when);
  return relaxed;
}

function prereqStatusIn(code, when, pos, sameTermOk) {
  const c = course(code);
  if (!c || when < 0) {
    return { ok: true, missing: [] };
  }
  const pre = evalTree(c.p, when, pos, sameTermOk);
  const co = evalTree(c.q, when, pos, true);
  const missing = (pre === false ? missingCourses(c.p, when, pos, sameTermOk) : [])
    .concat(co === false ? missingCourses(c.q, when, pos, true) : []);
  const ok = pre === false || co === false ? false : pre === null || co === null ? null : true;
  const consentOnly = ok === false && !mentionsCourse(c.p) && !mentionsCourse(c.q);
  // c.u: the catalog's wording didn't parse cleanly, so a "not met" may be
  // the parser's mistake rather than the plan's (see build_planner_data.py).
  return { ok, missing: Array.from(new Set(missing)), consentOnly, coreqFailed: co === false && pre !== false, unsure: ok === false && !!c.u };
}

// ---------- requirements ----------

// Works out which requirement every course in the plan counts toward. A
// course counts once (Focus aside, which overlays everything), in the check
// sheet's own priority: named requirement, Group I, Group II up to its
// minimum, technical elective, engineering breadth, then the gen-ed slots.
// An item's `as` (set in its details) overrides the automatic choice.
function evaluatePlan() {
  const v = pv();
  const entries = [];
  plan.semesters.forEach((sem, i) => {
    sem.items.forEach((item) => entries.push({ item, sem, index: sem.transfer ? -1 : i }));
  });
  const courses = entries.filter((e) => e.item.code);
  const used = new Map();
  const free = (e) => !used.has(e.item.id);
  const take = (e, cat, label, pool) => used.set(e.item.id, { cat, label: label || CATEGORY_LABEL[cat], pool: pool || null });
  const cr = (list) => list.reduce((sum, e) => sum + creditsOf(e.item), 0);
  const wants = (e, as, auto) => e.item.as === as || (!e.item.as && auto(e.item.code));
  const byCode = (code) => courses.find((e) => e.item.code === code) || null;

  // Required courses: the course itself, or whatever the sheet lets stand in
  // for it. One substitute can cover two requirements (MATH 253A for 243 and
  // 244), so a substitute is found even if it's already been counted.
  //
  // When a substitute is already standing in for one requirement, it stands
  // in for everything else it covers too, even if the plan also has that
  // course itself: with CHEM 171 in place of CHEM 161, CHEM 171 covers CHEM
  // 162 as well (check sheet note 3), so a CHEM 162 in the plan isn't the
  // "required" one -- it's free to count as something else (pre-med's
  // second semester of chemistry, say) or as an elective.
  const subs = v.program.substitutes || {};
  const substituteFor = (group) => {
    let found = null;
    group.some((code) => (subs[code] || []).some((alt) => {
      const parts = (Array.isArray(alt) ? alt : [alt]).map(byCode);
      found = parts.every(Boolean) ? parts : null;
      return !!found;
    }));
    return found;
  };
  const subKey = (parts) => parts.map((e) => e.item.code).join("+");
  const inUse = new Set();
  v.fixedGroups.forEach((group) => {
    const parts = substituteFor(group);
    if (parts && !courses.some((e) => group.includes(e.item.code))) {
      inUse.add(subKey(parts));
    }
  });
  const fixed = v.fixedGroups.map((group) => {
    const parts = substituteFor(group);
    let entry = parts && inUse.has(subKey(parts)) ? null : courses.find((e) => free(e) && group.includes(e.item.code)) || null;
    if (entry) {
      take(entry, "fixed");
    } else if (parts) {
      parts.forEach((part) => take(part, "fixed"));
      entry = parts[0];
    }
    return { group, entry };
  });

  // The major's elective pools, in the order the check sheet's rules need.
  const pools = v.pools.map((pool) => {
    const res = { pool, items: [], credits: 0, need: pool.need || 0, approval: [], skipped: [], extras: [], manual: !!pool.manualKey && vizManual.has(pool.manualKey) };
    const add = (e) => {
      take(e, pool.cat, pool.label, pool.id);
      res.items.push(e);
      res.credits += creditsOf(e.item);
    };
    if (pool.kind === "all") {
      res.parts = pool.codes.map((code) => {
        const entry = courses.find((e) => free(e) && e.item.code === code) || null;
        if (entry) {
          add(entry);
        }
        return { code, entry };
      });
      res.need = pool.codes.length;
      res.met = res.parts.every((part) => part.entry);
      return res;
    }
    const limits = pool.limits || [];
    const counted = limits.map(() => 0);
    courses.filter((e) => free(e) && wants(e, pool.id, (code) => poolTakes(pool, code))).forEach((e) => {
      const code = e.item.code;
      const explicit = e.item.as === pool.id;
      if (!pool.greedy && res.credits >= res.need && !explicit) {
        return;
      }
      const hits = limits.map((limit) => limit.test(code));
      const over = hits.findIndex((hit, i) => hit && counted[i] >= limits[i].count);
      if (over >= 0) {
        res.skipped.push({ entry: e, limit: limits[over] });
        return;
      }
      hits.forEach((hit, i) => {
        if (hit) {
          counted[i]++;
        }
      });
      add(e);
      if (pool.approval ? pool.approval(code) : !poolTakes(pool, code)) {
        res.approval.push(e);
      }
    });
    res.extras = (pool.extras || []).map((extra) => ({
      extra, have: cr(res.items.filter((e) => extra.counts(e.item.code))),
    }));
    res.met = res.manual || res.credits >= res.need;
    return res;
  });
  const poolById = {};
  pools.forEach((res) => {
    poolById[res.pool.id] = res;
  });
  const minima = v.minima.map((min) => ({
    min, have: min.pools.reduce((sum, id) => sum + (poolById[id] ? poolById[id].credits : 0), 0),
  }));

  // FG: two courses, preferring two different groups when the plan has them.
  const fgCands = courses.filter((e) => free(e) && wants(e, "FG", fgGroup));
  const fg = { items: [], need: 2 };
  if (fgCands.length) {
    fg.items.push(fgCands[0]);
    const second = fgCands.find((e) => e !== fgCands[0] && fgGroup(e.item.code) !== fgGroup(fgCands[0].item.code)) || fgCands[1];
    if (second) {
      fg.items.push(second);
    }
  }
  fg.items.forEach((e) => take(e, "gened", `FG${fgGroup(e.item.code) ? ` (${fgGroup(e.item.code)})` : ""}`));
  fg.sameGroup = fg.items.length === 2 && !!fgGroup(fg.items[0].item.code) && fgGroup(fg.items[0].item.code) === fgGroup(fg.items[1].item.code);

  const hasTag = (tags) => (code) => genedOf(code).some((g) => tags.includes(g));
  const dhdl = { entry: courses.find((e) => free(e) && wants(e, "DHDL", hasTag(["DH", "DL"]))) || null };
  if (dhdl.entry) {
    take(dhdl.entry, "gened", genedOf(dhdl.entry.item.code).includes("DL") ? "DL" : "DH");
  }
  // DS: one course besides the named ECON one, from a different subject. A
  // second ECON course is never counted, even if the student set it to.
  const dsCands = courses.filter((e) => free(e) && wants(e, "DS", hasTag(["DS"])));
  const sameSubject = (e) => requiredDsSubjects().has(subjectOf(e.item.code));
  const ds = { entry: dsCands.find((e) => !sameSubject(e)) || null, rejected: dsCands.filter(sameSubject) };
  if (ds.entry) {
    take(ds.entry, "gened", "DS");
  }

  const focus = {};
  FOCUS_LETTERS.forEach((letter) => {
    focus[letter] = { items: courses.filter((e) => focusOf(e.item).includes(letter)), need: FOCUS_NEED[letter] };
  });
  focus.W.upper = focus.W.items.filter((e) => courseNumber(e.item.code) >= 300).length;

  // The prereq map's manual gen-ed checkboxes count here too. Its Focus
  // checkboxes deliberately don't: Focus here is always counted from the
  // courses actually in this plan, so "done" always points at a course. A
  // Focus earned some other way is recorded by ticking it on the course it
  // came with (course details).
  fg.manual = ["__gened_FG1", "__gened_FG2"].filter((k) => vizManual.has(k)).length;
  dhdl.manual = vizManual.has("__gened_DHDL");
  ds.manual = vizManual.has("__gened_DS");

  const premed = plan.premed ? evaluatePremed(courses, used) : null;

  return {
    entries, courses, used, fixed, pools, poolById, minima, fg, dhdl, ds, focus,
    premed,
    placeholders: entries.filter((e) => e.item.slot),
    credits: cr(entries),
  };
}

// Which of JABSOM's prerequisites the plan covers. Courses that count toward
// nothing in the EE degree get the "Pre-med" label (and color) on their tile.
function evaluatePremed(courses, used) {
  const have = new Map();
  courses.forEach((e) => {
    if (!have.has(e.item.code)) {
      have.set(e.item.code, e);
    }
  });
  const label = (e) => {
    if (e && !used.has(e.item.id)) {
      used.set(e.item.id, { cat: "premed", label: CATEGORY_LABEL.premed });
    }
  };
  const groups = PREMED.groups.map((group) => {
    const slots = group.slots.map((options) => {
      const entry = options.map((code) => have.get(code)).find(Boolean) || null;
      label(entry);
      return { options, entry };
    });
    return { name: group.name, detail: group.detail, slots, met: slots.filter((s) => s.entry).length };
  });
  const recommended = PREMED.recommended.map((rec) => {
    const entries = rec.codes.map((code) => have.get(code)).filter(Boolean);
    entries.forEach(label);
    return { name: rec.name, codes: rec.codes, entries };
  });
  // Courses taken only because a pre-med course needs them first (BIOL 275
  // and 275L for BIOL 402) are pre-med too: follow the prerequisites of
  // everything labeled so far, as far down as they go.
  const support = [];
  const seen = new Set();
  const follow = (code) => {
    if (seen.has(code)) {
      return;
    }
    seen.add(code);
    const c = course(code);
    [c && c.p, c && c.q].forEach((tree) => courseLeaves(tree).forEach((leaf) => {
      const e = have.get(leaf);
      if (e && !used.has(e.item.id)) {
        label(e);
        support.push(e);
      }
      if (e) {
        follow(leaf);
      }
    }));
  };
  const core = new Set([].concat(...groups.map((g) => g.slots), recommended.map((r) => ({ entry: r.entries[0] })))
    .filter((x) => x.entry).map((x) => x.entry.item.code));
  core.forEach(follow);
  // And whatever the student marked "Counts toward: Pre-med" themselves.
  courses.filter((e) => e.item.as === "premed" && !used.has(e.item.id)).forEach((e) => {
    label(e);
    support.push(e);
  });
  return { groups, recommended, support };
}

function premedCodes() {
  const codes = [].concat(...PREMED.groups.map((g) => [].concat(...g.slots)), ...PREMED.recommended.map((r) => r.codes));
  return Array.from(new Set(codes));
}

const MANUAL_NOTE = "marked done in the prereq map";

function focusMet(f) {
  return f.items.length >= f.need;
}

function fgCount(ev) {
  return Math.min(ev.fg.need, ev.fg.items.length + ev.fg.manual);
}

function categoryOf(item, ev) {
  if (item.slot) {
    const def = slotDef(item.slot);
    return def ? { cat: def.cat, label: def.label } : { cat: "extra", label: item.slot };
  }
  return ev.used.get(item.id) || { cat: "extra", label: CATEGORY_LABEL.extra };
}

// Which still-open gen-ed / Focus needs a course would cover -- what makes
// one course a better pick than another for the same slot.
function openNeeds(ev) {
  return {
    FG: fgCount(ev) < ev.fg.need, DHDL: !ev.dhdl.entry && !ev.dhdl.manual, DS: !ev.ds.entry && !ev.ds.manual,
    W: !focusMet(ev.focus.W), O: !focusMet(ev.focus.O), E: !focusMet(ev.focus.E), H: !focusMet(ev.focus.H),
  };
}

function coversOf(code, open) {
  const c = course(code);
  if (!c) {
    return [];
  }
  const out = [];
  const g = c.g || [];
  if (open.FG && fgGroup(code)) {
    out.push(fgGroup(code));
  }
  if (open.DHDL && (g.includes("DH") || g.includes("DL"))) {
    out.push(g.includes("DH") ? "DH" : "DL");
  }
  if (open.DS && countsAsSecondDs(code)) {
    out.push("DS");
  }
  (c.f || []).forEach((letter) => {
    if (open[letter]) {
      out.push(letter);
    }
  });
  return out;
}

// ---------- the rule check ----------

const PREMED_GROUP = "Pre-med (JABSOM) not yet met";
const ISSUE_GROUPS = ["Prerequisites", "When courses run", "Time conflicts", "Credit load", "Difficulty", "Requirements not yet met", PREMED_GROUP, "Worth knowing"];

function runChecks(ev) {
  const issues = [];
  const add = (level, group, text, where) => issues.push(Object.assign({ level, group, text }, where || {}));
  // Extra explanation for the issue just added, shown when it's expanded
  // in the report (see issueSections()).
  const explain = (sections) => {
    issues[issues.length - 1].sections = sections;
  };
  const pos = buildPositions(plan.semesters);

  // Prerequisites and corequisites, in plan order.
  ev.courses.forEach((e) => {
    if (e.sem.transfer) {
      return;
    }
    const c = course(e.item.code);
    const code = e.item.code;
    const where = { itemId: e.item.id };
    if (!c) {
      add("info", "Worth knowing", `${code} isn't in the 2026–2027 catalog, so its prerequisites can't be checked.`, where);
      return;
    }
    const st = prereqStatus(code, e.index, pos, isSummer(e.sem));
    if (st.backToBack && st.backToBack.length && !isCompleted(e.sem)) {
      // Already done that way in a past summer: nothing left to say.
      add("info", "Prerequisites", `${code} and its prerequisite ${st.backToBack.join(", ")} are both in ${e.sem.term}. That works back to back: ${st.backToBack.join(", ")} in the first summer session, ${code} in the second. Registering for both at once may need a prerequisite waiver.`, where);
    }
    if (st.ok === false && st.consentOnly) {
      add("info", "Prerequisites", `${code} (${e.sem.term}) needs instructor consent: ${c.pr || c.qr}`, where);
    } else if (st.ok === false && st.unsure) {
      add("info", "Prerequisites", `${code} in ${e.sem.term}: couldn't confirm the prerequisite from the catalog's wording. Read it yourself: “${(c.pr || c.qr || "").trim()}”`, where);
    } else if (st.ok === false) {
      const parts = st.missing.map((m) => {
        const p = pos.get(m);
        if (p === undefined) {
          return `${m} (not in your plan)`;
        }
        return `${m} (${p === e.index ? "same semester" : `not until ${plan.semesters[p].term}`})`;
      });
      const kind = st.coreqFailed ? "corequisite" : "prerequisite";
      const raw = st.coreqFailed ? c.qr : c.pr;
      add("error", "Prerequisites", `${code} in ${e.sem.term}: ${kind} not in place — needs ${parts.join(", ") || raw}.${raw ? ` Catalog: “${raw.trim()}”` : ""}`, where);
      explain([{
        title: "How to fix it",
        lines: st.missing.map((m) => {
          const at = pos.get(m);
          if (at === undefined) {
            return `Add ${m} to a semester before ${e.sem.term}${st.coreqFailed ? " (or the same one: it's a corequisite)" : ""}.`;
          }
          return st.coreqFailed
            ? `Move ${m} into ${e.sem.term} or earlier, or move ${code} to ${plan.semesters[at].term} or later.`
            : `Move ${m} to a semester before ${e.sem.term}, or move ${code} to one after ${plan.semesters[at].term}.`;
        }).concat(mentionsConsent(st.coreqFailed ? c.q : c.p) ? ["The catalog also allows instructor consent in place of the prerequisite."] : []),
      }]);
    }
    const standing = /\b(sophomore|junior|senior) standing/i.exec(c.r || "");
    if (standing) {
      const level = standing[1].toLowerCase();
      const before = ev.entries.filter((x) => x.index < e.index).reduce((sum, x) => sum + creditsOf(x.item), 0);
      if (before < STANDING_CREDITS[level]) {
        add("warn", "Prerequisites", `${code} in ${e.sem.term} needs ${level} standing (${STANDING_CREDITS[level]}+ credits) or consent; this plan has ${before} credits before then.`, where);
        explain([{
          title: "Class standing",
          lines: [
            `Sophomore ${STANDING_CREDITS.sophomore}+ credits, junior ${STANDING_CREDITS.junior}+, senior ${STANDING_CREDITS.senior}+.`,
            `Credits in this plan before ${e.sem.term}: ${before}. Short by ${STANDING_CREDITS[level] - before}.`,
            "Standing is counted from credits earned, so transfer and AP credit under “already completed” help.",
          ],
        }]);
      }
    }
  });

  // Does each course actually run in the season it's planned for?
  if (star) {
    const span = `${star.terms[0].name} – ${star.terms[star.terms.length - 1].name}`;
    ev.courses.forEach((e) => {
      if (isCompleted(e.sem) || !course(e.item.code)) {
        return;
      }
      const code = e.item.code;
      const season = parseTerm(e.sem.term).season;
      const o = offering(code);
      const where = { itemId: e.item.id };
      if (o.arranged) {
        return;
      }
      if (!o.per) {
        add("warn", "When courses run", `${code} (${e.sem.term}) didn't run at all in ${span}. Ask the department whether it will be offered.`, where);
        return;
      }
      const st = seasonStatus(code, season);
      const s = o.by[season];
      const better = ["Fall", "Spring", "Summer"].filter((x) => x !== season && o.by[x].n === o.by[x].of && o.by[x].of);
      const moveTo = {
        title: "What to do",
        lines: better.length
          ? [`It ran every ${better.join(" and every ")} STAR has. Move it to a ${better.join(" or ")} semester.`]
          : ["It hasn't run reliably in any season. Ask the department when it's next planned."],
      };
      if (st === "no") {
        add("error", "When courses run", `${code} is planned for ${e.sem.term}, but it ran in none of the last ${plural(s.of, `${season} term`)} (${o.label}).`, where);
        explain([moveTo]);
      } else if (st === "some") {
        add("warn", "When courses run", `${code} (${e.sem.term}) ran in only ${s.n} of the last ${plural(s.of, `${season} term`)} (${o.label}).`, where);
        explain([moveTo]);
      }
    });
  } else {
    add("info", "Worth knowing", "STAR's section history couldn't be loaded, so “when courses run” and time conflicts weren't checked.");
  }

  // Per semester: time conflicts (against STAR's real timetables) and load.
  // Finished semesters are history: nothing left to register for or fit.
  plan.semesters.forEach((sem) => {
    if (isCompleted(sem)) {
      return;
    }
    const season = parseTerm(sem.term).season;
    const credits = sem.items.reduce((sum, it) => sum + creditsOf(it), 0);
    const where = { semId: sem.id };
    if (season !== "Summer") {
      if (credits > MAX_CREDITS) {
        add("error", "Credit load", `${sem.term} has ${credits} credits. More than ${MAX_CREDITS} needs approval from the college.`, where);
      } else if (credits >= HEAVY_CREDITS) {
        add("warn", "Credit load", `${sem.term} has ${credits} credits, a heavy semester.`, where);
      } else if (credits > 0 && credits < FULL_TIME_CREDITS) {
        add("info", "Credit load", `${sem.term} has ${credits} credits, below full-time (${FULL_TIME_CREDITS}).`, where);
      }
    } else if (credits > 9) {
      add("warn", "Credit load", `${sem.term} has ${credits} credits, a lot for a summer.`, where);
    }
    // Hard courses piling up (local only: needs the difficulty file).
    const load = semesterDifficulty(sem);
    if (load && load.hard.length >= 2) {
      const names = load.hard.map((r) => `${r.code} (${r.d.d.toFixed(1)})`).join(", ");
      const heavy = credits >= HEAVY_CREDITS - 1;
      if (load.level === "high" || heavy) {
        add("warn", "Difficulty", `${sem.term} stacks ${load.hard.length} courses reviewers rate hard — ${names} — ${load.hardCredits} of its ${credits} credits${heavy && load.level !== "high" ? ", in an already heavy semester" : ""}. Consider moving one.`, where);
      } else {
        add("info", "Difficulty", `${sem.term} has two courses reviewers rate hard: ${names}.`, where);
      }
      explain([
        { title: "Every rated course this semester", lines: load.rated.slice().sort((a, b) => b.d.d - a.d.d).map((r) => diffLine(r.code, r.d)) },
        { title: "How this is judged", lines: [
          `Difficulty is the average 1–5 score Rate My Professors reviewers gave the course, across every instructor; ${DIFF_HARD.toFixed(1)} and up counts as hard (about a quarter of rated courses).`,
          `A semester is flagged at three hard courses or ${DIFF_HARD_CREDITS} hard credits.${load.unrated ? ` ${plural(load.unrated, "course")} here ${load.unrated === 1 ? "has" : "have"} too few reviews to rate and ${load.unrated === 1 ? "isn't" : "aren't"} counted either way.` : ""}`,
          "Reviews are self-selected and who teaches a course changes how hard it is: open a course for its instructors.",
        ] },
      ]);
    }
    if (!star) {
      return;
    }
    const codes = Array.from(new Set(sem.items.filter((it) => it.code).map((it) => it.code)));
    const termIndexes = star.seasonTerms[season];
    const results = termIndexes.map((ti) => ({ ti, res: timetableCheck(codes, ti) })).filter((x) => x.res.compared >= 2);
    const bad = results.filter((x) => !x.res.ok);
    if (!bad.length) {
      return;
    }
    const latest = results[results.length - 1];
    const shown = !latest.res.ok ? latest : bad[bad.length - 1];
    const termName = star.terms[shown.ti].name;
    const pairs = shown.res.blockers.map((b) => `${b.a} (${b.at}) and ${b.b} (${b.bt})`).join("; ");
    const how = pairs ? `${pairs} overlapped in every section` : "no combination of sections fit without an overlap";
    const tally = `That happened in ${bad.length} of the ${results.length} ${season} terms STAR has.`;
    if (!latest.res.ok) {
      add(bad.length === results.length ? "error" : "warn", "Time conflicts", `${sem.term}: in ${termName}, ${how}. ${tally}`, where);
    } else {
      add("info", "Time conflicts", `${sem.term}: these fit together in ${star.terms[latest.ti].name}, but in ${termName} ${how}.`, where);
    }
    explain(conflictSections(sem, codes, results, shown));
  });

  // Requirements.
  const req = "Requirements not yet met";
  ev.placeholders.forEach((e) => {
    const def = slotDef(e.item.slot);
    add("warn", req, `${semesterName(e.sem)}: the ${def ? def.label : e.item.slot} slot still needs a real course.`, { itemId: e.item.id, rule: e.item.slot });
  });
  // An unfilled slot already says "this still needs a course", so the
  // matching "not enough credits" line would only repeat it.
  const reserved = (slots) => ev.placeholders.filter((e) => slots.includes(e.item.slot)).reduce((sum, e) => sum + creditsOf(e.item), 0);
  const missingFixed = ev.fixed.filter((f) => !f.entry).map((f) => f.group.join(" or "));
  if (missingFixed.length) {
    add("error", req, `Required courses not in the plan: ${missingFixed.join(", ")}.`, { rule: "fixed" });
  }
  ev.pools.forEach((res) => {
    const pool = res.pool;
    const slotIds = Object.keys(pool.slots || {});
    const rule = slotIds[0];
    if (pool.kind === "all") {
      const missing = res.parts.filter((part) => !part.entry).map((part) => part.code);
      if (missing.length) {
        add("error", req, `${pool.name} courses not in the plan: ${missing.join(", ")}.`, { rule });
      }
      return;
    }
    if (!res.manual && res.credits + reserved(slotIds) < res.need) {
      add("error", req, `${pool.name}: ${res.credits} of ${res.need} credits planned.`, { rule });
    }
    res.extras.forEach((x) => {
      if (res.credits > 0 && x.have < x.extra.need) {
        add("error", req, `${pool.name}: ${x.have} of the ${plural(x.extra.need, "credit")} ${x.extra.label}.`, { rule: x.extra.slot || rule });
      }
    });
    res.approval.forEach((e) => {
      add("warn", req, `${e.item.code} ${pool.approvalNote}`, { itemId: e.item.id });
    });
    if (pool.caseByCase) {
      res.items.filter((e) => pool.caseByCase(e.item.code)).forEach((e) => {
        add("info", req, `${e.item.code} ${pool.caseNote}`, { itemId: e.item.id });
      });
    }
    res.skipped.forEach((skip) => {
      add("warn", req, `${skip.entry.item.code} isn't counting toward ${pool.name.toLowerCase()}: only ${skip.limit.count} ${skip.limit.label} may count, and another already does.`, { itemId: skip.entry.item.id, rule });
    });
  });
  if (fgCount(ev) + reserved(["FG"]) / GENED_SLOTS.FG.credits < ev.fg.need) {
    add("error", req, `FG: ${fgCount(ev)} of 2 courses planned.`, { rule: "FG" });
  } else if (ev.fg.sameGroup) {
    const group = fgGroup(ev.fg.items[0].item.code);
    add("error", req, `FG: ${ev.fg.items[0].item.code} and ${ev.fg.items[1].item.code} are both ${group}. The two FG courses must come from different groups.`, { itemId: ev.fg.items[1].item.id });
  }
  if (!ev.dhdl.entry && !ev.dhdl.manual && !reserved(["DHDL"])) {
    add("error", req, "DH or DL: no Humanities or Literatures course planned.", { rule: "DHDL" });
  }
  if (!ev.ds.entry && !ev.ds.manual) {
    const econ = ev.fixed.find((f) => f.group.some((code) => requiredDsSubjects().has(subjectOf(code))));
    const required = econ && econ.entry ? econ.entry.item.code : "the required ECON course";
    if (ev.ds.rejected.length) {
      const extra = ev.ds.rejected[0];
      add("error", req, `DS: ${extra.item.code} can't be your second DS. It's the same subject as ${required}, and the two DS courses must come from different subjects. Swap it for a DS course outside ${subjectOf(extra.item.code)}.`, { itemId: extra.item.id, rule: "DS" });
    } else if (!reserved(["DS"])) {
      add("error", req, "DS: no Social Sciences course planned besides the required ECON course.", { rule: "DS" });
    }
  }
  FOCUS_LETTERS.forEach((letter) => {
    const f = ev.focus[letter];
    if (!focusMet(f)) {
      add("error", req, `${letter} Focus (${FOCUS_NAME[letter]}): ${f.items.length} of ${f.need} planned.`, { rule: letter });
    }
  });
  if (ev.focus.W.items.length >= ev.focus.W.need && ev.focus.W.upper < W_UPPER_NEED) {
    add("error", req, `W Focus: only ${ev.focus.W.upper} of the ${W_UPPER_NEED} that must be at the 300 level or higher.`, { rule: "W" });
  }
  // Credit totals that span pools, once each pool is complete on its own.
  ev.minima.forEach((m) => {
    const complete = m.min.pools.every((id) => ev.poolById[id] && ev.poolById[id].met);
    if (complete && m.have < m.min.need) {
      const last = ev.poolById[m.min.pools[m.min.pools.length - 1]].pool;
      add("error", req, `${m.min.name}: ${m.have} of the ${m.min.need} ${m.min.label}.`, { rule: Object.keys(last.slots || {})[0] });
    }
  });

  // Things that aren't wrong, but that a student should know.
  const seen = new Map();
  ev.courses.forEach((e) => {
    if (seen.has(e.item.code)) {
      // Project and directed-study courses are meant to be taken more than
      // once (the capstone, ECE 496, usually runs two semesters).
      if (REPEATABLE.test(e.item.code)) {
        return;
      }
      add("warn", "Worth knowing", `${e.item.code} is in the plan twice (${semesterName(seen.get(e.item.code))} and ${semesterName(e.sem)}).`, { itemId: e.item.id });
    } else {
      seen.set(e.item.code, e.sem);
    }
  });
  pv().fixedGroups.forEach((group) => {
    // Only worth saying when the second one isn't counting as something
    // else (a second ECON course is a perfectly good DS).
    const have = group.filter((code) => seen.has(code));
    const spare = ev.courses.some((e) => group.includes(e.item.code) && !ev.used.has(e.item.id));
    if (have.length > 1 && spare) {
      add("info", "Worth knowing", `${have.join(" and ")} are alternatives on the check sheet: only one is required.`);
    }
  });
  if (star) {
    ev.courses.forEach((e) => {
      if (isCompleted(e.sem)) {
        return;
      }
      const code = e.item.code;
      focusOf(e.item).forEach((letter) => {
        const share = focusShare(code, letter);
        if (share && share.total && share.withIt / share.total < 0.5) {
          add("info", "Worth knowing", `${code} counts as ${letter} Focus here, but only ${share.withIt} of its ${plural(share.total, "section")} in STAR carried it. Register for a ${letter} section.`, { itemId: e.item.id });
        }
      });
      const per = starPer(code);
      if (!per || ARRANGED.test(code)) {
        return;
      }
      const regular = star.terms.map((term, i) => (term.season !== "Summer" && per[i] ? per[i] : null)).filter(Boolean).slice(-3);
      const full = regular.filter((a) => a.seats && a.taken >= a.seats * 0.95).length;
      if (regular.length >= 2 && full >= 2) {
        add("info", "Worth knowing", `${code} was 95%+ full in ${full} of its last ${regular.length} Fall/Spring terms. Register on your first day.`, { itemId: e.item.id });
      }
    });
  }
  // Whatever else this major's check sheet says.
  if (prog().checks) {
    prog().checks(ev, add);
  }
  (prog().notes || []).forEach((note) => add("info", "Worth knowing", `${prog().name}: ${note}`));
  if (ev.premed) {
    ev.premed.groups.forEach((group) => {
      const missing = group.slots.filter((s) => !s.entry).map((s) => s.options.filter((code) => course(code)).slice(0, 2).join(" or "));
      if (missing.length) {
        add("error", PREMED_GROUP, `${group.name} (${group.detail}): still needs ${missing.join(", ")}.`);
        explain([{
          title: "Courses that fill each open slot",
          lines: group.slots.filter((slot) => !slot.entry).map((slot) => slot.options.filter((code) => course(code)).map((code) => `${code} ${titleOf(code)}`).join("  or  ")),
        }, {
          title: "Already in your plan",
          lines: group.slots.filter((slot) => slot.entry).map((slot) => whereText(slot.entry)).concat(group.met ? [] : ["Nothing yet."]),
        }]);
        issues[issues.length - 1].rule = "PM";
      }
    });
    if (ev.credits < PREMED.credits) {
      add("error", PREMED_GROUP, `JABSOM needs ${PREMED.credits} college-level semester credits; this plan has ${ev.credits}.`);
    }
    const inPlan = (codes) => codes.filter((code) => ev.courses.some((e) => e.item.code === code));
    // A second semester of general chemistry with its lab on top of the
    // accelerated course makes the full academic year: nothing to caution.
    const fullYear = inPlan(["CHEM 162", "CHEM 162L"]).length === 2;
    if (inPlan(PREMED_ACCELERATED_CHEM).length && !fullYear) {
      add("warn", "Worth knowing", `Pre-med: ${inPlan(PREMED_ACCELERATED_CHEM).join(", ")} is a one-semester general chemistry sequence. JABSOM asks for one academic year: confirm with admissions that it counts.`);
    }
    if (inPlan(PREMED_CALC_PHYSICS).length) {
      add("info", "Worth knowing", `Pre-med: JABSOM describes its physics prerequisite as non-calculus physics. ${inPlan(PREMED_CALC_PHYSICS).join(" and ")} cover the same topics with calculus; confirm with admissions that they count.`);
    }
    add("info", "Worth knowing", "Pre-med: the MCAT and AAMC PREview must both be taken within three years of the year you'd start medical school, and every prerequisite must be finished before matriculation.");
  }
  return issues;
}

function mentionsConsent(tree) {
  return !!tree && (tree.type === "consent" || (tree.children || []).some(mentionsConsent));
}

// STAR's record of a course, one line per captured term.
function termHistoryLines(code) {
  const per = starPer(code);
  if (!star || !per) {
    return [];
  }
  return star.terms.map((term, i) => {
    const a = per[i];
    if (!a) {
      return `${term.name}: did not run`;
    }
    const fill = a.seats ? `, ${a.taken} of ${a.seats} seats taken (${Math.round((100 * a.taken) / a.seats)}%)` : "";
    return `${term.name}: ${plural(a.sections, "section")}${fill}`;
  });
}

// The distinct meeting times a course had in one STAR term.
function sectionTimeLines(code, termIndex) {
  const counts = new Map();
  sectionsOf(code, termIndex).forEach((sec) => {
    const key = prettyMeeting(sec.r[6]) + (sec.r[8] & 16 ? " (part of term)" : "");
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts, ([time, n]) => (n > 1 ? `${time} (${plural(n, "section")})` : time));
}

// Time conflicts, spelled out: the verdict for every term of that season
// STAR has, then each course's real section times in the term shown.
function conflictSections(sem, codes, results, shown) {
  const season = parseTerm(sem.term).season;
  const verdicts = results.map((x) => {
    const name = star.terms[x.ti].name;
    if (x.res.ok) {
      return `${name}: a clash-free set of sections existed`;
    }
    const pairs = x.res.blockers.map((b) => `${b.a} and ${b.b}`).join("; ");
    return `${name}: no clash-free set of sections${pairs ? ` (${pairs} always overlapped)` : " (no single pair to blame: the overlaps chain across several courses)"}`;
  });
  const termName = star.terms[shown.ti].name;
  const times = codes.filter((code) => sectionsOf(code, shown.ti).length).map((code) => `${code}: ${sectionTimeLines(code, shown.ti).join("  |  ")}`);
  const skipped = codes.filter((code) => !sectionsOf(code, shown.ti).length);
  const blamed = Array.from(new Set([].concat(...shown.res.blockers.map((b) => [b.a, b.b]))));
  return [
    { title: `Every ${season} term STAR has`, lines: verdicts },
    { title: `Section times in ${termName}`, lines: times.concat(skipped.length ? [`Not compared (no listed times that term): ${skipped.join(", ")}`] : []) },
    {
      title: "What to do",
      lines: [
        blamed.length ? `Move one of ${blamed.join(", ")} to a different semester.` : "Move one of these courses to a different semester and check again.",
        "Timetables are set term by term, so a past clash is a warning, not a certainty. Check the real schedule when it's posted.",
      ],
    },
  ];
}

// What a requirement asks for and what the plan has toward it.
function ruleSections(rule, ev) {
  const preset = presets().find((p) => p.id === rule);
  const where = (list) => (list.length ? list.map((e) => `${whereText(e)} — ${creditsOf(e.item)} cr`) : ["Nothing yet."]);
  const def = pv().slots[rule];
  const res = def && def.pool ? ev.poolById[def.pool.id] : null;
  let counting = null;
  if (rule === "fixed") {
    counting = ev.fixed.filter((f) => !f.entry).map((f) => `Missing: ${f.group.map((code) => `${code} ${titleOf(code)}`).join("  or  ")}`);
  } else if (res && res.pool.kind === "all") {
    counting = res.parts.map((part) => (part.entry ? `✓ ${whereText(part.entry)}` : `Missing: ${part.code} ${titleOf(part.code)} (${offering(part.code).label || "no STAR history"})`));
  } else if (res) {
    counting = where(res.items);
    const tallies = [`Total ${res.credits} of ${res.need} cr`].concat(res.extras.map((x) => `${x.extra.name}: ${x.have} of ${x.extra.need} cr`));
    counting.push(`${tallies.join(" · ")}.`);
    (res.pool.limits || []).forEach((limit) => counting.push(`At most ${limit.count} ${limit.label} may count.`));
    ev.minima.filter((m) => m.min.pools.includes(res.pool.id)).forEach((m) => counting.push(`${m.min.name}: ${m.have} of the ${m.min.need} ${m.min.label}.`));
  } else if (rule === "FG") {
    counting = ev.fg.items.length ? ev.fg.items.map((e) => `${whereText(e)} — ${fgGroup(e.item.code) || "group unknown"}`) : ["Nothing yet."];
  } else if (rule === "DHDL") {
    counting = where(ev.dhdl.entry ? [ev.dhdl.entry] : []);
  } else if (rule === "DS") {
    counting = where(ev.ds.entry ? [ev.ds.entry] : []);
  } else if (ev.focus[rule]) {
    counting = ev.focus[rule].items.length
      ? ev.focus[rule].items.map((e) => `${whereText(e)}${rule === "W" ? (courseNumber(e.item.code) >= 300 ? " — 300+" : " — lower division") : ""}`)
      : ["No course in your plan carries it yet."];
    counting.push("Counted from the Focus letters ticked on each course (click a course to change them).");
  }
  const out = [];
  if (preset) {
    out.push({ title: "The rule", lines: [preset.hint] });
  }
  if (counting) {
    out.push({ title: rule === "fixed" ? "Still needed" : "Counting toward it now", lines: counting });
  }
  return out;
}

// Everything the report shows when an issue is expanded: whatever the check
// attached, the requirement's rule, then the catalog and STAR record of the
// course (or the contents of the semester) it's about.
function issueSections(issue) {
  const out = (issue.sections || []).slice();
  if (issue.rule) {
    ruleSections(issue.rule, view.ev).forEach((sec) => out.push(sec));
  }
  const found = issue.itemId ? findItem(issue.itemId) : null;
  if (found && found.item.code) {
    const code = found.item.code;
    const c = course(code);
    if (c) {
      const catalog = [`${code} — ${c.t}, ${creditsOf(found.item)} cr, in ${semesterName(found.sem)}`];
      catalog.push(`Prerequisite: ${c.pr ? c.pr.trim() : "none listed"}`);
      if (c.qr) {
        catalog.push(`Corequisite: ${c.qr.trim()}`);
      }
      if (c.r) {
        catalog.push(c.r.trim());
      }
      out.push({ title: "Catalog", lines: catalog });
    }
    const history = termHistoryLines(code);
    if (history.length) {
      out.push({ title: `When it has run (STAR) — ${offering(code).label}`, lines: history });
    } else if (star && !ARRANGED.test(code)) {
      out.push({ title: "When it has run (STAR)", lines: [`No sections listed ${star.terms[0].name} – ${star.terms[star.terms.length - 1].name}.`] });
    }
    if (star && !found.sem.transfer) {
      const terms = star.seasonTerms[parseTerm(found.sem.term).season];
      const latest = terms.slice().reverse().find((ti) => sectionsOf(code, ti).length);
      if (latest != null) {
        out.push({ title: `Section times in ${star.terms[latest].name}`, lines: sectionTimeLines(code, latest) });
      }
    }
  }
  const sem = issue.semId ? semesterById(issue.semId) : null;
  if (sem) {
    const credits = sem.items.reduce((sum, it) => sum + creditsOf(it), 0);
    out.push({
      title: `${semesterName(sem)} — ${credits} credits`,
      lines: sem.items.map((it) => (it.code ? `${it.code} ${titleOf(it.code)} — ${creditsOf(it)} cr` : `${slotDef(it.slot) ? slotDef(it.slot).label : it.slot} (not chosen yet) — ${creditsOf(it)} cr`)),
    });
    if (issue.group === "Credit load") {
      out.push({ title: "For reference", lines: [`Full-time is ${FULL_TIME_CREDITS} credits; more than ${MAX_CREDITS} needs the college's approval. The check sheet's own semesters run 14 to 17.`] });
    }
  }
  return out;
}

// ---------- changing the plan ----------

function addCourseTo(sem, code, options) {
  const item = Object.assign({ id: newId(), code }, options || {});
  sem.items.push(item);
  return item;
}

function removeItem(itemId) {
  plan.semesters.forEach((sem) => {
    sem.items = sem.items.filter((it) => it.id !== itemId);
  });
}

function moveItem(itemId, semId, beforeId) {
  const found = findItem(itemId);
  const target = semesterById(semId);
  if (!found || !target) {
    return;
  }
  found.sem.items = found.sem.items.filter((it) => it.id !== itemId);
  const at = beforeId ? target.items.findIndex((it) => it.id === beforeId) : -1;
  if (at >= 0) {
    target.items.splice(at, 0, found.item);
  } else {
    target.items.push(found.item);
  }
}

function addSemester(term) {
  if (term === "transfer") {
    if (!plan.semesters.some((s) => s.transfer)) {
      plan.semesters.push(makeSemester(null));
    }
  } else if (parseTerm(term) && !plan.semesters.some((s) => s.term === term)) {
    plan.semesters.push(makeSemester(term));
  }
  sortSemesters();
}

// For a pool whose every course is required (EE's Group I), which course goes
// in which of its slots on the grid: every arrangement is scored by whether
// each course runs in its slot's season and has its prereqs/coreqs in place.
function assignCoreSlots(v, terms) {
  const out = new Map();
  const basePos = new Map();
  v.grid.forEach((sem, si) => sem.forEach((it) => {
    (it.alt || (it.code ? [it.code] : [])).forEach((code) => basePos.set(code, si));
  }));
  const permutations = (arr) => {
    if (arr.length <= 1) {
      return [arr.slice()];
    }
    const list = [];
    arr.forEach((x, i) => permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach((p) => list.push([x].concat(p))));
    return list;
  };
  const pad = (codes, n) => codes.concat(Array(Math.max(0, n - codes.length)).fill(null));
  const seasonScore = { yes: 3, unknown: 2, some: 1, no: 0 };
  v.pools.filter((pool) => pool.kind === "all" && pool.slots).forEach((pool) => {
    // One group per kind of slot (lectures, labs), each with its grid places.
    const groups = Object.keys(pool.slots).map((id) => {
      const where = [];
      v.grid.forEach((sem, si) => sem.forEach((it, k) => {
        if (it.slot === id) {
          where.push({ si, k });
        }
      }));
      const only = pool.slots[id].only || (() => true);
      return { where, codes: pad(pool.codes.filter(only), where.length) };
    }).filter((group) => group.where.length);
    let best = null;
    let bestScore = -Infinity;
    const walk = (gi, placed) => {
      if (gi < groups.length) {
        permutations(groups[gi].codes).forEach((perm) => {
          const mine = [];
          groups[gi].where.forEach((sl, i) => perm[i] && mine.push({ code: perm[i], sl }));
          walk(gi + 1, placed.concat(mine));
        });
        return;
      }
      const pos = new Map(basePos);
      placed.forEach((p) => pos.set(p.code, p.sl.si));
      let score = 0;
      placed.forEach((p) => {
        score += seasonScore[seasonStatus(p.code, parseTerm(terms[p.sl.si]).season)];
        if (prereqStatus(p.code, p.sl.si, pos).ok === false) {
          score -= 10;
        }
      });
      if (score > bestScore) {
        bestScore = score;
        best = placed;
      }
    };
    walk(0, []);
    (best || []).forEach((p) => out.set(`${p.sl.si}:${p.sl.k}`, p.code));
  });
  return out;
}

// Replaces the plan's regular semesters with the check sheet's recommended
// eight for a major and track, starting at `start`. Anything in the transfer
// bucket is kept, and a course already there isn't scheduled a second time.
function fillFromCheckSheet(start, trackKey, programId) {
  if (programId && programs.byId[programId]) {
    plan.program = programId;
  }
  plan.track = trackFor(prog(), trackKey);
  const v = pv();
  const transfer = plan.semesters.find((s) => s.transfer) || makeSemester(null);
  const done = new Set(transfer.items.filter((it) => it.code).map((it) => it.code));
  const terms = regularTermsFrom(start, v.grid.length);
  const core = assignCoreSlots(v, terms);
  plan.semesters = [transfer];
  v.grid.forEach((gridSem, si) => {
    const sem = makeSemester(terms[si]);
    const season = parseTerm(terms[si]).season;
    gridSem.forEach((it, k) => {
      if (it.code) {
        if (!done.has(it.code)) {
          addCourseTo(sem, it.code);
        }
      } else if (it.alt) {
        if (it.alt.some((code) => done.has(code))) {
          return;
        }
        // Of an either/or, the one that most reliably runs that season.
        const order = { yes: 0, unknown: 1, some: 2, no: 3 };
        const pick = it.alt.filter((code) => course(code)).sort((a, b) => order[seasonStatus(a, season)] - order[seasonStatus(b, season)])[0] || it.alt[0];
        addCourseTo(sem, pick);
      } else if (core.has(`${si}:${k}`)) {
        if (!done.has(core.get(`${si}:${k}`))) {
          addCourseTo(sem, core.get(`${si}:${k}`));
        }
      } else {
        sem.items.push({ id: newId(), slot: it.slot });
      }
    });
    plan.semesters.push(sem);
  });
  sortSemesters();
}

// ---------- rendering: board ----------

let view = null;

function renderAll() {
  sortSemesters();
  trackHistory();
  if ($("advanced-btn")) {
    $("advanced-btn").classList.toggle("on", !!plan.premed);
  }
  if ($("undo-btn")) {
    $("undo-btn").disabled = !undoStack.length;
    $("redo-btn").disabled = !redoStack.length;
  }
  const ev = evaluatePlan();
  const issues = checkOn ? runChecks(ev) : [];
  view = { ev, issues, pos: buildPositions(plan.semesters) };
  document.body.className = `layout-${plan.layout}`;
  $("layout-vertical").classList.toggle("on", plan.layout === "vertical");
  $("layout-horizontal").classList.toggle("on", plan.layout === "horizontal");
  renderMajorSelects();
  $("check-btn").textContent = checkOn ? "Re-check rules" : "Check rules";
  $("total-credits").textContent = `${ev.credits} credits planned`;
  renderPlanSelect();
  renderLegend();
  renderStartSelect();
  renderAddTermSelect();
  renderBoard();
  renderRequirements();
  renderReport();
  savePlan();
}

function renderStartSelect() {
  const sel = $("start-select");
  const current = startTerm();
  const thisYear = new Date().getFullYear();
  const options = [];
  for (let year = thisYear - 8; year <= thisYear + 4; year++) {
    options.push(`Spring ${year}`, `Fall ${year}`);
  }
  if (current && !options.includes(current)) {
    options.push(current);
    options.sort((a, b) => termSortKey(a) - termSortKey(b));
  }
  sel.innerHTML = "";
  options.forEach((term) => {
    const opt = el("option", null, term);
    opt.value = term;
    sel.appendChild(opt);
  });
  sel.value = current || DEFAULT_START;
}

function renderAddTermSelect() {
  const sel = $("add-term-select");
  sel.innerHTML = "";
  const first = el("option", null, "Add…");
  first.value = "";
  sel.appendChild(first);
  // Every term the plan doesn't have yet, in date order: the ones after the
  // plan first (the usual thing to add), then holes inside it (a skipped
  // semester, a summer), then earlier ones.
  const have = new Set(plan.semesters.map((s) => s.term));
  const terms = plan.semesters.filter((s) => !s.transfer).map((s) => s.term);
  const firstKey = terms.length ? termSortKey(terms[0]) : termSortKey(DEFAULT_START);
  const lastKey = terms.length ? termSortKey(terms[terms.length - 1]) : firstKey - 1;
  const firstYear = Math.floor(firstKey / 10);
  const lastYear = Math.floor(Math.max(lastKey, firstKey) / 10);
  const groups = [["After your plan", []], ["Within your plan", []], ["Before your plan", []]];
  for (let year = firstYear - 2; year <= lastYear + 2; year++) {
    ["Spring", "Summer", "Fall"].forEach((season) => {
      const term = `${season} ${year}`;
      if (have.has(term)) {
        return;
      }
      const key = termSortKey(term);
      groups[key > lastKey ? 0 : key > firstKey ? 1 : 2][1].push(term);
    });
  }
  groups.forEach(([label, list]) => {
    if (!list.length) {
      return;
    }
    const group = el("optgroup");
    group.label = label;
    list.forEach((term) => {
      const opt = el("option", null, term);
      opt.value = term;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  });
  if (!plan.semesters.some((s) => s.transfer)) {
    const opt = el("option", null, TRANSFER_NAME);
    opt.value = "transfer";
    sel.appendChild(opt);
  }
}

function issuesFor(key, id) {
  return view.issues.filter((i) => i[key] === id);
}

function worstLevel(list) {
  return list.some((i) => i.level === "error") ? "error" : list.some((i) => i.level === "warn") ? "warn" : list.length ? "info" : "";
}

function renderTile(item, sem) {
  const info = categoryOf(item, view.ev);
  const tile = el("div", `tile cat-${info.cat}`);
  tile.dataset.itemId = item.id;
  tile.draggable = true;
  tile.tabIndex = 0;

  const remove = el("button", "tile-x", "×");
  remove.type = "button";
  remove.title = "Remove";
  remove.setAttribute("aria-label", `Remove ${item.code || info.label}`);
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    removeItem(item.id);
    renderAll();
  });
  tile.appendChild(remove);

  if (item.slot) {
    tile.classList.add("placeholder");
    tile.appendChild(el("div", "tile-code", info.label));
    tile.appendChild(el("div", "tile-title", "Choose a course"));
    tile.title = `${slotDef(item.slot) ? slotDef(item.slot).title : item.slot} — click to choose the course`;
  } else {
    tile.appendChild(el("div", "tile-code", item.code));
    tile.appendChild(el("div", "tile-title", titleOf(item.code)));
    tile.title = `${item.code} — ${titleOf(item.code)}\nCounts as: ${info.label}`;
  }

  const foot = el("div", "tile-foot");
  const tags = el("span", "tile-tags");
  if (item.code) {
    tags.appendChild(el("span", "tag tag-req", info.label));
    focusOf(item).forEach((letter) => {
      const tag = el("span", "tag tag-focus", letter);
      tag.title = `${FOCUS_NAME[letter]} (${letter} Focus)`;
      tags.appendChild(tag);
    });
    const d = diffRated(item.code);
    if (d) {
      const tag = el("span", `tag tag-diff band-${diffBand(d.d)}`, d.d.toFixed(1));
      tag.title = diffTip(item.code);
      tags.appendChild(tag);
    }
  }
  foot.appendChild(tags);
  foot.appendChild(el("span", "tile-cr", `${creditsOf(item)} cr`));
  tile.appendChild(foot);

  const mine = issuesFor("itemId", item.id);
  const level = worstLevel(mine.filter((i) => i.level !== "info"));
  if (level) {
    tile.classList.add(`issue-${level}`);
    tile.title += `\n\n${mine.filter((i) => i.level !== "info").map((i) => `• ${i.text}`).join("\n")}`;
    tile.appendChild(el("span", "tile-flag", "!"));
  }

  const open = () => {
    if (item.slot) {
      openPicker({ semId: sem.id, replaceId: item.id, preset: item.slot });
    } else {
      openDetail(item.id);
    }
  };
  tile.addEventListener("click", open);
  tile.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  tile.addEventListener("dragstart", (event) => {
    dragItemId = item.id;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.id);
    tile.classList.add("dragging");
  });
  tile.addEventListener("dragend", () => {
    dragItemId = null;
    document.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
    tile.classList.remove("dragging");
  });
  return tile;
}

function renderSemester(sem) {
  const box = el("section", "semester");
  box.dataset.semId = sem.id;
  if (sem.transfer) {
    box.classList.add("transfer");
  } else if (isCompleted(sem)) {
    box.classList.add("past");
  }
  if (sem.gap) {
    box.classList.add("gap");
  }
  const credits = sem.items.reduce((sum, it) => sum + creditsOf(it), 0);
  const mine = issuesFor("semId", sem.id).filter((i) => i.level !== "info");

  const head = el("div", "semester-head");
  head.appendChild(el("h3", "semester-name", semesterName(sem)));
  if (!sem.transfer && isCompleted(sem)) {
    const done = el("span", "semester-done", "completed");
    done.title = "Before the current term: counted as taken, and shared with the prereq map";
    head.appendChild(done);
  }
  const cr = el("span", "semester-credits", `${credits} cr`);
  if (worstLevel(mine)) {
    cr.classList.add(`issue-${worstLevel(mine)}`);
    cr.title = mine.map((i) => `• ${i.text}`).join("\n");
  }
  if (!sem.gap) {
    head.appendChild(cr);
  }
  const collapsed = sem.transfer && plan.hideCompleted;
  if (sem.transfer) {
    const toggle = el("button", "semester-gap", collapsed ? "Show" : "Hide");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = collapsed ? "Show these courses" : "Fold these courses away (they still count)";
    toggle.addEventListener("click", () => {
      plan.hideCompleted = !plan.hideCompleted;
      renderAll();
    });
    head.appendChild(toggle);
  }
  if (!sem.transfer) {
    const gap = el("button", `semester-gap${sem.gap ? " on" : ""}`, "Gap");
    gap.type = "button";
    gap.setAttribute("aria-pressed", String(!!sem.gap));
    gap.title = sem.gap
      ? "Take courses this semester after all"
      : sem.items.length
        ? "Sit this semester out: its courses, and every semester after it, move one term later"
        : "Mark this as a semester you're sitting out";
    gap.addEventListener("click", () => {
      setGap(sem, !sem.gap);
      renderAll();
    });
    head.appendChild(gap);
  }
  const remove = el("button", "semester-remove", "×");
  remove.type = "button";
  remove.title = sem.items.length ? "Remove this semester and its courses" : "Remove this semester";
  remove.addEventListener("click", () => {
    const go = () => {
      plan.semesters = plan.semesters.filter((s) => s.id !== sem.id);
      renderAll();
    };
    // Always asked, even for an empty semester: the button is small and
    // sits right next to Gap.
    askConfirm(sem.items.length
      ? `Remove ${semesterName(sem)} and the ${plural(sem.items.length, "course")} in it? You can bring it back with Undo.`
      : `Remove ${semesterName(sem)} from your plan? You can bring it back with Undo.`, go);
  });
  head.appendChild(remove);
  box.appendChild(head);

  if (sem.gap) {
    box.appendChild(el("div", "gap-note", "Gap semester — no courses"));
    return box;
  }

  const load = semesterDifficulty(sem);
  if (load) {
    const line = el("div", `semester-diff level-${load.level}`);
    line.appendChild(el("span", "semester-diff-avg", `Difficulty ${load.avg.toFixed(1)}`));
    line.appendChild(document.createTextNode(load.hard.length
      ? ` · ${load.hard.length} hard: ${load.hard.map((r) => r.code).join(", ")}`
      : " · no hard-rated courses"));
    line.title = [`Credit-weighted average of the ${plural(load.rated.length, "rated course")} (1–5, Rate My Professors):`]
      .concat(load.rated.slice().sort((a, b) => b.d.d - a.d.d).map((r) => `• ${diffLine(r.code, r.d)}`))
      .concat(load.unrated ? [`${plural(load.unrated, "course")} without enough reviews ${load.unrated === 1 ? "isn't" : "aren't"} counted.`] : [])
      .join("\n");
    box.appendChild(line);
  }

  const tiles = el("div", "tiles");
  if (collapsed) {
    box.classList.add("collapsed");
    box.appendChild(el("div", "gap-note", `${plural(sem.items.length, "course")} folded away — still counted toward your requirements.`));
    tiles.hidden = true;
  }
  sem.items.forEach((item) => tiles.appendChild(renderTile(item, sem)));
  const addBtn = el("button", "tile add", "+ Add course");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => openPicker({ semId: sem.id, preset: "fixed" }));
  tiles.appendChild(addBtn);
  box.appendChild(tiles);

  box.addEventListener("dragover", (event) => {
    if (!dragItemId) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    box.classList.add("drop-target");
  });
  box.addEventListener("dragleave", (event) => {
    if (!box.contains(event.relatedTarget)) {
      box.classList.remove("drop-target");
    }
  });
  box.addEventListener("drop", (event) => {
    if (!dragItemId) {
      return;
    }
    event.preventDefault();
    const over = event.target.closest(".tile[data-item-id]");
    const beforeId = over && over.dataset.itemId !== dragItemId ? over.dataset.itemId : null;
    moveItem(dragItemId, sem.id, beforeId);
    dragItemId = null;
    renderAll();
  });
  return box;
}

function renderBoard() {
  const board = $("board");
  // Created here if a cached copy of the page predates it.
  let top = $("board-top");
  if (!top) {
    top = el("section", "board-top");
    top.id = "board-top";
    board.parentNode.insertBefore(top, board);
  }
  board.innerHTML = "";
  top.innerHTML = "";
  if (!plan.semesters.length) {
    board.appendChild(el("div", "empty-board", "No semesters yet. Use “Check-sheet plan…” to start from the recommended schedule, or “Add term” to build one from scratch."));
    return;
  }
  // Side by side, a long list of completed courses would be one very tall
  // column pushing everything else off screen, so in the horizontal layout
  // the bucket sits in its own full-width row above the semesters.
  plan.semesters.forEach((sem) => {
    const home = sem.transfer && plan.layout === "horizontal" ? top : board;
    home.appendChild(renderSemester(sem));
  });
}

function renderLegend() {
  const legend = $("legend");
  legend.innerHTML = "";
  // One swatch per tile color the active major uses.
  const cats = [["fixed", CATEGORY_LABEL.fixed]];
  pv().pools.forEach((pool) => {
    if (!cats.some((c) => c[0] === pool.cat)) {
      cats.push([pool.cat, pool.label]);
    }
  });
  if (!cats.some((c) => c[0] === "gened")) {
    cats.push(["gened", CATEGORY_LABEL.gened]);
  }
  if (plan.premed) {
    cats.push(["premed", CATEGORY_LABEL.premed]);
  }
  cats.push(["extra", CATEGORY_LABEL.extra]);
  cats.forEach(([cat, label]) => {
    const item = el("span", "legend-item");
    item.appendChild(el("span", `legend-swatch cat-${cat}`));
    item.appendChild(document.createTextNode(cat === "gened" ? CATEGORY_LABEL.gened : label));
    legend.appendChild(item);
  });
  const focus = el("span", "legend-item");
  focus.appendChild(el("span", "tag tag-focus", "W"));
  focus.appendChild(document.createTextNode("Focus counted"));
  legend.appendChild(focus);
  if (difficulty) {
    const diff = el("span", "legend-item");
    diff.title = `Average difficulty reviewers gave the course on Rate My Professors (1–5), shown for courses with ${DIFF_MIN_REVIEWS}+ reviews. Local only.`;
    [["light", "easier"], ["typical", "typical"], ["hard", "hard"], ["vhard", "very hard"]].forEach(([band, text]) => diff.appendChild(el("span", `tag tag-diff band-${band}`, text)));
    diff.appendChild(document.createTextNode("Rated difficulty"));
    legend.appendChild(diff);
  }
}

// The Major and Track boxes (toolbar and the check-sheet dialog). Track only
// shows for a major that has tracks.
function fillTrackSelect(sel, program, value) {
  sel.innerHTML = "";
  Object.keys(program.tracks || {}).forEach((key) => {
    const opt = el("option", null, program.tracks[key].name);
    opt.value = key;
    sel.appendChild(opt);
  });
  sel.value = trackFor(program, value) || "";
  sel.closest("label").hidden = !program.tracks;
}

function renderMajorSelects() {
  const major = $("major-select");
  if (major) {
    if (!major.options.length) {
      programs.list.forEach((program) => {
        const opt = el("option", null, program.name);
        opt.value = program.id;
        major.appendChild(opt);
      });
    }
    major.value = prog().id;
  }
  fillTrackSelect($("track-select"), prog(), plan.track);
  const starSpan = star ? ` · STAR ${star.terms[0].name} – ${star.terms[star.terms.length - 1].name}` : "";
  $("app-sub").textContent = `${data.catalog} catalog · ${prog().effective} check sheet${starSpan}`;
}

// ---------- rendering: requirements ----------

function whereText(entry) {
  return `${entry.item.code} · ${semesterName(entry.sem).replace(TRANSFER_NAME, "done")}`;
}

function reqSection(title, sub) {
  const sec = el("div", "req-section");
  const head = el("div", "req-section-head");
  head.appendChild(el("h3", null, title));
  if (sub) {
    head.appendChild(el("span", "req-section-sub", sub));
  }
  sec.appendChild(head);
  return sec;
}

// One requirement line: a mark, a name, what's planned toward it, and a
// button that opens the picker on exactly the courses that satisfy it.
function reqRow(options) {
  const row = el("div", `req-row ${options.state}`);
  row.appendChild(el("span", "req-mark", options.state === "met" ? "✓" : options.state === "partial" ? "◐" : "○"));
  const body = el("div", "req-body");
  body.appendChild(el("div", "req-name", options.name));
  if (options.detail) {
    body.appendChild(el("div", "req-detail", options.detail));
  }
  row.appendChild(body);
  if (options.preset && options.state !== "met") {
    const btn = el("button", "btn small", "Choose…");
    btn.type = "button";
    btn.addEventListener("click", () => openPicker({ preset: options.preset, query: options.query, only: options.only }));
    row.appendChild(btn);
  }
  return row;
}

// The Requirements rows for one elective pool: the pool itself, then any
// further conditions inside it (EE's "3 outside your track", "1 lab credit").
function poolRows(res) {
  const pool = res.pool;
  const preset = Object.keys(pool.slots || {})[0];
  if (pool.kind === "all") {
    const met = res.parts.filter((part) => part.entry).length;
    return [reqRow({
      state: met === res.parts.length ? "met" : met ? "partial" : "open",
      name: `${pool.label} — all ${res.parts.length} courses`,
      detail: res.parts.map((part) => (part.entry ? `✓ ${part.code}` : `○ ${part.code}`)).join("   "),
      preset,
    })];
  }
  const items = res.items.map(whereText).join(", ");
  const rows = [reqRow({
    state: res.met ? "met" : res.credits ? "partial" : "open",
    name: pool.rowName || `${pool.label} — ${res.credits} of ${res.need} credits`,
    detail: (pool.rowName ? `${res.credits} of ${res.need} credits · ` : "") + (items || (res.manual ? MANUAL_NOTE : pool.blurb || "None planned yet")),
    preset,
  })];
  res.extras.forEach((x) => rows.push(reqRow({
    state: x.have >= x.extra.need ? "met" : x.have ? "partial" : "open",
    name: x.extra.name,
    detail: `${x.have} of ${plural(x.extra.need, "credit")}`,
    preset: x.extra.slot || preset,
  })));
  return rows;
}

function renderRequirements() {
  const ev = view.ev;
  const root = $("requirements");
  root.innerHTML = "";
  root.appendChild(el("h2", "panel-title", "Requirements"));

  const fixedMet = ev.fixed.filter((f) => f.entry).length;
  const core = reqSection("Required courses", `${fixedMet} of ${ev.fixed.length}`);
  const chips = el("div", "req-chips");
  ev.fixed.forEach((f) => {
    const label = f.group.join(" or ");
    if (f.entry) {
      const chip = el("span", "req-chip met", f.entry.item.code);
      chip.title = `${label}: ${whereText(f.entry)}`;
      chips.appendChild(chip);
    } else {
      const chip = el("button", "req-chip", label);
      chip.type = "button";
      chip.title = `Add ${label} to the plan`;
      chip.addEventListener("click", () => openPicker({ preset: "fixed", only: f.group }));
      chips.appendChild(chip);
    }
  });
  core.appendChild(chips);
  root.appendChild(core);

  // The major's pools, grouped under the section each names; the ones that
  // belong with gen-ed (EE's engineering breadth, Civil's BSE) come after.
  const sections = new Map();
  ev.pools.filter((res) => res.pool.section !== "gened").forEach((res) => {
    const title = res.pool.section || res.pool.name;
    sections.set(title, (sections.get(title) || []).concat([res]));
  });
  sections.forEach((list, title) => {
    const ids = list.map((res) => res.pool.id);
    const min = ev.minima.find((m) => m.min.pools.every((id) => ids.includes(id)));
    const only = list.length === 1 && list[0].pool.kind === "credits" ? list[0] : null;
    const sec = reqSection(title, min ? `${min.have} of ${min.min.need}+ cr` : only ? `${only.credits} of ${only.need} cr` : "");
    list.forEach((res) => poolRows(res).forEach((row) => sec.appendChild(row)));
    root.appendChild(sec);
  });

  const other = reqSection("Breadth and gen-ed");
  ev.pools.filter((res) => res.pool.section === "gened").forEach((res) => poolRows(res).forEach((row) => other.appendChild(row)));
  other.appendChild(reqRow({
    state: ev.fg.sameGroup ? "partial" : fgCount(ev) >= 2 ? "met" : fgCount(ev) ? "partial" : "open",
    name: `FG — ${fgCount(ev)} of 2, from two different groups`,
    detail: ev.fg.items.map((e) => `${whereText(e)} (${fgGroup(e.item.code) || "manual"})`).join(", ")
      + (ev.fg.sameGroup ? " — same group: swap one" : "") + (ev.fg.manual ? ` ${ev.fg.manual} ${MANUAL_NOTE}` : "") || "FGA, FGB or FGC",
    preset: "FG",
  }));
  other.appendChild(reqRow({
    state: ev.dhdl.entry || ev.dhdl.manual ? "met" : "open",
    name: "DH or DL — Humanities or Literatures",
    detail: ev.dhdl.entry ? whereText(ev.dhdl.entry) : ev.dhdl.manual ? MANUAL_NOTE : "One course",
    preset: "DHDL",
  }));
  other.appendChild(reqRow({
    state: ev.ds.entry || ev.ds.manual ? "met" : "open",
    name: "DS — Social Sciences",
    detail: ev.ds.entry ? whereText(ev.ds.entry) : ev.ds.manual ? MANUAL_NOTE : "One course besides the required ECON course",
    preset: "DS",
  }));
  root.appendChild(other);

  const focus = reqSection("Focus", "counted from the courses in your plan");
  FOCUS_LETTERS.forEach((letter) => {
    const f = ev.focus[letter];
    const upperOk = letter !== "W" || f.upper >= W_UPPER_NEED;
    const codes = f.items.map((e) => e.item.code).join(", ");
    focus.appendChild(reqRow({
      state: f.items.length >= f.need && upperOk ? "met" : f.items.length ? "partial" : "open",
      name: `${letter} — ${FOCUS_NAME[letter]}: ${Math.min(f.items.length, f.need)} of ${f.need}`,
      detail: (letter === "W" ? `${Math.min(f.upper, W_UPPER_NEED)} of ${W_UPPER_NEED} at 300+ · ` : "")
        + (codes || "no course in your plan yet. If a course you took carried it, click that course and tick it under Focus."),
      preset: letter,
    }));
  });
  root.appendChild(focus);

  if (ev.premed) {
    const slots = [].concat(...ev.premed.groups.map((g) => g.slots));
    const pm = reqSection("Pre-med: JABSOM prerequisites", `${slots.filter((s) => s.entry).length} of ${slots.length} courses`);
    ev.premed.groups.forEach((group) => {
      const open = group.slots.filter((s) => !s.entry);
      pm.appendChild(reqRow({
        state: !open.length ? "met" : group.met ? "partial" : "open",
        name: `${group.name} — ${group.detail}`,
        detail: group.slots.map((s) => (s.entry ? `✓ ${s.entry.item.code}` : `○ ${s.options.filter((code) => course(code)).slice(0, 2).join(" or ")}`)).join("   "),
        preset: "PM",
        only: [].concat(...open.map((s) => s.options)),
      }));
    });
    pm.appendChild(reqRow({
      state: ev.credits >= PREMED.credits ? "met" : "partial",
      name: `${PREMED.credits} college-level semester credits`,
      detail: `${ev.credits} planned`,
    }));
    const have = ev.premed.recommended.filter((r) => r.entries.length);
    pm.appendChild(reqRow({
      state: have.length === ev.premed.recommended.length ? "met" : have.length ? "partial" : "open",
      name: "Recommended, not required",
      detail: ev.premed.recommended.map((r) => (r.entries.length ? `✓ ${r.name} (${r.entries[0].item.code})` : `○ ${r.name}`)).join("   "),
      preset: "PM",
      only: [].concat(...ev.premed.recommended.filter((r) => !r.entries.length).map((r) => r.codes)),
    }));
    if (ev.premed.support.length) {
      pm.appendChild(reqRow({
        state: "met",
        name: "Other pre-med courses",
        detail: `${ev.premed.support.map((e) => e.item.code).join(", ")} — prerequisites of the courses above, or ones you set to count toward Pre-med`,
      }));
    }
    const note = el("p", "req-note");
    note.appendChild(document.createTextNode("Also required: the MCAT and AAMC PREview. JABSOM lists subjects, not course numbers; the courses here are this planner's reading of them. "));
    const link = el("a", null, "JABSOM's requirements");
    link.href = PREMED.source;
    link.target = "_blank";
    link.rel = "noopener";
    note.appendChild(link);
    pm.appendChild(note);
    root.appendChild(pm);
  }
}

// ---------- rendering: the check report ----------

function renderReport() {
  const root = $("report");
  root.hidden = !checkOn;
  root.innerHTML = "";
  if (!checkOn) {
    return;
  }
  const errors = view.issues.filter((i) => i.level === "error").length;
  const warns = view.issues.filter((i) => i.level === "warn").length;
  const verdict = el("div", `verdict ${errors ? "bad" : warns ? "caution" : "good"}`);
  const head = el("div", "verdict-head");
  head.appendChild(el("strong", null, errors
    ? `Not workable yet: ${plural(errors, "problem")} to fix`
    : warns ? `Likely to work, with ${plural(warns, "thing")} to watch` : "This schedule looks like it works"));
  const close = el("button", "modal-x", "×");
  close.type = "button";
  close.title = "Hide the check";
  close.addEventListener("click", () => {
    checkOn = false;
    renderAll();
  });
  head.appendChild(close);
  verdict.appendChild(head);
  verdict.appendChild(el("div", "verdict-sub", `${plural(errors, "problem")} · ${plural(warns, "caution")} · updates as you edit the plan`));
  root.appendChild(verdict);

  ISSUE_GROUPS.forEach((group) => {
    const list = view.issues.filter((i) => i.group === group);
    if (!list.length) {
      return;
    }
    const order = { error: 0, warn: 1, info: 2 };
    list.sort((a, b) => order[a.level] - order[b.level]);
    const sec = el("div", "report-group");
    sec.appendChild(el("h3", null, `${group} (${list.length})`));
    const ul = el("ul", "issues");
    list.forEach((issue) => ul.appendChild(renderIssue(issue)));
    sec.appendChild(ul);
    root.appendChild(sec);
  });
}

// Which report rows are open, by their text, so they stay open while the
// plan is edited and the report redraws.
const expandedIssues = new Set();

// One row of the report. Click it to open the explanation underneath: what
// the rule is, what the plan has, the catalog text, and STAR's record.
function renderIssue(issue) {
  const key = `${issue.group}|${issue.text}`;
  const open = expandedIssues.has(key);
  const li = el("li", `issue ${issue.level}${open ? " open" : ""}`);
  const head = el("button", "issue-head");
  head.type = "button";
  head.setAttribute("aria-expanded", String(open));
  head.title = open ? "Hide the details" : "Show more about this";
  head.appendChild(el("span", "issue-mark", issue.level === "error" ? "✕" : issue.level === "warn" ? "!" : "i"));
  head.appendChild(el("span", "issue-text", issue.text));
  head.appendChild(el("span", "issue-chevron", open ? "▾" : "▸"));
  head.addEventListener("click", () => {
    if (open) {
      expandedIssues.delete(key);
    } else {
      expandedIssues.add(key);
    }
    renderReport();
  });
  li.appendChild(head);
  if (!open) {
    return li;
  }

  const body = el("div", "issue-detail");
  issueSections(issue).forEach((section) => {
    body.appendChild(el("h4", null, section.title));
    const lines = el("ul");
    section.lines.forEach((line) => lines.appendChild(el("li", null, line)));
    body.appendChild(lines);
  });
  const actions = el("div", "issue-actions");
  const button = (label, onClick) => {
    const b = el("button", "btn small", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    actions.appendChild(b);
  };
  const found = issue.itemId ? findItem(issue.itemId) : null;
  if (found || issue.semId) {
    button("Show in the plan", () => flash(issue));
  }
  if (found && found.item.code) {
    button("Open course details", () => openDetail(issue.itemId));
  }
  if (found && found.item.slot) {
    button("Choose the course", () => openPicker({ semId: found.sem.id, replaceId: found.item.id, preset: found.item.slot }));
  } else if (issue.rule) {
    button("Find courses that count", () => openPicker({ preset: issue.rule }));
  }
  if (actions.children.length) {
    body.appendChild(actions);
  }
  li.appendChild(body);
  return li;
}

function flash(issue) {
  const node = issue.itemId
    ? document.querySelector(`.tile[data-item-id="${issue.itemId}"]`)
    : document.querySelector(`.semester[data-sem-id="${issue.semId}"]`);
  if (!node) {
    return;
  }
  node.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  node.classList.remove("flash");
  void node.offsetWidth;
  node.classList.add("flash");
}

// ---------- modals ----------

function openModal(id) {
  $(id).classList.remove("hidden");
}

function closeModal(id) {
  $(id).classList.add("hidden");
  if (id === "picker-modal") {
    picker = null;
  }
  if (id === "detail-modal") {
    detailItemId = null;
  }
}

function askText(title, value, okLabel, onOk) {
  $("text-title").textContent = title;
  $("text-ok").textContent = okLabel;
  const input = $("text-input");
  input.value = value;
  const go = () => {
    closeModal("text-modal");
    onOk(input.value);
  };
  $("text-ok").onclick = go;
  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      go();
    }
  };
  openModal("text-modal");
  input.focus();
  input.select();
}

function askConfirm(text, onYes) {
  $("confirm-text").textContent = text;
  $("confirm-yes").onclick = () => {
    closeModal("confirm-modal");
    onYes();
  };
  openModal("confirm-modal");
}

// ---------- the course picker ----------

function presetCodes(preset) {
  const v = pv();
  const all = Object.keys(data.courses);
  const tagged = (tags) => all.filter((code) => (data.courses[code].g || []).some((g) => tags.includes(g)));
  // One of the major's own requirements: whatever its pool takes, minus
  // courses the sheet already requires by name (they can't count twice).
  const def = v.slots[preset];
  if (def && def.pool) {
    const pool = def.pool;
    let codes = pool.codes ? pool.codes.slice() : all.filter((code) => poolTakes(pool, code));
    if (def.only) {
      codes = codes.filter(def.only);
    }
    return pool.kind === "all" ? codes : codes.filter((code) => !v.fixedCodes.has(code));
  }
  switch (preset) {
    case "fixed": return [].concat(...v.fixedGroups);
    case "FG": return tagged(["FGA", "FGB", "FGC"]);
    case "DHDL": return tagged(["DH", "DL"]);
    case "DS": return tagged(["DS"]).filter(countsAsSecondDs);
    case "PM": return premedCodes();
    case "W": case "O": case "E": case "H":
      return all.filter((code) => (data.courses[code].f || []).includes(preset));
    default: return all;
  }
}

function openPicker(options) {
  if (!plan.semesters.length) {
    addSemester(DEFAULT_START);
    renderAll();
  }
  const open = openSemesters();
  const usable = (s) => (s && !s.gap ? s : null);
  const sem = usable(semesterById(options.semId)) || usable(semesterById(lastSemesterId)) || open.find((s) => !s.transfer) || open[0];
  // presets: the requirement filters switched on, combined with AND ("H
  // Focus" + "DH or DL" lists courses that are both). Empty means any course.
  // slot: the requirement the picker was opened for, for its title.
  const first = options.preset && options.preset !== "all" ? options.preset : null;
  picker = {
    semId: sem.id, replaceId: options.replaceId || null, presets: first ? [first] : [], slot: first,
    title: options.title || null, levels: new Set(),
    only: options.only || null, query: "", runs: false, ready: false,
  };
  $("picker-search").value = "";
  $("picker-runs").checked = false;
  $("picker-ready").checked = false;
  openModal("picker-modal");
  renderPicker();
  $("picker-search").focus();
}

function renderPicker() {
  if (!picker) {
    return;
  }
  const sem = semesterById(picker.semId);
  const semIndex = sem.transfer ? -1 : plan.semesters.indexOf(sem);
  const season = sem.transfer ? null : parseTerm(sem.term).season;
  const allPresets = presets();
  const presetById = (id) => allPresets.find((p) => p.id === id) || { id, label: id, hint: "" };
  const active = picker.presets.map(presetById);

  $("picker-title").textContent = picker.title ? picker.title : picker.replaceId && picker.slot ? `Choose the ${presetById(picker.slot).label} course` : "Add a course";
  const semSel = $("picker-sem");
  semSel.innerHTML = "";
  openSemesters().forEach((s) => {
    const opt = el("option", null, semesterName(s));
    opt.value = s.id;
    semSel.appendChild(opt);
  });
  semSel.value = sem.id;

  const chips = $("picker-presets");
  chips.innerHTML = "";
  // Chips toggle and combine: every one that's on must be satisfied.
  // "Any course" is the same as none of them.
  allPresets.filter((p) => (p.chip !== false && (!p.premed || plan.premed)) || picker.presets.includes(p.id)).forEach((p) => {
    const on = p.id === "all" ? !picker.presets.length : picker.presets.includes(p.id);
    const chip = el("button", `chip${on ? " on" : ""}`, p.label);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(on));
    chip.title = p.id === "all" ? "Clear the filters" : on ? "Click to drop this filter" : "Click to add this filter (combines with the others)";
    chip.addEventListener("click", () => {
      if (p.id === "all") {
        picker.presets = [];
      } else if (on) {
        picker.presets = picker.presets.filter((id) => id !== p.id);
      } else {
        picker.presets.push(p.id);
      }
      picker.only = null;
      renderPicker();
    });
    chips.appendChild(chip);
  });

  // Levels combine with OR among themselves (a course has only one), and
  // with AND against everything else.
  const levelBox = $("picker-levels");
  if (levelBox) {
    levelBox.innerHTML = "";
    levelBox.appendChild(el("span", "picker-levels-label", "Level"));
    LEVELS.forEach(([level, label]) => {
      const on = picker.levels.has(level);
      const b = el("button", `chip small${on ? " on" : ""}`, label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));
      b.title = level === 5 ? "Graduate-level courses" : `${label}-level courses`;
      b.addEventListener("click", () => {
        if (on) {
          picker.levels.delete(level);
        } else {
          picker.levels.add(level);
        }
        renderPicker();
      });
      levelBox.appendChild(b);
    });
  }

  $("picker-runs").parentElement.hidden = !season || !star;
  $("picker-runs-label").textContent = `Runs in ${season || ""}`;
  $("picker-ready").parentElement.hidden = semIndex < 0;
  const hintOf = (p) => p.hint;
  $("picker-hint").textContent = !active.length
    ? BASE_PRESETS[0].hint + " Click the filters above to narrow it down; several at once show courses that satisfy all of them."
    : active.length === 1
      ? hintOf(active[0])
      : `Courses that count as all of: ${active.map((p) => p.label).join(" + ")}.`;

  const inPlan = new Map();
  view.ev.courses.forEach((e) => inPlan.set(e.item.code, e.sem));
  const open = openNeeds(view.ev);
  const query = picker.query.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const seasonRank = { yes: 0, some: 1, unknown: 2, no: 3 };

  let codes = picker.only;
  if (!codes) {
    codes = presetCodes(picker.presets[0] || "all");
    picker.presets.slice(1).forEach((id) => {
      const also = new Set(presetCodes(id));
      codes = codes.filter((code) => also.has(code));
    });
    codes = Array.from(new Set(codes));
  }
  if (!picker.presets.length && !picker.only) {
    codes = codes.concat(Object.keys(plan.custom).filter((code) => !data.courses[code]));
  }
  let rows = codes.filter((code) => course(code)).map((code) => {
    const c = course(code);
    const status = season ? seasonStatus(code, season) : "unknown";
    const pre = semIndex < 0 ? { ok: true, missing: [] } : prereqStatus(code, semIndex, view.pos, isSummer(sem));
    return { code, c, status, pre, covers: coversOf(code, open), sem: inPlan.get(code) || null };
  });
  if (words.length) {
    rows = rows.filter((r) => {
      const hay = `${r.code} ${r.c.t}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  if (picker.levels.size) {
    rows = rows.filter((r) => picker.levels.has(levelOf(r.code)));
  }
  if (picker.runs && season) {
    rows = rows.filter((r) => r.status === "yes" || r.status === "some");
  }
  if (picker.ready) {
    rows = rows.filter((r) => r.pre.ok !== false || r.pre.unsure);
  }
  // The fixed list keeps unmet requirements on top; gen-ed and Focus lists
  // put courses that cover the most open needs first.
  const fixedDone = new Set();
  view.ev.fixed.filter((f) => f.entry).forEach((f) => f.group.forEach((code) => fixedDone.add(code)));
  rows.sort((a, b) =>
    (!!a.sem - !!b.sem)
    || (fixedDone.has(a.code) - fixedDone.has(b.code))
    || (seasonRank[a.status] - seasonRank[b.status])
    || ((a.pre.ok === false && !a.pre.unsure) - (b.pre.ok === false && !b.pre.unsure))
    || (b.covers.length - a.covers.length)
    || a.code.localeCompare(b.code, undefined, { numeric: true }));

  const list = $("picker-list");
  list.innerHTML = "";
  list.classList.toggle("has-diff", !!difficulty);
  if (!rows.length) {
    list.appendChild(el("div", "picker-empty", "No courses match. Loosen the filters, or enter the course manually below."));
  }
  rows.slice(0, PICKER_ROW_LIMIT).forEach((r) => {
    const row = el("button", "picker-row");
    row.type = "button";
    if (r.sem) {
      row.classList.add("in-plan");
    }
    row.appendChild(el("span", "pr-code", r.code));
    const main = el("span", "pr-main");
    main.appendChild(el("span", "pr-title", r.c.t));
    const tags = el("span", "pr-tags");
    (r.c.g || []).forEach((g) => tags.appendChild(el("span", "tag tag-gened", g)));
    (r.c.f || []).forEach((f) => tags.appendChild(el("span", "tag tag-focus", f)));
    if (r.covers.length > 1) {
      tags.appendChild(el("span", "tag tag-covers", `covers ${r.covers.join(" + ")}`));
    }
    main.appendChild(tags);
    row.appendChild(main);
    const cr = r.c.c ? (r.c.c[0] === r.c.c[1] ? `${r.c.c[0]}` : `${r.c.c[0]}–${r.c.c[1]}`) : "?";
    row.appendChild(el("span", "pr-cr", `${cr} cr`));
    if (difficulty) {
      const d = diffRated(r.code);
      const few = !d && diffOf(r.code) ? diffOf(r.code).n : 0;
      const cell = el("span", "pr-diff");
      if (d) {
        cell.appendChild(el("span", `tag tag-diff band-${diffBand(d.d)}`, d.d.toFixed(1)));
        cell.appendChild(document.createTextNode(` ${DIFF_BAND_LABEL[diffBand(d.d)].replace(" than most", "")} (${d.n})`));
      } else {
        cell.classList.add("none");
        cell.textContent = few ? plural(few, "review") : "";
      }
      cell.title = diffTip(r.code);
      row.appendChild(cell);
    }
    const off = el("span", `pr-offered st-${r.status}`, star ? offering(r.code).label : "");
    if (season && star) {
      off.title = { yes: `Ran every ${season} in STAR`, some: `Ran some ${season} terms`, no: `Hasn't run in a ${season}`, unknown: "No regular STAR history" }[r.status];
    }
    row.appendChild(off);
    let preText = "";
    let preClass = "ok";
    if (r.sem) {
      preText = `In plan: ${semesterName(r.sem).replace(TRANSFER_NAME, "done")}`;
      preClass = "muted";
    } else if (r.pre.ok === false) {
      preText = r.pre.consentOnly ? "Needs consent" : r.pre.unsure ? "Check prereq text" : `Needs ${r.pre.missing.join(", ")}`;
      preClass = r.pre.unsure ? "muted" : "bad";
    } else if (r.pre.backToBack && r.pre.backToBack.length) {
      preText = `2nd session, after ${r.pre.backToBack.join(", ")}`;
    } else if (semIndex >= 0) {
      preText = r.pre.ok === null && r.c.pr ? "Check prereq text" : "Prereqs OK";
      preClass = r.pre.ok === null && r.c.pr ? "muted" : "ok";
    }
    const pre = el("span", `pr-pre ${preClass}`, preText);
    pre.title = r.c.pr ? `Prerequisite: ${r.c.pr}` : "No prerequisite listed";
    row.appendChild(pre);
    row.addEventListener("click", () => placeFromPicker(r.code));
    list.appendChild(row);
  });
  $("picker-count").textContent = rows.length > PICKER_ROW_LIMIT
    ? `Showing ${PICKER_ROW_LIMIT} of ${rows.length}. Search to narrow it down.`
    : plural(rows.length, "course");
}

function placeFromPicker(code) {
  const sem = semesterById(picker.semId);
  const options = {};
  // Only pin the requirement when the automatic choice would differ: a
  // course an earlier pool would claim (one from the student's own Group II
  // list) picked on purpose for a later one (as a technical elective).
  const v = pv();
  const chosen = picker.presets.map((id) => v.slots[id]).filter((def) => def && def.pool).map((def) => def.pool);
  const target = chosen[chosen.length - 1];
  if (target && target.kind === "credits"
    && v.pools.slice(0, v.pools.indexOf(target)).some((pool) => pool.kind === "credits" && poolTakes(pool, code))) {
    options.as = target.id;
  }
  const replacing = picker.replaceId ? findItem(picker.replaceId) : null;
  if (replacing && replacing.sem.id === sem.id) {
    const at = sem.items.indexOf(replacing.item);
    sem.items.splice(at, 1, Object.assign({ id: newId(), code }, options));
  } else {
    if (replacing) {
      removeItem(picker.replaceId);
    }
    addCourseTo(sem, code, options);
  }
  lastSemesterId = sem.id;
  closeModal("picker-modal");
  renderAll();
}

// ---------- course details ----------

// Which picker filter to start on when swapping a course out: the
// requirement it currently counts toward. A named requirement with
// alternatives (ECE 160 or ECE 110) lists just those; one with none has
// nothing to swap to within the requirement, so the picker starts unfiltered.
function swapFilter(item, info) {
  if (info.cat === "fixed") {
    const group = pv().fixedGroups.find((g) => g.includes(item.code));
    return group && group.length > 1 ? { preset: "fixed", only: group } : { preset: "all" };
  }
  const pool = info.pool ? pv().pools.find((p) => p.id === info.pool) : null;
  if (pool) {
    // The pool's slot this course fits: its lab slot for a lab, and so on.
    const ids = Object.keys(pool.slots || {});
    const fit = ids.find((id) => pool.slots[id].only && pool.slots[id].only(item.code)) || ids.find((id) => !pool.slots[id].only) || ids[0];
    return { preset: fit || "all" };
  }
  if (info.cat === "gened") {
    return { preset: /^FG/.test(info.label) ? "FG" : info.label === "DS" ? "DS" : "DHDL" };
  }
  return { preset: info.cat === "premed" ? "PM" : "all" };
}

function openDetail(itemId) {
  detailItemId = itemId;
  renderDetail();
  openModal("detail-modal");
}

function detailRow(label, node) {
  const row = el("div", "detail-row");
  row.appendChild(el("div", "detail-label", label));
  const value = el("div", "detail-value");
  if (typeof node === "string") {
    value.textContent = node;
  } else {
    value.appendChild(node);
  }
  row.appendChild(value);
  return row;
}

function renderDetail() {
  const found = findItem(detailItemId);
  if (!found) {
    closeModal("detail-modal");
    return;
  }
  const { item, sem } = found;
  const c = course(item.code);
  const info = categoryOf(item, view.ev);
  $("detail-title").textContent = `${item.code} — ${titleOf(item.code)}`;
  const body = $("detail-body");
  body.innerHTML = "";
  const update = (change) => {
    change();
    renderAll();
    renderDetail();
  };

  const semSel = el("select");
  openSemesters().forEach((s) => {
    const opt = el("option", null, semesterName(s));
    opt.value = s.id;
    semSel.appendChild(opt);
  });
  semSel.value = sem.id;
  semSel.addEventListener("change", () => update(() => moveItem(item.id, semSel.value)));
  body.appendChild(detailRow("Semester", semSel));

  if (isVariableCredit(item.code) || !c || item.credits != null) {
    const input = el("input");
    input.type = "number";
    input.min = c && c.c ? c.c[0] : 0;
    input.max = c && c.c ? c.c[1] : 12;
    input.value = creditsOf(item);
    input.addEventListener("change", () => update(() => {
      item.credits = Math.max(0, Number(input.value) || 0);
    }));
    const wrap = el("span");
    wrap.appendChild(input);
    if (c && c.c) {
      wrap.appendChild(document.createTextNode(` variable, ${c.c[0]}–${c.c[1]} in the catalog`));
    }
    body.appendChild(detailRow("Credits", wrap));
  } else {
    body.appendChild(detailRow("Credits", String(creditsOf(item))));
  }
  if (difficulty) {
    body.appendChild(detailRow("Difficulty", difficultyNode(item.code)));
  }

  const asSel = el("select");
  const options = asOptions();
  if (item.as && !options.some((pair) => pair[0] === item.as)) {
    // Set under another major: keep it selectable rather than silently dropping it.
    options.push([item.as, `${item.as} (another major's requirement)`]);
  }
  options.filter((pair) => pair[0] !== "premed" || plan.premed || item.as === "premed").forEach((pair) => {
    const opt = el("option", null, pair[0] ? pair[1] : `Automatic (${info.label})`);
    opt.value = pair[0];
    asSel.appendChild(opt);
  });
  asSel.value = item.as || "";
  asSel.addEventListener("change", () => update(() => {
    if (asSel.value) {
      item.as = asSel.value;
    } else {
      delete item.as;
    }
  }));
  const asWrap = el("span");
  asWrap.appendChild(asSel);
  if (item.as && info.cat === "extra" && item.as !== "none") {
    asWrap.appendChild(el("div", "detail-note warn", "That requirement is already full, so this isn't counting toward it."));
  }
  body.appendChild(detailRow("Counts toward", asWrap));

  const focusWrap = el("div", "detail-focus");
  const counted = focusOf(item);
  FOCUS_LETTERS.forEach((letter) => {
    const label = el("label", "check");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = counted.includes(letter);
    cb.addEventListener("change", () => update(() => {
      const next = FOCUS_LETTERS.filter((f) => (f === letter ? cb.checked : counted.includes(f)));
      const usual = (c && c.f) || [];
      if (next.length === usual.length && next.every((f) => usual.includes(f))) {
        delete item.focus;
      } else {
        item.focus = next;
      }
    }));
    label.appendChild(cb);
    const share = focusShare(item.code, letter);
    let text = ` ${letter}`;
    if (share && share.withIt) {
      text += ` (${share.withIt} of ${share.total} sections)`;
    }
    label.appendChild(document.createTextNode(text));
    label.title = FOCUS_NAME[letter];
    focusWrap.appendChild(label);
  });
  focusWrap.appendChild(el("div", "detail-note", "Focus belongs to the section you register for. Tick what you plan to count; the counts are STAR's sections that carried each one."));
  body.appendChild(detailRow("Focus", focusWrap));

  if (c) {
    if (c.g && c.g.length) {
      body.appendChild(detailRow("Gen-ed", c.g.join(", ")));
    }
    const pre = el("div");
    pre.appendChild(el("div", null, c.pr || "None listed"));
    if (c.qr) {
      pre.appendChild(el("div", null, `Corequisite: ${c.qr}`));
    }
    if (c.r) {
      pre.appendChild(el("div", "detail-note", c.r));
    }
    body.appendChild(detailRow("Prerequisites", pre));
  }

  if (star) {
    const o = offering(item.code);
    const offered = el("div");
    offered.appendChild(el("div", null, o.label));
    if (o.per) {
      const grid = el("div", "term-grid");
      star.terms.forEach((term, i) => {
        const a = o.per[i];
        const cell = el("span", `term-cell${a ? " ran" : ""}`);
        cell.appendChild(el("span", "term-name", term.name.replace(/^(\w)\w+ \d\d(\d\d)$/, "$1$2").replace(/^S(\d\d)$/, term.season === "Summer" ? "Su$1" : "Sp$1")));
        cell.appendChild(el("span", "term-n", a ? `${a.sections} sec` : "–"));
        cell.title = a ? `${term.name}: ${plural(a.sections, "section")}, ${a.taken} of ${a.seats} seats taken` : `${term.name}: did not run`;
        grid.appendChild(cell);
      });
      offered.appendChild(grid);
    }
    body.appendChild(detailRow("Offered (STAR)", offered));
  }

  const mine = issuesFor("itemId", item.id);
  if (mine.length) {
    const ul = el("ul", "issues");
    mine.forEach((issue) => {
      const li = el("li", `issue ${issue.level}`);
      li.appendChild(el("span", "issue-mark", issue.level === "error" ? "✕" : issue.level === "warn" ? "!" : "i"));
      li.appendChild(el("span", "issue-text", issue.text));
      ul.appendChild(li);
    });
    body.appendChild(detailRow("Rule check", ul));
  }

  const actions = el("div", "modal-actions");
  // Swap this course for another in the same spot. The picker opens on the
  // requirement this one is filling, so the alternatives are one click away.
  const change = el("button", "btn", "Change course…");
  change.type = "button";
  change.title = "Pick a different course for this spot";
  change.addEventListener("click", () => {
    const swap = swapFilter(item, info);
    closeModal("detail-modal");
    openPicker({ semId: sem.id, replaceId: item.id, preset: swap.preset, only: swap.only, title: `Change ${item.code} to…` });
  });
  actions.appendChild(change);
  if (data.courses[item.code]) {
    const link = el("a", "btn", "Open in the prereq map");
    link.href = `../visualizer/index.html?course=${encodeURIComponent(item.code)}`;
    link.target = "_blank";
    link.rel = "noopener";
    actions.appendChild(link);
  }
  const remove = el("button", "btn danger", "Remove from plan");
  remove.type = "button";
  remove.addEventListener("click", () => {
    removeItem(item.id);
    closeModal("detail-modal");
    renderAll();
  });
  actions.appendChild(remove);
  body.appendChild(actions);
}

// ---------- manual entry, fill, export/import ----------

function openManualEntry() {
  const semId = picker ? picker.semId : null;
  const replaceId = picker ? picker.replaceId : null;
  const typed = picker ? picker.query.trim() : "";
  closeModal("picker-modal");
  $("manual-course-number").value = typed.toUpperCase();
  $("manual-course-name").value = "";
  $("manual-course-credits").value = "3";
  $("manual-course-gened").value = "";
  $("manual-entry-save").onclick = () => {
    const code = $("manual-course-number").value.trim().toUpperCase().replace(/\s+/g, " ");
    const sem = semesterById(semId) || plan.semesters[0];
    if (!code || !sem) {
      return;
    }
    const credits = Math.max(0, Number($("manual-course-credits").value) || 0);
    if (!data.courses[code]) {
      plan.custom[code] = {
        t: $("manual-course-name").value.trim() || code,
        c: [credits, credits],
        g: $("manual-course-gened").value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
      };
    }
    if (replaceId) {
      removeItem(replaceId);
    }
    addCourseTo(sem, code);
    closeModal("manual-entry-modal");
    renderAll();
  };
  openModal("manual-entry-modal");
  $("manual-course-number").focus();
}

function openFill() {
  const startSel = $("fill-start");
  startSel.innerHTML = "";
  const year = new Date().getFullYear();
  for (let y = year - 8; y <= year + 4; y++) {
    [`Spring ${y}`, `Fall ${y}`].forEach((term) => {
      const opt = el("option", null, term);
      opt.value = term;
      startSel.appendChild(opt);
    });
  }
  startSel.value = startTerm() || DEFAULT_START;
  if (!startSel.value) {
    startSel.value = DEFAULT_START;
  }
  const major = $("fill-major");
  major.innerHTML = "";
  programs.list.forEach((program) => {
    const opt = el("option", null, program.name);
    opt.value = program.id;
    major.appendChild(opt);
  });
  major.value = prog().id;
  const showTracks = () => fillTrackSelect($("fill-track"), programs.byId[major.value], plan.track);
  major.onchange = showTracks;
  showTracks();
  $("fill-text").textContent = "Lays out a major's August 2026 check sheet as its recommended eight semesters. Courses the sheet names go in their semesters; every open slot becomes a tile you click to choose the course.";
  const planned = plan.semesters.filter((s) => !s.transfer).reduce((n, s) => n + s.items.length, 0);
  $("fill-warning").textContent = planned ? `This replaces the ${plural(planned, "course")} currently in your semesters. Anything under “${TRANSFER_NAME}” is kept.` : "";
  openModal("fill-modal");
}

function exportPlan() {
  const name = activeEntry().name;
  const blob = new Blob([JSON.stringify(Object.assign({ name }, plan), null, 2)], { type: "application/json" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ee-degree-plan-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importPlan(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let next = null;
    let name = "Imported plan";
    try {
      const raw = JSON.parse(reader.result);
      next = sanitizePlan(raw);
      name = typeof raw.name === "string" && raw.name ? raw.name : name;
    } catch (err) {
      next = null;
    }
    if (!next) {
      askConfirm("That file isn't a plan exported from this page. Nothing was changed.", () => {});
      return;
    }
    // Comes in as its own plan, so it can't overwrite the one on screen.
    next.layout = plan.layout;
    addPlan(name, next);
  };
  reader.readAsText(file);
}

// ---------- boot ----------



function wireControls() {
  $("track-select").addEventListener("change", (event) => {
    plan.track = event.target.value;
    renderAll();
  });
  // Changing the major re-checks the same courses against the new major's
  // requirements; it doesn't touch the schedule (the check-sheet dialog does).
  $("major-select").addEventListener("change", (event) => {
    plan.program = event.target.value;
    plan.track = trackFor(prog(), plan.track);
    renderAll();
    showNotice(`Now checking this plan against ${prog().name}. Your courses are unchanged. To lay out ${prog().name}'s recommended semesters, use “Check-sheet plan…”.`);
  });
  if ($("plan-select")) {
    $("plan-select").addEventListener("change", (event) => onPlanSelect(event.target.value));
  }
  $("start-select").addEventListener("change", (event) => {
    setStartTerm(event.target.value);
    renderAll();
  });
  $("layout-vertical").addEventListener("click", () => {
    plan.layout = "vertical";
    renderAll();
  });
  $("layout-horizontal").addEventListener("click", () => {
    plan.layout = "horizontal";
    renderAll();
  });
  $("check-btn").addEventListener("click", () => {
    checkOn = true;
    renderAll();
    $("report").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("notice-close").addEventListener("click", () => showNotice(""));
  if ($("undo-btn")) {
    $("undo-btn").addEventListener("click", undo);
    $("redo-btn").addEventListener("click", redo);
  }
  // Ctrl/Cmd+Z and Ctrl/Cmd+Y (or Shift+Z), except while typing in a field,
  // where the browser's own text undo should win.
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      redo();
    }
  });
  $("fill-btn").addEventListener("click", openFill);
  if ($("advanced-btn")) {
    $("advanced-btn").addEventListener("click", () => {
      $("opt-premed").checked = !!plan.premed;
      $("premed-source").href = PREMED.source;
      openModal("advanced-modal");
    });
    $("opt-premed").addEventListener("change", (event) => {
      plan.premed = event.target.checked;
      renderAll();
    });
  }
  $("fill-go").addEventListener("click", () => {
    fillFromCheckSheet($("fill-start").value, $("fill-track").value, $("fill-major").value);
    closeModal("fill-modal");
    renderAll();
  });
  $("add-term-select").addEventListener("change", (event) => {
    if (event.target.value) {
      addSemester(event.target.value);
      renderAll();
    }
  });
  $("export-btn").addEventListener("click", exportPlan);
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (event) => {
    if (event.target.files[0]) {
      importPlan(event.target.files[0]);
    }
    event.target.value = "";
  });
  $("clear-btn").addEventListener("click", () => {
    askConfirm("Remove every course from the plan? The semesters stay.", () => {
      plan.semesters.forEach((sem) => {
        sem.items = [];
      });
      renderAll();
    });
  });

  $("picker-sem").addEventListener("change", (event) => {
    picker.semId = event.target.value;
    renderPicker();
  });
  $("picker-search").addEventListener("input", (event) => {
    picker.query = event.target.value;
    renderPicker();
  });
  $("picker-runs").addEventListener("change", (event) => {
    picker.runs = event.target.checked;
    renderPicker();
  });
  $("picker-ready").addEventListener("change", (event) => {
    picker.ready = event.target.checked;
    renderPicker();
  });
  $("picker-manual").addEventListener("click", openManualEntry);

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest("[data-close]")) {
        closeModal(modal.id);
      }
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const open = Array.from(document.querySelectorAll(".modal:not(.hidden)")).pop();
      if (open) {
        closeModal(open.id);
      }
    }
  });
}

function showNotice(text) {
  $("notice").hidden = !text;
  $("notice-text").textContent = text;
}

function renderLoadError(message) {
  const board = $("board");
  board.innerHTML = "";
  board.appendChild(el("div", "load-error", message));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function init() {
  try {
    data = await fetchJson(DATA_URL);
  } catch (err) {
    console.error(err);
    renderLoadError(
      "Could not load the course data. This page fetches web/data/planner_data.json, which browsers block over " +
        "file:// — serve this repo with a static server (e.g. `python -m http.server` from the repo root) and open " +
        "/web/index.html instead. If the file is missing, run `python scripts/build_planner_data.py`."
    );
    return;
  }
  try {
    star = prepareStar(await fetchJson(STAR_URL));
  } catch (err) {
    console.warn("STAR section data unavailable; offering and time-conflict checks are off.", err);
    star = null;
  }

  // Local only, and optional there too: see DIFFICULTY_URL.
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    try {
      difficulty = await fetchJson(DIFFICULTY_URL);
      // Scores are shown to one decimal, so that's what they're judged at:
      // a course displayed as 3.7 must not fall on the other side of a 3.7 line.
      const round = (x) => {
        x.d = Math.round(x.d * 10) / 10;
      };
      Object.values(difficulty.courses).forEach((c) => {
        if (c.n) {
          round(c);
        }
        c.by.forEach(round);
      });
    } catch (err) {
      difficulty = null;
    }
  }

  programs = buildPrograms(data);
  const saved = loadLibrary();
  // Courses already marked taken in the prereq map go in the completed
  // bucket; on a first visit the check sheet then fills in around them.
  const imported = syncFromVisualizer();
  if (!saved) {
    fillFromCheckSheet(DEFAULT_START, plan.track);
  }
  const noun = (n) => (n === 1 ? "it" : "them");
  showNotice(imported
    ? `${plural(imported, "course")} marked as taken in the prereq map ${imported === 1 ? "is" : "are"} now under “${TRANSFER_NAME}”. Drag ${noun(imported)} into the semester you took ${noun(imported)}.`
    : "");
  // The prereq map open in another tab: pick up its changes as they happen.
  window.addEventListener("storage", (event) => {
    if (event.key === VIZ_TAKEN_KEY || event.key === VIZ_TRACK_KEY) {
      const n = syncFromVisualizer();
      renderAll();
      if (n) {
        showNotice(`${plural(n, "course")} just marked as taken in the prereq map ${n === 1 ? "is" : "are"} now under “${TRANSFER_NAME}”.`);
      }
    }
  });

  $("app-footer").textContent =
    `Sources: each major's August 2026 curriculum check sheet, the ${data.catalog} catalog's prerequisites` +
    (star ? `, and UH STAR class availability for ${star.terms[0].name} – ${star.terms[star.terms.length - 1].name}. ` +
      "When a course runs, how full it gets and when it meets are read from those past terms; departments change schedules. " : ". ") +
    (difficulty ? `Difficulty ratings are Rate My Professors reviews collected ${difficulty.collected}, shown on this computer only: self-selected opinions, not a measure of the course. ` : "") +
    "Not an official degree audit. Confirm your plan with your department's advisor. Your plans are saved in this browser only.";

  wireControls();
  renderAll();
}

init();
