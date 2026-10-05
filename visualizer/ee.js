(function () {
  "use strict";

  // EE degree planning -- the "EE degree" tab of analysis.html. Combines three
  // sources a student or counselor would otherwise have to cross-reference by
  // hand:
  //   * the EE check sheet's requirement lists (data/ee_relevant_EE*.json, built
  //     by scripts/build_ee_relevant_courses.py) and the August 2026 sheet's
  //     recommended 8-semester grid (CHECKSHEET_GRID below, read off
  //     checksheets/2026.pdf),
  //   * the catalog's parsed prereq/coreq trees (data/prereq_graph*.json),
  //   * STAR's section history (data/star_sections.json): which terms each
  //     course actually ran, how many sections, how full, and when it meets.
  // Everything is computed in the browser; charts come from viz.js.

  var V = window.StarViz;
  var el = V.el, fmt = V.fmt, pct = V.pct, showTip = V.showTip, hideTip = V.hideTip, hover = V.hover, legend = V.legend,
    columnChart = V.columnChart, hBars = V.hBars, heatmap = V.heatmap, seqColor = V.seqColor, seqIsDark = V.seqIsDark,
    rampLegend = V.rampLegend, shortTerm = V.shortTerm, patternOf = V.patternOf, fillCell = V.fillCell, sortable = V.sortable;
  var DAYS = V.DAYS, HOURS = V.HOURS, ATTR_LABELS = V.ATTR_LABELS;

  var root = document.getElementById("ee-root");
  var STAR_URL = "data/star_sections.json";
  var TAKEN_KEY = "prereqMapTaken", TRACK_KEY = "prereqMapTrack";
  var SEASONS = ["Fall", "Spring", "Summer"];
  var EB_SUBJECTS = ["CEE", "ME", "ORE", "BE"];
  // Same category hues the course graph uses (styles.css --cat-*), as chip stripes.
  var CAT_COLOR = {
    fixed: "hsl(var(--cat-fixed-h), var(--cat-fixed-s), 52%)", group1: "hsl(var(--cat-group1-h), var(--cat-group1-s), 45%)",
    group2: "hsl(var(--cat-group2-h), var(--cat-group2-s), 40%)", te: "hsl(var(--cat-te-h), var(--cat-te-s), 55%)",
    eb: "hsl(var(--cat-eb-h), var(--cat-eb-s), 52%)", gened: "hsl(var(--cat-gened-h), var(--cat-gened-s), 55%)",
  };
  var CAT_LABEL = { fixed: "Fixed requirement", group1: "Major Group I", group2: "Major Group II", te: "Technical elective", eb: "Engineering breadth", gened: "Gen-ed slot" };
  // ECE 296/396/496 (and the ENGR equivalents, note 10) are project courses the
  // department arranges -- they barely appear in STAR's class listings, which
  // must not be read as "never offered".
  var ARRANGED = /^(ECE|EE|ENGR) [1-4]96$/;
  // Credits for variable-credit courses, as the check sheet's grid prints them.
  var GRID_CREDITS = { "ECE 296": 1, "ECE 396": 2, "ECE 496": 3, "ECE 495": 1 };
  // Class-standing gate the catalog's prereq text often leaves implicit (ECE
  // 495 has no parsed prereq at all): no 300-level course before the 3rd
  // regular semester, no 400-level before the 5th.
  var LEVEL_GATE = { 3: 2, 4: 4 };

  // The August 2026 check sheet's recommended plan, Freshman Fall (0) through
  // Senior Spring (7). {code}, {alt: [...]} for "X or Y", or {slot} for an open
  // requirement the student fills.
  var CHECKSHEET_GRID = [
    [{ code: "ENG 100" }, { code: "MATH 241" }, { code: "CHEM 161" }, { code: "CHEM 161L" }, { alt: ["ECE 160", "ECE 110"] }],
    [{ code: "MATH 242" }, { code: "PHYS 170" }, { code: "PHYS 170L" }, { code: "CHEM 162" }, { slot: "FG", credits: 3 }],
    [{ code: "ECE 211" }, { code: "ECE 260" }, { code: "MATH 243" }, { code: "PHYS 272" }, { code: "PHYS 272L" }],
    [{ code: "ECE 213" }, { code: "MATH 244" }, { code: "PHYS 274" }, { code: "ECE 296" }, { code: "COMG 251" }, { slot: "FG", credits: 3 }],
    [{ code: "ECE 315" }, { code: "ECE 324" }, { code: "ECE 371" }, { alt: ["ECE 345", "MATH 307"] }, { slot: "EB", credits: 3 }],
    [{ code: "ECE 323" }, { code: "ECE 323L" }, { code: "ECE 342" }, { slot: "TE", credits: 3 }, { slot: "G1", credits: 3 }, { slot: "G1L", credits: 1 }, { code: "ECE 396" }],
    [{ slot: "G1", credits: 3 }, { slot: "G1L", credits: 1 }, { slot: "G1", credits: 3 }, { slot: "TE", credits: 3 }, { slot: "TEL", credits: 1 }, { slot: "DHDL", credits: 3 }],
    [{ code: "ECE 496" }, { code: "ECE 495" }, { slot: "G2", credits: 3 }, { slot: "G2", credits: 3 }, { alt: ["ECON 120", "ECON 130", "ECON 131"] }, { slot: "DS", credits: 3 }],
  ];
  var GRID_YEARS = ["Freshman", "Sophomore", "Junior", "Senior"];
  var SLOT_LABEL = { FG: "FG", EB: "EB", TE: "TE ECE", TEL: "(Lab) TE ECE", G1: "Major ECE (Group I)", G1L: "(Lab) ECE (Group I)", G2: "Major ECE (Group II)", DHDL: "DH or DL", DS: "DS" };
  // Open Gen-ed slots the planner schedules as placeholders (the ECON course
  // is the sheet's other DS; COMG 251 its DA).
  var GENED_SLOTS = [
    { id: "__FG1", label: "FG", tags: ["FGA", "FGB", "FGC"] }, { id: "__FG2", label: "FG", tags: ["FGA", "FGB", "FGC"] },
    { id: "__DHDL", label: "DH or DL", tags: ["DH", "DL"] }, { id: "__DS", label: "DS", tags: ["DS"] },
  ];

  var D = null, star = null, rel = null, graph = null, taken = {};
  var P = {
    catalog: CATALOGS[0].id, track: null, start: null, cap: 17, summer: false, useTaken: true, g2: null,
    elecSeason: "ALL", ddSeason: "Spring", ddOnline: false, heatSeason: "Fall", ebSort: null,
    elecSort: { key: "rel", dir: -1 },
    // "Conflicts in past terms": which check-sheet semester (0-7, default
    // Junior Fall) and which past term of its season the timetable shows.
    cohort: 4, cohortTerm: null,
  };

  // ---------- STAR lookups ----------
  function starCode(code) { return code.replace(/^EE /, "ECE "); }
  function prepareStar(data) {
    var index = {};
    data.codes.forEach(function (c, i) { index[c] = i; });
    var per = data.codes.map(function () { return null; });
    data.rows.forEach(function (r) {
      var t = per[r[1]] || (per[r[1]] = data.terms.map(function () { return null; }));
      var a = t[r[0]] || (t[r[0]] = { sections: 0, seats: 0, taken: 0, credits: {}, rows: [], online: 0 });
      a.sections++; a.seats += r[2]; a.taken += r[3]; a.rows.push(r);
      a.credits[r[7]] = (a.credits[r[7]] || 0) + 1;
      if (r[4] === 1) a.online++;
    });
    var latest = {};
    data.terms.forEach(function (t, i) { latest[t.season] = i; });
    return { index: index, per: per, latest: latest };
  }
  function ci(code) { var i = star.index[starCode(code)]; return i == null ? -1 : i; }
  function perTerm(code) { var i = ci(code); return i < 0 ? null : star.per[i]; }
  function info(code) {
    var pt = perTerm(code), arranged = ARRANGED.test(code);
    var p = patternOf(pt, D.terms);
    return { per: pt, pattern: p, arranged: arranged, known: !!pt && !arranged };
  }
  // "yes" every captured term of that season / "some" / "no" / "unknown"
  // (arranged, or no STAR history at all -- never treated as a hard no).
  function seasonStatus(code, season) {
    var x = info(code);
    if (!x.known) return "unknown";
    var s = x.pattern.by[season];
    return !s.n ? "no" : s.n === s.of ? "yes" : "some";
  }
  function lastRun(code, season) {
    var pt = perTerm(code);
    if (!pt) return null;
    for (var i = D.terms.length - 1; i >= 0; i--) if (pt[i] && (!season || D.terms[i].season === season)) return { term: D.terms[i], i: i, a: pt[i] };
    return null;
  }
  function attrsOf(code) {
    var pt = perTerm(code), mask = 0;
    (pt || []).forEach(function (a) { if (a) a.rows.forEach(function (r) { mask |= r[5]; }); });
    return D.attrs.filter(function (a, i) { return mask & (1 << i); });
  }

  // ---------- catalog / requirement lookups ----------
  function node(code) { return graph && (graph.nodes[code] || graph.nodes[code.replace(/^ECE /, "EE ")] || graph.nodes[starCode(code)]) || null; }
  function title(code) {
    var n = node(code); if (n && n.title) return n.title;
    var i = ci(code); return i >= 0 ? D.titles[i] : "";
  }
  function credits(code) {
    if (GRID_CREDITS[code]) return GRID_CREDITS[code];
    var n = node(code);
    if (n && n.credits_min != null && n.credits_min === n.credits_max) return n.credits_min;
    var lr = lastRun(code);
    if (lr) {
      var best = null, cnt = -1;
      Object.keys(lr.a.credits).forEach(function (k) { if (lr.a.credits[k] > cnt && !isNaN(Number(k))) { best = Number(k); cnt = lr.a.credits[k]; } });
      if (best != null) return best;
    }
    return n && n.credits_min != null ? n.credits_min : 3;
  }
  function level(code) { var m = /\s(\d)\d\d/.exec(code); return m ? Number(m[1]) : 0; }
  function isTaken(code) { return P.useTaken && (taken[code] || taken[starCode(code)] || taken[code.replace(/^ECE /, "EE ")]); }
  function catOf(code) { return rel.category_by_code[code] || rel.category_by_code[code.replace(/^ECE /, "EE ")] || null; }
  function tracks() { return rel.track_groups; }
  function teCodes() { return Object.keys(rel.category_by_code).filter(function (c) { return rel.category_by_code[c] === "te"; }).sort(); }
  function ebNamed() { return Object.keys(rel.category_by_code).filter(function (c) { return rel.category_by_code[c] === "eb"; }); }
  function reliability(code) {
    var x = info(code);
    if (!x.known) return x.arranged ? 2 : 0;
    var by = x.pattern.by;
    return (by.Fall.n / (by.Fall.of || 1) + by.Spring.n / (by.Spring.of || 1)) * 1.5 + (by.Summer.n ? 0.25 : 0);
  }
  // Fixed either/or groups: the one already taken, else the most reliably offered.
  function fixedPicks() {
    return (rel.fixed_groups || []).map(function (g) {
      var t = g.filter(isTaken)[0];
      if (t) return { code: t, alts: g };
      var best = g.slice().sort(function (a, b) { return reliability(b) - reliability(a); })[0];
      return { code: best, alts: g };
    });
  }
  // Group II picks: the user's, else the most reliably offered lectures until
  // the track's credit minimum is met (labs only if still short).
  function g2Picks(track) {
    var t = tracks()[track];
    if (P.g2 && P.g2.track === track) return P.g2.codes.slice();
    var opts = t.group2.slice().sort(function (a, b) {
      return (/L$/.test(a) - /L$/.test(b)) || reliability(b) - reliability(a) || a.localeCompare(b);
    });
    var picks = t.group2.filter(isTaken), cr = picks.reduce(function (s, c) { return s + credits(c); }, 0);
    opts.forEach(function (c) { if (cr < t.group2_required_credits && picks.indexOf(c) < 0 && reliability(c) > 0) { picks.push(c); cr += credits(c); } });
    return picks;
  }

  function takenCredits() {
    if (!P.useTaken) return 0;
    return Object.keys(taken).filter(function (k) { return k.indexOf("__") !== 0 && node(k); })
      .reduce(function (s, k) { return s + credits(k); }, 0);
  }
  function standingSemesters() { return Math.round(takenCredits() / 15); }

  // Which semester (0-7) of the check sheet's grid names this course, or null.
  function gridIndexOf(code) {
    for (var i = 0; i < CHECKSHEET_GRID.length; i++) {
      if (CHECKSHEET_GRID[i].some(function (it) { return it.code === code || (it.alt && it.alt.indexOf(code) >= 0); })) return i;
    }
    return null;
  }

  // ---------- prereq trees ----------
  function leaves(tree, out) {
    out = out || [];
    if (!tree) return out;
    if (tree.course) out.push({ code: tree.course, concurrent: !!tree.concurrent });
    (tree.children || []).forEach(function (c) { leaves(c, out); });
    return out;
  }
  function mentionsCourse(t) { return !!t && (!!t.course || (t.children || []).some(mentionsCourse)); }

  // ---------- the scheduler ----------
  // Semesters from a start term: Fall Y -> Spring Y+1 -> (Summer Y+1) -> Fall Y+1 ...
  function semesters(startKey, n, summer) {
    var t = D.terms[termIndex(startKey)] || D.terms[D.terms.length - 1];
    var parts = t.name.split(" "), season = parts[0], year = Number(parts[1]);
    if (startKey && startKey.indexOf("+") >= 0) { // a future start beyond STAR's data, e.g. "Spring+2027"
      parts = startKey.split("+"); season = parts[0]; year = Number(parts[1]);
    }
    var out = [], reg = 0;
    while (out.length < n) {
      if (season !== "Summer" || summer) out.push({ season: season, year: year, name: season + " " + year, reg: reg });
      if (season !== "Summer") reg++;
      if (season === "Fall") { season = "Spring"; year++; } else if (season === "Spring") season = "Summer"; else season = "Fall";
    }
    return out;
  }
  function termIndex(key) { for (var i = 0; i < D.terms.length; i++) if (D.terms[i].key === key) return i; return -1; }

  // List scheduling: every semester, place whatever is ready -- prereqs/coreqs
  // done (or concurrent ones this same term), class standing reached, offered
  // that season per STAR, room under the credit cap -- longest remaining chain
  // first. Options: blocked {code: semIndex} forbids one placement (the "if you
  // miss it" reruns); ignoreSeasons drops the STAR constraint (prereqs-only).
  function plan(opts) {
    opts = opts || {};
    var track = P.track, t = tracks()[track];
    var courses = [];
    function add(code, cat, extra) {
      if (isTaken(code) || courses.some(function (c) { return c.code === code; })) return;
      var o = { code: code, cat: cat, credits: credits(code), real: true };
      Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
      courses.push(o);
    }
    fixedPicks().forEach(function (f) { add(f.code, "fixed", f.alts.length > 1 ? { alts: f.alts } : null); });
    t.group1.forEach(function (c) { add(c, "group1"); });
    var g2 = g2Picks(track);
    g2.forEach(function (c) { add(c, "group2"); });
    // Group II credits past the minimum spill into TE (note 9).
    var g2cr = g2.reduce(function (s, c) { return s + credits(c); }, 0);
    var teNeed = Math.max(0, 7 - Math.max(0, g2cr - t.group2_required_credits));
    var eb = ebNamed()[0] || "CEE 270";
    if (!isTaken(eb)) add(eb, "eb");
    var holders = [];
    if (teNeed >= 1) holders.push({ code: "__TEL", label: "TE lab", credits: 1, cat: "te", gate: 4 });
    for (var k = teNeed - 1; k > 0; k -= 3) holders.push({ code: "__TE" + k, label: "TE ECE", credits: Math.min(3, k), cat: "te", gate: 4 });
    GENED_SLOTS.forEach(function (g) { holders.push({ code: g.id, label: g.label, credits: 3, cat: "gened", gate: 0, summerOk: true }); });

    var inPlan = {};
    courses.forEach(function (c) { inPlan[c.code] = c; });
    // Longest remaining chain through each course (successors in the plan).
    var succ = {};
    courses.forEach(function (c) {
      var n = node(c.code);
      leaves(n && n.prereq_tree).concat(leaves(n && n.coreq_tree).map(function (l) { return { code: l.code, concurrent: true }; })).forEach(function (l) {
        if (!inPlan[l.code]) return;
        (succ[l.code] = succ[l.code] || []).push({ code: c.code, w: l.concurrent ? 0 : 1 });
      });
    });
    var rank = {}, visiting = {};
    function rk(code) {
      if (rank[code] != null) return rank[code];
      if (visiting[code]) return 0;
      visiting[code] = true;
      var best = 0;
      (succ[code] || []).forEach(function (s) { best = Math.max(best, rk(s.code) + s.w); });
      visiting[code] = false;
      return (rank[code] = best);
    }
    courses.forEach(function (c) {
      c.rank = rk(c.code);
      c.scarce = ["Fall", "Spring"].filter(function (s) { return seasonStatus(c.code, s) === "no"; }).length;
      c.grid = gridIndexOf(c.code);
      // A course with no course prereqs at all (ECE 495, the arranged project
      // sequence, COMG 251...) would otherwise land in semester one: hold it
      // to no earlier than where the check sheet's grid puts it.
      var n = node(c.code);
      if (c.grid != null && (ARRANGED.test(c.code) || !leaves(n && n.prereq_tree).length)) c.gate = Math.max(LEVEL_GATE[level(c.code)] || 0, c.grid);
    });
    var order = courses.slice().sort(function (a, b) {
      return b.rank - a.rank || b.scarce - a.scarce || (a.grid == null ? 9 : a.grid) - (b.grid == null ? 9 : b.grid) || b.credits - a.credits || a.code.localeCompare(b.code);
    });

    var sems = semesters(P.start, 24, P.summer);
    var placed = {}, waits = {}, capDefer = {};
    function done(code, s, concurrentOk) {
      if (isTaken(code)) return true;
      if (!inPlan[code]) return null; // outside the plan: assumed met (placement, AP, transfer)
      return placed[code] != null && (concurrentOk ? placed[code] <= s : placed[code] < s);
    }
    function sat(tree, s, forceConcurrent) {
      if (!tree) return null;
      if (tree.course) return done(tree.course, s, forceConcurrent || tree.concurrent);
      if (!tree.op) return null; // consent / standing / unparsed: not a course gate
      var vals = (tree.children || []).map(function (c) { return sat(c, s, forceConcurrent); });
      if (tree.op === "AND") return vals.some(function (v) { return v === false; }) ? false : true;
      if (tree.op === "OR") {
        var decided = vals.filter(function (v) { return v !== null; });
        if (!decided.length) return null;
        return decided.some(Boolean);
      }
      if (tree.op === "N_OF") { var need = tree.n || vals.length; return vals.filter(function (v) { return v !== false; }).length >= need; }
      return null;
    }
    function ready(c, s) {
      var n = node(c.code);
      return sat(n && n.prereq_tree, s) !== false && sat(n && n.coreq_tree, s, true) !== false;
    }
    // Standing gates count from the student's real standing, not the plan's
    // first term: semesters already done ~ credits marked taken / 15.
    var already = standingSemesters();
    function gateOk(c, sem) { return sem.reg + already >= (c.gate != null ? c.gate : (LEVEL_GATE[level(c.code)] || 0)); }
    function offered(c, sem) {
      if (opts.ignoreSeasons) return sem.season !== "Summer" || !!c.summerOk || seasonStatus(c.code, "Summer") !== "no";
      if (c.code.indexOf("__") === 0) return sem.season !== "Summer" || !!c.summerOk;
      var st = seasonStatus(c.code, sem.season);
      if (st === "unknown") return sem.season !== "Summer";
      return st !== "no";
    }
    var left = order.length + holders.length, s;
    for (s = 0; s < sems.length && left > 0; s++) {
      var sem = sems[s], cr = 0, cap = sem.season === "Summer" ? Math.min(7, P.cap) : P.cap, changed = true;
      while (changed) {
        changed = false;
        for (var i = 0; i < order.length; i++) {
          var c = order[i];
          if (placed[c.code] != null || !gateOk(c, sem)) continue;
          if (opts.blocked && opts.blocked[c.code] === s) continue;
          if (!ready(c, s)) continue;
          if (!offered(c, sem)) { if (!waits[c.code]) waits[c.code] = []; if (waits[c.code].indexOf(sem.name) < 0) waits[c.code].push(sem.name); continue; }
          if (cr + c.credits > cap) { capDefer[c.code] = true; continue; }
          placed[c.code] = s; cr += c.credits; left--; changed = true;
          // Rescan from the top: this placement may have just made a
          // higher-priority course ready (a concurrent prereq), and it should
          // get the remaining room before anything further down the list.
          break;
        }
      }
      holders.forEach(function (h) {
        if (placed[h.code] != null || !gateOk(h, sem) || !offered(h, sem) || cr + h.credits > cap) return;
        placed[h.code] = s; cr += h.credits; left--;
      });
    }
    var all = order.concat(holders);
    var last = -1;
    all.forEach(function (c) { if (placed[c.code] != null && placed[c.code] > last) last = placed[c.code]; });
    var used = sems.slice(0, last + 1).map(function (sem, i) {
      var items = all.filter(function (c) { return placed[c.code] === i; });
      return { sem: sem, items: items, credits: items.reduce(function (x, c) { return x + c.credits; }, 0) };
    });
    return {
      courses: order, holders: holders, placed: placed, sems: used, waits: waits, capDefer: capDefer,
      unplaced: all.filter(function (c) { return placed[c.code] == null; }),
      lastSem: last >= 0 ? sems[last] : null, regular: last >= 0 ? sems[last].reg + 1 : 0, g2: g2, teNeed: teNeed,
    };
  }

  // ---------- meeting-time conflicts ----------
  function parseMeetings(str) {
    return (str || "").split("|").filter(Boolean).map(function (m) {
      var p = m.split(" "), span = p[1].split("-");
      function mins(x) { return parseInt(x.slice(0, 2), 10) * 60 + parseInt(x.slice(2), 10); }
      return { days: p[0], s: mins(span[0]), e: mins(span[1]) };
    });
  }
  function clash(a, b) {
    var A = parseMeetings(a), B = parseMeetings(b);
    return A.some(function (x) {
      return B.some(function (y) {
        return x.s < y.e && y.s < x.e && x.days.split("").some(function (d) { return y.days.indexOf(d) >= 0; });
      });
    });
  }
  function prettyMeeting(m) {
    return parseMeetings(m).map(function (x) {
      function t(v) { var h = Math.floor(v / 60), mm = ("0" + (v % 60)).slice(-2); return (h % 12 || 12) + ":" + mm + (h < 12 ? "a" : "p"); }
      return x.days + " " + t(x.s) + "–" + t(x.e);
    }).join("; ");
  }

  // ---------- page scaffolding ----------
  var controls, content;
  function card(title, sub, cls) {
    var c = el("section", "st-card" + (cls ? " " + cls : ""));
    var head = el("div", "st-card-head"), hw = el("div");
    hw.appendChild(el("h3", null, title));
    if (sub) hw.appendChild(el("p", "st-sub", sub));
    head.appendChild(hw); c.appendChild(head); content.appendChild(c);
    c.head = head;
    return c;
  }
  function seg(c, options, value, onChange) {
    var g = el("div", "st-seg");
    options.forEach(function (o) {
      var b = el("button", null, o[1]); b.type = "button";
      b.setAttribute("aria-pressed", String(o[0] === value));
      b.addEventListener("click", function () { onChange(o[0]); render(); });
      g.appendChild(b);
    });
    c.head.appendChild(g);
  }
  function sectionTitle(text) { content.appendChild(el("h2", "st-section-title", text)); }
  function pill(text, kind, titleText) { var p = el("span", "st-pill" + (kind ? " " + kind : ""), text); if (titleText) p.title = titleText; return p; }
  function patternPill(code) {
    var x = info(code);
    if (x.arranged) return pill("Arranged", "ee-arranged", "Project course arranged through the department — rarely listed in STAR, so no season data.");
    if (!x.per) return pill("Not in STAR", "offer-none", "No sections in any captured term (" + D.terms[0].name + " – " + D.terms[D.terms.length - 1].name + ").");
    return pill(x.pattern.label, "offer-" + x.pattern.kind, "Fall " + x.pattern.by.Fall.n + "/" + x.pattern.by.Fall.of + " · Spring " + x.pattern.by.Spring.n + "/" + x.pattern.by.Spring.of + " · Summer " + x.pattern.by.Summer.n + "/" + x.pattern.by.Summer.of);
  }
  var STATUS = {
    yes: { icon: "✓", cls: "ok", text: "runs every" }, some: { icon: "!", cls: "warn", text: "only some" },
    no: { icon: "✕", cls: "bad", text: "never in" }, unknown: { icon: "○", cls: "unk", text: "arranged / no data for" }, done: { icon: "✓", cls: "done", text: "already taken" },
  };
  function statusIcon(st, titleText) {
    var s = el("span", "ee-st " + STATUS[st].cls, STATUS[st].icon);
    s.setAttribute("aria-label", titleText || STATUS[st].text); s.title = titleText || "";
    return s;
  }
  function graphLink(code) {
    var a = el("a", "ee-code", code);
    a.href = "index.html?course=" + encodeURIComponent(code); a.target = "_blank"; a.rel = "noopener";
    a.title = title(code) + " — open in the course graph";
    return a;
  }

  function select(label, value, options, onChange) {
    var f = el("label", "cmp-field");
    f.appendChild(el("span", null, label));
    var s = el("select", "year-select"); s.setAttribute("aria-label", label);
    options.forEach(function (o) { var op = el("option", null, o[1]); op.value = o[0]; s.appendChild(op); });
    s.value = value;
    s.addEventListener("change", function () { onChange(s.value); });
    f.appendChild(s); controls.appendChild(f);
    return s;
  }
  function startOptions() {
    // The latest captured term and the next two after it.
    var last = D.terms[D.terms.length - 1], parts = last.name.split(" "), season = parts[0], year = Number(parts[1]);
    var out = [];
    for (var k = 0; k < 4 && out.length < 3; k++) {
      if (season !== "Summer") out.push([k === 0 ? last.key : season + "+" + year, season + " " + year]);
      if (season === "Fall") { season = "Spring"; year++; } else if (season === "Spring") season = "Summer"; else season = "Fall";
    }
    return out;
  }
  function buildControls() {
    controls.textContent = "";
    var catOpts = CATALOGS.filter(function (c) { return PROGRAMS[0].urls[c.id]; }).map(function (c) { return [c.id, c.label + " catalog"]; });
    select("Requirements from", P.catalog, catOpts, function (v) { P.catalog = v; P.g2 = null; loadCatalog().then(render); });
    select("Track", P.track, Object.keys(tracks()).map(function (k) { return [k, tracks()[k].name]; }), function (v) { P.track = v; P.g2 = null; render(); });
    select("Start", P.start, startOptions(), function (v) { P.start = v; render(); });
    select("Credits / semester", String(P.cap), [12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map(function (n) { return [String(n), n + " max"]; }), function (v) { P.cap = Number(v); render(); });
    select("Summers", P.summer ? "yes" : "no", [["no", "No summer classes"], ["yes", "Use summers (7 cr max)"]], function (v) { P.summer = v === "yes"; render(); });
    var n = Object.keys(taken).filter(function (k) { return k.indexOf("__") !== 0; }).length;
    var lab = el("label", "ee-check");
    var cb = el("input"); cb.type = "checkbox"; cb.checked = P.useTaken; cb.disabled = !n;
    cb.addEventListener("change", function () { P.useTaken = cb.checked; render(); });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(n ? " Use my " + n + " courses marked taken in the course graph" : " No courses marked taken in the course graph yet"));
    controls.appendChild(lab);
  }

  // ---------- render ----------
  function render() {
    hideTip();
    var y = window.scrollY;
    content.textContent = "";
    if (!tracks()[P.track]) P.track = Object.keys(tracks())[0];
    buildControls();
    var main = plan();
    var prereqOnly = plan({ ignoreSeasons: true });
    var grid = gridCheck(P.track);
    var miss = missCosts(main);
    renderKpis(main, prereqOnly, grid, miss);
    sectionTitle("Plan");
    renderGrid(grid);
    renderPlan(main, prereqOnly);
    renderMiss(main, miss);
    renderGatekeepers(main);
    sectionTitle("When requirements actually run");
    renderAvailability(main);
    renderTracks();
    renderElectives();
    sectionTitle("Scheduling");
    renderConflicts(main);
    renderHeat(main);
    renderPipeline();
    var hist = conflictHistory();
    sectionTitle("Conflicts in past terms");
    renderHistory(hist);
    sectionTitle("Gen-ed, Focus and breadth");
    renderGened(main);
    renderEB(main);
    sectionTitle("Advising notes");
    renderNotes(main, grid, miss, hist);
    window.scrollTo(0, y);
  }

  // ---------- KPIs ----------
  function renderKpis(main, prereqOnly, grid, miss) {
    var wrap = el("div", "st-kpis"); content.appendChild(wrap);
    function tile(label, value, sub, hero) {
      var t = el("div", "st-kpi" + (hero ? " hero" : ""));
      t.appendChild(el("div", "label", label)); t.appendChild(el("div", "value", value));
      t.appendChild(el("div", "delta", sub || ""));
      wrap.appendChild(t);
    }
    var reqCodes = main.courses.map(function (c) { return c.code; });
    var single = reqCodes.filter(function (c) { var x = info(c); return x.known && (x.pattern.kind === "fall" || x.pattern.kind === "spring"); });
    var full = reqCodes.filter(function (c) { var lr = lastRun(c); return lr && info(c).known && lr.a.taken >= lr.a.seats * 0.95; });
    var t = tracks()[P.track];
    var neverG2 = t.group2.filter(function (c) { return !info(c).per; });
    tile("Earliest graduation", main.lastSem ? main.lastSem.name : "–", main.regular + " regular semesters from " + (main.sems[0] ? main.sems[0].sem.name : ""), true);
    tile("Cost of seasonality", (main.regular - prereqOnly.regular > 0 ? "+" : "") + (main.regular - prereqOnly.regular), "semesters vs. prereqs alone (" + prereqOnly.regular + ")");
    tile("Check sheet issues", String(grid.issues.length), grid.issues.length ? "slots that don't match when courses run" : "the recommended grid works as printed");
    tile("Single-season courses", String(single.length), "of " + reqCodes.length + " courses left to plan");
    tile("Fill up", String(full.length), "were 95%+ full the last time they ran");
    tile("Miss it, lose a year", String(miss.filter(function (m) { return m.delay >= 2; }).length), "courses whose one missed term costs 2+ semesters");
    tile("Group II never run", neverG2.length + " / " + t.group2.length, "listed for " + P.track + " but no section in " + D.terms.length + " terms");
  }

  // ---------- 1. check sheet grid vs STAR ----------
  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    var out = [];
    arr.forEach(function (x, i) { permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach(function (p) { out.push([x].concat(p)); }); });
    return out;
  }
  // Best assignment of a track's Group I courses (lectures and labs separately)
  // to the grid's Group I slots, scored by whether each runs in the slot's season.
  function matchGroupI(track) {
    var t = tracks()[track], slots = { G1: [], G1L: [] };
    CHECKSHEET_GRID.forEach(function (sem, si) { sem.forEach(function (it, k) { if (it.slot === "G1" || it.slot === "G1L") slots[it.slot].push({ si: si, k: k }); }); });
    var score = { yes: 3, unknown: 2, some: 1, no: 0 }, result = {};
    [["G1", t.group1.filter(function (c) { return !/L$/.test(c); })], ["G1L", t.group1.filter(function (c) { return /L$/.test(c); })]].forEach(function (pair) {
      var list = slots[pair[0]], codes = pair[1].slice();
      while (codes.length < list.length) codes.push(null);
      var best = null, bestScore = -1;
      permutations(codes).forEach(function (perm) {
        var sc = 0;
        list.forEach(function (sl, i) { if (perm[i]) sc += score[seasonStatus(perm[i], sl.si % 2 ? "Spring" : "Fall")]; });
        if (sc > bestScore) { bestScore = sc; best = perm; }
      });
      list.forEach(function (sl, i) { result[sl.si + ":" + sl.k] = best ? best[i] : null; });
      // More Group I courses than grid slots (SDS lists 12 cr): the extras.
      result["extra:" + pair[0]] = pair[1].filter(function (c) { return !best || best.indexOf(c) < 0; });
    });
    return result;
  }
  function seasonOfGridSem(si) { return si % 2 ? "Spring" : "Fall"; }
  function slotOptions(slot, season, track) {
    var t = tracks()[track], codes = [];
    if (slot === "G2") codes = t.group2;
    else if (slot === "TE" || slot === "TEL") {
      codes = teCodes();
      Object.keys(tracks()).forEach(function (k) { if (k !== track) codes = codes.concat(tracks()[k].group1, tracks()[k].group2); });
      codes = codes.filter(function (c, i, a) { return a.indexOf(c) === i && t.group1.indexOf(c) < 0 && t.group2.indexOf(c) < 0; });
      if (slot === "TEL") codes = codes.filter(function (c) { return /L$/.test(c); }); else codes = codes.filter(function (c) { return !/L$/.test(c); });
    } else if (slot === "EB") codes = ebNamed().concat(ebSubjectCodes());
    return codes.filter(function (c) { return seasonStatus(c, season) === "yes"; });
  }
  function ebSubjectCodes() {
    return D.codes.filter(function (c) {
      var p = c.split(" "), m = /(\d+)/.exec(p[1] || "");
      return EB_SUBJECTS.indexOf(p[0]) >= 0 && m && Number(m[1]) >= 300 && Number(m[1]) < 500;
    });
  }
  function genedCount(tags, season) {
    var li = star.latest[season];
    if (li == null) return 0;
    var bits = tags.map(function (t) { return 1 << D.attrs.indexOf(t); }), seen = {};
    D.rows.forEach(function (r) { if (r[0] === li && bits.some(function (b) { return r[5] & b; })) seen[r[1]] = true; });
    return Object.keys(seen).length;
  }
  function gridCheck(track) {
    var g1 = matchGroupI(track), issues = [], cells = [];
    CHECKSHEET_GRID.forEach(function (sem, si) {
      var season = seasonOfGridSem(si), out = [];
      sem.forEach(function (it, k) {
        var row = { item: it, season: season, si: si };
        if (it.code || it.alt) {
          var codes = it.code ? [it.code] : it.alt;
          var tk = codes.filter(isTaken)[0];
          var statuses = codes.map(function (c) { return { c: c, st: seasonStatus(c, season) }; });
          var order = { yes: 0, unknown: 1, some: 2, no: 3 };
          statuses.sort(function (a, b) { return order[a.st] - order[b.st]; });
          row.label = codes.join(" or "); row.codes = codes; row.credits = credits(statuses[0].c);
          row.status = tk ? "done" : statuses[0].st; row.best = statuses[0].c;
        } else if (it.slot === "G1" || it.slot === "G1L") {
          var c = g1[si + ":" + k];
          row.label = SLOT_LABEL[it.slot]; row.credits = it.credits;
          row.assigned = c; row.status = !c ? "unknown" : isTaken(c) ? "done" : seasonStatus(c, season);
        } else if (it.slot === "G2" || it.slot === "TE" || it.slot === "TEL" || it.slot === "EB") {
          var opts = slotOptions(it.slot, season, track);
          row.label = SLOT_LABEL[it.slot]; row.credits = it.credits; row.options = opts;
          row.status = opts.length >= (it.slot === "G2" ? 2 : 1) ? "yes" : opts.length ? "some" : "no";
        } else {
          var tags = it.slot === "FG" ? ["FGA", "FGB", "FGC"] : it.slot === "DHDL" ? ["DH", "DL"] : ["DS"];
          var n = genedCount(tags, season);
          row.label = SLOT_LABEL[it.slot]; row.credits = it.credits; row.count = n; row.status = n ? "yes" : "no";
        }
        if (row.status === "no" || row.status === "some") issues.push(row);
        out.push(row);
      });
      cells.push(out);
    });
    return { cells: cells, issues: issues, g1: g1 };
  }
  function renderGrid(grid) {
    var c = card("Check sheet plan vs. when courses actually run",
      "The August 2026 check sheet's recommended 8 semesters, with every slot checked against STAR: does it run in that season? Group I slots are filled with your track's courses in the best order the seasons allow.", "wide");
    // The grid starts in a Fall: label it from the first Fall on or after the chosen start.
    var firstFall = semesters(P.start, 3, false).filter(function (s) { return s.season === "Fall"; })[0];
    var g = el("div", "ee-grid"); c.appendChild(g);
    CHECKSHEET_GRID.forEach(function (sem, si) {
      var col = el("div", "ee-grid-col");
      var season = seasonOfGridSem(si), yr = firstFall.year + Math.floor(si / 2) + (si % 2 ? 1 : 0);
      var h = el("div", "ee-grid-head");
      h.appendChild(el("strong", null, GRID_YEARS[Math.floor(si / 2)] + " " + season));
      h.appendChild(el("span", null, season + " " + yr));
      col.appendChild(h);
      var total = 0;
      grid.cells[si].forEach(function (row) {
        total += row.credits || 0;
        var r = el("div", "ee-grid-row " + STATUS[row.status].cls);
        r.appendChild(statusIcon(row.status));
        var lab = el("span", "lab");
        if (row.assigned) { lab.appendChild(graphLink(row.assigned)); lab.appendChild(el("span", "slot", " Group I")); }
        else if (row.codes) row.codes.forEach(function (cd, i) { if (i) lab.appendChild(document.createTextNode(" or ")); lab.appendChild(graphLink(cd)); });
        else lab.textContent = row.label;
        r.appendChild(lab);
        r.appendChild(el("span", "cr", String(row.credits || "")));
        hover(r, function (evt) {
          var rows = [], note;
          if (row.codes || row.assigned) {
            (row.codes || [row.assigned]).forEach(function (cd) {
              var x = info(cd);
              rows.push({ value: x.arranged ? "arranged" : !x.per ? "not in STAR" : x.pattern.label, label: cd });
            });
            note = STATUS[row.status].text + " " + season + (row.status === "done" ? "" : " (" + D.terms.filter(function (t) { return t.season === season; }).length + " captured)");
          } else if (row.options) {
            rows.push({ value: String(row.options.length), label: "options run every " + season });
            note = row.options.slice(0, 8).join(", ") + (row.options.length > 8 ? " …" : "");
          } else rows.push({ value: fmt(row.count), label: "courses carried it last " + season });
          showTip(evt, row.label + " · " + GRID_YEARS[Math.floor(si / 2)] + " " + season, rows, note);
        });
        col.appendChild(r);
      });
      col.appendChild(el("div", "ee-grid-total", total + " cr"));
      g.appendChild(col);
    });
    var lg = el("div", "ee-legend");
    [["yes", "runs every time in that season"], ["some", "only some years"], ["no", "never in that season"], ["unknown", "arranged / no STAR data"], ["done", "already taken"]].forEach(function (x) {
      var k = el("span"); k.appendChild(statusIcon(x[0])); k.appendChild(document.createTextNode(" " + x[1])); lg.appendChild(k);
    });
    c.appendChild(lg);
    if (grid.issues.length) {
      var ul = el("ul", "ee-issues"), said = {};
      grid.issues.forEach(function (row) {
        var li = el("li");
        var key = row.si + ":" + (row.item.slot || row.label);
        if (said[key]) return; // the grid's two identical Group II slots
        said[key] = true;
        var where = GRID_YEARS[Math.floor(row.si / 2)] + " " + row.season;
        if (row.assigned) li.textContent = row.assigned + " (" + info(row.assigned).pattern.label + ") lands in the " + where + " Group I slot — no order of your track's Group I courses fits every slot's season. Plan it for a " + (row.season === "Fall" ? "Spring" : "Fall") + " instead.";
        else if (row.codes) li.textContent = row.label + " is recommended for " + where + " but " + (row.status === "no" ? "has never run in a " + row.season : "ran in only some " + row.season + "s") + " (" + info(row.best).pattern.label + ").";
        else if (row.options) li.textContent = where + " " + row.label + ": " + (row.options.length ? "only " + row.options.length + " option runs every " + row.season + " (" + row.options.join(", ") + ")." : "no option runs every " + row.season + ".");
        else li.textContent = where + " " + row.label + ": nothing carried it last " + row.season + ".";
        ul.appendChild(li);
      });
      c.appendChild(ul);
    }
    var extra = (grid.g1["extra:G1"] || []).concat(grid.g1["extra:G1L"] || []);
    if (extra.length) c.appendChild(el("p", "st-sub", "Group I courses with no slot on the grid (the " + P.track + " track needs " + tracks()[P.track].group1_required_credits + " Group I credits): " + extra.join(", ") + " — they take one of the TE or Group II slots' time."));
  }

  // ---------- 2. planner ----------
  function renderPlan(main, prereqOnly) {
    var c = card("Fastest path from here",
      "Every remaining requirement placed as early as its prereqs, class standing (300-level from the 3rd semester, 400-level from the 5th), the credit cap, and STAR's record of which seasons it runs allow — longest prereq chain first. Gen-ed and TE slots fill the room left over.", "wide");
    var t = tracks()[P.track];
    // Group II picks
    var picks = el("div", "ee-picks");
    picks.appendChild(el("span", "st-sub", "Group II picks (" + t.group2_required_credits + " cr needed) — click to change:"));
    t.group2.forEach(function (code) {
      var on = main.g2.indexOf(code) >= 0;
      var b = el("button", "ee-chip-btn" + (on ? " on" : ""), code + " · " + credits(code) + " cr"); b.type = "button";
      b.setAttribute("aria-pressed", String(on));
      b.title = title(code) + " — " + (info(code).per ? info(code).pattern.label : "not offered in any captured term");
      b.addEventListener("click", function () {
        var cur = main.g2.slice(), i = cur.indexOf(code);
        if (i >= 0) cur.splice(i, 1); else cur.push(code);
        P.g2 = { track: P.track, codes: cur }; render();
      });
      picks.appendChild(b);
    });
    var auto = el("button", "st-link-btn", "Auto-pick"); auto.type = "button";
    auto.addEventListener("click", function () { P.g2 = null; render(); });
    picks.appendChild(auto);
    c.appendChild(picks);
    var g2cr = main.g2.reduce(function (s, x) { return s + credits(x); }, 0);
    if (g2cr < t.group2_required_credits) c.appendChild(el("p", "ee-warn", "Your Group II picks add up to " + g2cr + " of " + t.group2_required_credits + " credits."));

    var lg = el("div", "viz-legend");
    Object.keys(CAT_LABEL).forEach(function (k) { var s = el("span", "key"); var sw = el("span", "sw"); sw.style.background = CAT_COLOR[k]; s.appendChild(sw); s.appendChild(document.createTextNode(CAT_LABEL[k])); lg.appendChild(s); });
    c.appendChild(lg);

    var tl = el("div", "ee-timeline"); c.appendChild(tl);
    main.sems.forEach(function (s, i) {
      var col = el("div", "ee-sem" + (s.sem.season === "Summer" ? " summer" : ""));
      var h = el("div", "ee-sem-head");
      h.appendChild(el("strong", null, s.sem.name));
      h.appendChild(el("span", s.credits > 18 ? "over" : null, s.credits + " cr"));
      col.appendChild(h);
      s.items.slice().sort(function (a, b) { return (a.code.indexOf("__") === 0) - (b.code.indexOf("__") === 0) || a.code.localeCompare(b.code); }).forEach(function (it) {
        var chip = el("div", "ee-chip");
        chip.style.borderLeftColor = CAT_COLOR[it.cat];
        var top = el("div", "top");
        if (it.real) top.appendChild(graphLink(it.code)); else top.appendChild(el("span", "ph", it.label));
        top.appendChild(el("span", "cr", String(it.credits)));
        chip.appendChild(top);
        if (it.real) {
          var flags = el("div", "flags"), x = info(it.code);
          if (x.arranged) flags.appendChild(el("span", "f", "arranged"));
          else if (x.known && (x.pattern.kind === "fall" || x.pattern.kind === "spring")) flags.appendChild(el("span", "f warn", x.pattern.kind === "fall" ? "Fall only" : "Spring only"));
          else if (x.known && x.pattern.kind === "irregular") flags.appendChild(el("span", "f warn", "irregular"));
          else if (!x.per) flags.appendChild(el("span", "f bad", "not in STAR"));
          var lr = lastRun(it.code);
          if (lr && x.known && lr.a.taken >= lr.a.seats * 0.95) flags.appendChild(el("span", "f warn", "fills up"));
          if (main.waits[it.code]) flags.appendChild(el("span", "f", "waited " + main.waits[it.code].length));
          if (it.alts) flags.appendChild(el("span", "f", "or " + it.alts.filter(function (a) { return a !== it.code; }).join("/")));
          if (flags.childNodes.length) chip.appendChild(flags);
        }
        hover(chip, function (evt) {
          var rows = [{ value: CAT_LABEL[it.cat], label: "" }];
          if (it.real) {
            var x = info(it.code);
            rows.push({ value: x.arranged ? "Arranged" : x.per ? x.pattern.label : "Not in STAR", label: "" });
            var lr = lastRun(it.code);
            if (lr) rows.push({ value: pct(lr.a.seats ? lr.a.taken / lr.a.seats : null), label: "full in " + lr.term.name + " (" + lr.a.sections + " section" + (lr.a.sections === 1 ? "" : "s") + ")" });
          }
          var note = main.waits[it.code] ? "Ready earlier but not offered in: " + main.waits[it.code].join(", ") : it.real ? "Prereq chain length after it: " + it.rank : "Open slot — pick a course that fits";
          showTip(evt, it.real ? it.code + " — " + title(it.code) : it.label, rows, note);
        });
        col.appendChild(chip);
      });
      tl.appendChild(col);
    });
    var notes = el("ul", "ee-issues");
    if (main.unplaced.length) notes.appendChild(el("li", null, "Couldn't place within 24 terms: " + main.unplaced.map(function (u) { return u.code; }).join(", ") + "."));
    Object.keys(main.waits).forEach(function (code) {
      notes.appendChild(el("li", null, code + " was ready in " + main.waits[code][0] + " but isn't offered that season — it waits for " + (main.placed[code] != null ? main.sems[main.placed[code]].sem.name : "later") + "."));
    });
    if (prereqOnly.regular < main.regular) notes.appendChild(el("li", null, "Prereqs alone would allow " + prereqOnly.regular + " regular semesters; season-only courses add " + (main.regular - prereqOnly.regular) + "."));
    if (notes.childNodes.length) c.appendChild(notes);
    var tc = takenCredits();
    c.appendChild(el("p", "st-sub", (tc ? "Counts you as " + standingSemesters() + " semester" + (standingSemesters() === 1 ? "" : "s") + " in (" + tc + " credits marked taken) for class standing. " : "") +
      "Assumes MATH 241 placement (no precalculus), C-or-better in every prereq, and that a course keeps running in the seasons it has since " + D.terms[0].name + ". Courses outside the plan that a prereq names (placement exams, AP) are treated as already met."));
  }

  // ---------- 3. cost of missing a course ----------
  function missCosts(main) {
    return main.courses.filter(function (c) { return main.placed[c.code] != null; }).map(function (c) {
      var p = main.placed[c.code], blocked = {}; blocked[c.code] = p;
      var alt = plan({ blocked: blocked });
      return { code: c.code, at: main.sems[p] ? main.sems[p].sem.name : "", delay: alt.regular - main.regular, newEnd: alt.lastSem ? alt.lastSem.name : "?" };
    }).sort(function (a, b) { return b.delay - a.delay || a.code.localeCompare(b.code); });
  }
  function renderMiss(main, miss) {
    var c = card("If you miss it", "Replan with each course pushed out of the term the plan puts it in (a full section, a failed prereq, a conflict). How much later you'd finish.");
    var bad = miss.filter(function (m) { return m.delay > 0; });
    if (!bad.length) { c.appendChild(el("p", "st-empty", "No single missed course delays this plan — there's slack everywhere.")); return; }
    // Anything in the final term trivially delays graduation if missed; list
    // the ones earlier in the plan (the real bottlenecks) first.
    var lastName = main.lastSem ? main.lastSem.name : "";
    bad.sort(function (a, b) { return (a.at === lastName) - (b.at === lastName) || b.delay - a.delay; });
    var items = bad.slice(0, 14).map(function (m) {
      return { label: m.code, value: m.delay, valueText: "+" + m.delay + " sem" + (m.delay >= 2 ? " (a year)" : "") + (m.at === lastName ? " · final term" : " · " + m.at),
        tipTitle: m.code + " — " + title(m.code), tipRows: [{ value: m.at, label: "planned" }, { value: m.newEnd, label: "graduation if missed" }], tipNote: info(m.code).arranged ? "Arranged course" : info(m.code).pattern.label };
    });
    hBars(c, { items: items, labelW: 76, rowH: 22, color: "var(--viz-2)" });
    c.appendChild(el("p", "st-sub", (miss.length - bad.length) + " other courses have slack — missing one term of them doesn't move graduation."));
  }

  // ---------- 4. gatekeepers ----------
  function renderGatekeepers(main) {
    var c = card("Gatekeepers", "Courses most of the degree waits on: how many later requirements depend on them, and how risky they are to get into.");
    var plannedCodes = main.courses.map(function (x) { return x.code; });
    var deps = {};
    plannedCodes.forEach(function (code) {
      var seen = {}, stack = [code];
      while (stack.length) {
        var cur = stack.pop(), n = node(cur);
        leaves(n && n.prereq_tree).forEach(function (l) { if (!seen[l.code] && plannedCodes.indexOf(l.code) >= 0) { seen[l.code] = true; stack.push(l.code); } });
      }
      Object.keys(seen).forEach(function (p) { (deps[p] = deps[p] || []).push(code); });
    });
    var rows = plannedCodes.map(function (code) {
      var x = info(code), lr = lastRun(code), fill = lr && lr.a.seats ? lr.a.taken / lr.a.seats : null;
      var unlocks = (deps[code] || []).length;
      var risk = unlocks * (x.known && (x.pattern.kind === "fall" || x.pattern.kind === "spring") ? 2 : 1) * (fill != null && fill >= 0.95 ? 1.5 : 1) * (lr && lr.a.sections === 1 ? 1.2 : 1);
      return { code: code, unlocks: unlocks, fill: fill, sections: lr ? lr.a.sections : 0, risk: risk };
    }).filter(function (r) { return r.unlocks > 0; }).sort(function (a, b) { return b.risk - a.risk; }).slice(0, 12);
    var wrap = el("div", "st-table-wrap"); c.appendChild(wrap);
    var t = el("table", "st-table"); wrap.appendChild(t);
    var hr = el("tr"); ["Course", "Unlocks", "Offered", "Sections", "Last fill"].forEach(function (h, i) { hr.appendChild(el("th", i === 1 || i === 3 ? "num" : null, h)); }); t.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el("tr");
      var td = el("td", "code"); td.appendChild(graphLink(r.code)); tr.appendChild(td);
      var u = el("td", "num", String(r.unlocks)); u.title = (deps[r.code] || []).join(", "); tr.appendChild(u);
      var p = el("td"); p.appendChild(patternPill(r.code)); tr.appendChild(p);
      tr.appendChild(el("td", "num", r.sections ? String(r.sections) : "–"));
      fillCell(tr.appendChild(el("td")), r.fill);
      t.appendChild(tr);
    });
  }

  // ---------- 5. availability calendar ----------
  function renderAvailability(main) {
    var c = card("Requirement calendar", "Every term in STAR for your requirements, shaded by how full each course got. Dots are terms it didn't run.", "wide");
    var t = tracks()[P.track];
    var other = [];
    Object.keys(tracks()).forEach(function (k) { if (k !== P.track) other = other.concat(tracks()[k].group1, tracks()[k].group2); });
    var groups = [
      ["Fixed requirements", [].concat.apply([], rel.fixed_groups || [])],
      [P.track + " Group I", t.group1], [P.track + " Group II", t.group2],
      ["Technical electives (listed)", teCodes()],
      ["Other track (counts as TE outside your track)", other.filter(function (x, i, a) { return a.indexOf(x) === i && t.group1.indexOf(x) < 0 && t.group2.indexOf(x) < 0; })],
      ["Engineering breadth", ebNamed()],
    ];
    var wrap = el("div", "st-table-wrap"); c.appendChild(wrap);
    var tb = el("table", "st-cal"); wrap.appendChild(tb);
    var hr = el("tr"); hr.appendChild(el("th")); D.terms.forEach(function (term) { hr.appendChild(el("th", null, shortTerm(term))); }); hr.appendChild(el("th", null, "Pattern")); tb.appendChild(hr);
    groups.forEach(function (g) {
      var gr = el("tr", "ee-group"); var gth = el("th", null, g[0]); gth.colSpan = D.terms.length + 2; gr.appendChild(gth); tb.appendChild(gr);
      g[1].slice().sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); }).forEach(function (code) {
        var tr = el("tr");
        var th = el("th", "rowhead"); th.appendChild(graphLink(code)); if (isTaken(code)) th.appendChild(el("span", "ee-taken", " ✓")); tr.appendChild(th);
        var pt = perTerm(code);
        D.terms.forEach(function (term, i) {
          var a = pt && pt[i], td = el("td");
          if (!a) { td.className = "off"; td.textContent = "·"; }
          else {
            var fill = a.seats ? a.taken / a.seats : 0;
            td.style.background = seqColor(fill, 1); if (seqIsDark(fill, 1)) td.className = "on-dark";
            td.textContent = pct(fill);
            hover(td, function (evt) { showTip(evt, code + " · " + term.name, [{ value: fmt(a.taken) + " / " + fmt(a.seats), label: "seats taken" }, { value: String(a.sections), label: "sections" }]); });
          }
          tr.appendChild(td);
        });
        var pc = el("td"); pc.style.width = "auto"; pc.style.textAlign = "left"; pc.appendChild(patternPill(code)); tr.appendChild(pc);
        tb.appendChild(tr);
      });
    });
    rampLegend(c, "0% filled", "100% filled");
  }

  // ---------- 6. track comparison ----------
  function renderTracks() {
    Object.keys(tracks()).forEach(function (k) {
      var t = tracks()[k];
      var c = card(t.name + (k === P.track ? " — your track" : ""), "Group I " + t.group1_required_credits + " cr (all) + Group II " + t.group2_required_credits + " cr (pick).");
      var g = gridCheck(k), g1Issues = g.issues.filter(function (r) { return r.assigned; });
      var stats = el("ul", "ee-stats"); c.appendChild(stats);
      function stat(label, value, cls) { var li = el("li", cls); li.appendChild(el("span", null, label)); li.appendChild(el("strong", null, value)); stats.appendChild(li); }
      var g1s = { Fall: 0, Spring: 0, both: 0 };
      t.group1.forEach(function (code) { var kd = info(code).pattern.kind; g1s[kd === "fall" ? "Fall" : kd === "spring" ? "Spring" : "both"] += credits(code); });
      stat("Group I credits, Fall-only / Spring-only / either", g1s.Fall + " / " + g1s.Spring + " / " + g1s.both);
      stat("Fits the check sheet's Group I slots", g1Issues.length ? "No — " + g1Issues.map(function (r) { return r.assigned; }).join(", ") + " can't sit where the grid puts it" : "Yes", g1Issues.length ? "bad" : "ok");
      var never = t.group2.filter(function (code) { return !info(code).per; });
      stat("Group II courses listed / never ran in STAR", t.group2.length + " / " + never.length, never.length > t.group2.length / 2 ? "bad" : null);
      var items = ["Fall", "Spring"].map(function (season) {
        var li = star.latest[season], ran = t.group2.filter(function (code) { var pt = perTerm(code); return pt && pt[li]; });
        var cr = ran.reduce(function (s, code) { return s + credits(code); }, 0);
        return { label: D.terms[li].name, value: cr, valueText: cr + " cr · " + ran.length + " course" + (ran.length === 1 ? "" : "s"),
          tipRows: ran.map(function (code) { return { value: code, label: title(code) }; }), tipNote: "Group II offered that term; " + t.group2_required_credits + " cr needed" };
      });
      c.appendChild(el("p", "st-sub", "Group II credits actually offered in the latest Fall and Spring:"));
      hBars(c, { items: items, labelW: 92, rowH: 24, max: Math.max(t.group2_required_credits * 2, items[0].value, items[1].value) });
      if (never.length) c.appendChild(el("p", "st-sub", "Never ran " + D.terms[0].name + " – " + D.terms[D.terms.length - 1].name + ": " + never.join(", ")));
    });
  }

  // ---------- 7. electives that run ----------
  function renderElectives() {
    var c = card("Electives that actually run", "Group II (both tracks) and the listed technical electives, by how reliably they're offered. A Group II course from the other track counts as a TE outside your track.", "wide");
    seg(c, [["ALL", "All"], ["Fall", "Runs in Fall"], ["Spring", "Runs in Spring"], ["Summer", "Summer"]], P.elecSeason, function (v) { P.elecSeason = v; });
    var rows = [], seen = {};
    function addRow(code, role) {
      if (seen[code]) { seen[code].role += ", " + role; return; }
      var x = info(code), lr = lastRun(code);
      var r = { code: code, role: role, lab: /L$/.test(code), credits: credits(code), x: x, lr: lr,
        rel: reliability(code), fill: lr && lr.a.seats ? lr.a.taken / lr.a.seats : null, seats: lr ? lr.a.seats : 0 };
      seen[code] = r; rows.push(r);
    }
    Object.keys(tracks()).forEach(function (k) { tracks()[k].group2.forEach(function (code) { addRow(code, k + " Group II"); }); });
    teCodes().forEach(function (code) { addRow(code, "TE"); });
    if (P.elecSeason !== "ALL") rows = rows.filter(function (r) { return r.x.known && r.x.pattern.by[P.elecSeason].n > 0; });
    var st = P.elecSort;
    rows.sort(function (a, b) {
      var va = a[st.key], vb = b[st.key];
      if (typeof va === "string") return st.dir * va.localeCompare(vb);
      return st.dir * ((va == null ? -1 : va) - (vb == null ? -1 : vb)) || a.code.localeCompare(b.code);
    });
    var wrap = el("div", "st-table-wrap"); c.appendChild(wrap);
    var t = el("table", "st-table"); wrap.appendChild(t);
    var hr = el("tr"); t.appendChild(hr);
    [["code", "Course"], [null, "Title"], ["role", "Counts as"], ["credits", "Cr", 1], ["rel", "Offered"], [null, "Fall", 1], [null, "Spring", 1], [null, "Summer", 1], ["seats", "Seats last run", 1], ["fill", "Last fill"]].forEach(function (h) {
      var th = el("th", h[2] ? "num" : null, h[1]); hr.appendChild(th);
      if (h[0]) sortable(th, st, h[0], render);
    });
    rows.forEach(function (r) {
      var tr = el("tr", r.x.per ? null : "dim");
      var td = el("td", "code"); td.appendChild(graphLink(r.code)); tr.appendChild(td);
      var tt = el("td", "title", title(r.code)); tt.title = title(r.code); tr.appendChild(tt);
      tr.appendChild(el("td", null, r.role + (r.lab ? " · lab" : "")));
      tr.appendChild(el("td", "num", String(r.credits)));
      var p = el("td"); p.appendChild(patternPill(r.code)); tr.appendChild(p);
      SEASONS.forEach(function (s) { var b = r.x.pattern.by[s]; tr.appendChild(el("td", "num", b.n + "/" + b.of)); });
      tr.appendChild(el("td", "num", r.lr ? fmt(r.seats) + " · " + shortTerm(r.lr.term) : "–"));
      fillCell(tr.appendChild(el("td")), r.fill);
      t.appendChild(tr);
    });
    c.appendChild(el("p", "st-sub", rows.length + " courses. Greyed rows had no section in any captured term."));
  }

  // ---------- 8. conflicts ----------
  function renderConflicts(main) {
    var c = card("Time conflicts in your plan", "For courses the plan puts in the same term: in the latest STAR term of that season, can you find sections that don't overlap? 'Unavoidable' = every section of one clashes with every section of the other.");
    var found = [], single = [];
    main.sems.forEach(function (s) {
      var li = star.latest[s.sem.season];
      if (li == null) return;
      var real = s.items.filter(function (it) { return it.real; }).map(function (it) {
        var pt = perTerm(it.code); return { code: it.code, secs: pt && pt[li] ? pt[li].rows.filter(function (r) { return r[6]; }) : [] };
      }).filter(function (x) { return x.secs.length; });
      real.forEach(function (x) { if (x.secs.length === 1) single.push({ code: x.code, sem: s.sem.name, when: prettyMeeting(x.secs[0][6]) }); });
      for (var i = 0; i < real.length; i++) for (var j = i + 1; j < real.length; j++) {
        var a = real[i], b = real[j], combos = 0, bad = 0;
        a.secs.forEach(function (ra) { b.secs.forEach(function (rb) { combos++; if (clash(ra[6], rb[6])) bad++; }); });
        if (bad) found.push({ a: a, b: b, sem: s.sem.name, term: D.terms[li].name, bad: bad, combos: combos });
      }
    });
    found.sort(function (x, y) { return (y.bad === y.combos) - (x.bad === x.combos) || y.bad / y.combos - x.bad / x.combos; });
    if (!found.length) c.appendChild(el("p", "st-empty", "No overlapping sections between courses planned for the same term."));
    else {
      var ul = el("ul", "ee-issues");
      found.slice(0, 12).forEach(function (f) {
        var li = el("li", f.bad === f.combos ? "bad" : null);
        li.appendChild(el("strong", null, f.bad === f.combos ? "Unavoidable: " : f.bad + " of " + f.combos + " section pairs clash: "));
        li.appendChild(document.createTextNode(f.a.code + " and " + f.b.code + " (" + f.sem + "; based on " + f.term + "): " +
          prettyMeeting(f.a.secs[0][6]) + " vs " + prettyMeeting(f.b.secs[0][6]) + "."));
        ul.appendChild(li);
      });
      c.appendChild(ul);
    }
    if (single.length) {
      c.appendChild(el("p", "st-sub", "Only one section — no flexibility, build around these:"));
      var ul2 = el("ul", "st-list");
      single.forEach(function (s) {
        var li = el("li"); li.style.cursor = "default";
        li.appendChild(el("span", "code", s.code)); li.appendChild(el("span", "title", s.when)); li.appendChild(el("span", "stat", s.sem));
        ul2.appendChild(li);
      });
      c.appendChild(ul2);
    }
  }

  // ---------- 9. meeting-time heatmap ----------
  function renderHeat(main) {
    var c = card("When EE requirement classes meet", "Sections of every course in your plan (latest " + P.heatSeason + " in STAR), by hour. Plan jobs and gen-eds around the dark cells.");
    seg(c, [["Fall", "Fall"], ["Spring", "Spring"]], P.heatSeason, function (v) { P.heatSeason = v; });
    var li = star.latest[P.heatSeason], codes = {};
    main.courses.forEach(function (x) { codes[starCode(x.code)] = true; });
    var M = DAYS.map(function () { return HOURS.map(function () { return 0; }); }), names = DAYS.map(function () { return HOURS.map(function () { return {}; }); });
    D.rows.forEach(function (r) {
      if (r[0] !== li || !codes[D.codes[r[1]]] || !r[6]) return;
      parseMeetings(r[6]).forEach(function (m) {
        DAYS.forEach(function (d, di) {
          if (m.days.indexOf(d[0]) < 0) return;
          HOURS.forEach(function (h, hi) { if (m.s < (h + 1) * 60 && m.e > h * 60) { M[di][hi]++; names[di][hi][D.codes[r[1]]] = true; } });
        });
      });
    });
    function hl(h) { return (h % 12 || 12) + (h < 12 ? "a" : "p"); }
    heatmap(c, { rows: DAYS.map(function (d) { return d[1]; }), cols: HOURS.map(hl), matrix: M, unit: "sections",
      tipTitle: function (i, j) { return DAYS[i][1] + " " + hl(HOURS[j]) + "–" + hl(HOURS[j] + 1); },
      tipNote: function (i, j) { var n = Object.keys(names[i][j]); return n.length ? n.join(", ") : D.terms[li].name; } });
  }

  // ---------- 10. pipeline ----------
  function renderPipeline() {
    var c = card("Class sizes through the program", "Students enrolled in each core course over the latest full academic year (Fall + Spring + Summer). The drop from 200- to 400-level is roughly attrition plus students on other paths.", "wide");
    // Latest academic year with all of Fall Y, Spring Y+1, Summer Y+1 captured.
    var ay = null;
    for (var i = D.terms.length - 1; i >= 0 && !ay; i--) {
      var t = D.terms[i];
      if (t.season !== "Summer") continue;
      var yr = Number(t.name.split(" ")[1]);
      var f = D.terms.filter(function (x) { return x.name === "Fall " + (yr - 1); })[0], sp = D.terms.filter(function (x) { return x.name === "Spring " + yr; })[0];
      if (f && sp) ay = { label: "Fall " + (yr - 1) + " – Summer " + yr, idx: [termIndex(f.key), termIndex(sp.key), i] };
    }
    if (!ay) { c.appendChild(el("p", "st-empty", "No complete academic year in the captured terms.")); return; }
    var codes = [];
    CHECKSHEET_GRID.forEach(function (sem) { sem.forEach(function (it) { var cc = it.code || (it.alt && it.alt[0]); if (cc && /^ECE /.test(cc) && !ARRANGED.test(cc)) codes.push(cc); }); });
    var values = codes.map(function (code) { var pt = perTerm(code), s = 0; ay.idx.forEach(function (k) { if (pt && pt[k]) s += pt[k].taken; }); return s; });
    c.appendChild(el("p", "st-sub", ay.label + ", in check-sheet order."));
    columnChart(c, { labels: codes.map(function (x) { return x.replace("ECE ", ""); }), values: values, name: "students enrolled", height: 220,
      tipTitles: codes.map(function (x) { return x + " — " + title(x); }),
      tipNote: function (k) { var pt = perTerm(codes[k]); return ay.idx.map(function (j) { return D.terms[j].name + ": " + (pt && pt[j] ? pt[j].taken : 0); }).join(" · "); } });
  }

  // ---------- 11. gen-ed / focus ----------
  function renderGened(main) {
    var c = card("Gen-ed and Focus: what's left, and two-for-ones", "What your required courses already cover, then courses that satisfy two or more of what's left at once — the cheapest way through the Gen-ed core.", "wide");
    var planCodes = main.courses.map(function (x) { return x.code; }).concat(Object.keys(taken).filter(function (k) { return P.useTaken && k.indexOf("__") !== 0; }));
    var cover = { WI: [], OC: [], ETH: [], HAP: [] };
    planCodes.forEach(function (code) { attrsOf(code).forEach(function (a) { if (cover[a] && cover[a].indexOf(code) < 0) cover[a].push(code); }); });
    var wUpper = cover.WI.filter(function (x) { return level(x) >= 3; }).length;
    var needs = [
      { key: "W", label: "W Focus", need: 5, have: cover.WI.length, note: "need 5 (2+ upper division) · covered: " + (cover.WI.join(", ") || "none") + " (" + wUpper + " upper)" },
      { key: "O", label: "O Focus", need: 1, have: cover.OC.length, note: cover.OC.join(", ") || "not covered" },
      { key: "E", label: "E Focus", need: 1, have: cover.ETH.length, note: cover.ETH.join(", ") || "not covered" },
      { key: "H", label: "H Focus", need: 1, have: cover.HAP.length, note: "never in engineering courses (note 6) — double-count it with DH/DL or DS" },
      { key: "FG", label: "FG", need: 2, have: 0, note: "two courses" }, { key: "DHDL", label: "DH or DL", need: 1, have: 0, note: "one course" },
      { key: "DS", label: "DS", need: 1, have: 0, note: "one besides the ECON course" },
    ];
    var grid = el("div", "ee-needs"); c.appendChild(grid);
    needs.forEach(function (n) {
      var left = Math.max(0, n.need - n.have);
      var b = el("div", "ee-need" + (left ? "" : " met"));
      b.appendChild(el("strong", null, n.label));
      b.appendChild(el("span", "num", left ? left + " left" : "covered"));
      b.appendChild(el("span", "note", n.note));
      grid.appendChild(b);
    });
    var open = { FG: true, DHDL: true, DS: true, H: !cover.HAP.length, W: cover.WI.length < 5, O: !cover.OC.length, E: !cover.ETH.length };
    function hits(mask) {
      var h = [];
      function has(a) { return mask & (1 << D.attrs.indexOf(a)); }
      if (open.FG && (has("FGA") || has("FGB") || has("FGC"))) h.push("FG");
      if (open.DHDL && (has("DH") || has("DL"))) h.push(has("DH") ? "DH" : "DL");
      if (open.DS && has("DS")) h.push("DS");
      if (open.H && has("HAP")) h.push("H");
      if (open.W && has("WI")) h.push("W");
      if (open.O && has("OC")) h.push("O");
      if (open.E && has("ETH")) h.push("E");
      return h;
    }
    var bar = el("div", "ee-dd-controls");
    c.appendChild(bar);
    var segWrap = { head: bar };
    seg(segWrap, [["Fall", "Fall"], ["Spring", "Spring"], ["Summer", "Summer"]], P.ddSeason, function (v) { P.ddSeason = v; });
    var on = el("label", "ee-check"); var cb = el("input"); cb.type = "checkbox"; cb.checked = P.ddOnline;
    cb.addEventListener("change", function () { P.ddOnline = cb.checked; render(); });
    on.appendChild(cb); on.appendChild(document.createTextNode(" Has an online section")); bar.appendChild(on);
    var li = star.latest[P.ddSeason], by = {};
    D.rows.forEach(function (r) {
      if (r[0] !== li) return;
      var x = by[r[1]] || (by[r[1]] = { mask: 0, seats: 0, taken: 0, sections: 0, online: 0 });
      x.mask |= r[5]; x.seats += r[2]; x.taken += r[3]; x.sections++; if (r[4] === 1) x.online++;
    });
    var list = Object.keys(by).map(function (k) { var x = by[k]; x.ci = Number(k); x.hits = hits(x.mask); return x; })
      .filter(function (x) { return x.hits.length >= 2 && (!P.ddOnline || x.online); })
      .sort(function (a, b) { return b.hits.length - a.hits.length || (b.seats - b.taken) - (a.seats - a.taken); });
    c.appendChild(el("p", "st-sub", list.length + " courses in " + D.terms[li].name + " cover two or more of your open Gen-ed/Focus needs." + (list.length > 40 ? " Showing the 40 with the most open seats per tier." : "")));
    var wrap = el("div", "st-table-wrap"); wrap.style.maxHeight = "420px"; wrap.style.overflowY = "auto"; c.appendChild(wrap);
    var t = el("table", "st-table"); wrap.appendChild(t);
    var hr = el("tr"); ["Course", "Title", "Covers", "Sections", "Open seats", "Filled", "Online"].forEach(function (h, i) { hr.appendChild(el("th", i === 3 || i === 4 ? "num" : null, h)); }); t.appendChild(hr);
    list.slice(0, 40).forEach(function (x) {
      var code = D.codes[x.ci], tr = el("tr");
      var td = el("td", "code"); td.appendChild(graphLink(code)); tr.appendChild(td);
      var tt = el("td", "title", D.titles[x.ci]); tt.title = D.titles[x.ci]; tr.appendChild(tt);
      var cv = el("td"); x.hits.forEach(function (h) { cv.appendChild(pill(h, "ee-need-pill")); cv.appendChild(document.createTextNode(" ")); }); tr.appendChild(cv);
      tr.appendChild(el("td", "num", String(x.sections)));
      tr.appendChild(el("td", "num", fmt(x.seats - x.taken)));
      fillCell(tr.appendChild(el("td")), x.seats ? x.taken / x.seats : null);
      tr.appendChild(el("td", null, x.online ? x.online + " of " + x.sections : "–"));
      t.appendChild(tr);
    });
  }

  // ---------- 12. engineering breadth ----------
  function missingPrereqs(tree, have) {
    if (!tree) return [];
    if (tree.course) return have[tree.course] || have[starCode(tree.course)] ? [] : [tree.course];
    if (!tree.op) return [];
    var kids = (tree.children || []).map(function (k) { return { k: k, m: missingPrereqs(k, have) }; });
    if (tree.op === "OR") {
      var pool = kids.filter(function (x) { return mentionsCourse(x.k); });
      if (!pool.length) return [];
      return pool.sort(function (a, b) { return a.m.length - b.m.length; })[0].m;
    }
    return [].concat.apply([], kids.map(function (x) { return x.m; })).filter(function (v, i, a) { return a.indexOf(v) === i; });
  }
  function renderEB(main) {
    var c = card("Engineering breadth options", "CEE 270 or any CEE / ME / ORE (Ocean) / BE course at the 300-level or higher that ran in STAR — with whether your EE plan already gives you its prereqs.", "wide");
    var have = {};
    main.courses.forEach(function (x) { have[x.code] = true; });
    Object.keys(taken).forEach(function (k) { if (P.useTaken) have[k] = true; });
    (rel.fixed_groups || []).forEach(function (g) { g.forEach(function (x) { have[x] = true; }); });
    var codes = ebNamed().concat(ebSubjectCodes().filter(function (x) { return info(x).per; }));
    var rows = codes.filter(function (x, i, a) { return a.indexOf(x) === i; }).map(function (code) {
      var n = node(code), miss = missingPrereqs(n && n.prereq_tree, have), lr = lastRun(code);
      return { code: code, miss: miss, inCatalog: !!n, lr: lr, rel: reliability(code), fill: lr && lr.a.seats ? lr.a.taken / lr.a.seats : null };
    }).sort(function (a, b) { return a.miss.length - b.miss.length || b.rel - a.rel || (a.fill || 0) - (b.fill || 0); });
    var ready = rows.filter(function (r) { return !r.miss.length; }).length;
    c.appendChild(el("p", "st-sub", ready + " of " + rows.length + " options need nothing beyond your EE plan."));
    var wrap = el("div", "st-table-wrap"); wrap.style.maxHeight = "420px"; wrap.style.overflowY = "auto"; c.appendChild(wrap);
    var t = el("table", "st-table"); wrap.appendChild(t);
    var hr = el("tr"); ["Course", "Title", "Offered", "Seats last run", "Last fill", "Prereqs"].forEach(function (h, i) { hr.appendChild(el("th", i === 3 ? "num" : null, h)); }); t.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el("tr");
      var td = el("td", "code"); td.appendChild(graphLink(r.code)); tr.appendChild(td);
      var tt = el("td", "title", title(r.code)); tt.title = title(r.code); tr.appendChild(tt);
      var p = el("td"); p.appendChild(patternPill(r.code)); tr.appendChild(p);
      tr.appendChild(el("td", "num", r.lr ? fmt(r.lr.a.seats) + " · " + shortTerm(r.lr.term) : "–"));
      fillCell(tr.appendChild(el("td")), r.fill);
      var pr = el("td");
      if (!r.inCatalog) pr.textContent = "not in this catalog";
      else if (!r.miss.length) pr.appendChild(pill("✓ covered by your plan", "ee-ok"));
      else pr.textContent = "also needs " + r.miss.join(", ");
      tr.appendChild(pr);
      t.appendChild(tr);
    });
  }

  // ---------- 13. advising notes ----------
  function renderNotes(main, grid, miss, hist) {
    var c = card("Advising notes", "Generated from everything above, most important first.", "wide");
    var notes = [];
    // Same-semester courses that couldn't be taken together the last time that season ran.
    hist.cohorts.forEach(function (co) {
      var last = co.terms[co.terms.length - 1];
      if (!last) return;
      if (last.feasible === 0 && !last.missing.length) {
        notes.push(["bad", GRID_YEARS[Math.floor(co.si / 2)] + " " + co.season + " courses on the check sheet had no conflict-free schedule in " + last.term.name +
          (last.blockers.length ? " (" + last.blockers.map(function (b) { return b.a + " vs " + b.b; }).join("; ") + ")" : "") + ". Plan to take one of them in a different term."]);
      }
    });
    var recurring = hist.hotspots.filter(function (h) { return h.unavoidable.length >= 2 && h.tags.length; }).slice(0, 4);
    recurring.forEach(function (h) {
      notes.push(["warn", h.a + " and " + h.b + " have clashed in " + h.unavoidable.length + " terms (" + h.unavoidable.map(function (x) { return x.term.name; }).join(", ") + ") — don't count on taking them together."]);
    });
    grid.issues.filter(function (r) { return r.assigned || r.codes; }).forEach(function (r) {
      var where = GRID_YEARS[Math.floor(r.si / 2)] + " " + r.season;
      if (r.assigned) notes.push(["bad", r.assigned + " is " + info(r.assigned).pattern.label + ", but the check sheet's grid leaves it a " + where + " slot. Take it in a " + (r.season === "Fall" ? "Spring" : "Fall") + " (usually by doubling up Group I in the other semester)."]);
      else notes.push(["warn", r.label + " is recommended for " + where + ", but STAR shows " + info(r.best).pattern.label + "."]);
    });
    miss.filter(function (m) { return m.delay >= 2; }).forEach(function (m) {
      var x = info(m.code);
      notes.push(["bad", "Don't miss " + m.code + " in " + m.at + (x.known ? " (" + x.pattern.label + ")" : "") + " — the next chance pushes graduation from " + (main.lastSem ? main.lastSem.name : "?") + " to " + m.newEnd + "."]);
    });
    var early = [];
    main.courses.forEach(function (x) {
      var pt = perTerm(x.code); if (!pt || info(x.code).arranged) return;
      var regs = D.terms.map(function (t, i) { return t.season !== "Summer" && pt[i] ? pt[i] : null; }).filter(Boolean).slice(-3);
      var full = regs.filter(function (a) { return a.taken >= a.seats * 0.95; }).length;
      if (regs.length >= 2 && full >= 2) early.push(x.code + " (" + full + "/" + regs.length + ")");
    });
    if (early.length) notes.push(["warn", "Register on your first day for these — 95%+ full in most of their last Fall/Spring terms (full terms / terms checked): " + early.join(", ") + "."]);
    var summerOk = main.courses.filter(function (x) { return info(x.code).known && info(x.code).pattern.by.Summer.n >= 2; }).map(function (x) { return x.code; });
    if (summerOk.length) notes.push(["ok", "Catch-up options in summer (ran 2+ of the captured summers): " + summerOk.join(", ") + "."]);
    var arranged = main.courses.filter(function (x) { return info(x.code).arranged; }).map(function (x) { return x.code; });
    if (arranged.length) notes.push(["info", arranged.join(", ") + " are arranged through the department (barely listed in STAR) — confirm the timing with an advisor."]);
    var t = tracks()[P.track], never = t.group2.filter(function (code) { return !info(code).per; });
    if (never.length) notes.push(["info", never.length + " of " + t.group2.length + " " + P.track + " Group II courses didn't run at all " + D.terms[0].name + " – " + D.terms[D.terms.length - 1].name + " (" + never.join(", ") + "). Plan Group II around the ones that do."]);
    if (main.regular > 8) notes.push(["warn", "This plan needs " + main.regular + " regular semesters. " + (P.summer ? "" : "Allowing summer classes or ") + "a higher credit cap may shorten it."]);
    if (!notes.length) notes.push(["ok", "No scheduling risks found for this plan."]);
    var ul = el("ul", "ee-notes");
    notes.forEach(function (n) { ul.appendChild(el("li", n[0], n[1])); });
    c.appendChild(ul);
    var foot = el("p", "st-foot");
    foot.textContent = "Sources: the EE check sheet (requirement lists and the August 2026 recommended grid), the " + (CATALOGS.filter(function (x) { return x.id === P.catalog; })[0] || {}).label +
      " catalog's prerequisites, and UH STAR class availability for " + D.terms[0].name + " – " + D.terms[D.terms.length - 1].name + ". Offering seasons are inferred from those terms; departments can change schedules. Not an official degree audit — confirm with an ECE advisor.";
    c.appendChild(foot);
  }

  // ---------- conflicts in past terms ----------
  // Works on STAR's actual section times for every captured term. Sections
  // with no set time (TBA, online-asynchronous) never conflict with anything.
  var secCache = {};
  function sectionsOf(codes, ti) {
    var out = [];
    codes.forEach(function (code) {
      var key = code + "@" + ti;
      if (!secCache[key]) {
        var pt = perTerm(code);
        secCache[key] = pt && pt[ti] ? pt[ti].rows.map(function (r) { return { code: code, r: r, m: parseMeetings(r[6]) }; }) : [];
      }
      out = out.concat(secCache[key]);
    });
    return out;
  }
  function sharesDay(a, b) { for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) return true; return false; }
  // Part-of-term sections (summer sessions, half-semester sections; flag 16)
  // can share a weekday and hour with another section without ever meeting in
  // the same weeks -- STAR's rows here don't say which session -- so they're
  // never counted as clashing.
  function secClash(a, b) {
    if ((a.r && a.r[8] & 16) || (b.r && b.r[8] & 16)) return false;
    return a.m.some(function (x) { return b.m.some(function (y) { return x.s < y.e && y.s < x.e && sharesDay(x.days, y.days); }); });
  }
  // Every course that must be finished before `code` (non-concurrent prereq
  // leaves, transitively). Two courses where one requires the other can't be
  // taken together anyway, so their clash doesn't matter.
  var priorCache = {};
  function priorOf(code) {
    if (priorCache[code]) return priorCache[code];
    var seen = {}, stack = [code];
    while (stack.length) {
      var n = node(stack.pop());
      leaves(n && n.prereq_tree).forEach(function (l) { if (!l.concurrent && !seen[l.code]) { seen[l.code] = true; stack.push(l.code); } });
    }
    return (priorCache[code] = seen);
  }
  function secTime(sec) { return sec.r[6] ? prettyMeeting(sec.r[6]) : "no set time"; }

  // A check-sheet semester's required courses, as "slots": one course, or an
  // either/or ("ECE 345 or MATH 307") where any section of either will do.
  // Group I slots get the track's course that matchGroupI() puts there. The
  // arranged project courses have no listed times, so they're left out.
  function cohortSlots(si) {
    var g1 = matchGroupI(P.track), slots = [];
    CHECKSHEET_GRID[si].forEach(function (it, k) {
      if (it.code && !ARRANGED.test(it.code)) slots.push({ label: it.code, codes: [it.code] });
      else if (it.alt) slots.push({ label: it.alt.join(" or "), codes: it.alt });
      else if ((it.slot === "G1" || it.slot === "G1L") && g1[si + ":" + k]) slots.push({ label: g1[si + ":" + k], codes: [g1[si + ":" + k]], group1: true });
    });
    return slots;
  }

  // Can one section of every slot be taken together in term ti? Backtracking,
  // fewest-sections slot first. Returns the number of conflict-free schedules
  // (capped), the first one found, up to `keep` of them, slots with no
  // sections that term, and -- when nothing works -- the pairs that clash in
  // every combination (the reason).
  function feasibility(slots, ti, opts) {
    opts = opts || {};
    var cand = [], missing = [];
    slots.forEach(function (s) { var secs = sectionsOf(s.codes, ti); if (secs.length) cand.push({ slot: s, secs: secs }); else missing.push(s.label); });
    cand.sort(function (a, b) { return a.secs.length - b.secs.length; });
    var cap = opts.cap || 2000, keep = opts.keep || 0, count = 0, first = null, combos = [], chosen = [];
    (function bt(i) {
      if (count >= cap) return;
      if (i === cand.length) { count++; if (!first) first = chosen.slice(); if (combos.length < keep) combos.push(chosen.slice()); return; }
      for (var k = 0; k < cand[i].secs.length && count < cap; k++) {
        var sec = cand[i].secs[k];
        if (chosen.some(function (c) { return secClash(c, sec); })) continue;
        chosen.push(sec); bt(i + 1); chosen.pop();
      }
    })(0);
    var blockers = [];
    if (!count) {
      for (var i = 0; i < cand.length; i++) for (var j = i + 1; j < cand.length; j++) {
        var all = cand[i].secs.every(function (a) { return cand[j].secs.every(function (b) { return secClash(a, b); }); });
        if (all) blockers.push({ a: cand[i].slot.label, b: cand[j].slot.label, at: secTime(cand[i].secs[0]), bt: secTime(cand[j].secs[0]) });
      }
    }
    return { count: count, capped: count >= cap, first: first, combos: combos, missing: missing, cand: cand, blockers: blockers };
  }
  function pairStatus(codesA, codesB, ti) {
    var A = sectionsOf(codesA, ti), B = sectionsOf(codesB, ti);
    if (!A.length || !B.length) return { status: "na", A: A, B: B };
    var bad = 0, combos = 0;
    A.forEach(function (a) { B.forEach(function (b) { combos++; if (secClash(a, b)) bad++; }); });
    return { status: !bad ? "clear" : bad === combos ? "unavoidable" : "partial", bad: bad, combos: combos, A: A, B: B };
  }
  function seasonTerms(season) { return D.terms.map(function (t, i) { return t.season === season ? i : -1; }).filter(function (i) { return i >= 0; }); }

  function conflictHistory() {
    var t = tracks()[P.track];
    // 1. each check-sheet semester, every past term of its season
    var cohorts = CHECKSHEET_GRID.map(function (sem, si) {
      var season = seasonOfGridSem(si), slots = cohortSlots(si), tis = seasonTerms(season);
      var terms = tis.map(function (ti) {
        var f = feasibility(slots, ti);
        return { term: D.terms[ti], ti: ti, feasible: f.count, capped: f.capped, missing: f.missing, blockers: f.blockers };
      });
      var pairs = [];
      for (var i = 0; i < slots.length; i++) for (var j = i + 1; j < slots.length; j++) {
        var cells = tis.map(function (ti) { var p = pairStatus(slots[i].codes, slots[j].codes, ti); p.ti = ti; return p; });
        pairs.push({ a: slots[i].label, b: slots[j].label, cells: cells,
          un: cells.filter(function (c) { return c.status === "unavoidable"; }).length, pa: cells.filter(function (c) { return c.status === "partial"; }).length });
      }
      pairs.sort(function (x, y) { return y.un - x.un || y.pa - x.pa || x.a.localeCompare(y.a); });
      return { si: si, season: season, slots: slots, terms: terms, pairs: pairs };
    });

    // 2. program-wide hotspots: every pair of EE requirement courses that's
    // ever been impossible to take together, tagged by why the pair matters.
    var core = {}, elective = {}, mine = {};
    (rel.fixed_groups || []).forEach(function (g) { g.forEach(function (c) { core[c] = true; }); });
    t.group1.forEach(function (c) { core[c] = true; mine[c] = true; });
    t.group2.concat(teCodes()).forEach(function (c) { elective[c] = true; });
    Object.keys(tracks()).forEach(function (k) { if (k !== P.track) tracks()[k].group1.concat(tracks()[k].group2).forEach(function (c) { if (!core[c]) elective[c] = true; }); });
    var codes = Object.keys(core).concat(Object.keys(elective)).filter(function (c, i, a) { return a.indexOf(c) === i && !ARRANGED.test(c) && perTerm(c); }).sort();
    var hotspots = [];
    for (var i = 0; i < codes.length; i++) for (var j = i + 1; j < codes.length; j++) {
      var a = codes[i], b = codes[j], tags = [];
      var ga = gridIndexOf(a), gb = gridIndexOf(b);
      if (ga != null && ga === gb) tags.push("same check-sheet semester");
      if (mine[a] && mine[b]) tags.push("both your Group I");
      if ((core[a] && elective[b]) || (core[b] && elective[a])) { if (/^ECE/.test(a) && /^ECE/.test(b) && level(a) >= 3 && level(b) >= 3) tags.push("elective vs. required"); }
      if (!tags.length && /^ECE/.test(a) && /^ECE/.test(b) && level(a) === level(b) && level(a) >= 3 && core[a] && core[b]) tags.push("both required " + level(a) + "00-level");
      if (!tags.length || priorOf(a)[b] || priorOf(b)[a]) continue;
      var unav = [], both = 0;
      D.terms.forEach(function (term, ti) {
        if (term.season === "Summer") return; // separate summer sessions -- see secClash()
        var p = pairStatus([a], [b], ti);
        if (p.status === "na") return;
        both++;
        if (p.status === "unavoidable") unav.push({ term: term, ti: ti, at: secTime(p.A[0]), bt: secTime(p.B[0]) });
      });
      if (unav.length) hotspots.push({ a: a, b: b, tags: tags, unavoidable: unav, both: both });
    }
    hotspots.sort(function (x, y) {
      var px = x.tags[0] === "same check-sheet semester" || x.tags[0] === "both your Group I" ? 0 : 1, py = y.tags[0] === "same check-sheet semester" || y.tags[0] === "both your Group I" ? 0 : 1;
      return px - py || y.unavoidable.length - x.unavoidable.length || y.unavoidable[y.unavoidable.length - 1].ti - x.unavoidable[x.unavoidable.length - 1].ti;
    });
    return { cohorts: cohorts, hotspots: hotspots };
  }

  function statusCell(td, p) {
    var map = { unavoidable: ["bad", "✕", "always clash"], partial: ["warn", "!", "some sections clash"], clear: ["ok", "✓", "no clash"], na: ["unk", "·", "not both offered"] };
    var m = map[p.status];
    if (p.status === "na") { td.className = "off"; td.textContent = "·"; return; }
    td.appendChild(statusIcon(m[0] === "bad" ? "no" : m[0] === "warn" ? "some" : "yes", m[2]));
    if (p.status === "partial") td.appendChild(el("span", "ee-frac", " " + p.bad + "/" + p.combos));
  }

  function renderHistory(hist) {
    var co = hist.cohorts[P.cohort], season = co.season;
    var tis = seasonTerms(season);
    if (P.cohortTerm == null || tis.indexOf(P.cohortTerm) < 0) P.cohortTerm = tis[tis.length - 1];

    // --- card 1: the whole semester together, term by term, plus a timetable
    var c = card("Could you take that semester's courses together?",
      "The check sheet puts these in the same semester (your track's Group I filled in). For every past " + season + " in STAR: is there one section of each that don't overlap? Three-way conflicts count too.", "wide");
    var sel = el("select", "year-select"); sel.setAttribute("aria-label", "Check-sheet semester");
    CHECKSHEET_GRID.forEach(function (s, si) { var o = el("option", null, GRID_YEARS[Math.floor(si / 2)] + " " + seasonOfGridSem(si)); o.value = String(si); sel.appendChild(o); });
    sel.value = String(P.cohort);
    sel.addEventListener("change", function () { P.cohort = Number(sel.value); P.cohortTerm = null; render(); });
    c.head.appendChild(sel);
    var chips = el("div", "ee-picks");
    chips.appendChild(el("span", "st-sub", "Courses checked:"));
    co.slots.forEach(function (s) { chips.appendChild(pill(s.label, null)); });
    c.appendChild(chips);
    var ul = el("ul", "ee-feas");
    co.terms.forEach(function (x) {
      var li = el("li");
      var st = x.missing.length && !x.feasible ? "some" : x.feasible ? (x.missing.length ? "some" : "yes") : "no";
      li.appendChild(statusIcon(st));
      li.appendChild(el("strong", null, x.term.name));
      var text;
      if (x.feasible) text = (x.capped ? "2,000+" : fmt(x.feasible)) + " conflict-free schedule" + (x.feasible === 1 ? "" : "s") + (x.feasible <= 3 ? " — very little room to choose" : "");
      else if (x.blockers.length) text = "no conflict-free schedule: " + x.blockers.map(function (b) { return b.a + " (" + b.at + ") vs " + b.b + " (" + b.bt + ")"; }).join("; ");
      else if (!x.missing.length) text = "no conflict-free schedule — no single pair always clashes, but three or more courses overlap each other";
      else text = "no conflict-free schedule among the courses that ran";
      if (x.missing.length) text += " · not offered that term: " + x.missing.join(", ");
      li.appendChild(el("span", null, " " + text));
      ul.appendChild(li);
    });
    c.appendChild(ul);
    // Term picker + timetable
    var tsel = el("div", "ee-dd-controls"); c.appendChild(tsel);
    seg({ head: tsel }, tis.map(function (ti) { return [String(ti), D.terms[ti].name]; }), String(P.cohortTerm), function (v) { P.cohortTerm = Number(v); });
    var f = feasibility(co.slots, P.cohortTerm);
    timetable(c, co.slots, P.cohortTerm, f);

    // --- card 2: pair-by-pair history
    var c2 = card("Pair by pair", "Every two of those courses, every past " + season + ": ✕ every section of one clashes with every section of the other, ! only some section pairs clash (fraction shown), ✓ no clash.", "wide");
    var wrap = el("div", "st-table-wrap"); c2.appendChild(wrap);
    var tb = el("table", "st-table ee-pairs"); wrap.appendChild(tb);
    var hr = el("tr"); hr.appendChild(el("th", null, "Courses"));
    tis.forEach(function (ti) { hr.appendChild(el("th", null, D.terms[ti].name)); });
    hr.appendChild(el("th", null, "History")); tb.appendChild(hr);
    co.pairs.forEach(function (p) {
      var tr = el("tr", p.un ? null : p.pa ? null : "dim");
      var td = el("td"); td.appendChild(el("span", "ee-code", p.a)); td.appendChild(document.createTextNode(" + ")); td.appendChild(el("span", "ee-code", p.b)); tr.appendChild(td);
      p.cells.forEach(function (cell) {
        var cc = el("td"); statusCell(cc, cell);
        if (cell.status !== "na") hover(cc, function (evt) {
          showTip(evt, p.a + " + " + p.b + " · " + D.terms[cell.ti].name,
            cell.A.map(function (s) { return { value: s.code, label: secTime(s) }; }).concat(cell.B.map(function (s) { return { value: s.code, label: secTime(s) }; })),
            cell.status === "unavoidable" ? "Every combination overlaps." : cell.status === "partial" ? cell.bad + " of " + cell.combos + " section combinations overlap." : "No overlap.");
        });
        tr.appendChild(cc);
      });
      tr.appendChild(el("td", null, p.un ? "always clashed in " + p.un + " term" + (p.un === 1 ? "" : "s") : p.pa ? "partly clashed in " + p.pa : "never clashed"));
      tb.appendChild(tr);
    });
    if (!co.pairs.length) c2.appendChild(el("p", "st-empty", "Fewer than two courses with listed times in this semester."));

    // --- card 3: program-wide hotspots
    var c3 = card("Conflict hotspots across the program", "Every pair of EE requirement courses that was impossible to take together in at least one Fall or Spring — every section of one overlapped every section of the other. Tagged by why the pair matters to you. Pairs where one is a prereq of the other are left out (you can't take those together anyway), and so are summers (separate sessions).", "wide");
    if (!hist.hotspots.length) c3.appendChild(el("p", "st-empty", "No requirement pair has ever been impossible to take together."));
    else {
      var w3 = el("div", "st-table-wrap"); w3.style.maxHeight = "460px"; w3.style.overflowY = "auto"; c3.appendChild(w3);
      var t3 = el("table", "st-table"); w3.appendChild(t3);
      var h3 = el("tr"); ["Courses", "Why it matters", "Clashed in", "Latest clash", ""].forEach(function (h) { h3.appendChild(el("th", null, h)); }); t3.appendChild(h3);
      hist.hotspots.slice(0, 60).forEach(function (h) {
        var tr = el("tr"), last = h.unavoidable[h.unavoidable.length - 1];
        var td = el("td"); td.style.whiteSpace = "nowrap"; td.appendChild(graphLink(h.a)); td.appendChild(document.createTextNode(" + ")); td.appendChild(graphLink(h.b)); tr.appendChild(td);
        var tg = el("td"); h.tags.forEach(function (x) { tg.appendChild(pill(x, x === "same check-sheet semester" || x === "both your Group I" ? "offer-fall" : null)); tg.appendChild(document.createTextNode(" ")); }); tr.appendChild(tg);
        tr.appendChild(el("td", null, h.unavoidable.map(function (x) { return shortTerm(x.term); }).join(", ") + " (" + h.unavoidable.length + " of " + h.both + " terms both ran)"));
        tr.appendChild(el("td", null, last.term.name + ": " + h.a + " " + last.at + " vs " + h.b + " " + last.bt));
        tr.appendChild(el("td"));
        t3.appendChild(tr);
      });
      if (hist.hotspots.length > 60) c3.appendChild(el("p", "st-sub", "+" + (hist.hotspots.length - 60) + " more."));
    }

    renderStability();
    renderElectiveFit(co);
    renderGenedFit(co);
  }

  // Weekly timetable of every section of the slots in term ti; the first
  // conflict-free schedule highlighted, sections of always-clashing pairs outlined.
  function timetable(container, slots, ti, f) {
    var secs = [];
    slots.forEach(function (s) { sectionsOf(s.codes, ti).forEach(function (x) { secs.push(x); }); });
    var timed = secs.filter(function (x) { return x.m.length; });
    var untimed = secs.filter(function (x) { return !x.m.length; });
    if (!timed.length) { container.appendChild(el("p", "st-empty", "No sections with set times in " + D.terms[ti].name + ".")); return; }
    var chosen = f.first || [], clashing = {};
    f.blockers.forEach(function (b) { clashing[b.a] = true; clashing[b.b] = true; });
    var days = ["M", "T", "W", "R", "F"];
    if (timed.some(function (x) { return x.m.some(function (m) { return m.days.indexOf("S") >= 0; }); })) days.push("S");
    var lo = 24 * 60, hi = 0;
    timed.forEach(function (x) { x.m.forEach(function (m) { lo = Math.min(lo, m.s); hi = Math.max(hi, m.e); }); });
    lo = Math.floor(lo / 60) * 60; hi = Math.ceil(hi / 60) * 60;
    var W = Math.max(320, container.clientWidth || 700), gut = 44, hourH = 34, top = 22;
    var colW = (W - gut) / days.length, H = top + (hi - lo) / 60 * hourH + 6;
    var s = V.svg("svg", { "class": "viz ee-tt", viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img" });
    container.appendChild(s);
    var g = V.svg("g", { "class": "grid" }, s);
    for (var m = lo; m <= hi; m += 60) {
      var y = top + (m - lo) / 60 * hourH;
      V.svg("line", { x1: gut, x2: W, y1: y, y2: y }, g);
      var tx = V.svg("text", { x: gut - 6, y: y + 4, "text-anchor": "end" }, s);
      var h = m / 60; tx.textContent = (h % 12 || 12) + (h < 12 ? "a" : "p");
    }
    var names = { M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", S: "Sat" };
    days.forEach(function (d, di) {
      var t = V.svg("text", { x: gut + colW * (di + 0.5), y: 14, "text-anchor": "middle", "class": "lab" }, s); t.textContent = names[d];
      // Lay out this day's blocks in lanes so overlapping sections sit side by side.
      var blocks = [];
      timed.forEach(function (x) { x.m.forEach(function (mm) { if (mm.days.indexOf(d) >= 0) blocks.push({ x: x, s: mm.s, e: mm.e }); }); });
      blocks.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
      var laneEnd = [];
      blocks.forEach(function (b) {
        var lane = 0; while (lane < laneEnd.length && laneEnd[lane] > b.s) lane++;
        laneEnd[lane] = b.e; b.lane = lane;
      });
      var lanes = Math.max(1, laneEnd.length), lw = (colW - 4) / lanes;
      blocks.forEach(function (b) {
        var x0 = gut + colW * di + 2 + b.lane * lw, y0 = top + (b.s - lo) / 60 * hourH, hh = Math.max(10, (b.e - b.s) / 60 * hourH - 2);
        var inPlan = chosen.indexOf(b.x) >= 0, bad = clashing[b.x.code] || Object.keys(clashing).some(function (k) { return k.split(" or ").indexOf(b.x.code) >= 0; });
        var r = V.svg("rect", { x: x0, y: y0, width: Math.max(4, lw - 2), height: hh, rx: 4, "class": "ee-blk" + (inPlan ? " pick" : "") + (bad ? " clash" : "") }, s);
        if (lw > 26 && hh > 14) {
          var lab = V.svg("text", { x: x0 + 4, y: y0 + 12, "class": "ee-blk-t" }, s);
          lab.textContent = lw > 52 ? b.x.code : b.x.code.split(" ")[1];
        }
        hover(r, function (evt) {
          var a = b.x.r;
          showTip(evt, b.x.code + " — " + title(b.x.code), [{ value: secTime(b.x), label: "" }, { value: fmt(a[3]) + " / " + fmt(a[2]), label: "seats taken" }],
            (inPlan ? "In the highlighted conflict-free schedule. " : "") + (bad ? "Part of a pair that always clashed this term." : ""));
        });
      });
    });
    var lg = el("div", "viz-legend");
    [["pick", "One conflict-free schedule" + (f.first ? "" : " (none exists this term)")], ["clash", "Course in a pair that always clashed"], ["", "Other sections"]].forEach(function (x) {
      var k = el("span", "key"), sw = el("span", "sw ee-sw " + x[0]); k.appendChild(sw); k.appendChild(document.createTextNode(x[1])); lg.appendChild(k);
    });
    container.appendChild(lg);
    if (untimed.length) container.appendChild(el("p", "st-sub", "Also offered with no set time (online or arranged): " + untimed.map(function (x) { return x.code; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ") + "."));
  }

  // Does each course keep its meeting time from year to year? A course that
  // never moves will keep clashing with whatever it clashed with before.
  function renderStability() {
    var c = card("Do courses keep their time slot?", "Each course's most common meeting time (usually the lecture) and in how many past terms of that season it met then. Stable times make past conflicts likely to repeat.");
    var t = tracks()[P.track];
    var codes = [].concat.apply([], rel.fixed_groups || []).concat(t.group1).filter(function (x, i, a) { return a.indexOf(x) === i && /^ECE/.test(x) && !ARRANGED.test(x) && perTerm(x); }).sort();
    var rows = [];
    codes.forEach(function (code) {
      ["Fall", "Spring"].forEach(function (season) {
        // Count each individual meeting time ("MWF 1330-1420") by how many
        // terms it appears in. Multi-section courses keep the lecture fixed
        // while lab sections move, so the whole schedule rarely repeats
        // exactly -- the most common single meeting is the honest measure.
        var inTerms = {}, n = 0, others = {};
        seasonTerms(season).forEach(function (ti) {
          var secs = sectionsOf([code], ti).filter(function (x) { return x.r[6]; });
          if (!secs.length) return;
          n++;
          var here = {};
          secs.forEach(function (x) { x.r[6].split("|").forEach(function (m) { here[m] = true; }); });
          Object.keys(here).forEach(function (m) { inTerms[m] = (inTerms[m] || 0) + 1; others[m] = true; });
        });
        if (!n) return;
        var best = Object.keys(inTerms).sort(function (a, b) { return inTerms[b] - inTerms[a] || a.localeCompare(b); })[0];
        rows.push({ code: code, season: season, n: n, same: inTerms[best], sig: best, other: Object.keys(others).length - 1 });
      });
    });
    var wrap = el("div", "st-table-wrap"); wrap.style.maxHeight = "460px"; wrap.style.overflowY = "auto"; c.appendChild(wrap);
    var tb = el("table", "st-table"); wrap.appendChild(tb);
    var hr = el("tr"); ["Course", "Season", "Usual time", "Same slot"].forEach(function (h, i) { hr.appendChild(el("th", i === 3 ? "num" : null, h)); }); tb.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el("tr");
      var td = el("td", "code"); td.appendChild(graphLink(r.code)); tr.appendChild(td);
      tr.appendChild(el("td", null, r.season));
      var tt = el("td", null, prettyMeeting(r.sig) + (r.other ? " (+" + r.other + " other time" + (r.other === 1 ? "" : "s") + ", e.g. labs)" : "")); tr.appendChild(tt);
      var st = el("td", "num", r.same + " / " + r.n); if (r.same === r.n && r.n >= 2) st.style.fontWeight = "700"; tr.appendChild(st);
      tb.appendChild(tr);
    });
  }

  // For the chosen semester's season: does each Group II / TE option fit
  // around that semester's required courses, term by term?
  function renderElectiveFit(co) {
    var c = card("Electives that fit around " + GRID_YEARS[Math.floor(co.si / 2)] + " " + co.season,
      "Group II and TE options that ran in a past " + co.season + ", checked against a conflict-free schedule of that semester's required courses. ✕ names what blocked it.");
    var t = tracks()[P.track], opts = t.group2.concat(teCodes());
    Object.keys(tracks()).forEach(function (k) { if (k !== P.track) opts = opts.concat(tracks()[k].group1, tracks()[k].group2); });
    var inCohort = {};
    co.slots.forEach(function (s) { s.codes.forEach(function (x) { inCohort[x] = true; }); });
    opts = opts.filter(function (x, i, a) { return a.indexOf(x) === i && !inCohort[x] && t.group1.indexOf(x) < 0; });
    var tis = seasonTerms(co.season);
    var rows = opts.map(function (code) {
      var cells = tis.map(function (ti) {
        if (!sectionsOf([code], ti).length) return { st: "na" };
        var f = feasibility(co.slots.concat([{ label: code, codes: [code] }]), ti, { cap: 1 });
        if (f.count) return { st: "fit" };
        var blk = co.slots.filter(function (s) { return pairStatus(s.codes, [code], ti).status === "unavoidable"; }).map(function (s) { return s.label; });
        return { st: "no", blk: blk };
      });
      return { code: code, cells: cells, ran: cells.filter(function (x) { return x.st !== "na"; }).length, fits: cells.filter(function (x) { return x.st === "fit"; }).length };
    }).filter(function (r) { return r.ran; }).sort(function (a, b) { return b.fits / b.ran - a.fits / a.ran || b.ran - a.ran || a.code.localeCompare(b.code); });
    if (!rows.length) { c.appendChild(el("p", "st-empty", "No Group II or TE option ran in a past " + co.season + ".")); return; }
    var wrap = el("div", "st-table-wrap"); c.appendChild(wrap);
    var tb = el("table", "st-table"); wrap.appendChild(tb);
    var hr = el("tr"); hr.appendChild(el("th", null, "Option"));
    tis.forEach(function (ti) { hr.appendChild(el("th", null, shortTerm(D.terms[ti]))); });
    tb.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el("tr");
      var td = el("td", "code"); td.appendChild(graphLink(r.code)); tr.appendChild(td);
      r.cells.forEach(function (x) {
        var cc = el("td");
        if (x.st === "na") { cc.className = "off"; cc.textContent = "·"; }
        else if (x.st === "fit") cc.appendChild(statusIcon("yes", "fits"));
        else { cc.appendChild(statusIcon("no", "doesn't fit")); if (x.blk.length) cc.appendChild(el("span", "ee-frac", " " + x.blk.join(", "))); }
        tr.appendChild(cc);
      });
      tb.appendChild(tr);
    });
  }

  // How many Gen-ed sections fit around a conflict-free schedule of the
  // chosen semester's required courses, in the chosen term?
  function renderGenedFit(co) {
    var ti = P.cohortTerm, term = D.terms[ti];
    var c = card("Gen-eds that fit around " + GRID_YEARS[Math.floor(co.si / 2)] + " " + co.season,
      "Sections in " + term.name + " for each open Gen-ed/Focus need, and how many fit around at least one conflict-free schedule of that semester's required courses. Online and no-set-time sections always fit.");
    var f = feasibility(co.slots, ti, { keep: 300 });
    if (!f.count) { c.appendChild(el("p", "st-empty", "The required courses themselves had no conflict-free schedule in " + term.name + ", so nothing fits around them.")); return; }
    var needs = [["FG", ["FGA", "FGB", "FGC"]], ["DH or DL", ["DH", "DL"]], ["DS", ["DS"]], ["H Focus", ["HAP"]], ["W Focus", ["WI"]]];
    var items = needs.map(function (nd) {
      var bits = nd[1].map(function (a) { return 1 << D.attrs.indexOf(a); }), total = 0, fit = 0, courses = {};
      D.rows.forEach(function (r) {
        if (r[0] !== ti || !bits.some(function (b) { return r[5] & b; })) return;
        total++;
        var sec = { r: r, m: parseMeetings(r[6]) };
        if (f.combos.some(function (combo) { return combo.every(function (x) { return !secClash(x, sec); }); })) { fit++; courses[r[1]] = true; }
      });
      return { label: nd[0], value: fit, valueText: fit + " / " + total, tipRows: [{ value: fmt(fit), label: "sections fit" }, { value: fmt(Object.keys(courses).length), label: "different courses" }, { value: fmt(total), label: "sections in all" }], tipNote: term.name };
    });
    hBars(c, { items: items, labelW: 76, rowH: 26 });
    c.appendChild(el("p", "st-sub", "Bars: sections that fit / all sections with that designation. Based on " + (f.capped ? "2,000+" : fmt(f.count)) + " conflict-free schedule" + (f.count === 1 ? "" : "s") + " of the required courses" + (f.count > 300 ? " (the first 300 checked)" : "") + "."));
  }

  // ---------- boot ----------
  function loadCatalog() {
    var cat = CATALOGS.filter(function (x) { return x.id === P.catalog; })[0] || CATALOGS[0];
    return Promise.all([
      fetch(PROGRAMS[0].urls[cat.id]).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
      fetch(cat.url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
    ]).then(function (res) { rel = res[0]; graph = res[1]; });
  }
  function readTaken() {
    try {
      JSON.parse(localStorage.getItem(TAKEN_KEY) || "[]").forEach(function (c) { taken[c] = true; });
      var tr = localStorage.getItem(TRACK_KEY); if (tr) P.track = tr;
    } catch (e) { /* storage blocked: start from nothing */ }
  }
  readTaken();
  Promise.all([fetch(STAR_URL).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }), loadCatalog()])
    .then(function (res) {
      D = res[0]; star = prepareStar(D);
      if (!P.start) {
        // Default start: the next Fall after the latest captured term... or that term itself if it's a Fall.
        P.start = startOptions().filter(function (o) { return o[1].indexOf("Fall") === 0; })[0][0];
      }
      root.textContent = "";
      controls = el("div", "st-filters"); root.appendChild(controls);
      content = el("div", "st-grid"); root.appendChild(content);
      if (!P.track) P.track = Object.keys(tracks())[0];
      render();
      var t = null;
      window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(function () { if (!document.getElementById("panel-ee").hidden) render(); }, 200); });
    })
    .catch(function (err) {
      console.error(err);
      root.textContent = "";
      root.appendChild(el("div", "cmp-loading", "Couldn't load the EE planning data (" + err.message + ")."));
    });
})();
