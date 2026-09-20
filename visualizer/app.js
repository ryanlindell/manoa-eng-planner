(function () {
  "use strict";

  // Published as an Artifact, files are served relative to index.html
  // itself with no parent to go up to -- a "../" path 404s there even
  // though it's the right relative path for local static-file serving
  // (where visualizer/ and data/ are real sibling folders on disk). Using
  // "data/prereq_graph.json" here (matching the Artifact's published path)
  // means a local copy has to live at visualizer/data/prereq_graph.json too
  // -- see graph.py, which writes both copies together so they can't drift.
  var GRAPH_URL = "data/prereq_graph.json";
  var MAX_PER_COLUMN = 9;

  // expandedMore: keys are "<focal>|unlock", "<focal>|coreq", or
  // "<focal>|prereq|<level>" -- any truncated "+N more" column a viewer has
  // clicked to fully expand for that specific focal course.
  var state = { graph: null, index: null, cy: null, focal: null, expandedMore: {}, history: [], historyIndex: -1, nodePositions: {}, mobile: false, peek: null };

  // Click-vs-double-click disambiguation for graph nodes, done by hand:
  // a single click's toggle re-renders the graph immediately (a new
  // Cytoscape instance replaces the old one), which was destroying the
  // in-progress gesture the browser's own double-click detection relies
  // on right as the second click arrived -- so a real double-click almost
  // never actually registered, making it feel impossible to navigate.
  // Waiting out this short window before acting on a single click keeps
  // both clicks of a real double-click landing on the same still-alive
  // instance.
  var clickTimer = null;
  var CLICK_DELAY_MS = 400;

  function cancelPendingClick() {
    if (clickTimer) { clearTimeout(clickTimer.timeout); clickTimer = null; }
  }

  // ---------- phone / touch mode ----------
  // "Mobile" = a phone-sized viewport, or a touch-first device that isn't
  // desktop-sized (tablets). It sets the `is-mobile` class on <html>, which
  // every phone-specific style in styles.css hangs off, and switches the
  // graph to touch interaction (see renderGraph). Re-evaluated live, so
  // rotating a phone or resizing a window flips modes without a reload.
  var MOBILE_QUERIES = ["(max-width: 720px)", "(pointer: coarse) and (max-width: 1100px)"];
  // A full prereq chain is often 10+ columns wide; "fit everything" on a
  // phone shrinks the text to a few pixels. Start at a zoom where course
  // codes are actually readable and let the viewer pan / pinch instead.
  var MOBILE_ZOOM = 0.7;
  var rootEl = document.documentElement;
  var mobileMqls = window.matchMedia ? MOBILE_QUERIES.map(function (q) { return window.matchMedia(q); }) : [];

  function detectMobile() {
    return mobileMqls.some(function (m) { return m.matches; });
  }
  state.mobile = detectMobile();
  rootEl.classList.toggle("is-mobile", state.mobile);

  // Keeps the search sheet the size and position of what's actually visible.
  // Opening the on-screen keyboard shrinks the *visual* viewport but not the
  // layout one, so a plain full-screen sheet ends up half under the keyboard,
  // and the browser's "scroll the focused input into view" then drags it
  // around -- which is how it used to land on the class list instead of the
  // search box.
  function syncSheetToViewport() {
    var vv = window.visualViewport;
    if (!vv) return;
    rootEl.style.setProperty("--vv-top", vv.offsetTop + "px");
    rootEl.style.setProperty("--vv-h", vv.height + "px");
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncSheetToViewport);
    window.visualViewport.addEventListener("scroll", syncSheetToViewport);
  }

  function openSidebar() {
    var sheet = document.getElementById("sidebar");
    syncSheetToViewport();
    rootEl.classList.add("sidebar-open");
    document.getElementById("open-sidebar").setAttribute("aria-expanded", "true");
    sheet.scrollTop = 0;
    document.getElementById("browse").scrollTop = 0;
    // Must happen inside this tap (iOS won't raise the keyboard otherwise),
    // and preventScroll stops the browser scrolling to the input while the
    // sheet is still sliding in.
    var input = document.getElementById("search");
    input.focus({ preventScroll: true });
    input.select(); // last pick is still in the box; typing should replace it
  }
  function closeSidebar() {
    rootEl.classList.remove("sidebar-open");
    document.getElementById("open-sidebar").setAttribute("aria-expanded", "false");
    document.getElementById("search").blur();
  }
  function setDetailOpen(open) {
    rootEl.classList.toggle("detail-open", open);
    document.getElementById("detail-toggle").setAttribute("aria-expanded", String(open));
  }
  function setLegendOpen(open) {
    rootEl.classList.toggle("legend-open", open);
    document.getElementById("btn-legend").setAttribute("aria-expanded", String(open));
  }

  // Tapping a course on a phone opens this small action bar instead of the
  // desktop click (toggle its prereqs) / double-click (go there) pair --
  // double-tapping is undiscoverable and fights the browser's own gestures.
  function hideNodeActions() {
    state.peek = null;
    document.getElementById("node-actions").hidden = true;
    if (state.cy) state.cy.nodes(".peek").removeClass("peek");
  }
  function showNodeActions(id) {
    var n = state.graph.nodes[id];
    state.peek = id;
    document.querySelector("#node-actions .na-code").textContent = id;
    document.querySelector("#node-actions .na-name").textContent = n ? (n.title || "") : "(not in dataset)";
    var hasPrereqs = computeRequirementUnits(id, "prereq_tree").length > 0;
    var expandBtn = document.getElementById("na-expand");
    expandBtn.hidden = !hasPrereqs;
    expandBtn.textContent = state.expandedMore[state.focal + "|node|" + id] ? "Hide its prereqs" : "Show its prereqs";
    document.getElementById("na-open").hidden = !n;
    state.cy.nodes(".peek").removeClass("peek");
    state.cy.getElementById(id).addClass("peek");
    document.getElementById("node-actions").hidden = false;
  }

  function focusOn(code, animate) {
    var cy = state.cy;
    var n = cy && cy.getElementById(code);
    if (!n || !n.length) return;
    var z = MOBILE_ZOOM, p = n.position();
    // Prereqs extend to the left of the course and required-by courses to
    // the right. When there's nothing on the right, park the course toward
    // the right edge so its prereq column isn't cropped by the screen edge.
    var rightSpan = (cy.elements().boundingBox().x2 - p.x) * z;
    var view = { zoom: z, pan: { x: cy.width() * (rightSpan < 60 ? 0.7 : 0.5) - p.x * z, y: cy.height() / 2 - p.y * z } };
    if (animate) cy.animate(view, { duration: 250 });
    else { cy.zoom(z); cy.pan(view.pan); }
  }
  function fitAll(animate) {
    var cy = state.cy;
    if (!cy) return;
    if (animate) cy.animate({ fit: { eles: cy.elements(), padding: 24 } }, { duration: 250 });
    else cy.fit(undefined, 24);
  }
  // Opening view of a freshly navigated course.
  function setInitialView(focal) {
    if (!state.mobile) { state.cy.fit(undefined, 40); return; }
    fitAll(false);
    var fitZoom = state.cy.zoom();
    if (fitZoom < MOBILE_ZOOM) focusOn(focal, false);
    else if (fitZoom > 1.3) { state.cy.zoom(1.3); state.cy.center(); } // a 2-node graph shouldn't be blown up to fill the screen
  }

  document.getElementById("open-sidebar").addEventListener("click", openSidebar);
  document.getElementById("close-sidebar").addEventListener("click", closeSidebar);
  document.getElementById("detail-toggle").addEventListener("click", function () { setDetailOpen(!rootEl.classList.contains("detail-open")); });
  document.getElementById("btn-legend").addEventListener("click", function () { setLegendOpen(!rootEl.classList.contains("legend-open")); });
  document.getElementById("btn-focus").addEventListener("click", function () { if (state.focal) focusOn(state.focal, true); });
  document.getElementById("btn-fit").addEventListener("click", function () { fitAll(true); });
  document.getElementById("na-expand").addEventListener("click", function () {
    if (!state.peek) return;
    var id = state.peek;
    var key = state.focal + "|node|" + id;
    state.expandedMore[key] = !state.expandedMore[key];
    var expanding = state.expandedMore[key];
    renderGraph(state.focal, { preserveViewport: true });
    // The new prereq columns grow off to the left of the course, which is
    // usually off-screen already -- slide the view so they're visible, or
    // it looks like nothing happened.
    if (expanding) {
      var cy = state.cy, rp = cy.getElementById(id).renderedPosition();
      cy.animate({ panBy: { x: cy.width() * 0.72 - rp.x, y: cy.height() / 2 - rp.y } }, { duration: 300 });
    }
  });
  document.getElementById("na-open").addEventListener("click", function () {
    var id = state.peek;
    hideNodeActions();
    if (id) select(id);
  });
  window.addEventListener("keydown", function (evt) {
    if (evt.key !== "Escape") return;
    closeSidebar(); setLegendOpen(false); hideNodeActions();
  });

  // The graph container resizes when the details sheet opens or the phone
  // rotates; Cytoscape doesn't notice a container resize on its own.
  if (window.ResizeObserver) {
    new ResizeObserver(function () { if (state.cy) state.cy.resize(); }).observe(document.getElementById("cy"));
  }

  function onDeviceModeChange() {
    var now = detectMobile();
    if (now === state.mobile) return;
    state.mobile = now;
    rootEl.classList.toggle("is-mobile", now);
    closeSidebar(); setLegendOpen(false); setDetailOpen(false);
    // Node sizing, dragging and the opening view all differ by mode, so
    // rebuild the graph rather than patching the live instance.
    if (state.focal) renderGraph(state.focal);
  }
  mobileMqls.forEach(function (m) {
    if (m.addEventListener) m.addEventListener("change", onDeviceModeChange);
    else if (m.addListener) m.addListener(onDeviceModeChange);
  });

  fetch(GRAPH_URL)
    .then(function (r) {
      if (!r.ok) {
        throw new Error("HTTP " + r.status + " fetching " + GRAPH_URL);
      }
      return r.json();
    })
    .then(function (graph) {
      state.graph = graph;
      state.index = buildIndex(graph);
      // Not .hidden = true: #loading has its own "display: flex" rule (an
      // ID selector), which beats the browser's default (non-!important)
      // "[hidden] { display: none }" UA rule on plain specificity. The
      // published Artifact papers over this with an auto-injected
      // "[hidden]{display:none!important}" reset, which is exactly why this
      // worked there but not when the file is served standalone locally.
      // An inline style always wins, everywhere, regardless of context.
      document.getElementById("loading").style.display = "none";
      buildHighlights(graph, state.index);
      // Open on a genuinely deep, real course rather than an empty shell.
      var opener = pickOpener(graph);
      select(opener);
    })
    .catch(function (err) {
      console.error(err);
      document.getElementById("loading").textContent =
        "Couldn't load " + GRAPH_URL + ": " + err.message +
        ". If you're viewing this from disk (a file:// URL), browsers block " +
        "loading local JSON that way -- serve this repo with a static server " +
        "(e.g. `python -m http.server` from the repo root) and open " +
        "/visualizer/index.html instead.";
    });

  // Flat prereqOf/unlocks maps -- used for simple counts (search-adjacent
  // "most direct prereqs"/"most far-reaching" highlights, the ungrouped
  // unlocks column) where AND/OR structure doesn't matter, only "is there a
  // relationship at all". The ancestor-chain and coreq rendering use the
  // real prereq_tree/coreq_tree via computeRequirementUnits instead, since
  // grouping *does* matter there.
  function buildIndex(graph) {
    var byCode = graph.nodes;
    var prereqOf = {};   // code -> [codes required BY code]
    var unlocks = {};    // code -> [codes that require code directly]
    Object.keys(byCode).forEach(function (c) { prereqOf[c] = []; unlocks[c] = []; });
    graph.edges.forEach(function (e) {
      if (e.type !== "prereq") return;
      if (!(e.from in prereqOf)) prereqOf[e.from] = [];
      if (!(e.to in prereqOf)) prereqOf[e.to] = [];
      if (!(e.from in unlocks)) unlocks[e.from] = [];
      if (!(e.to in unlocks)) unlocks[e.to] = [];
      prereqOf[e.to].push(e.from);   // e.to requires e.from
      unlocks[e.from].push(e.to);    // e.from unlocks e.to
    });
    return { prereqOf: prereqOf, unlocks: unlocks };
  }

  function pickOpener(graph) {
    var best = null, bestDepth = -1;
    Object.keys(graph.nodes).forEach(function (c) {
      var n = graph.nodes[c];
      if (n.in_catalog && typeof n.depth === "number" && n.depth > bestDepth) { bestDepth = n.depth; best = c; }
    });
    return best;
  }

  // ---------- highlights ----------
  function buildHighlights(graph, index) {
    var nodes = graph.nodes;
    var codes = Object.keys(nodes).filter(function (c) { return nodes[c].in_catalog; });

    var deepest = codes.filter(function (c) { return typeof nodes[c].depth === "number"; })
      .sort(function (a, b) { return nodes[b].depth - nodes[a].depth; }).slice(0, 12)
      .map(function (c) { return { code: c, value: nodes[c].depth + (nodes[c].depth === 1 ? " semester deep" : " semesters deep") }; });

    // Requirement UNITS, not flat edges -- "A or B or C" is one choice, not
    // three separate prereqs. index.prereqOf[c].length (used pre-fix) counts
    // every OR alternative as its own prereq, so a course like HWST 491 with
    // three "pick one of several" groups showed as "17 direct prereqs"
    // instead of the ~5 actual requirements (2 required courses + 3 groups).
    var mostPrereqs = codes.map(function (c) { return { code: c, n: computeRequirementUnits(c, "prereq_tree").length }; })
      .filter(function (x) { return x.n > 0; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 12)
      .map(function (x) { return { code: x.code, value: x.n + " direct prereqs" }; });

    var mostUnlocks = codes.map(function (c) { return { code: c, n: index.unlocks[c].length }; })
      .filter(function (x) { return x.n > 0; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 12)
      .map(function (x) { return { code: x.code, value: "required by " + x.n } ; });

    var cyclic = codes.filter(function (c) { return nodes[c].depth_status === "cycle"; })
      .sort().map(function (c) { return { code: c, value: "circular" }; });

    var tabs = [
      { id: "deepest", label: "Deepest chains", items: deepest },
      { id: "prereqs", label: "Most direct prereqs", items: mostPrereqs },
      { id: "unlocks", label: "Most far-reaching", items: mostUnlocks },
      { id: "cycles", label: "Circular (" + cyclic.length + ")", items: cyclic }
    ];

    var tabsEl = document.getElementById("tabs");
    var panesEl = document.getElementById("highlight-panes");
    tabs.forEach(function (tab, i) {
      var btn = document.createElement("button");
      btn.textContent = tab.label; btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", i === 0 ? "true" : "false");
      btn.addEventListener("click", function () {
        tabsEl.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-selected", "false"); });
        panesEl.querySelectorAll(".highlight-pane").forEach(function (p) { p.hidden = true; });
        btn.setAttribute("aria-selected", "true");
        document.getElementById("pane-" + tab.id).hidden = false;
      });
      tabsEl.appendChild(btn);

      var pane = document.createElement("div");
      pane.className = "highlight-pane"; pane.id = "pane-" + tab.id; pane.hidden = i !== 0;
      var ul = document.createElement("ul"); ul.className = "rank-list";
      if (tab.items.length === 0) {
        var li0 = document.createElement("li"); li0.style.padding = "8px 4px"; li0.style.color = "var(--ink-muted)";
        li0.textContent = "none found"; ul.appendChild(li0);
      }
      tab.items.forEach(function (item) {
        var li = document.createElement("li");
        var b = document.createElement("button");
        var codeSpan = document.createElement("span"); codeSpan.className = "code"; codeSpan.textContent = item.code;
        var titleSpan = document.createElement("span"); titleSpan.className = "title"; titleSpan.textContent = nodes[item.code] ? nodes[item.code].title || "" : "";
        var valueSpan = document.createElement("span"); valueSpan.className = "value"; valueSpan.textContent = item.value;
        b.appendChild(codeSpan); b.appendChild(titleSpan); b.appendChild(valueSpan);
        b.addEventListener("click", function () { select(item.code); });
        li.appendChild(b); ul.appendChild(li);
      });
      pane.appendChild(ul);
      panesEl.appendChild(pane);
    });
  }

  // ---------- search ----------
  var searchInput = document.getElementById("search");
  var resultsEl = document.getElementById("search-results");
  // On a phone the results replace "worth a look" while they're showing
  // (styles.css keys off .has-results), so every show/hide goes through here.
  function setResultsVisible(visible) {
    resultsEl.hidden = !visible;
    document.getElementById("sidebar").classList.toggle("has-results", visible);
  }
  searchInput.addEventListener("input", function () {
    var q = searchInput.value.trim().toLowerCase();
    resultsEl.innerHTML = "";
    if (!q || !state.graph) { setResultsVisible(false); return; }
    var nodes = state.graph.nodes;
    var matches = Object.keys(nodes).filter(function (c) {
      return nodes[c].in_catalog && (c.toLowerCase().indexOf(q) !== -1 || (nodes[c].title || "").toLowerCase().indexOf(q) !== -1);
    }).slice(0, 8);
    if (matches.length === 0) {
      // A phone has no room to leave people guessing why nothing appeared.
      if (state.mobile) {
        var none = document.createElement("div"); none.className = "no-results";
        none.textContent = "No courses match “" + searchInput.value.trim() + "”";
        resultsEl.appendChild(none);
        setResultsVisible(true);
      } else setResultsVisible(false);
      return;
    }
    matches.forEach(function (c) {
      var b = document.createElement("button");
      var codeSpan = document.createElement("span"); codeSpan.className = "code"; codeSpan.textContent = c + " ";
      var rest = document.createTextNode(nodes[c].title || "");
      b.appendChild(codeSpan); b.appendChild(rest);
      b.addEventListener("click", function () { select(c); setResultsVisible(false); searchInput.value = c; });
      resultsEl.appendChild(b);
    });
    setResultsVisible(true);
  });
  // Enter (the keyboard's "Search" key on a phone) jumps to the top match.
  searchInput.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var first = resultsEl.querySelector("button");
    if (first) { e.preventDefault(); first.click(); }
  });
  document.addEventListener("click", function (e) {
    if (!resultsEl.contains(e.target) && e.target !== searchInput) setResultsVisible(false);
  });

  // ---------- graph rendering ----------
  function tokens() {
    var s = getComputedStyle(document.documentElement);
    function v(name) { return s.getPropertyValue(name).trim(); }
    return {
      ink: v("--ink"), ink2: v("--ink-2"), surface: v("--surface"), hairline: v("--hairline"),
      accent: v("--accent"), accentInk: v("--accent-ink"),
      edgePrereq: v("--edge-prereq"), edgeCoreq: v("--edge-coreq"),
      critical: v("--status-critical"), warning: v("--status-warning"),
      depth: [v("--depth-0"), v("--depth-1"), v("--depth-2"), v("--depth-3"), v("--depth-4"), v("--depth-5"), v("--depth-6"), v("--depth-7")]
    };
  }

  function depthColor(t, depth, inCatalog) {
    // External/dangling refs get a cached depth of 0 as a side effect of
    // dependency resolution (see graph.py's compute_depths) -- that's not a
    // real "0 prereqs deep" claim, so they stay unshaded regardless.
    if (!inCatalog || typeof depth !== "number") return t.surface;
    var i = Math.max(0, Math.min(t.depth.length - 1, depth));
    return t.depth[i];
  }

  // Renders a course without touching the visit history -- used both by
  // select() below (after it records the visit) and by back/forward, which
  // must move through history without appending a new detour into it.
  function goTo(code) {
    var nodes = state.graph.nodes;
    if (!nodes[code]) return;
    cancelPendingClick();
    state.focal = code;
    renderDetail(code);
    renderGraph(code);
    updateNavButtons();
    // Land back on the graph: a phone has no room to keep the search sheet
    // or the details sheet open over the course you just navigated to.
    closeSidebar();
    setLegendOpen(false);
    if (state.mobile) setDetailOpen(false);
  }

  // A fresh navigation (search, click, graph tap): truncates any forward
  // history past the current point -- same convention as a browser tab --
  // so a back-back-click-forward sequence can't "forward" into a course you
  // never actually visited after that click.
  function select(code) {
    if (!state.graph.nodes[code]) return;
    if (state.history[state.historyIndex] !== code) {
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(code);
      state.historyIndex = state.history.length - 1;
    }
    goTo(code);
  }

  function navigateHistory(delta) {
    var i = state.historyIndex + delta;
    if (i < 0 || i >= state.history.length) return;
    state.historyIndex = i;
    goTo(state.history[i]);
  }

  function updateNavButtons() {
    var backBtn = document.getElementById("nav-back");
    var fwdBtn = document.getElementById("nav-forward");
    backBtn.disabled = state.historyIndex <= 0;
    fwdBtn.disabled = state.historyIndex >= state.history.length - 1;
  }

  function capped(list) {
    var shown = list.slice(0, MAX_PER_COLUMN);
    var extra = list.length - shown.length;
    return { shown: shown, extra: extra };
  }

  var ANCESTOR_CAP = 200;       // total safety cap (worst real case in the catalog is 42)
  var MAX_UNITS_PER_LEVEL = 10;

  function mentionsCourse(node) {
    if (node.course) return true;
    if (node.children) return node.children.some(mentionsCourse);
    return false;
  }

  function collectAllCourseLeaves(node) {
    if (node.course) return [node.course];
    if (node.children) {
      var out = [];
      node.children.forEach(function (c) { out = out.concat(collectAllCourseLeaves(c)); });
      return out;
    }
    return [];
  }

  // Reduces a course's prereq_tree (or coreq_tree) to a flat list of
  // "requirement units": each unit is either a single required course, or a
  // real group of alternatives (only one -- or N, for N_OF -- actually
  // needed), so the graph can draw one clumped node + one arrow for a group
  // instead of a separate node+arrow per alternative implying all of them
  // are required. See the escape-hatch handling inside for why this isn't
  // just "flatten every OR/N_OF subtree".
  function computeRequirementUnits(code, treeField) {
    var n = state.graph.nodes[code];
    if (!n || !n[treeField]) return [];
    var units = [];
    function walk(node) {
      if (node.course) {
        units.push({ type: "single", codes: [node.course] });
        return;
      }
      if (node.type) {
        return; // consent/standing/major_restriction/unparsed -- not a course
      }
      if (node.op === "AND") {
        (node.children || []).forEach(walk);
        return;
      }
      if (node.op === "OR" || node.op === "N_OF") {
        // "X and either Y or Z; or consent" is OR[AND(X, OR(Y,Z)), consent]
        // at the top -- naively flattening every course under an OR into
        // one group would wrongly clump X in with Y/Z (found via ECE 342
        // showing "pick 1 of {ECE 315, MATH 244, MATH 253A}" when only the
        // MATH pair are real alternatives). "or consent" is a pure escape
        // hatch, not a real alternative course path, so when exactly one
        // child actually mentions a course, that child IS the real
        // requirement -- recurse into it directly instead of grouping.
        var children = node.children || [];
        var courseBearing = children.filter(mentionsCourse);
        if (courseBearing.length === 0) return;
        if (courseBearing.length === 1) {
          walk(courseBearing[0]);
          return;
        }
        // Multiple genuine alternative paths -- clump them into one "pick
        // one/N" group. When every alternative is a plain course (the
        // common case, "MATH 244 or MATH 253A") the group is exact. When
        // some alternative is itself a whole subtree -- usually a
        // comma-list precedence artifact from Stage 4 (e.g. BIOL 171's
        // "(A, B, C, D, or E) or concurrent" mis-nests as OR[AND(A,B,C,D),
        // E] -- flatten to that subtree's full course set rather than
        // walking it as if separately required: that would claim you need
        // ALL of A-D, which is worse than the imprecision of over-grouping.
        var codes = [];
        courseBearing.forEach(function (c) {
          if (c.course) { codes.push(c.course); return; }
          codes = codes.concat(collectAllCourseLeaves(c));
        });
        codes = codes.filter(function (c, i, arr) { return arr.indexOf(c) === i; });
        if (codes.length) {
          units.push({ type: node.op === "N_OF" ? "nof" : "group", n: node.n, codes: codes });
        }
      }
    }
    walk(n[treeField]);
    return units;
  }

  // The *entire* prerequisite chain, not just one hop -- a language sequence
  // like KOR 101 -> 102 -> ... -> 496 should render as the full series of
  // courses, not just KOR 496's immediate prereq. BFS backward through
  // prereq requirement units (not the flat edge list, which can't tell a
  // real alternative-group apart from separately-required courses), one
  // column per hop-distance from the focal course.
  // (Unlocks go the other way and are NOT expanded like this -- a foundational
  // course like MATH 161 transitively unlocks 900+ courses, so that side
  // stays immediate-neighbors-only; see idx.unlocks usage below.)
  function computeAncestorChain(focal) {
    var level = {};
    level[focal] = 0;
    var levelUnits = {};
    var frontier = [focal];
    var lvl = 0;
    var truncated = false;
    var placedCount = 1;

    while (frontier.length && placedCount < ANCESTOR_CAP) {
      lvl++;
      var next = [];
      var unitsThisLevel = [];
      frontier.forEach(function (targetCode) {
        computeRequirementUnits(targetCode, "prereq_tree").forEach(function (unit) {
          // Already satisfied via a path reached at an earlier/other level
          // -- skip rather than draw a duplicate or a partial group.
          var alreadyPlaced = unit.codes.some(function (c) { return c in level; });
          if (alreadyPlaced) return;
          if (placedCount + unit.codes.length > ANCESTOR_CAP) { truncated = true; return; }
          // A real alternative group ("pick one of these") only needs ONE
          // path continued backward -- expanding every alternative's own
          // chain by default buries the single path you'll actually take
          // under however many others you won't. All alternatives still
          // get drawn at this level either way; only whether their OWN
          // prereqs cascade into the next level is gated. altKey is a
          // content-derived (not render-order-derived) id so it survives
          // a re-render even as other expansions shift things around.
          var altKey = null;
          if (unit.codes.length > 1) {
            var othersHaveDeeper = unit.codes.slice(1).some(function (c) {
              return computeRequirementUnits(c, "prereq_tree").length > 0;
            });
            if (othersHaveDeeper) altKey = focal + "|alt|" + targetCode + "|" + unit.codes.join(",");
          }
          var expanded = !altKey || state.expandedMore[altKey];
          unit.codes.forEach(function (c, i) {
            level[c] = lvl;
            placedCount++;
            if (i === 0 || expanded) next.push(c);
          });
          unitsThisLevel.push({ type: unit.type, n: unit.n, codes: unit.codes.slice(), target: targetCode, altKey: altKey });
        });
      });
      levelUnits[lvl] = unitsThisLevel;
      frontier = next;
    }

    var realMaxLevel = 0;
    Object.keys(levelUnits).forEach(function (l) { if (levelUnits[l].length) realMaxLevel = Math.max(realMaxLevel, Number(l)); });
    return { levelUnits: levelUnits, maxLevel: realMaxLevel, allCodes: Object.keys(level), truncated: truncated };
  }

  // A plain node's nominal style "height" (below) is 34, but Cytoscape's
  // "padding" visibly inflates the painted shape by 2x its value (it's not
  // just an invisible hit-box), and every node also gets a 1-2px border --
  // the real rendered height is consistently ~57-58px, confirmed by
  // directly inspecting boundingBox() on real Cytoscape instances across
  // many real courses. ROW_H matches that measured reality, not the
  // nominal style value.
  //
  // A previous version of this tried to correct positions post-hoc by
  // reading each node's real boundingBox() back from Cytoscape after
  // construction. That measurement was reliable for plain leaf nodes, but
  // NOT for a compound parent's own boundingBox(): it sometimes reported a
  // stale pre-move size, and its "extra" size over its members' span
  // varied wildly with member count (10px for a 10-member group vs ~38px
  // for a 2-member one on real data, which shouldn't happen since a
  // label's height doesn't scale with how many members it has). Rather
  // than chase that further, GROUP_CHROME below is a fixed, verified
  // allowance for that same padding+label overhead, computed once up
  // front like everything else -- no post-render measurement or
  // correction pass needed at all.
  var ROW_H = 58, INTRA_GROUP_GAP = 10, UNIT_GAP = 24;
  var GROUP_CHROME = 40;  // extra room reserved above/below a group's member stack for its own padding + top label

  // Matches the "width" style function below exactly, so a group's grid
  // packing (next) reserves the real space each member will actually take.
  // Phone mode uses a slightly larger font (see FONT in renderGraph), so its
  // per-character allowance is wider too.
  function nodeWidthEstimate(label) {
    return Math.max(50, String(label || "").length * (state.mobile ? 9 : 8) + 24);
  }

  // Packs a group's member courses into whichever grid (rows x cols) gives
  // the smallest bounding-box AREA, rather than always stacking them in
  // one tall column -- a "pick 1 of 6" group used to be a narrow 6-row
  // tower; this tries every column count from 1 to N and keeps whichever
  // is most square-ish for that many members, with no member touching the
  // next (INTRA_GROUP_GAP still separates every cell). Cached on the unit
  // itself since both unitHeight and the actual layout below need it and
  // it's the same answer both times.
  function groupPacking(u) {
    if (u._grid) return u._grid;
    var cellW = 0;
    u.codes.forEach(function (code) { cellW = Math.max(cellW, nodeWidthEstimate(code)); });
    var n = u.codes.length;
    var best = null;
    for (var cols = 1; cols <= n; cols++) {
      var rows = Math.ceil(n / cols);
      var w = cols * cellW + (cols - 1) * INTRA_GROUP_GAP;
      var h = rows * ROW_H + (rows - 1) * INTRA_GROUP_GAP;
      var area = w * h;
      // Minimizing raw area alone has a degenerate case: for a count with
      // few small factors (e.g. 11), a single flat row wastes zero grid
      // cells and can win on area despite being absurdly elongated (a
      // 1068x98 strip, confirmed on an 11-member group) -- not remotely
      // "the square formed by the dashed box" that was asked for. Scoring
      // by the side of the smallest *enclosing square* instead reliably
      // prefers the near-sqrt(n) layout; area only breaks a tie between
      // two options with the same square side.
      var squareSide = Math.max(w, h);
      if (!best || squareSide < best.squareSide || (squareSide === best.squareSide && area < best.area)) {
        best = { cols: cols, rows: rows, w: w, h: h, cellW: cellW, area: area, squareSide: squareSide };
      }
    }
    u._grid = best;
    return best;
  }

  function unitHeight(u) {
    if (u.type === "single") return ROW_H;
    return groupPacking(u).h + GROUP_CHROME;
  }

  // ---------- physics ----------
  // A small, self-contained force simulation layered on top of the
  // deterministic column layout below: renderGraph still computes a
  // "home" x for every node with the exact same math as always (prereq
  // depth to the left, unlocks to the right, one column per level), but
  // instead of pinning nodes there, this nudges them into an organic
  // arrangement -- repelling each other like like charges, pulled
  // together along real edges, and only weakly drawn back toward their
  // home column on the x axis (y is entirely free) so "closer to
  // 100-level on the left, more depth on the right" still holds without
  // every node being rigidly stacked in fixed rows.
  var PHYSICS = {
    repulsion: 9000,     // pairwise push, ~k / distance^2
    minDistance: 40,     // repulsion is capped below this so it can't blow up near distance 0
    springEdge: 0.012,   // pulls courses connected by a real edge toward edgeLength apart
    edgeLength: 150,
    springHomeX: 0.012,  // pull back toward the depth column's x
    // A long stack of mutually-repelling nodes with *no* y restoring force
    // at all has no real equilibrium to settle into -- each pushes the
    // next a little further out forever, so the whole column just spreads
    // apart in slow motion and the sim never actually comes to rest (this
    // was confirmed: individual nodes drifted tens of px/sec indefinitely,
    // not oscillating, genuinely never converging). A pull this much
    // weaker than the x one still lets nodes wander well off their
    // original row -- it only stops that wander from being unbounded.
    springHomeY: 0.004,
    damping: 0.8,
    settleEnergy: 0.6,    // total |velocity| below this pauses the sim until something wakes it
    groupRepulsion: 9000, // same strength as a regular node's push, but from the whole box's edge, not its center
    groupPad: 20           // extra clearance beyond the box's own drawn border
  };
  var physics = { bodies: {}, edges: [], groups: [], running: false, rafId: null };

  // (Re)builds the physics bodies from whatever's currently in state.cy --
  // called after every render. A body that already existed (by course
  // code) keeps its live velocity, so a redraw triggered by expanding or
  // collapsing a node doesn't reset the motion of everything already on
  // screen, only seeds newly-added bodies fresh.
  function physicsBuild() {
    var cy = state.cy;
    var bodies = {};
    cy.nodes().forEach(function (n) {
      if (n.data("isGroup")) return; // compound boxes follow their children automatically
      var id = n.id();
      var pos = n.position();
      var prev = physics.bodies[id];
      var homeX = n.data("homeX");
      var homeY = n.data("homeY");
      bodies[id] = {
        x: pos.x, y: pos.y,
        vx: prev ? prev.vx : 0, vy: prev ? prev.vy : 0,
        homeX: typeof homeX === "number" ? homeX : pos.x,
        homeY: typeof homeY === "number" ? homeY : pos.y,
        grabbed: false,
        fixed: !!n.data("focal")
      };
    });
    physics.bodies = bodies;

    // A group's own edge (its dashed "pick one of N" box -> its target)
    // has no body of its own to pull -- redirect it to pull each of the
    // group's real member courses instead, so the box still drifts toward
    // whatever it actually requires instead of just floating on
    // repulsion alone.
    var edges = [];
    cy.edges().forEach(function (e) {
      var srcNode = e.source(), tgtNode = e.target();
      var srcIds = srcNode.data("isGroup") ? srcNode.children().map(function (c) { return c.id(); }) : [srcNode.id()];
      var tgtIds = tgtNode.data("isGroup") ? tgtNode.children().map(function (c) { return c.id(); }) : [tgtNode.id()];
      srcIds.forEach(function (a) {
        tgtIds.forEach(function (b) {
          if (bodies[a] && bodies[b]) edges.push([a, b]);
        });
      });
    });
    physics.edges = edges;

    // Every group's whole box (not just its individual member courses)
    // repels other nodes too, approximated as a circle around the box's
    // member centroid sized to its half-diagonal -- a conservative but
    // simple stand-in for true rectangle-vs-point collision, so nothing
    // outside the group ever has to actually touch its dashed border to
    // get pushed away.
    var groups = [];
    cy.nodes('[?isGroup]').forEach(function (g) {
      var memberIds = g.children().map(function (c) { return c.id(); });
      if (!memberIds.length) return;
      var w = (g.data("boxWidth") || 100) + PHYSICS.groupPad * 2;
      var h = (g.data("boxHeight") || 60) + PHYSICS.groupPad * 2;
      groups.push({ memberIds: memberIds, radius: Math.sqrt(w * w + h * h) / 2 });
    });
    physics.groups = groups;

    physicsWake();
  }

  function physicsWake() {
    if (physics.running) return;
    physics.running = true;
    physics.rafId = requestAnimationFrame(physicsTick);
  }

  function physicsTick() {
    var bodies = physics.bodies;
    var ids = Object.keys(bodies);
    var forces = {};
    ids.forEach(function (id) { forces[id] = { x: 0, y: 0 }; });

    for (var i = 0; i < ids.length; i++) {
      var a = bodies[ids[i]];
      for (var j = i + 1; j < ids.length; j++) {
        var b = bodies[ids[j]];
        var dx = a.x - b.x, dy = a.y - b.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var d = Math.max(dist, PHYSICS.minDistance);
        var f = PHYSICS.repulsion / (d * d);
        var fx = (dx / dist) * f, fy = (dy / dist) * f;
        forces[ids[i]].x += fx; forces[ids[i]].y += fy;
        forces[ids[j]].x -= fx; forces[ids[j]].y -= fy;
      }
    }

    physics.edges.forEach(function (pair) {
      var a = bodies[pair[0]], b = bodies[pair[1]];
      if (!a || !b) return;
      var dx = b.x - a.x, dy = b.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      var f = PHYSICS.springEdge * (dist - PHYSICS.edgeLength);
      var fx = (dx / dist) * f, fy = (dy / dist) * f;
      forces[pair[0]].x += fx; forces[pair[0]].y += fy;
      forces[pair[1]].x -= fx; forces[pair[1]].y -= fy;
    });

    // Group boxes repel like an oversized node: push outsiders away from
    // the box's centroid at its effective radius (not distance 0), and
    // split the equal-and-opposite reaction across the box's own members
    // so the box visibly nudges away too instead of acting like an
    // immovable wall.
    physics.groups.forEach(function (grp) {
      var cx = 0, cy = 0, cnt = 0;
      grp.memberIds.forEach(function (id) {
        var b = bodies[id];
        if (b) { cx += b.x; cy += b.y; cnt++; }
      });
      if (!cnt) return;
      cx /= cnt; cy /= cnt;
      var memberSet = {};
      grp.memberIds.forEach(function (id) { memberSet[id] = true; });
      ids.forEach(function (id) {
        if (memberSet[id]) return; // a group's own members don't repel from their own box
        var b = bodies[id];
        var dx = b.x - cx, dy = b.y - cy;
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var d = Math.max(dist - grp.radius, PHYSICS.minDistance);
        var f = PHYSICS.groupRepulsion / (d * d);
        var fx = (dx / dist) * f, fy = (dy / dist) * f;
        forces[id].x += fx; forces[id].y += fy;
        grp.memberIds.forEach(function (mid) {
          if (forces[mid]) { forces[mid].x -= fx / cnt; forces[mid].y -= fy / cnt; }
        });
      });
    });

    ids.forEach(function (id) {
      forces[id].x += (bodies[id].homeX - bodies[id].x) * PHYSICS.springHomeX;
      forces[id].y += (bodies[id].homeY - bodies[id].y) * PHYSICS.springHomeY;
    });

    var totalSpeed = 0;
    ids.forEach(function (id) {
      var body = bodies[id];
      if (body.grabbed || body.fixed) { body.vx = 0; body.vy = 0; return; }
      body.vx = (body.vx + forces[id].x) * PHYSICS.damping;
      body.vy = (body.vy + forces[id].y) * PHYSICS.damping;
      body.x += body.vx;
      body.y += body.vy;
      totalSpeed += Math.abs(body.vx) + Math.abs(body.vy);
    });

    state.cy.batch(function () {
      ids.forEach(function (id) {
        var body = bodies[id];
        if (body.grabbed) { state.nodePositions[id] = { x: body.x, y: body.y }; return; }
        if (body.fixed) { body.x = body.homeX; body.y = body.homeY; }
        var n = state.cy.getElementById(id);
        if (n.length) n.position({ x: body.x, y: body.y });
        state.nodePositions[id] = { x: body.x, y: body.y };
      });
    });

    if (totalSpeed < PHYSICS.settleEnergy) {
      physics.running = false;
      return;
    }
    physics.rafId = requestAnimationFrame(physicsTick);
  }

  function renderGraph(focal, opts) {
    opts = opts || {};
    var nodes = state.graph.nodes;
    var idx = state.index;
    var t = tokens();
    var FONT = state.mobile ? { node: 14, group: 12, more: 13 } : { node: 12, group: 10, more: 11 };
    hideNodeActions();
    // Toggling a "+more"/alt-group/node expansion re-renders the whole
    // Cytoscape instance (no incremental update API is in use), which
    // would otherwise auto-fit the camera to the new element set every
    // time -- jarring, and it made newly-revealed nodes easy to miss since
    // the whole view rescales around them instead of staying put. Only a
    // real navigation (a different focal course entirely) re-fits.
    var savedPan = opts.preserveViewport && state.cy ? state.cy.pan() : null;
    var savedZoom = opts.preserveViewport && state.cy ? state.cy.zoom() : null;
    // A real navigation starts the physics simulation fresh from the
    // deterministic layout -- reusing cached live positions across two
    // unrelated courses' graphs would seed a shared prerequisite at some
    // arbitrary leftover spot from the last course instead of its own
    // sensible column. A toggle (preserveViewport) keeps the cache, which
    // is exactly what lets existing nodes stay put instead of resetting
    // every time something is expanded or collapsed.
    if (!opts.preserveViewport) state.nodePositions = {};

    var chain = computeAncestorChain(focal);
    var allUnlocks = idx.unlocks[focal] || [];
    var unlockKey = focal + "|unlock";
    var unlocks = state.expandedMore[unlockKey] ? { shown: allUnlocks, extra: 0 } : capped(allUnlocks);
    var coreqUnits = computeRequirementUnits(focal, "coreq_tree");

    var els = [];
    var placed = {};      // code -> true, only for nodes actually drawn (not "+more" stubs)
    var positions = {};   // code -> {x, y} of wherever it actually landed, for hanging a click-revealed expansion off of it
    var edgeSeen = {};    // "source->target:kind" -> true, so the same relationship is never drawn as two separately-id'd edges
    function edgeExists(source, target, kind) { return !!edgeSeen[source + "->" + target + ":" + kind]; }
    function markEdge(source, target, kind) { edgeSeen[source + "->" + target + ":" + kind] = true; }
    var colWidth = 240, rowHeight = ROW_H + UNIT_GAP;
    // Unlocks are always exactly one direct hop from the focal course, same
    // as prereq level 1 -- their column shouldn't drift outward with the
    // *prereq* chain's depth (that's an unrelated, opposite-direction axis).
    var unlockX = colWidth;
    var groupSeq = 0;

    // Skips re-adding a course already drawn elsewhere this render (e.g. a
    // click-revealed expansion reaching a course that's also directly
    // visible as a prereq/coreq/unlock) -- Cytoscape element ids must be
    // unique, and there's no value in a duplicate copy of the same node
    // anyway. An edge pointing at `code` still resolves fine to wherever it
    // was first placed, so callers don't need to check the return value.
    function addNode(code, x, y, opts) {
      opts = opts || {};
      if (placed[code]) return;
      var n = nodes[code] || { title: "(not in dataset)", in_catalog: false };
      placed[code] = true;
      positions[code] = { x: x, y: y };
      // homeX is the physics simulation's spring target (see the physics
      // module above) -- the deterministic column x computed here, kept
      // even though the node's actual live position will drift off it.
      var data = { id: code, label: code, title: n.title || "", depth: n.depth, status: n.depth_status, inCatalog: !!n.in_catalog, focal: !!opts.isFocal, homeX: x, homeY: y };
      if (opts.parent) data.parent = opts.parent;
      // Seed at wherever physics last settled this course, if anywhere --
      // otherwise this course is new to the graph and starts at its home
      // column, same as before physics existed.
      var seed = state.nodePositions[code] || { x: x, y: y };
      var el = { data: data, position: seed };
      if (opts.isFocal) el.grabbable = false; // stays a stable anchor for the rest of the graph to organize around
      els.push(el);
    }

    // Lays out a list of requirement units in a vertical column centered on
    // yCenter at horizontal position x. A "group"/"nof" unit becomes a
    // compound parent node (a dashed bounding box) containing its member
    // courses as children, with ONE edge from the group into its target --
    // "pick one (or N) of these", not "all of these are separately
    // required". Returns the total pixel height the column used.
    // defaultTarget is for callers whose units don't each carry their own
    // "target" (only computeAncestorChain's ancestor-level units do, one
    // per originating course) -- coreqUnits comes straight from
    // computeRequirementUnits with no target at all, since every coreq unit
    // targets the same place: the focal course itself.
    // expandKey identifies this specific column in state.expandedMore --
    // once a viewer clicks its "+N more" stub, this column (for this focal
    // course) renders in full on every subsequent redraw instead of
    // re-truncating.
    // The height layoutUnitColumn below will use for a given unit list --
    // pulled out on its own so a click-revealed expansion (see below) can
    // ask "how tall will this column be" before it's actually drawn, in
    // order to claim vertical room for it up front.
    function columnHeight(units, expandKey) {
      var shown = state.expandedMore[expandKey] ? units : units.slice(0, MAX_UNITS_PER_LEVEL);
      return shown.reduce(function (sum, u) { return sum + unitHeight(u); }, 0)
        + Math.max(0, shown.length - 1) * UNIT_GAP;
    }

    function layoutUnitColumn(units, x, yCenter, kind, defaultTarget, expandKey) {
      var shown = state.expandedMore[expandKey] ? units : units.slice(0, MAX_UNITS_PER_LEVEL);
      var extra = units.length - shown.length;
      var totalHeight = columnHeight(units, expandKey);
      var cursorY = yCenter - totalHeight / 2;

      shown.forEach(function (u) {
        var h = unitHeight(u);
        var target = u.target || defaultTarget;
        if (u.type === "single" && edgeExists(u.codes[0], target, kind)) {
          // This exact relationship is already drawn (common when a
          // click-revealed expansion reaches back to a course whose only
          // prerequisite is the focal course itself -- the focal-to-this
          // edge already exists in the unlocks column). Drawing it again
          // under a different element id wouldn't be caught as a
          // duplicate by Cytoscape, so two arrows would render for the
          // same relationship; skip the whole unit instead, since there's
          // nothing new to show.
        } else if (u.type === "single") {
          var code = u.codes[0];
          addNode(code, x, cursorY + h / 2);
          els.push({ data: { id: code + "->" + target + ":" + kind, source: code, target: target, kind: kind } });
          markEdge(code, target, kind);
        } else if (u.codes.every(function (code) { return placed[code]; })) {
          // Every member is already drawn elsewhere (common once a
          // click-revealed expansion's own chain overlaps the courses it's
          // already sitting among) -- a compound box with no actual
          // children of its own is just an empty dashed rectangle, so skip
          // the whole unit rather than draw one.
        } else {
          var gid = "grp:" + (groupSeq++);
          var collapsed = u.altKey && !state.expandedMore[u.altKey];
          var label = (u.type === "nof" ? (u.n + " of " + u.codes.length) : "1 of " + u.codes.length) + (collapsed ? "  ⋯" : "");
          var grid = groupPacking(u);
          // boxWidth/boxHeight are read back by the physics module so an
          // outside course repels off the whole box, not just its members.
          var gdata = { id: gid, label: label, isGroup: true, groupKind: kind, boxWidth: grid.w, boxHeight: grid.h + GROUP_CHROME };
          if (collapsed) { gdata.altKey = u.altKey; gdata.expandable = true; }
          els.push({ data: gdata });
          var membersTop = cursorY + GROUP_CHROME / 2;
          u.codes.forEach(function (code, i) {
            var col = i % grid.cols, row = Math.floor(i / grid.cols);
            var memberX = x + (col - (grid.cols - 1) / 2) * (grid.cellW + INTRA_GROUP_GAP);
            var memberY = membersTop + row * (ROW_H + INTRA_GROUP_GAP) + ROW_H / 2;
            addNode(code, memberX, memberY, { parent: gid });
          });
          els.push({ data: { id: gid + "->" + target, source: gid, target: target, kind: kind } });
        }
        cursorY += h + UNIT_GAP;
      });

      if (extra > 0) {
        var moreId = "__more_" + kind + "_" + x;
        els.push({ data: { id: moreId, label: "+" + extra + " more", isMore: true, moreKey: expandKey, expandable: true }, position: { x: x, y: cursorY + ROW_H / 2 } });
        // Tie the stub to whatever it's actually hiding via a muted edge --
        // without this it's just a floating box once physics nudges it
        // around, with nothing showing what "+N more" belongs to. The
        // hidden units can (rarely) target more than one course at this
        // level, so draw one edge per distinct target rather than guessing.
        var extraTargets = {};
        units.slice(shown.length).forEach(function (u) { extraTargets[u.target || defaultTarget] = true; });
        Object.keys(extraTargets).forEach(function (tgt) {
          els.push({ data: { id: moreId + "->" + tgt + ":" + kind, source: moreId, target: tgt, kind: kind, isMoreEdge: true } });
        });
      }
      return totalHeight;
    }

    addNode(focal, 0, 0, { isFocal: true });

    for (var l = 1; l <= chain.maxLevel; l++) {
      layoutUnitColumn(chain.levelUnits[l] || [], -colWidth * l, 0, "prereq", undefined, focal + "|prereq|" + l);
    }

    var coreqHeight = coreqUnits.length ? layoutUnitColumn(coreqUnits, 0, 120, "coreq", focal, focal + "|coreq") : 0;

    unlocks.shown.forEach(function (c, i) { addNode(c, unlockX, (i - (unlocks.shown.length - 1) / 2) * rowHeight); });
    if (unlocks.extra > 0) {
      els.push({ data: { id: "__more_unlock", label: "+" + unlocks.extra + " more", isMore: true, moreKey: unlockKey, expandable: true }, position: { x: unlockX, y: (unlocks.shown.length / 2 + 0.7) * rowHeight } });
      els.push({ data: { id: focal + "->__more_unlock", source: focal, target: "__more_unlock", kind: "prereq", isMoreEdge: true } });
    }
    unlocks.shown.forEach(function (c) {
      els.push({ data: { id: focal + "->" + c, source: focal, target: c, kind: "prereq" } });
      markEdge(focal, c, "prereq");
    });

    // Click-revealed expansions: a viewer can click any course node (a
    // coreq, an unlock, an alt-group member whose own chain wasn't
    // auto-expanded, even a course revealed by an earlier expansion) to
    // graft *its own* full prerequisite chain onto the graph, without
    // treating it as a real visit -- focal/history/detail panel don't
    // change (see the tap handler below). Positioned like the focal
    // course's own chain -- columns extending left, one per level --
    // centered as close as possible to the clicked node's actual height,
    // so it reads as "this is what would show up if this were the
    // selected course" rather than a disconnected side panel.
    //
    // Every unlock lives at the same x (unlockX), and every coreq at x=0,
    // so *any* unlock's or coreq's own level-1 column would otherwise land
    // at x <= 0 -- squarely on top of the focal node's own column (and, if
    // two are expanded at once, on top of each other). A small 1D slot
    // packer nudges only these collision-prone expansions up or down just
    // far enough to clear whatever's already claimed, defaulting to no
    // nudge at all when the desired row is already free. Prereq-chain-node
    // expansions extend further left of an already-negative x, away from
    // this shared area, so they're left alone (occasional overlap there is
    // an accepted tradeoff -- see the git history for the fuller
    // force-directed-layout discussion).
    var nodeExpandPrefix = focal + "|node|";
    var claimedYRanges = [[-ROW_H, ROW_H]]; // the focal node's own footprint
    if (coreqUnits.length) claimedYRanges.push([120 - coreqHeight / 2 - UNIT_GAP, 120 + coreqHeight / 2 + UNIT_GAP]);

    function claimYSlot(desiredY, halfHeight) {
      function overlaps(a, b) { return a[0] < b[1] && b[0] < a[1]; }
      function fits(center) {
        var range = [center - halfHeight, center + halfHeight];
        return !claimedYRanges.some(function (r) { return overlaps(r, range); });
      }
      var y = desiredY;
      if (!fits(y)) {
        var step = 24, found = false;
        for (var d = step; d < 8000; d += step) {
          if (fits(desiredY + d)) { y = desiredY + d; found = true; break; }
          if (fits(desiredY - d)) { y = desiredY - d; found = true; break; }
        }
        if (!found) y = desiredY; // pathological case -- fall back rather than loop forever
      }
      claimedYRanges.push([y - halfHeight, y + halfHeight]);
      return y;
    }

    Object.keys(state.expandedMore).forEach(function (key) {
      if (!state.expandedMore[key]) return;
      if (key.indexOf(nodeExpandPrefix) !== 0) return;
      var code = key.slice(nodeExpandPrefix.length);
      var origin = positions[code];
      if (!origin) return; // not currently visible -- nothing to hang it off of
      var subChain = computeAncestorChain(code);
      if (subChain.maxLevel === 0) return; // nothing to actually reveal

      var levelKeys = [];
      var maxLevelHeight = 0;
      for (var sl = 1; sl <= subChain.maxLevel; sl++) {
        var levelKey = key + "|" + sl;
        levelKeys.push(levelKey);
        maxLevelHeight = Math.max(maxLevelHeight, columnHeight(subChain.levelUnits[sl] || [], levelKey));
      }

      var risksCenterCollision = origin.x <= colWidth;
      var y = risksCenterCollision ? claimYSlot(origin.y, maxLevelHeight / 2 + UNIT_GAP) : origin.y;

      for (var sl2 = 1; sl2 <= subChain.maxLevel; sl2++) {
        layoutUnitColumn(subChain.levelUnits[sl2] || [], origin.x - colWidth * sl2, y, "prereq", undefined, levelKeys[sl2 - 1]);
      }
    });

    if (state.cy) state.cy.destroy();
    state.cy = cytoscape({
      container: document.getElementById("cy"),
      elements: els,
      layout: { name: "preset" },
      userZoomingEnabled: true, userPanningEnabled: true, boxSelectionEnabled: false,
      // On a touchscreen a finger that lands on a course should pan the
      // graph, not drag that course around -- nodes are big targets and
      // dragging them made panning nearly impossible. Also keeps a pinch
      // from zooming into oblivion.
      autoungrabify: state.mobile,
      minZoom: state.mobile ? 0.05 : 1e-50, maxZoom: state.mobile ? 3 : 1e50,
      style: [
        { selector: "node", style: {
          // "width": "label" is deprecated in this Cytoscape version (logs a
          // warning but silently produces zero-width/overlapping nodes) --
          // compute an explicit width from the label length instead, same
          // pattern as the background-color function below.
          "shape": "round-rectangle",
          "width": function (ele) { return nodeWidthEstimate(ele.data("label")); },
          "height": 34, "padding": "10px",
          "background-color": function (ele) { return depthColor(t, ele.data("depth"), ele.data("inCatalog")); },
          "label": "data(label)", "color": t.ink, "font-family": "IBM Plex Mono, monospace",
          "font-size": FONT.node, "font-weight": 600, "text-valign": "center", "text-halign": "center",
          "border-width": 1, "border-color": t.hairline
        }},
        { selector: "node[?focal]", style: { "background-color": t.accent, "color": t.accentInk, "border-width": 2, "border-color": t.accent, "font-weight": 700 } },
        { selector: "node[status = 'cycle']", style: { "border-width": 2, "border-color": t.critical } },
        { selector: "node[status = 'unresolved_prereq']", style: { "border-style": "dashed", "border-width": 2, "border-color": t.warning } },
        // Cytoscape selector syntax: falsy/absent data fields use "[!field]",
        // not "[field = false]" (which is an invalid selector -- silently
        // dropped, not applied, logged as an error in the console).
        { selector: "node[!inCatalog]", style: { "border-style": "dashed", "background-opacity": 0.5, "color": t.ink2 } },
        { selector: "node.peek", style: { "border-width": 3, "border-color": t.accent } },
        { selector: "node[?isMore]", style: {
          // "transparent" alone isn't enough: Cytoscape drops the alpha and
          // paints black at background-opacity, i.e. a grey slab.
          "shape": "round-rectangle", "background-color": "transparent", "background-opacity": 0, "border-width": 1, "border-style": "dashed",
          "border-color": t.hairline, "color": t.ink2, "font-family": "Public Sans, sans-serif", "font-size": FONT.more, "font-weight": 500
        }},
        // Compound parent = an alternative-courses group ("pick one/N of
        // these"). Auto-sized by Cytoscape to bound its member nodes; label
        // pinned to the top edge so it doesn't collide with the members.
        { selector: ":parent", style: {
          "shape": "round-rectangle", "background-opacity": 0.08, "border-width": 1, "border-style": "dashed",
          "padding": "10px",
          "label": "data(label)", "font-family": "Public Sans, sans-serif", "font-size": FONT.group, "font-weight": 600,
          "text-valign": "top", "text-halign": "center", "text-margin-y": -4,
          "color": t.ink2, "border-color": t.edgePrereq, "background-color": t.edgePrereq
        }},
        { selector: ":parent[groupKind = 'coreq']", style: { "border-color": t.edgeCoreq, "background-color": t.edgeCoreq } },
        { selector: "edge", style: {
          "curve-style": "bezier", "width": 1.6, "target-arrow-shape": "triangle", "arrow-scale": 0.9,
          "line-color": t.edgePrereq, "target-arrow-color": t.edgePrereq
        }},
        { selector: "edge[kind = 'coreq']", style: {
          "line-color": t.edgeCoreq, "target-arrow-color": t.edgeCoreq, "target-arrow-shape": "none",
          "line-style": "dashed", "curve-style": "bezier", "control-point-step-size": 30
        }},
        // A "+N more" stub's link to whatever it's hiding -- muted so it
        // still reads as "these belong together" without looking like a
        // real prereq/coreq relationship.
        { selector: "edge[?isMoreEdge]", style: { "line-style": "dashed", "opacity": 0.5, "width": 1.1 } }
      ]
    });

    physicsBuild();

    // Dragging a node (or a whole "pick one of N" group box, which drags
    // its members together) hands that course's position to Cytoscape's
    // own native drag for as long as it's held -- physics stops writing
    // to it, but it still repels/pulls everything else in real time, same
    // as the rest of the graph. Releasing it hands it back to physics.
    function dragBodyIds(n) {
      return n.data("isGroup") ? n.children().map(function (c) { return c.id(); }) : [n.id()];
    }
    state.cy.on("grab", "node", function (evt) {
      dragBodyIds(evt.target).forEach(function (id) { if (physics.bodies[id]) physics.bodies[id].grabbed = true; });
    });
    state.cy.on("drag", "node", function (evt) {
      dragBodyIds(evt.target).forEach(function (id) {
        var body = physics.bodies[id];
        if (!body) return;
        var live = state.cy.getElementById(id);
        if (!live.length) return;
        var p = live.position();
        body.x = p.x; body.y = p.y; body.vx = 0; body.vy = 0;
      });
      physicsWake();
    });
    state.cy.on("free", "node", function (evt) {
      dragBodyIds(evt.target).forEach(function (id) { if (physics.bodies[id]) physics.bodies[id].grabbed = false; });
      physicsWake();
    });

    // A single click never changes what's selected -- after a short pause
    // (so a second click has a chance to arrive first) it just toggles
    // whether *that specific course's* own prerequisite chain is grafted
    // onto the graph (see the expansion block above), leaving state.focal,
    // the detail panel, and history untouched. Double-click is the only
    // way to actually navigate there (select()).
    state.cy.on("tap", "node", function (evt) {
      var d = evt.target.data();
      var isRepeatClick = (evt.originalEvent && evt.originalEvent.detail > 1) ||
        (clickTimer && clickTimer.id === d.id);
      cancelPendingClick();
      if (d.moreKey) { state.expandedMore[d.moreKey] = true; renderGraph(focal, { preserveViewport: true }); return; }
      if (d.altKey) { state.expandedMore[d.altKey] = true; renderGraph(focal, { preserveViewport: true }); return; }
      if (d.isMore || d.isGroup) return;
      if (state.mobile) {
        // Touch: no click/double-click. The focal course's own tap opens
        // its details; any other course opens the action bar.
        if (d.id === focal) { setDetailOpen(true); hideNodeActions(); }
        else showNodeActions(d.id);
        return;
      }
      if (isRepeatClick) { select(d.id); return; }
      if (d.id === focal) return; // already fully shown via the primary chain
      var id = d.id;
      clickTimer = { id: id, timeout: setTimeout(function () {
        clickTimer = null;
        var key = focal + "|node|" + id;
        state.expandedMore[key] = !state.expandedMore[key];
        renderGraph(focal, { preserveViewport: true });
      }, CLICK_DELAY_MS) };
    });
    // Tapping empty canvas dismisses whatever phone overlay is open.
    state.cy.on("tap", function (evt) {
      if (evt.target !== state.cy || !state.mobile) return;
      hideNodeActions();
      setLegendOpen(false);
    });
    state.cy.on("mouseover", "node", function (evt) {
      var d = evt.target.data();
      var clickable = d.moreKey || d.altKey || (!d.isMore && !d.isGroup && !d.focal);
      if (clickable) document.getElementById("cy").style.cursor = "pointer";
    });
    state.cy.on("mouseout", "node", function () { document.getElementById("cy").style.cursor = ""; });
    if (savedPan && savedZoom != null) {
      state.cy.zoom(savedZoom);
      state.cy.pan(savedPan);
    } else {
      setInitialView(focal);
    }

    var chainLabel = document.getElementById("chain-label");
    var ancestorCount = chain.allCodes.length - 1;
    if (ancestorCount === 0) {
      chainLabel.textContent = "no prerequisites";
    } else {
      chainLabel.textContent = "← full prerequisite chain (" + ancestorCount + " course" + (ancestorCount === 1 ? "" : "s") +
        ", " + chain.maxLevel + " semester" + (chain.maxLevel === 1 ? "" : "s") + " back" +
        (chain.truncated ? ", truncated" : "") + ")";
    }
  }

  function fmtCredits(n) {
    if (!n) return "";
    if (n.credits_min == null) return n.credits_raw ? n.credits_raw + " cr" : "";
    if (n.credits_min === n.credits_max) return n.credits_min + " cr";
    return n.credits_min + "–" + n.credits_max + " cr";
  }

  function renderDetail(code) {
    var n = state.graph.nodes[code];
    var el = document.getElementById("detail");
    el.innerHTML = "";
    if (!n) return;

    // The phone's collapsed details handle shows just this one line.
    document.querySelector("#detail-toggle .dt-label").textContent = code + " · " + (n.title || "(untitled)");

    var codeEl = document.createElement("div"); codeEl.className = "code"; codeEl.textContent = code;
    var h2 = document.createElement("h2"); h2.textContent = n.title || "(untitled)";
    var meta = document.createElement("div"); meta.className = "meta";

    var credits = document.createElement("span"); credits.className = "mono"; credits.textContent = fmtCredits(n);
    meta.appendChild(credits);

    if (typeof n.depth === "number") {
      var depthSpan = document.createElement("span"); depthSpan.className = "mono";
      depthSpan.textContent = "depth " + n.depth;
      meta.appendChild(depthSpan);
    }
    if (n.depth_status === "cycle") {
      var b1 = document.createElement("span"); b1.className = "badge critical"; b1.textContent = "circular dependency";
      meta.appendChild(b1);
    }
    if (n.depth_status === "unresolved_prereq") {
      var b2 = document.createElement("span"); b2.className = "badge warning"; b2.textContent = "prereq text not fully parsed";
      meta.appendChild(b2);
    }
    if (!n.in_catalog) {
      var b3 = document.createElement("span"); b3.className = "badge warning"; b3.textContent = "referenced, not in current catalog";
      meta.appendChild(b3);
    }
    (n.gened || []).forEach(function (g) {
      var bg = document.createElement("span"); bg.className = "badge gened"; bg.textContent = g;
      meta.appendChild(bg);
    });

    el.appendChild(codeEl); el.appendChild(h2); el.appendChild(meta);

    function field(label, value) {
      if (!value) return;
      var l = document.createElement("div"); l.className = "field-label"; l.textContent = label;
      var v = document.createElement("div"); v.className = "field-value"; v.textContent = value;
      el.appendChild(l); el.appendChild(v);
    }
    field("Description", n.description);
    field("Prerequisites", n.prereq_raw);
    field("Corequisites", n.coreq_raw);
    field("Restrictions", n.restrictions_raw);

    if (n.source_url) {
      var l = document.createElement("div"); l.className = "field-label"; l.textContent = "Source";
      var a = document.createElement("a"); a.href = n.source_url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "catalog.manoa.hawaii.edu ↗"; a.style.fontSize = "0.82rem";
      el.appendChild(l); el.appendChild(a);
    }
  }

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (state.focal) renderGraph(state.focal, { preserveViewport: true });
    });
  }

  document.getElementById("nav-back").addEventListener("click", function () { navigateHistory(-1); });
  document.getElementById("nav-forward").addEventListener("click", function () { navigateHistory(1); });
  window.addEventListener("keydown", function (evt) {
    if (!evt.altKey || evt.ctrlKey || evt.metaKey) return;
    if (evt.key === "ArrowLeft") { navigateHistory(-1); evt.preventDefault(); }
    else if (evt.key === "ArrowRight") { navigateHistory(1); evt.preventDefault(); }
  });
})();
