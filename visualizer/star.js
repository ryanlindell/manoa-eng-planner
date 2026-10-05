(function () {
  "use strict";

  // STAR offerings analyzer -- the "STAR offerings" tab of analysis.html.
  // Reads data/star_sections.json (scripts/build_star_offerings.py: one
  // compact row per section, every captured term) and slices it every way the
  // panels below need. Everything is derived in the browser from those rows,
  // so every chart, table and tile always agrees with the filter row above it.
  //
  // Charts are hand-built SVG (no library), following the dataviz method:
  // one axis per chart, thin marks with 4px rounded data-ends, 2px lines,
  // categorical slots in fixed order (blue, orange, aqua -- validated light
  // and dark, all-pairs), a one-hue blue ramp for magnitude, text in ink
  // tokens never series colors, and a hover tooltip on every mark.

  var root = document.getElementById("star-root");
  var DATA_URL = "data/star_sections.json";
  var PAGE_SIZE = 50;
  var CAL_MAX = 120;
  var MOD_COLORS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)"];
  var PATTERN_LABELS = { both: "Fall & Spring", fall: "Fall only", spring: "Spring only", irregular: "Irregular", summer: "Summer only" };
  var LENS_LABELS = { req: "EE degree requirements (all)", fixed: "EE — fixed requirements", group1: "EE — Major Group I", group2: "EE — Major Group II", te: "EE — Technical electives", eb: "EE — Engineering breadth" };

  var D = null;           // the fetched payload
  var meta = null;        // derived per-code / per-row lookups, see prepare()
  var lensByCode = null;  // EE requirement category per code (ee_relevant_EE.json), or null
  var S = {
    term: null, cmp: "auto", subject: "ALL", level: "ALL", attr: "ALL", modality: "ALL", lens: "ALL", pattern: "ALL", q: "",
    trend: "seats", heat: "sections", sizeMode: "sections",
    sort: { key: "seats", dir: -1 }, subjSort: { key: "seats", dir: -1 }, page: 0, course: null, drawerTerm: null,
  };

  // Chart and DOM helpers come from viz.js (window.StarViz).
  var V = window.StarViz;
  var DAYS = V.DAYS, HOURS = V.HOURS, SIZE_BUCKETS = V.SIZE_BUCKETS, ATTR_LABELS = V.ATTR_LABELS;
  var el = V.el, svg = V.svg, fmt = V.fmt, pct = V.pct, signed = V.signed, niceMax = V.niceMax, shortTerm = V.shortTerm, showTip = V.showTip, hideTip = V.hideTip, hover = V.hover, frame = V.frame, yAxis = V.yAxis, xLabels = V.xLabels, colPath = V.colPath, barPath = V.barPath, legend = V.legend, lineChart = V.lineChart, columnChart = V.columnChart, stackedShares = V.stackedShares, hBars = V.hBars, divergingBars = V.divergingBars, seqColor = V.seqColor, seqIsDark = V.seqIsDark, rampLegend = V.rampLegend, heatmap = V.heatmap, sparkline = V.sparkline, patternOf = V.patternOf, sortable = V.sortable, fillCell = V.fillCell;
  function termByKey(key) { for (var i = 0; i < D.terms.length; i++) if (D.terms[i].key === key) return i; return -1; }

  // ---------- data preparation ----------
  function prepare(data) {
    var nCodes = data.codes.length, nTerms = data.terms.length;
    var subj = new Array(nCodes), num = new Array(nCodes), lvl = new Array(nCodes);
    data.codes.forEach(function (c, i) {
      var parts = c.split(" ");
      subj[i] = parts[0];
      var m = /(\d+)/.exec(parts[1] || "");
      num[i] = m ? parseInt(m[1], 10) : NaN;
      lvl[i] = m ? Math.floor(num[i] / 100) : null;
    });
    // Unfiltered per-course per-term totals -> each course's offering pattern
    // (a property of the course itself, not of whatever slice is on screen).
    var perTerm = [];
    for (var i = 0; i < nCodes; i++) perTerm.push(null);
    data.rows.forEach(function (r) {
      var t = perTerm[r[1]] || (perTerm[r[1]] = new Array(nTerms).fill(null));
      var cell = t[r[0]] || (t[r[0]] = [0, 0, 0]);
      cell[0]++; cell[1] += r[2]; cell[2] += r[3];
    });
    var pattern = perTerm.map(function (t) { return patternOf(t, data.terms); });
    var lower = data.codes.map(function (c, i) { return (c + " " + data.titles[i]).toLowerCase(); });
    return { subj: subj, num: num, lvl: lvl, perTerm: perTerm, pattern: pattern, lower: lower };
  }

  // ---------- filtering ----------
  function attrBit(name) { return 1 << D.attrs.indexOf(name); }
  function passesCourse(ci) {
    if (S.subject !== "ALL" && meta.subj[ci] !== S.subject) return false;
    if (S.level !== "ALL") {
      var l = meta.lvl[ci];
      if (S.level === "UG" ? !(l >= 1 && l <= 4) : S.level === "GR" ? !(l >= 6) : String(l) !== S.level) return false;
    }
    if (S.lens !== "ALL") {
      var cat = lensByCode && lensByCode[D.codes[ci]];
      if (!cat || (S.lens !== "req" && cat !== S.lens)) return false;
    }
    if (S.pattern !== "ALL" && meta.pattern[ci].kind !== S.pattern) return false;
    if (S.q && meta.lower[ci].indexOf(S.q.toLowerCase()) === -1) return false;
    return true;
  }
  function filteredRows() {
    var courseOk = new Array(D.codes.length);
    for (var i = 0; i < D.codes.length; i++) courseOk[i] = passesCourse(i);
    var bit = S.attr !== "ALL" ? attrBit(S.attr) : 0, mod = S.modality !== "ALL" ? Number(S.modality) : -1;
    return D.rows.filter(function (r) {
      return courseOk[r[1]] && (!bit || (r[5] & bit)) && (mod < 0 || r[4] === mod);
    });
  }
  function cmpIndex() {
    if (S.cmp === "none") return -1;
    if (S.cmp !== "auto") return termByKey(S.cmp);
    // Same season, the year before.
    var t = D.terms[S.term];
    for (var i = S.term - 1; i >= 0; i--) if (D.terms[i].season === t.season) return i;
    return -1;
  }
  function aggregate(rows) {
    var a = { sections: 0, seats: 0, taken: 0, full: 0, online: 0, courses: 0 }, seen = {};
    rows.forEach(function (r) {
      a.sections++; a.seats += r[2]; a.taken += r[3];
      if (r[3] >= r[2]) a.full++;
      if (r[4] === 1) a.online++;
      if (!seen[r[1]]) { seen[r[1]] = true; a.courses++; }
    });
    a.fill = a.seats ? a.taken / a.seats : null;
    return a;
  }
  function byTerm(rows) {
    var out = D.terms.map(function () { return []; });
    rows.forEach(function (r) { out[r[0]].push(r); });
    return out;
  }
  function byCourse(rows) {
    var m = {};
    rows.forEach(function (r) {
      var c = m[r[1]] || (m[r[1]] = { ci: r[1], timed: false, terms: D.terms.map(function () { return null; }) });
      if (r[6]) c.timed = true;
      var t = c.terms[r[0]] || (c.terms[r[0]] = { sections: 0, seats: 0, taken: 0, full: 0 });
      t.sections++; t.seats += r[2]; t.taken += r[3]; if (r[3] >= r[2]) t.full++;
    });
    return Object.keys(m).map(function (k) { return m[k]; });
  }

  // ---------- URL state (#star?subject=ECE&...) ----------
  var STATE_KEYS = ["term", "cmp", "subject", "level", "attr", "modality", "lens", "pattern", "q", "course"];
  function readHash() {
    var qs = location.hash.split("?")[1];
    if (!qs) return;
    var p = new URLSearchParams(qs);
    STATE_KEYS.forEach(function (k) { if (p.has(k)) S[k] = p.get(k); });
    if (S.term != null) { var ti = termByKey(S.term); S.term = ti >= 0 ? ti : null; }
  }
  function writeHash() {
    var p = new URLSearchParams();
    STATE_KEYS.forEach(function (k) {
      var v = k === "term" ? D.terms[S.term].key : S[k];
      var dflt = { cmp: "auto", subject: "ALL", level: "ALL", attr: "ALL", modality: "ALL", lens: "ALL", pattern: "ALL", q: "", course: null };
      if (k === "term" ? S.term !== D.terms.length - 1 : v != null && v !== dflt[k]) p.set(k, v);
    });
    var qs = p.toString();
    history.replaceState(null, "", "#star" + (qs ? "?" + qs : ""));
  }

  // ---------- page ----------
  var filterBar, content, drawer, drawerBack;
  function build() {
    root.textContent = "";
    filterBar = el("div", "st-filters");
    root.appendChild(filterBar);
    content = el("div", "st-grid");
    root.appendChild(content);
    drawerBack = el("div", "st-drawer-back"); drawerBack.hidden = true;
    drawer = el("aside", "st-drawer"); drawer.hidden = true; drawer.setAttribute("aria-label", "Course details");
    document.body.appendChild(drawerBack); document.body.appendChild(drawer);
    drawerBack.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !drawer.hidden) closeDrawer(); });
    buildFilters();
    render();
    if (S.course) openDrawer(S.course);
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (!document.getElementById("panel-star").hidden) render(); }, 180);
    });
  }

  function select(label, value, options, onChange, title) {
    var f = el("label", "cmp-field");
    f.appendChild(el("span", null, label));
    var s = el("select", "year-select");
    s.setAttribute("aria-label", title || label);
    options.forEach(function (o) {
      if (o.group) {
        var g = document.createElement("optgroup"); g.label = o.group;
        o.options.forEach(function (oo) { var op = el("option", null, oo[1]); op.value = oo[0]; g.appendChild(op); });
        s.appendChild(g);
      } else { var op = el("option", null, o[1]); op.value = o[0]; s.appendChild(op); }
    });
    s.value = value;
    s.addEventListener("change", function () { onChange(s.value); S.page = 0; render(); });
    f.appendChild(s);
    filterBar.appendChild(f);
    return s;
  }

  function buildFilters() {
    filterBar.textContent = "";
    var termOpts = D.terms.map(function (t, i) { return [String(i), t.name + (t.status === "live" ? " (live)" : "")]; }).reverse();
    select("Term", String(S.term), termOpts, function (v) { S.term = Number(v); });
    select("Compare to", S.cmp, [["auto", "Same season, year before"], ["none", "No comparison"]].concat(
      D.terms.map(function (t) { return [t.key, t.name]; }).reverse()), function (v) { S.cmp = v; });
    var subjCount = {};
    D.rows.forEach(function (r) { var s = meta.subj[r[1]]; subjCount[s] = (subjCount[s] || 0) + 1; });
    select("Subject", S.subject, [["ALL", "All subjects"]].concat(Object.keys(subjCount).sort().map(function (s) { return [s, s]; })),
      function (v) { S.subject = v; });
    select("Level", S.level, [["ALL", "All levels"], ["UG", "Undergraduate (100–499)"], ["GR", "Graduate (600+)"]].concat(
      [0, 1, 2, 3, 4, 5, 6, 7, 8].map(function (l) { return [String(l), l + "00-level"]; })), function (v) { S.level = v; });
    var gened = D.attrs.filter(function (a) { return ["WI", "HAP", "ETH", "OC"].indexOf(a) === -1; });
    select("Gen-ed / Focus", S.attr, [["ALL", "Any"], { group: "General education", options: gened.map(function (a) { return [a, a + " — " + ATTR_LABELS[a]]; }) },
      { group: "Focus", options: ["WI", "HAP", "ETH", "OC"].map(function (a) { return [a, ATTR_LABELS[a]]; }) }], function (v) { S.attr = v; });
    select("Modality", S.modality, [["ALL", "Any"]].concat(D.modalities.map(function (m, i) { return [String(i), m]; })), function (v) { S.modality = v; });
    select("Offered", S.pattern, [["ALL", "Any pattern"]].concat(Object.keys(PATTERN_LABELS).map(function (k) { return [k, PATTERN_LABELS[k]]; })),
      function (v) { S.pattern = v; }, "Offering pattern");
    if (lensByCode) {
      select("Major", S.lens, [["ALL", "All courses"]].concat(Object.keys(LENS_LABELS).map(function (k) { return [k, LENS_LABELS[k]]; })),
        function (v) { S.lens = v; }, "Limit to a major's requirements");
    }
    var qf = el("label", "cmp-field");
    qf.appendChild(el("span", null, "Search"));
    var q = el("input"); q.type = "search"; q.placeholder = "code or title"; q.value = S.q;
    q.setAttribute("aria-label", "Search courses by code or title");
    var qt = null;
    q.addEventListener("input", function () { clearTimeout(qt); qt = setTimeout(function () { S.q = q.value.trim(); S.page = 0; render(); }, 200); });
    qf.appendChild(q);
    filterBar.appendChild(qf);
    var reset = el("button", "st-reset", "Reset filters"); reset.type = "button";
    reset.addEventListener("click", function () {
      S.subject = "ALL"; S.level = "ALL"; S.attr = "ALL"; S.modality = "ALL"; S.lens = "ALL"; S.pattern = "ALL"; S.q = ""; S.cmp = "auto";
      S.term = D.terms.length - 1; S.page = 0;
      buildFilters(); render();
    });
    filterBar.appendChild(reset);
    filterBar.appendChild(el("div", "st-active"));
  }
  // Lets a click inside a chart or table change a filter and keep the dropdowns in sync.
  function setFilter(key, value) {
    S[key] = value; S.page = 0;
    buildFilters(); render();
    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function card(title, sub, cls) {
    var c = el("section", "st-card" + (cls ? " " + cls : ""));
    var head = el("div", "st-card-head");
    var hw = el("div");
    hw.appendChild(el("h3", null, title));
    if (sub) hw.appendChild(el("p", "st-sub", sub));
    head.appendChild(hw);
    c.appendChild(head);
    content.appendChild(c);
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

  // ---------- render ----------
  function render() {
    hideTip();
    var scrollY = window.scrollY;
    writeHash();
    content.textContent = "";
    var rows = filteredRows();
    var terms = byTerm(rows);
    var ft = S.term, ci = cmpIndex();
    var focusTerm = D.terms[ft], cmpTerm = ci >= 0 ? D.terms[ci] : null;
    var A = aggregate(terms[ft]), B = cmpTerm ? aggregate(terms[ci]) : null;

    var active = filterBar.querySelector(".st-active");
    active.textContent = "";
    active.appendChild(document.createTextNode("Showing "));
    active.appendChild(el("strong", null, fmt(rows.length)));
    active.appendChild(document.createTextNode(" sections across " + D.terms.length + " terms · focus term "));
    active.appendChild(el("strong", null, focusTerm.name));
    active.appendChild(document.createTextNode(cmpTerm ? " vs " + cmpTerm.name : ""));

    if (!rows.length) {
      content.appendChild(el("p", "st-empty", "No sections match these filters."));
      return;
    }
    renderKpis(A, B, focusTerm, cmpTerm);

    sectionTitle("Over time");
    renderTrend(terms, ft);
    renderFillTrend(terms, ft);
    renderModality(terms, ft);

    sectionTitle("In " + focusTerm.name);
    renderHeatmap(terms[ft], focusTerm);
    renderAttrs(terms[ft], focusTerm);
    renderSizes(terms[ft], focusTerm);
    renderBuildings(terms[ft], focusTerm);
    renderAccess(terms[ft], focusTerm);

    var courses = byCourse(rows);
    sectionTitle("Insights");
    renderHardest(courses, ft);
    renderOpenSeats(courses, ft, focusTerm);
    renderGrowth(courses, ft, ci, focusTerm, cmpTerm);
    renderNewGone(courses, ft, ci, focusTerm, cmpTerm);
    renderPatterns(courses);
    renderCredits(terms[ft], focusTerm);

    sectionTitle("Subjects and courses");
    renderSubjects(rows, terms, ft, ci, focusTerm, cmpTerm);
    renderCourses(courses, ft, ci, focusTerm, cmpTerm);
    renderCalendar(courses);
    renderNotes();
    window.scrollTo(0, scrollY);
  }

  function renderKpis(A, B, ft, ct) {
    var wrap = el("div", "st-kpis");
    content.appendChild(wrap);
    function tile(label, value, a, b, fmtDelta, hero, note) {
      var t = el("div", "st-kpi" + (hero ? " hero" : ""));
      t.appendChild(el("div", "label", label));
      t.appendChild(el("div", "value", value));
      var d = el("div", "delta");
      if (B && a != null && b != null) {
        // Neutral ink plus an arrow: whether "up" is good depends on the
        // metric (more full sections is not a win), so color doesn't judge it.
        var text = (fmtDelta || function (x) { return signed(x); })(a - b);
        var dir = /^\+/.test(text) ? "▲ " : /^−/.test(text) ? "▼ " : "";
        d.appendChild(el("span", "chg", dir + text));
        d.appendChild(document.createTextNode(" vs " + ct.name));
      } else if (note) d.textContent = note;
      t.appendChild(d);
      if (note && B) t.title = note;
      wrap.appendChild(t);
    }
    function ppDelta(x) { return signed(Math.round(x * 100) || 0) + " pts"; }
    tile("Seats filled", pct(A.fill), A.fill, B && B.fill, ppDelta, true, fmt(A.taken) + " of " + fmt(A.seats) + " seats");
    tile("Sections", fmt(A.sections), A.sections, B && B.sections);
    tile("Courses", fmt(A.courses), A.courses, B && B.courses);
    tile("Seats offered", fmt(A.seats), A.seats, B && B.seats);
    tile("Seats taken", fmt(A.taken), A.taken, B && B.taken);
    tile("Full sections · " + pct(A.sections ? A.full / A.sections : 0), fmt(A.full), A.full, B && B.full);
    tile("Online sections", pct(A.sections ? A.online / A.sections : 0), A.sections ? A.online / A.sections : null,
      B && B.sections ? B.online / B.sections : null, ppDelta);
    tile("Avg section size", fmt(A.sections ? A.seats / A.sections : 0), A.sections ? A.seats / A.sections : null,
      B && B.sections ? B.seats / B.sections : null, function (x) { return signed(x, function (v) { return v.toFixed(1); }); });
  }

  function termLabels() { return D.terms.map(shortTerm); }
  function termNames() { return D.terms.map(function (t) { return t.name + (t.status === "live" ? " (live, as of " + t.captured + ")" : ""); }); }

  function renderTrend(terms, ft) {
    var c = card("Seats, sections and courses by term", "Every captured term. Summers are much smaller — compare Fall to Fall and Spring to Spring.", "wide");
    seg(c, [["seats", "Seats"], ["sections", "Sections"], ["courses", "Courses"]], S.trend, function (v) { S.trend = v; });
    var aggs = terms.map(aggregate);
    var series = S.trend === "seats"
      ? [{ name: "Seats offered", color: "var(--viz-1)", values: aggs.map(function (a) { return a.seats; }) },
         { name: "Seats taken", color: "var(--viz-2)", values: aggs.map(function (a) { return a.taken; }) }]
      : [{ name: S.trend === "sections" ? "Sections" : "Courses", color: "var(--viz-1)", values: aggs.map(function (a) { return a[S.trend]; }) }];
    lineChart(c, { labels: termLabels(), tipTitles: termNames(), series: series, highlight: ft, height: 240,
      tipNote: function (i) { return S.trend === "seats" ? pct(aggs[i].fill) + " filled" : null; } });
  }
  function renderFillTrend(terms, ft) {
    var c = card("How full classes got", "Seats taken ÷ seats offered, per term.");
    var aggs = terms.map(aggregate);
    columnChart(c, { labels: termLabels(), tipTitles: termNames(), values: aggs.map(function (a) { return a.fill == null ? 0 : a.fill; }),
      max: 1, fmt: pct, fmtTick: pct, name: "of seats filled", highlight: ft,
      tipNote: function (i) { return fmt(aggs[i].taken) + " of " + fmt(aggs[i].seats) + " seats · " + fmt(aggs[i].full) + " full sections"; } });
  }
  function renderModality(terms, ft) {
    var c = card("In person vs online", "Share of sections by delivery mode.");
    var counts = terms.map(function (rs) { var a = [0, 0, 0]; rs.forEach(function (r) { a[r[4]]++; }); return a; });
    var cur = counts[ft], tot = cur[0] + cur[1] + cur[2];
    // Direct values in the legend: the hybrid aqua sits under 3:1 on the light surface.
    legend(c, D.modalities.map(function (m, i) { return { label: m, color: MOD_COLORS[i], num: pct(tot ? cur[i] / tot : 0) }; }));
    stackedShares(c, { labels: termLabels(), tipTitles: termNames(), highlight: ft,
      series: D.modalities.map(function (m, i) { return { name: m, color: MOD_COLORS[i], values: counts.map(function (a) { return a[i]; }) }; }) });
  }

  function minutes(hhmm) { return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10); }
  function renderHeatmap(rows, term) {
    var c = card("When classes meet", "Class meetings in progress each hour, Monday–Saturday. TBA and online-asynchronous sections have no time and aren't counted.", "wide");
    seg(c, [["sections", "Sections"], ["seats", "Seats"]], S.heat, function (v) { S.heat = v; });
    var M = DAYS.map(function () { return HOURS.map(function () { return 0; }); }), timed = 0;
    rows.forEach(function (r) {
      if (!r[6]) return;
      timed++;
      r[6].split("|").forEach(function (mtg) {
        var parts = mtg.split(" "), span = parts[1].split("-"), s = minutes(span[0]), e = minutes(span[1]);
        DAYS.forEach(function (d, di) {
          if (parts[0].indexOf(d[0]) === -1) return;
          HOURS.forEach(function (h, hi) { if (s < (h + 1) * 60 && e > h * 60) M[di][hi] += S.heat === "seats" ? r[2] : 1; });
        });
      });
    });
    if (!timed) { c.appendChild(el("p", "st-empty", "No scheduled meeting times in this slice.")); return; }
    function hl(h) { return (h % 12 || 12) + (h < 12 ? "a" : "p"); }
    function hlong(h) { return (h % 12 || 12) + (h < 12 ? " AM" : " PM"); }
    heatmap(c, { rows: DAYS.map(function (d) { return d[1]; }), cols: HOURS.map(hl), matrix: M,
      unit: S.heat === "seats" ? "seats" : "sections",
      tipTitle: function (i, j) { return DAYS[i][1] + " " + hlong(HOURS[j]) + "–" + hlong(HOURS[j] + 1); },
      tipNote: function () { return term.name + " · " + fmt(timed) + " sections with set times"; } });
  }

  function renderAttrs(rows, term) {
    var c = card("Gen-ed and Focus seats", "Seats offered in sections carrying each designation, with how full they got. Click a row to filter by it.");
    var items = D.attrs.map(function (a, i) {
      var bit = 1 << i, seats = 0, taken = 0, sections = 0;
      rows.forEach(function (r) { if (r[5] & bit) { seats += r[2]; taken += r[3]; sections++; } });
      return { key: a, label: a, value: seats, valueText: fmt(seats) + " · " + pct(seats ? taken / seats : null),
        tipTitle: a + " — " + ATTR_LABELS[a],
        tipRows: [{ value: fmt(seats), label: "seats" }, { value: fmt(taken), label: "taken (" + pct(seats ? taken / seats : null) + ")" }, { value: fmt(sections), label: "sections" }],
        tipNote: term.name };
    });
    hBars(c, { items: items, labelW: 48, rowH: 22, onClick: function (it) { setFilter("attr", it.key); } });
  }

  function renderSizes(rows, term) {
    var c = card("Section sizes", "How many sections fall in each capacity range — and how full each range got.", "third");
    var counts = SIZE_BUCKETS.map(function () { return { n: 0, seats: 0, taken: 0 }; });
    rows.forEach(function (r) {
      for (var i = 0; i < SIZE_BUCKETS.length; i++) if (r[2] >= SIZE_BUCKETS[i][0] && r[2] <= SIZE_BUCKETS[i][1]) {
        counts[i].n++; counts[i].seats += r[2]; counts[i].taken += r[3]; break;
      }
    });
    columnChart(c, { labels: SIZE_BUCKETS.map(function (b) { return b[2]; }), values: counts.map(function (x) { return x.n; }),
      name: "sections", tipTitles: SIZE_BUCKETS.map(function (b) { return b[2] + " seats"; }),
      tipNote: function (i) { return pct(counts[i].seats ? counts[i].taken / counts[i].seats : null) + " filled · " + term.name; } });
  }

  function renderBuildings(rows, term) {
    var c = card("Busiest buildings", "In-person sections by building (top 12).", "third");
    var m = {};
    rows.forEach(function (r) { if (r[9]) { var b = m[r[9]] || (m[r[9]] = { n: 0, seats: 0 }); b.n++; b.seats += r[2]; } });
    var items = Object.keys(m).map(function (k) { return { label: D.buildings[k], value: m[k].n, seats: m[k].seats }; })
      .sort(function (a, b) { return b.value - a.value; }).slice(0, 12);
    if (!items.length) { c.appendChild(el("p", "st-empty", "No in-person sections with a building.")); return; }
    items.forEach(function (it) { it.tipRows = [{ value: fmt(it.value), label: "sections" }, { value: fmt(it.seats), label: "seats" }]; it.tipNote = term.name; });
    hBars(c, { items: items, labelW: 64, rowH: 20, name: "sections" });
  }

  function renderAccess(rows, term) {
    var c = card("Who can get in", "Share of sections with an enrollment restriction or a special format.", "third");
    var n = rows.length || 1;
    function share(test) { var k = 0; rows.forEach(function (r) { if (test(r)) k++; }); return k; }
    var items = [
      ["Majors only", function (r) { return r[8] & 8; }],
      ["Instructor approval", function (r) { return r[8] & 2; }],
      ["Dept approval", function (r) { return r[8] & 4; }],
      ["Honors", function (r) { return r[8] & 1; }],
      ["Part of term", function (r) { return r[8] & 16; }],
      ["Online", function (r) { return r[4] === 1; }],
      ["No set time (TBA)", function (r) { return !r[6]; }],
    ].map(function (x) {
      var k = share(x[1]);
      return { label: x[0], value: k / n, valueText: pct(k / n), tipRows: [{ value: fmt(k), label: "of " + fmt(rows.length) + " sections" }], tipNote: term.name };
    });
    hBars(c, { items: items, labelW: 118, rowH: 22, max: 1 });
  }

  function courseLine(ul, ci, stat, note) {
    var li = el("li");
    li.appendChild(el("span", "code", D.codes[ci]));
    li.appendChild(el("span", "title", D.titles[ci]));
    li.appendChild(el("span", "stat", stat));
    if (note) li.title = note;
    li.addEventListener("click", function () { openDrawer(D.codes[ci]); });
    ul.appendChild(li);
  }

  function renderHardest(courses, ft) {
    var c = card("Hardest to get into", "Courses that fill up term after term: 15+ seats a term, offered 2+ terms, with scheduled class times (arranged courses like clinical rotations are left out — they're 'full' by design). Fill across every term it ran.");
    var list = courses.filter(function (co) { return co.timed; }).map(function (co) {
      var ran = co.terms.filter(Boolean), seats = 0, taken = 0, full = 0;
      ran.forEach(function (t) { seats += t.seats; taken += t.taken; if (t.taken >= t.seats * 0.98) full++; });
      return { ci: co.ci, ran: ran.length, seats: seats, fill: seats ? taken / seats : 0, full: full };
    }).filter(function (x) { return x.ran >= 2 && x.seats / x.ran >= 15; })
      .sort(function (a, b) { return b.fill - a.fill || b.full - a.full || b.seats - a.seats; }).slice(0, 15);
    if (!list.length) { c.appendChild(el("p", "st-empty", "Nothing qualifies in this slice.")); return; }
    var ul = el("ul", "st-list"); c.appendChild(ul);
    list.forEach(function (x) { courseLine(ul, x.ci, pct(x.fill) + " · full " + x.full + "/" + x.ran, fmt(x.seats) + " seats across " + x.ran + " terms"); });
  }

  function renderOpenSeats(courses, ft, term) {
    var c = card("Most open seats", "Where there was room in " + term.name + " — seats left unfilled.");
    var list = courses.map(function (co) { var t = co.terms[ft]; return t ? { ci: co.ci, open: t.seats - t.taken, t: t } : null; })
      .filter(function (x) { return x && x.open > 0; }).sort(function (a, b) { return b.open - a.open; }).slice(0, 15);
    if (!list.length) { c.appendChild(el("p", "st-empty", "Every section in this slice was full.")); return; }
    var ul = el("ul", "st-list"); c.appendChild(ul);
    list.forEach(function (x) { courseLine(ul, x.ci, fmt(x.open) + " open of " + fmt(x.t.seats), x.t.sections + " sections"); });
  }

  function renderGrowth(courses, ft, ci, term, cmpTerm) {
    var c = card("Biggest capacity changes", cmpTerm ? "Change in seats offered, " + cmpTerm.name + " → " + term.name + "." : "Pick a comparison term to see changes.");
    if (!cmpTerm) return;
    var diffs = courses.map(function (co) {
      var a = co.terms[ft], b = co.terms[ci];
      return { ci: co.ci, value: (a ? a.seats : 0) - (b ? b.seats : 0), a: a, b: b };
    }).filter(function (x) { return x.value !== 0; });
    var up = diffs.slice().sort(function (a, b) { return b.value - a.value; }).slice(0, 7).filter(function (x) { return x.value > 0; });
    var down = diffs.slice().sort(function (a, b) { return a.value - b.value; }).slice(0, 7).filter(function (x) { return x.value < 0; });
    var items = up.concat(down.reverse()).map(function (x) {
      return { label: D.codes[x.ci], value: x.value, ci: x.ci, tipTitle: D.codes[x.ci] + " — " + D.titles[x.ci],
        tipRows: [{ value: fmt(x.b ? x.b.seats : 0), label: "seats in " + cmpTerm.name }, { value: fmt(x.a ? x.a.seats : 0), label: "seats in " + term.name }] };
    });
    if (!items.length) { c.appendChild(el("p", "st-empty", "No changes in this slice.")); return; }
    divergingBars(c, { items: items, onClick: function (it) { openDrawer(D.codes[it.ci]); } });
  }

  function renderNewGone(courses, ft, ci, term, cmpTerm) {
    var c = card("New and dropped", "New: runs in " + term.name + " and in no earlier captured term. Dropped: ran in " + (cmpTerm ? cmpTerm.name : "the comparison term") + " but not " + term.name + ".");
    var fresh = courses.filter(function (co) { return co.terms[ft] && co.terms.slice(0, ft).every(function (t) { return !t; }); });
    var gone = cmpTerm ? courses.filter(function (co) { return co.terms[ci] && !co.terms[ft]; }) : [];
    function block(title, list, stat) {
      c.appendChild(el("p", "st-sub", title + " (" + list.length + ")"));
      if (!list.length) { c.appendChild(el("p", "st-empty", "None.")); return; }
      var ul = el("ul", "st-list"); c.appendChild(ul);
      list.slice(0, 8).forEach(function (co) { courseLine(ul, co.ci, stat(co)); });
      if (list.length > 8) c.appendChild(el("p", "st-sub", "+" + (list.length - 8) + " more — see the course table."));
    }
    block("New", fresh, function (co) { return fmt(co.terms[ft].seats) + " seats"; });
    if (cmpTerm) block("Dropped", gone, function (co) { return meta.pattern[co.ci].label; });
  }

  function renderPatterns(courses) {
    var c = card("Offering patterns", "Courses in this slice by when they run, across all " + D.terms.length + " captured terms. Click to filter.", "third");
    var counts = {};
    courses.forEach(function (co) { var k = meta.pattern[co.ci].kind; counts[k] = (counts[k] || 0) + 1; });
    var items = Object.keys(PATTERN_LABELS).map(function (k) {
      return { key: k, label: PATTERN_LABELS[k], value: counts[k] || 0, tipNote: "Fall & Spring = every Fall and Spring captured" };
    });
    hBars(c, { items: items, labelW: 96, rowH: 24, name: "courses", onClick: function (it) { setFilter("pattern", S.pattern === it.key ? "ALL" : it.key); } });
  }

  function renderCredits(rows, term) {
    var c = card("Credits per section", "How many credits " + term.name + " sections carry.", "third");
    var m = {};
    rows.forEach(function (r) { var k = String(r[7]); m[k] = (m[k] || 0) + 1; });
    var keys = Object.keys(m).sort(function (a, b) { return (parseFloat(a) || 99) - (parseFloat(b) || 99); }).slice(0, 10);
    columnChart(c, { labels: keys, values: keys.map(function (k) { return m[k]; }), name: "sections",
      tipTitles: keys.map(function (k) { return k + " credit" + (k === "1" ? "" : "s"); }) });
  }

  function renderSubjects(rows, terms, ft, ci, term, cmpTerm) {
    var c = card("Subjects", "Every subject in this slice, " + term.name + ". Click one to filter to it.", "wide");
    var m = {};
    rows.forEach(function (r) {
      var s = meta.subj[r[1]];
      var x = m[s] || (m[s] = { subject: s, perTerm: D.terms.map(function () { return { sections: 0, seats: 0, taken: 0, online: 0 }; }) });
      var t = x.perTerm[r[0]]; t.sections++; t.seats += r[2]; t.taken += r[3]; if (r[4] === 1) t.online++;
    });
    var list = Object.keys(m).map(function (k) {
      var x = m[k], a = x.perTerm[ft], b = ci >= 0 ? x.perTerm[ci] : null;
      return { subject: k, sections: a.sections, seats: a.seats, taken: a.taken, fill: a.seats ? a.taken / a.seats : null,
        online: a.sections ? a.online / a.sections : null, delta: b ? a.seats - b.seats : null, spark: x.perTerm.map(function (t) { return t.seats; }) };
    }).filter(function (x) { return x.sections || x.delta; });
    var st = S.subjSort;
    list.sort(function (a, b) {
      var va = a[st.key], vb = b[st.key];
      if (typeof va === "string") return st.dir * va.localeCompare(vb);
      return st.dir * ((va == null ? -1e9 : va) - (vb == null ? -1e9 : vb));
    });
    var wrap = el("div", "st-table-wrap"); wrap.style.maxHeight = "420px"; wrap.style.overflowY = "auto"; c.appendChild(wrap);
    var t = el("table", "st-table"); wrap.appendChild(t);
    var hr = el("tr"); t.appendChild(hr);
    [["subject", "Subject"], ["sections", "Sections", 1], ["seats", "Seats", 1], ["taken", "Taken", 1], ["fill", "Filled"], ["online", "Online", 1],
     ["delta", cmpTerm ? "Δ seats vs " + shortTerm(cmpTerm) : "Δ seats", 1], [null, "Seats by term"]].forEach(function (h) {
      var th = el("th", h[2] ? "num" : null, h[1]); hr.appendChild(th);
      if (h[0]) sortable(th, st, h[0], render);
    });
    list.forEach(function (x) {
      var tr = el("tr", "clickable");
      tr.appendChild(el("td", "code", x.subject));
      tr.appendChild(el("td", "num", fmt(x.sections)));
      tr.appendChild(el("td", "num", fmt(x.seats)));
      tr.appendChild(el("td", "num", fmt(x.taken)));
      fillCell(tr.appendChild(el("td")), x.fill);
      tr.appendChild(el("td", "num", pct(x.online)));
      tr.appendChild(el("td", "num", x.delta == null ? "–" : signed(x.delta)));
      var sp = el("td"); sp.appendChild(sparkline(x.spark)); tr.appendChild(sp);
      tr.addEventListener("click", function () { setFilter("subject", x.subject); });
      t.appendChild(tr);
    });
  }

  function courseRows(courses, ft, ci) {
    return courses.map(function (co) {
      var a = co.terms[ft], b = ci >= 0 ? co.terms[ci] : null, seats = 0, taken = 0, ran = 0;
      co.terms.forEach(function (t) { if (t) { seats += t.seats; taken += t.taken; ran++; } });
      return {
        ci: co.ci, code: D.codes[co.ci], title: D.titles[co.ci], pattern: meta.pattern[co.ci],
        ran: ran, sections: a ? a.sections : 0, seats: a ? a.seats : 0, taken: a ? a.taken : 0,
        fill: a && a.seats ? a.taken / a.seats : null, avgFill: seats ? taken / seats : null,
        delta: ci >= 0 ? (a ? a.seats : 0) - (b ? b.seats : 0) : null,
        spark: co.terms.map(function (t) { return t ? t.seats : null; }),
      };
    });
  }

  function renderCourses(courses, ft, ci, term, cmpTerm) {
    var c = card("Courses", "Every course in this slice. Seats and fill are for " + term.name + "; avg fill is across every term it ran. Click a row for its full history.", "wide");
    var csvBtn = el("button", "st-link-btn", "Download CSV"); csvBtn.type = "button";
    c.head.appendChild(csvBtn);
    var list = courseRows(courses, ft, ci);
    var st = S.sort;
    list.sort(function (a, b) {
      var va = st.key === "pattern" ? a.pattern.label : a[st.key], vb = st.key === "pattern" ? b.pattern.label : b[st.key];
      if (typeof va === "string") return st.dir * va.localeCompare(vb);
      return st.dir * ((va == null ? -1e9 : va) - (vb == null ? -1e9 : vb)) || a.code.localeCompare(b.code);
    });
    csvBtn.addEventListener("click", function () { downloadCsv(list, term, cmpTerm); });
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (S.page >= pages) S.page = pages - 1;
    var wrap = el("div", "st-table-wrap"); c.appendChild(wrap);
    var t = el("table", "st-table"); wrap.appendChild(t);
    var hr = el("tr"); t.appendChild(hr);
    [["code", "Course"], ["title", "Title"], ["pattern", "Offered"], ["ran", "Terms", 1], ["sections", "Sections", 1], ["seats", "Seats", 1],
     ["fill", "Filled"], ["avgFill", "Avg fill", 1], ["delta", cmpTerm ? "Δ vs " + shortTerm(cmpTerm) : "Δ", 1], [null, "Seats by term"]].forEach(function (h) {
      var th = el("th", h[2] ? "num" : null, h[1]); hr.appendChild(th);
      if (h[0]) sortable(th, st, h[0], function () { S.page = 0; render(); });
    });
    list.slice(S.page * PAGE_SIZE, (S.page + 1) * PAGE_SIZE).forEach(function (x) {
      var tr = el("tr", "clickable" + (x.sections ? "" : " dim"));
      tr.appendChild(el("td", "code", x.code));
      var tt = el("td", "title", x.title); tt.title = x.title; tr.appendChild(tt);
      var pc = el("td"); pc.appendChild(el("span", "st-pill offer-" + x.pattern.kind, x.pattern.label)); tr.appendChild(pc);
      tr.appendChild(el("td", "num", x.ran + "/" + D.terms.length));
      tr.appendChild(el("td", "num", x.sections ? fmt(x.sections) : "–"));
      tr.appendChild(el("td", "num", x.sections ? fmt(x.seats) : "–"));
      fillCell(tr.appendChild(el("td")), x.fill);
      tr.appendChild(el("td", "num", pct(x.avgFill)));
      tr.appendChild(el("td", "num", x.delta == null ? "–" : x.delta ? signed(x.delta) : "0"));
      var sp = el("td"); sp.appendChild(sparkline(x.spark)); tr.appendChild(sp);
      tr.addEventListener("click", function () { openDrawer(x.code); });
      t.appendChild(tr);
    });
    var pager = el("div", "st-pager");
    pager.appendChild(el("span", null, fmt(list.length) + " courses · page " + (S.page + 1) + " of " + pages + " · greyed rows didn't run in " + term.name));
    var btns = el("span");
    var prev = el("button", null, "← Prev"); prev.type = "button"; prev.disabled = S.page === 0;
    var next = el("button", null, "Next →"); next.type = "button"; next.disabled = S.page >= pages - 1;
    prev.addEventListener("click", function () { S.page--; render(); });
    next.addEventListener("click", function () { S.page++; render(); });
    btns.appendChild(prev); btns.appendChild(document.createTextNode(" ")); btns.appendChild(next);
    pager.appendChild(btns);
    c.appendChild(pager);
  }

  function downloadCsv(list, term, cmpTerm) {
    var head = ["course", "title", "offered", "terms_offered", "sections_" + term.key, "seats_" + term.key, "taken_" + term.key, "fill_" + term.key, "avg_fill_all_terms"]
      .concat(cmpTerm ? ["seat_change_vs_" + cmpTerm.key] : []).concat(D.terms.map(function (t) { return "seats_" + t.key; }));
    function q(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var lines = [head.join(",")].concat(list.map(function (x) {
      return [x.code, x.title, x.pattern.label, x.ran, x.sections, x.seats, x.taken,
        x.fill == null ? "" : x.fill.toFixed(3), x.avgFill == null ? "" : x.avgFill.toFixed(3)]
        .concat(cmpTerm ? [x.delta] : []).concat(x.spark.map(function (v) { return v == null ? "" : v; })).map(q).join(",");
    }));
    var blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    var a = el("a"); a.href = URL.createObjectURL(blob); a.download = "star_courses_" + term.key + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function renderCalendar(courses) {
    var c = card("Offering calendar", "Which terms each course ran, shaded by how full it got. Narrow the filters (a subject, a major, a search) to " + CAL_MAX + " or fewer courses to see it.", "wide");
    if (courses.length > CAL_MAX) { c.appendChild(el("p", "st-empty", fmt(courses.length) + " courses in this slice — narrow it down to " + CAL_MAX + " or fewer.")); return; }
    var list = courses.slice().sort(function (a, b) { return D.codes[a.ci].localeCompare(D.codes[b.ci], undefined, { numeric: true }); });
    var wrap = el("div", "st-table-wrap"); c.appendChild(wrap);
    var t = el("table", "st-cal"); wrap.appendChild(t);
    var hr = el("tr"); hr.appendChild(el("th")); t.appendChild(hr);
    D.terms.forEach(function (term) { hr.appendChild(el("th", null, shortTerm(term))); });
    hr.appendChild(el("th", null, "Pattern"));
    list.forEach(function (co) {
      var tr = el("tr");
      var th = el("th", "rowhead", D.codes[co.ci]); th.title = D.titles[co.ci];
      th.addEventListener("click", function () { openDrawer(D.codes[co.ci]); });
      tr.appendChild(th);
      co.terms.forEach(function (x, i) {
        var td = el("td");
        if (!x) { td.className = "off"; td.textContent = "·"; }
        else {
          var fill = x.seats ? x.taken / x.seats : 0;
          td.style.background = seqColor(fill, 1);
          if (seqIsDark(fill, 1)) td.className = "on-dark";
          td.textContent = pct(fill);
          hover(td, function (evt) {
            showTip(evt, D.codes[co.ci] + " · " + D.terms[i].name, [{ value: fmt(x.taken) + " / " + fmt(x.seats), label: "seats taken" }, { value: fmt(x.sections), label: "sections" }]);
          });
        }
        tr.appendChild(td);
      });
      var pc = el("td"); pc.style.width = "auto"; pc.style.textAlign = "left";
      pc.appendChild(el("span", "st-pill offer-" + meta.pattern[co.ci].kind, meta.pattern[co.ci].label));
      tr.appendChild(pc);
      t.appendChild(tr);
    });
    rampLegend(c, "0% filled", "100% filled");
  }

  function renderNotes() {
    var foot = el("div", "st-foot");
    foot.style.gridColumn = "span 12";
    var captured = {};
    D.terms.forEach(function (t) { captured[t.captured] = true; });
    var live = D.terms.filter(function (t) { return t.status === "live"; });
    foot.textContent = "Source: UH STAR class availability, Mānoa, captured " + Object.keys(captured).join(", ") + ". " +
      "Seats taken = capacity minus open seats at capture — final enrollment for terms captured after add/drop closed" +
      (live.length ? " (" + live.map(function (t) { return t.name; }).join(", ") + " is still a live snapshot)" : "") + ". " +
      "Cancelled (zero-seat) sections are left out. EE courses are counted under ECE, the department's current prefix. " +
      "Cross-listed sections appear under each of their codes. STAR's waitlist fields were empty in every term, so there's no waitlist data.";
    content.appendChild(foot);
  }

  // ---------- course drawer ----------
  function openDrawer(code) {
    var ci = D.codes.indexOf(code);
    if (ci < 0) return;
    S.course = code;
    writeHash();
    hideTip();
    drawer.textContent = "";
    var close = el("button", "close", "×"); close.type = "button"; close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeDrawer);
    drawer.appendChild(close);
    drawer.appendChild(el("div", "code", code));
    drawer.appendChild(el("h2", null, D.titles[ci]));
    var m = el("div", "meta");
    var p = meta.pattern[ci];
    m.appendChild(el("span", "st-pill offer-" + p.kind, p.label));
    m.appendChild(el("span", null, "ran " + p.terms + " of " + D.terms.length + " terms"));
    var link = el("a", "st-link-btn", "Open in course graph →");
    link.href = "index.html?course=" + encodeURIComponent(code);
    m.appendChild(link);
    drawer.appendChild(m);
    drawerBack.hidden = false; drawer.hidden = false;
    // Every section of this course, ignoring the page filters -- this is the course's whole story.
    var rows = D.rows.filter(function (r) { return r[1] === ci; });
    var per = byTerm(rows).map(aggregate);

    var c1 = el("section", "st-card"); drawer.appendChild(c1);
    c1.appendChild(el("h3", null, "Seats by term"));
    c1.appendChild(el("p", "st-sub", "Gaps are terms it didn't run."));
    lineChart(c1, { labels: termLabels(), tipTitles: termNames(), height: 200,
      series: [{ name: "Seats offered", color: "var(--viz-1)", values: per.map(function (a) { return a.sections ? a.seats : null; }) },
               { name: "Seats taken", color: "var(--viz-2)", values: per.map(function (a) { return a.sections ? a.taken : null; }) }],
      tipNote: function (i) { return per[i].sections ? per[i].sections + " section" + (per[i].sections === 1 ? "" : "s") + " · " + pct(per[i].fill) + " filled" : "not offered"; } });

    var ran = per.map(function (a, i) { return a.sections ? i : -1; }).filter(function (i) { return i >= 0; });
    var dt = S.drawerTerm != null && per[S.drawerTerm] && per[S.drawerTerm].sections ? S.drawerTerm : ran[ran.length - 1];
    var c2 = el("section", "st-card"); drawer.appendChild(c2);
    var head = el("div", "st-card-head"); c2.appendChild(head);
    head.appendChild(el("h3", null, "Sections"));
    var sel = el("select", "year-select"); sel.setAttribute("aria-label", "Term");
    ran.slice().reverse().forEach(function (i) { var o = el("option", null, D.terms[i].name); o.value = String(i); sel.appendChild(o); });
    sel.value = String(dt);
    sel.addEventListener("change", function () { S.drawerTerm = Number(sel.value); openDrawer(code); });
    head.appendChild(sel);
    var wrap = el("div", "st-table-wrap"); c2.appendChild(wrap);
    var t = el("table", "st-table"); wrap.appendChild(t);
    var hr = el("tr"); t.appendChild(hr);
    ["Seats", "Filled", "Mode", "Meets", "Bldg", "Cr", "Notes"].forEach(function (h, i) { hr.appendChild(el("th", i === 0 ? "num" : null, h)); });
    rows.filter(function (r) { return r[0] === dt; }).sort(function (a, b) { return (a[6] || "~").localeCompare(b[6] || "~"); }).forEach(function (r) {
      var tr = el("tr");
      tr.appendChild(el("td", "num", fmt(r[3]) + "/" + fmt(r[2])));
      fillCell(tr.appendChild(el("td")), r[2] ? r[3] / r[2] : null);
      tr.appendChild(el("td", null, D.modalities[r[4]]));
      tr.appendChild(el("td", null, r[6] ? r[6].split("|").map(prettyMeeting).join("; ") : "TBA"));
      tr.appendChild(el("td", null, D.buildings[r[9]] || "–"));
      tr.appendChild(el("td", null, String(r[7])));
      var notes = [];
      if (r[8] & 8) notes.push("majors only");
      if (r[8] & 2) notes.push("instructor approval");
      if (r[8] & 4) notes.push("dept approval");
      if (r[8] & 1) notes.push("honors");
      if (r[8] & 16) notes.push("part of term");
      D.attrs.forEach(function (a, i) { if (r[5] & (1 << i)) notes.push(a); });
      tr.appendChild(el("td", null, notes.join(", ")));
      t.appendChild(tr);
    });

    var c3 = el("section", "st-card"); drawer.appendChild(c3);
    c3.appendChild(el("h3", null, "Term by term"));
    var t2 = el("table", "st-table"); c3.appendChild(t2);
    var h2 = el("tr"); t2.appendChild(h2);
    ["Term", "Sections", "Seats", "Taken", "Filled", "Online"].forEach(function (h, i) { h2.appendChild(el("th", i && i < 4 ? "num" : null, h)); });
    D.terms.slice().reverse().forEach(function (term, ri) {
      var a = per[D.terms.length - 1 - ri], tr = el("tr", a.sections ? null : "dim");
      tr.appendChild(el("td", null, term.name));
      tr.appendChild(el("td", "num", a.sections ? fmt(a.sections) : "–"));
      tr.appendChild(el("td", "num", a.sections ? fmt(a.seats) : "–"));
      tr.appendChild(el("td", "num", a.sections ? fmt(a.taken) : "–"));
      fillCell(tr.appendChild(el("td")), a.sections ? a.fill : null);
      tr.appendChild(el("td", null, a.sections ? pct(a.online / a.sections) : "–"));
      t2.appendChild(tr);
    });
    drawer.scrollTop = 0;
    close.focus();
  }
  function prettyMeeting(m) {
    var parts = m.split(" "), span = parts[1].split("-");
    function t(hhmm) { var h = parseInt(hhmm.slice(0, 2), 10), mm = hhmm.slice(2); return (h % 12 || 12) + ":" + mm + (h < 12 ? "a" : "p"); }
    return parts[0] + " " + t(span[0]) + "–" + t(span[1]);
  }
  function closeDrawer() {
    drawer.hidden = true; drawerBack.hidden = true; S.course = null; S.drawerTerm = null; writeHash(); hideTip();
  }

  // ---------- boot ----------
  function lensUrl() {
    for (var i = 0; i < PROGRAMS.length; i++) if (PROGRAMS[i].id === "EE") {
      var urls = PROGRAMS[i].urls;
      return urls[CATALOGS[0].id] || urls[Object.keys(urls)[0]];
    }
    return null;
  }
  var lensFetch = lensUrl() ? fetch(lensUrl()).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }) : Promise.resolve(null);
  Promise.all([fetch(DATA_URL).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + DATA_URL);
    return r.json();
  }), lensFetch]).then(function (res) {
    D = res[0];
    meta = prepare(D);
    if (res[1] && res[1].category_by_code) {
      lensByCode = {};
      var cats = res[1].category_by_code;
      Object.keys(cats).forEach(function (code) {
        if (LENS_LABELS[cats[code]]) lensByCode[code.replace(/^EE /, "ECE ")] = cats[code];
      });
    }
    readHash();
    if (S.term == null || !D.terms[S.term]) S.term = D.terms.length - 1;
    build();
  }).catch(function (err) {
    console.error(err);
    root.textContent = "";
    root.appendChild(el("div", "cmp-loading", "Couldn't load the STAR data (" + err.message + ")."));
  });
})();
