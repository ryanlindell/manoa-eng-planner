(function () {
  "use strict";

  // CATALOGS and PROGRAMS come from catalogs.js (loaded before this file).

  // Sub-filter keys, matching build_ee_relevant_courses.py's
  // checksheet_categories() output -- shown as checkboxes once a major
  // whose relevance data actually carries a .categories object with these
  // keys is selected (right now, just "EE"). "eb" exists in that data too
  // but isn't offered here; add a row to MAJOR_SUBCATEGORIES if that's
  // ever wanted.
  var MAJOR_SUBCATEGORIES = [
    { key: "group1", label: "Group I (Major EE)" },
    { key: "group2", label: "Group II (Major EE)" },
    { key: "te", label: "Technical Electives (TE)" },
  ];

  var FOCUS_LABELS = {
    W: "Writing Intensive (W Focus)",
    H: "Hawaiian, Asian & Pacific Issues (H Focus)",
    E: "Contemporary Ethical Issues (E Focus)",
    O: "Oral Communication (O Focus)",
  };

  var state = {
    catalogAId: null,
    catalogBId: null,
    subject: "ALL",
    gened: "ALL",
    focus: "ALL", // "ALL", "ANY" (carries at least one Focus), or one letter
    major: "none",
    majorSub: {}, // subset of MAJOR_SUBCATEGORIES keys currently checked
  };
  var graphCache = {};      // catalogId -> nodes object
  var relevantCache = {};   // "programId:catalogId" -> Set of codes

  function catalogById(id) {
    for (var i = 0; i < CATALOGS.length; i++) if (CATALOGS[i].id === id) return CATALOGS[i];
    return null;
  }
  function programById(id) {
    for (var i = 0; i < PROGRAMS.length; i++) if (PROGRAMS[i].id === id) return PROGRAMS[i];
    return null;
  }

  function fmtCredits(n) {
    if (!n) return "";
    if (n.credits_min == null) return n.credits_raw ? n.credits_raw + " cr" : "";
    if (n.credits_min === n.credits_max) return n.credits_min + " cr";
    return n.credits_min + "–" + n.credits_max + " cr";
  }

  function normalizeTitle(t) {
    return (t || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  // ---------- data loading ----------

  function loadCatalog(id) {
    if (graphCache[id]) return Promise.resolve(graphCache[id]);
    var entry = catalogById(id);
    return fetch(entry.url)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + entry.url);
        return r.json();
      })
      .then(function (graph) {
        graphCache[id] = graph.nodes;
        return graph.nodes;
      });
  }

  // Cached value is the parsed relevance JSON itself (courses + optional
  // per-requirement categories, see build_ee_relevant_courses.py), plus a
  // Set built from .courses attached as .courseSet for fast lookups --
  // not just a bare Set, since the Group I/II/TE sub-filter needs
  // .categories too.
  function loadRelevant(programId, catalogId) {
    var key = programId + ":" + catalogId;
    if (relevantCache[key]) return Promise.resolve(relevantCache[key]);
    var program = programById(programId);
    var url = program && program.urls[catalogId];
    if (!url) return Promise.resolve(null);
    return fetch(url)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url); return r.json(); })
      .then(function (data) {
        data.courseSet = new Set(data.courses);
        relevantCache[key] = data;
        return data;
      });
  }

  // ---------- diffing ----------

  var DIFF_FIELDS = [
    { key: "title", label: "title" },
    { key: "credits_raw", label: "credits" },
    { key: "gened", label: "gen-ed", isArray: true },
    { key: "prereq_raw", label: "prereq" },
    { key: "coreq_raw", label: "coreq" },
    { key: "restrictions_raw", label: "restrictions" },
  ];

  function fieldDiffs(a, b) {
    var diffs = [];
    DIFF_FIELDS.forEach(function (f) {
      var av = a[f.key], bv = b[f.key];
      var same;
      if (f.isArray) {
        var as = (av || []).slice().sort().join(",");
        var bs = (bv || []).slice().sort().join(",");
        same = as === bs;
        av = (av || []).join(", ") || "(none)";
        bv = (bv || []).join(", ") || "(none)";
      } else {
        same = (av || null) === (bv || null);
        av = av || "(none)";
        bv = bv || "(none)";
      }
      if (!same) diffs.push({ label: f.label, from: av, to: bv });
    });
    return diffs;
  }

  function diffCatalogs(nodesA, nodesB) {
    var codesA = Object.keys(nodesA).filter(function (c) { return nodesA[c].in_catalog; });
    var codesB = Object.keys(nodesB).filter(function (c) { return nodesB[c].in_catalog; });
    var setB = new Set(codesB);
    var setA = new Set(codesA);

    var onlyA = codesA.filter(function (c) { return !setB.has(c); });
    var onlyB = codesB.filter(function (c) { return !setA.has(c); });
    var both = codesA.filter(function (c) { return setB.has(c); });

    var changed = [];
    both.forEach(function (code) {
      var diffs = fieldDiffs(nodesA[code], nodesB[code]);
      if (diffs.length) changed.push({ code: code, a: nodesA[code], b: nodesB[code], diffs: diffs });
    });

    // Renumber/rename heuristic: pair an only-in-A course with an
    // only-in-B course when they share an exact normalized title -- a
    // title reused by several courses on either side is genuinely
    // ambiguous (e.g. a generic "Independent Study" in several
    // departments), so those are left as plain new/removed rather than
    // guessed at, UNLESS the course number (everything after the subject
    // prefix, e.g. "422" or "422L") also matches exactly one candidate on
    // each side -- e.g. a title collision between EE 449/EE 644 (an
    // undergrad/grad pair, same title) and ECE 449/ECE 644 would
    // otherwise decline to match either, even though "449 -> 449" and
    // "644 -> 644" is obviously right once the number is considered too.
    // This also naturally catches whole-department prefix renames (e.g.
    // EE -> ECE between the 2023-24 and 2024-25 catalogs, or ACM ->
    // CINE/ACM -> CINE across 2022-2024) without needing a hardcoded
    // alias table, since both the title and the number are preserved
    // across those renames in the source data.
    function courseSuffix(code) { return code.slice(code.indexOf(" ") + 1); }
    var byTitleA = {}, byTitleB = {};
    onlyA.forEach(function (c) {
      var t = normalizeTitle(nodesA[c].title);
      (byTitleA[t] = byTitleA[t] || []).push(c);
    });
    onlyB.forEach(function (c) {
      var t = normalizeTitle(nodesB[c].title);
      (byTitleB[t] = byTitleB[t] || []).push(c);
    });
    var renamed = [];
    var matchedA = new Set(), matchedB = new Set();
    function pairMatch(codeA, codeB) {
      renamed.push({ from: codeA, to: codeB, a: nodesA[codeA], b: nodesB[codeB], diffs: fieldDiffs(nodesA[codeA], nodesB[codeB]) });
      matchedA.add(codeA); matchedB.add(codeB);
    }
    Object.keys(byTitleA).forEach(function (t) {
      if (!t) return; // an empty/untitled match is meaningless
      var groupA = byTitleA[t], groupB = byTitleB[t];
      if (!groupB) return;
      if (groupA.length === 1 && groupB.length === 1) {
        pairMatch(groupA[0], groupB[0]);
        return;
      }
      // Title collision on at least one side -- fall back to also
      // requiring the course number to match exactly one candidate per
      // side within this title group.
      var numA = {}, numB = {};
      groupA.forEach(function (c) { var n = courseSuffix(c); (numA[n] = numA[n] || []).push(c); });
      groupB.forEach(function (c) { var n = courseSuffix(c); (numB[n] = numB[n] || []).push(c); });
      Object.keys(numA).forEach(function (n) {
        var ga = numA[n], gb = numB[n];
        if (ga.length === 1 && gb && gb.length === 1) pairMatch(ga[0], gb[0]);
      });
    });

    var newOnly = onlyB.filter(function (c) { return !matchedB.has(c); });
    var removedOnly = onlyA.filter(function (c) { return !matchedA.has(c); });

    newOnly.sort(); removedOnly.sort();
    changed.sort(function (x, y) { return x.code < y.code ? -1 : x.code > y.code ? 1 : 0; });
    renamed.sort(function (x, y) { return x.from < y.from ? -1 : x.from > y.from ? 1 : 0; });

    return { newOnly: newOnly, removedOnly: removedOnly, changed: changed, renamed: renamed };
  }

  // ---------- filtering ----------

  function relevantData() {
    if (state.major === "none") return null;
    return {
      a: relevantCache[state.major + ":" + state.catalogAId],
      b: relevantCache[state.major + ":" + state.catalogBId],
    };
  }

  // Active sub-filter keys the user has checked, if any.
  function activeSubKeys() {
    return MAJOR_SUBCATEGORIES.map(function (s) { return s.key; }).filter(function (k) { return state.majorSub[k]; });
  }

  // The code set a given side's relevance data contributes: the full
  // "relevant to this major" set with no sub-filter checked, or the union
  // of just the checked categories' codes when at least one is checked.
  function activeCodeSet(data) {
    if (!data) return null;
    var subKeys = activeSubKeys();
    if (!subKeys.length) return data.courseSet;
    var set = new Set();
    subKeys.forEach(function (k) {
      (data.categories && data.categories[k] || []).forEach(function (c) { set.add(c); });
    });
    return set;
  }

  function passesSubject(subjects) {
    if (state.subject === "ALL") return true;
    for (var i = 0; i < subjects.length; i++) if (subjects[i] === state.subject) return true;
    return false;
  }

  function passesGened(genedLists) {
    if (state.gened === "ALL") return true;
    for (var i = 0; i < genedLists.length; i++) {
      if ((genedLists[i] || []).indexOf(state.gened) >= 0) return true;
    }
    return false;
  }

  // Focus (W/H/E/O) isn't catalog data -- it's the "focus" list
  // scripts/build_star_focus.py embeds on each node from STAR's section
  // attributes, the same letters for a course in every catalog year. So it
  // filters and labels rows here, but is never itself a "changed" field.
  function passesFocus(focusLists) {
    if (state.focus === "ALL") return true;
    for (var i = 0; i < focusLists.length; i++) {
      var f = focusLists[i] || [];
      if (state.focus === "ANY" ? f.length : f.indexOf(state.focus) >= 0) return true;
    }
    return false;
  }

  function passesMajor(codes) {
    var rel = relevantData();
    if (!rel) return true;
    var setA = activeCodeSet(rel.a), setB = activeCodeSet(rel.b);
    for (var i = 0; i < codes.length; i++) {
      if ((setA && setA.has(codes[i])) || (setB && setB.has(codes[i]))) return true;
    }
    return false;
  }

  function filterRow(subjects, genedLists, focusLists, codes) {
    return passesSubject(subjects) && passesGened(genedLists) && passesFocus(focusLists) && passesMajor(codes);
  }

  // ---------- rendering ----------

  function courseUrl(code, catalogId) {
    var url = "index.html?course=" + encodeURIComponent(code);
    if (catalogId !== CATALOGS[0].id) url += "&catoid=" + encodeURIComponent(catalogId);
    return url;
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderSimpleRow(code, node, catalogId) {
    var li = el("li", "cmp-row");
    li.appendChild(el("span", "cmp-code", code));
    li.appendChild(el("span", "cmp-title", node.title || "(untitled)"));
    if (node.gened && node.gened.length) li.appendChild(genedBadges(node.gened));
    if (node.focus && node.focus.length) li.appendChild(focusBadges(node.focus));
    li.appendChild(el("span", "cmp-credits cmp-push", fmtCredits(node)));
    var a = el("a", "cmp-link", "view in graph");
    a.href = courseUrl(code, catalogId);
    li.appendChild(a);
    return li;
  }

  // Diffs still include "gen-ed" for the purpose of deciding whether a
  // course counts as changed at all -- this just keeps it out of the
  // plain-text diff list below, since renderGenedBadges (below) shows it
  // instead, as the same colored badges the graph page uses (.badge.gened
  // in styles.css), not another "field: from → to" text line.
  function renderDiffList(diffs) {
    var ul = el("ul", "cmp-diffs");
    diffs.forEach(function (d) {
      if (d.label === "gen-ed") return;
      var li = el("li");
      li.appendChild(el("span", "field", d.label));
      li.appendChild(el("span", "from", d.from));
      li.appendChild(document.createTextNode(" → "));
      li.appendChild(el("span", "to", d.to));
      ul.appendChild(li);
    });
    return ul;
  }

  function genedBadges(tags, extraClass) {
    var span = el("span", "cmp-gened" + (extraClass ? " " + extraClass : ""));
    (tags || []).forEach(function (g) {
      span.appendChild(el("span", "badge gened", g));
    });
    return span;
  }

  // Same .badge.focus the graph page's course details use.
  function focusBadges(letters) {
    var span = el("span", "cmp-gened");
    (letters || []).forEach(function (f) {
      var b = el("span", "badge focus", f);
      b.title = FOCUS_LABELS[f] || f;
      span.appendChild(b);
    });
    return span;
  }
  // A renamed course's two codes can each carry the letters (EE -> ECE), so
  // show whichever side has them, newer first.
  function focusOfEntry(entry) {
    return (entry.b.focus && entry.b.focus.length ? entry.b.focus : entry.a.focus) || [];
  }

  // Always shown for a changed/renamed course, not just when gen-ed is
  // itself one of the diffs -- the point is quick visual context (what
  // gen-ed tags does this course carry right now), the same way the graph
  // page's course detail panel always shows them. Sits inline right after
  // the title, not on its own line -- only switches to the old/new arrow
  // form when the tags actually differ.
  function renderGenedInline(a, b) {
    var sameTags = (a.gened || []).slice().sort().join(",") === (b.gened || []).slice().sort().join(",");
    if (sameTags) return a.gened && a.gened.length ? [genedBadges(a.gened)] : [];
    var parts = [];
    if (a.gened && a.gened.length) parts.push(genedBadges(a.gened, "old"));
    if (parts.length) parts.push(el("span", "cmp-arrow", "→"));
    if (b.gened && b.gened.length) parts.push(genedBadges(b.gened));
    return parts;
  }

  function renderChangedRow(entry, catalogAId, catalogBId) {
    var li = el("li", "cmp-row");
    li.appendChild(el("span", "cmp-code", entry.code));
    li.appendChild(el("span", "cmp-title", entry.b.title || entry.a.title || "(untitled)"));
    renderGenedInline(entry.a, entry.b).forEach(function (n) { li.appendChild(n); });
    if (focusOfEntry(entry).length) li.appendChild(focusBadges(focusOfEntry(entry)));
    var aLink = el("a", "cmp-link cmp-push", "A"); aLink.href = courseUrl(entry.code, catalogAId);
    var bLink = el("a", "cmp-link", "B"); bLink.href = courseUrl(entry.code, catalogBId);
    li.appendChild(aLink); li.appendChild(bLink);
    var textDiffs = entry.diffs.filter(function (d) { return d.label !== "gen-ed"; });
    if (textDiffs.length) li.appendChild(renderDiffList(entry.diffs));
    return li;
  }

  function renderRenamedRow(entry, catalogAId, catalogBId) {
    var li = el("li", "cmp-row");
    li.appendChild(el("span", "cmp-code old", entry.from));
    li.appendChild(el("span", "cmp-arrow", "→"));
    li.appendChild(el("span", "cmp-code", entry.to));
    li.appendChild(el("span", "cmp-title", entry.b.title || "(untitled)"));
    renderGenedInline(entry.a, entry.b).forEach(function (n) { li.appendChild(n); });
    if (focusOfEntry(entry).length) li.appendChild(focusBadges(focusOfEntry(entry)));
    var aLink = el("a", "cmp-link cmp-push", "old"); aLink.href = courseUrl(entry.from, catalogAId);
    var bLink = el("a", "cmp-link", "new"); bLink.href = courseUrl(entry.to, catalogBId);
    li.appendChild(aLink); li.appendChild(bLink);
    var textDiffs = entry.diffs.filter(function (d) { return d.label !== "gen-ed"; });
    if (textDiffs.length) li.appendChild(renderDiffList(entry.diffs));
    return li;
  }

  function setSection(kind, count, listEl, emptyEl) {
    document.getElementById("count-" + kind).textContent = count;
    emptyEl.hidden = count > 0;
  }

  function render(diff, nodesA, nodesB) {
    var labelA = catalogById(state.catalogAId).label;
    var labelB = catalogById(state.catalogBId).label;
    document.getElementById("label-new").textContent = labelB;
    document.getElementById("label-removed").textContent = labelA;

    var newRows = diff.newOnly.filter(function (c) { return filterRow([nodesB[c].subject], [nodesB[c].gened], [nodesB[c].focus], [c]); });
    var removedRows = diff.removedOnly.filter(function (c) { return filterRow([nodesA[c].subject], [nodesA[c].gened], [nodesA[c].focus], [c]); });
    var changedRows = diff.changed.filter(function (e) { return filterRow([e.a.subject, e.b.subject], [e.a.gened, e.b.gened], [e.a.focus, e.b.focus], [e.code]); });
    var renamedRows = diff.renamed.filter(function (e) { return filterRow([e.a.subject, e.b.subject], [e.a.gened, e.b.gened], [e.a.focus, e.b.focus], [e.from, e.to]); });

    var listNew = document.getElementById("list-new"); listNew.innerHTML = "";
    newRows.forEach(function (c) { listNew.appendChild(renderSimpleRow(c, nodesB[c], state.catalogBId)); });
    setSection("new", newRows.length, listNew, document.getElementById("empty-new"));

    var listRemoved = document.getElementById("list-removed"); listRemoved.innerHTML = "";
    removedRows.forEach(function (c) { listRemoved.appendChild(renderSimpleRow(c, nodesA[c], state.catalogAId)); });
    setSection("removed", removedRows.length, listRemoved, document.getElementById("empty-removed"));

    var listRenamed = document.getElementById("list-renamed"); listRenamed.innerHTML = "";
    renamedRows.forEach(function (e) { listRenamed.appendChild(renderRenamedRow(e, state.catalogAId, state.catalogBId)); });
    setSection("renamed", renamedRows.length, listRenamed, document.getElementById("empty-renamed"));

    var listChanged = document.getElementById("list-changed"); listChanged.innerHTML = "";
    changedRows.forEach(function (e) { listChanged.appendChild(renderChangedRow(e, state.catalogAId, state.catalogBId)); });
    setSection("changed", changedRows.length, listChanged, document.getElementById("empty-changed"));

    var summary = document.getElementById("summary");
    summary.innerHTML = "";
    var totalA = Object.keys(nodesA).filter(function (c) { return nodesA[c].in_catalog; }).length;
    var totalB = Object.keys(nodesB).filter(function (c) { return nodesB[c].in_catalog; }).length;
    var s1 = el("span"); s1.appendChild(document.createTextNode(labelA + ": "));
    s1.appendChild(el("strong", null, String(totalA))); s1.appendChild(document.createTextNode(" courses"));
    var s2 = el("span"); s2.appendChild(document.createTextNode(labelB + ": "));
    s2.appendChild(el("strong", null, String(totalB))); s2.appendChild(document.createTextNode(" courses"));
    summary.appendChild(s1); summary.appendChild(s2);
    if (state.catalogAId === state.catalogBId) {
      summary.appendChild(el("span", null, "Same catalog selected for both — nothing to compare."));
    }
    summary.hidden = false;
    document.getElementById("results").hidden = false;
  }

  // ---------- subject list ----------

  function populateSubjects(nodesA, nodesB) {
    var subjects = new Set();
    [nodesA, nodesB].forEach(function (nodes) {
      Object.keys(nodes).forEach(function (c) {
        if (nodes[c].in_catalog) subjects.add(nodes[c].subject);
      });
    });
    var sorted = Array.from(subjects).sort();
    var sel = document.getElementById("subject-filter");
    var prev = sel.value || "ALL";
    sel.innerHTML = "";
    var allOpt = el("option", null, "All subjects"); allOpt.value = "ALL"; sel.appendChild(allOpt);
    sorted.forEach(function (s) {
      var opt = el("option", null, s); opt.value = s; sel.appendChild(opt);
    });
    sel.value = sorted.indexOf(prev) >= 0 || prev === "ALL" ? prev : "ALL";
    state.subject = sel.value;
  }

  // ---------- gen-ed list ----------

  function populateGened(nodesA, nodesB) {
    var tags = new Set();
    [nodesA, nodesB].forEach(function (nodes) {
      Object.keys(nodes).forEach(function (c) {
        if (nodes[c].in_catalog) (nodes[c].gened || []).forEach(function (g) { tags.add(g); });
      });
    });
    var sorted = Array.from(tags).sort();
    var sel = document.getElementById("gened-filter");
    var prev = sel.value || "ALL";
    sel.innerHTML = "";
    var allOpt = el("option", null, "All gen-ed"); allOpt.value = "ALL"; sel.appendChild(allOpt);
    sorted.forEach(function (g) {
      var opt = el("option", null, g); opt.value = g; sel.appendChild(opt);
    });
    sel.value = sorted.indexOf(prev) >= 0 || prev === "ALL" ? prev : "ALL";
    state.gened = sel.value;
  }

  // ---------- focus list ----------

  // Fixed options, unlike the gen-ed list -- there are only ever these four.
  function populateFocus() {
    var sel = document.getElementById("focus-filter");
    [["ALL", "All courses"], ["ANY", "Any Focus"]].concat(Object.keys(FOCUS_LABELS).map(function (f) {
      return [f, f + " — " + FOCUS_LABELS[f].replace(/ \(.*$/, "")];
    })).forEach(function (pair) {
      var opt = el("option", null, pair[1]); opt.value = pair[0]; sel.appendChild(opt);
    });
  }

  // ---------- major availability ----------

  function updateMajorAvailability() {
    var sel = document.getElementById("major-filter");
    Array.prototype.forEach.call(sel.options, function (opt) {
      if (opt.value === "none") { opt.disabled = false; return; }
      var program = programById(opt.value);
      var available = program && program.urls[state.catalogAId] && program.urls[state.catalogBId];
      opt.disabled = !available;
      opt.title = available ? "" : "Not available for one of the selected catalogs -- no relevance data has been built for it yet.";
    });
    if (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].disabled) {
      sel.value = "none";
      state.major = "none";
    }
  }

  // Shows the Group I / Group II / TE checkboxes only once a major is
  // picked AND at least one of the two selected catalogs' relevance data
  // actually has a non-empty .categories entry for one of them -- data
  // built before build_ee_relevant_courses.py grew this field (there
  // shouldn't be any left committed, but a stale local file is possible)
  // just hides the row rather than showing empty/broken checkboxes.
  function updateMajorSubfilter() {
    var container = document.getElementById("major-subfilter");
    if (state.major === "none") {
      container.hidden = true; container.innerHTML = ""; state.majorSub = {};
      return;
    }
    var rel = relevantData();
    function hasCategory(data, key) { return !!(data && data.categories && data.categories[key] && data.categories[key].length); }
    var hasAny = MAJOR_SUBCATEGORIES.some(function (s) { return hasCategory(rel.a, s.key) || hasCategory(rel.b, s.key); });
    if (!hasAny) {
      container.hidden = true; container.innerHTML = ""; state.majorSub = {};
      return;
    }
    container.hidden = false;
    container.innerHTML = "";
    container.appendChild(el("span", "cmp-subfilter-label", "Within " + state.major + ":"));
    MAJOR_SUBCATEGORIES.forEach(function (s) {
      var label = el("label", "cmp-subfilter-opt");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!state.majorSub[s.key];
      cb.addEventListener("change", function () {
        state.majorSub[s.key] = cb.checked;
        refresh();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + s.label));
      container.appendChild(label);
    });
  }

  // ---------- main refresh ----------

  function showToast(message) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { el.classList.remove("show"); }, 4000);
  }

  function refresh() {
    var loadingEl = document.getElementById("cmp-loading");
    loadingEl.hidden = false;
    loadingEl.textContent = "loading catalogs…";
    document.getElementById("results").hidden = true;
    document.getElementById("summary").hidden = true;

    Promise.all([loadCatalog(state.catalogAId), loadCatalog(state.catalogBId)])
      .then(function (results) {
        var nodesA = results[0], nodesB = results[1];
        populateSubjects(nodesA, nodesB);
        populateGened(nodesA, nodesB);
        updateMajorAvailability();

        var majorPromise = state.major === "none"
          ? Promise.resolve()
          : Promise.all([loadRelevant(state.major, state.catalogAId), loadRelevant(state.major, state.catalogBId)]);

        return Promise.resolve(majorPromise).then(function () {
          updateMajorSubfilter();
          var diff = diffCatalogs(nodesA, nodesB);
          loadingEl.hidden = true;
          render(diff, nodesA, nodesB);
        });
      })
      .catch(function (e) {
        loadingEl.hidden = false;
        loadingEl.textContent = "Couldn't load one of the catalogs: " + e.message;
        showToast(String((e && e.message) || e));
      });
  }

  // ---------- init ----------

  function populateCatalogSelect(sel) {
    CATALOGS.forEach(function (c) {
      var opt = el("option", null, c.label); opt.value = c.id; sel.appendChild(opt);
    });
  }

  function populateMajorSelect() {
    var sel = document.getElementById("major-filter");
    var noneOpt = el("option", null, "No filter"); noneOpt.value = "none"; sel.appendChild(noneOpt);
    PROGRAMS.forEach(function (p) {
      var opt = el("option", null, p.label); opt.value = p.id; sel.appendChild(opt);
    });
  }

  function init() {
    var selA = document.getElementById("catalog-a");
    var selB = document.getElementById("catalog-b");
    populateCatalogSelect(selA);
    populateCatalogSelect(selB);
    // Default to the most recent one-year jump -- the smallest, most
    // likely-useful comparison; any other pair (including a wide span like
    // 2020-2026) is one click away.
    state.catalogAId = (CATALOGS[1] || CATALOGS[0]).id;
    state.catalogBId = CATALOGS[0].id;
    selA.value = state.catalogAId;
    selB.value = state.catalogBId;

    populateMajorSelect();
    populateFocus();

    selA.addEventListener("change", function () { state.catalogAId = selA.value; refresh(); });
    selB.addEventListener("change", function () { state.catalogBId = selB.value; refresh(); });
    document.getElementById("btn-swap").addEventListener("click", function () {
      var a = selA.value; selA.value = selB.value; selB.value = a;
      state.catalogAId = selA.value; state.catalogBId = selB.value;
      refresh();
    });
    document.getElementById("subject-filter").addEventListener("change", function (e) {
      state.subject = e.target.value;
      refresh();
    });
    document.getElementById("gened-filter").addEventListener("change", function (e) {
      state.gened = e.target.value;
      refresh();
    });
    document.getElementById("focus-filter").addEventListener("change", function (e) {
      state.focus = e.target.value;
      refresh();
    });
    document.getElementById("major-filter").addEventListener("change", function (e) {
      state.major = e.target.value;
      state.majorSub = {}; // stale checkboxes from a different major wouldn't mean anything here
      refresh();
    });

    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
