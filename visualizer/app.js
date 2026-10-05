(function () {
  "use strict";

  // CATALOGS and PROGRAMS are defined in catalogs.js (loaded before this
  // file) -- shared with compare.js so the two pages can't drift apart.
  var MAX_PER_COLUMN = 9;

  // One entry per requirement category a program's relevance data can
  // assign a course to (see build_ee_relevant_courses.py's
  // category_by_code) -- cssVar names the --cat-<key>-h/-s custom
  // properties in styles.css, which is where the actual hue/saturation
  // values live (kept in CSS with the site's other color tokens, same as
  // --depth-0..7). "marker" isn't a fill category at all: it's the amber
  // outline drawn on any course that carries a Focus designation (see
  // focusOf() below), shown in the legend whenever the focus data has
  // loaded -- nothing in the relevance data ever assigns a course to it.
  var CATEGORIES = [
    { key: "fixed", label: "Class Requirements", cssVar: "cat-fixed" },
    { key: "group1", label: "Major EE I (Group I)", cssVar: "cat-group1" },
    { key: "group2", label: "Major EE II (Group II)", cssVar: "cat-group2" },
    { key: "te", label: "Technical Electives (TE)", cssVar: "cat-te" },
    { key: "eb", label: "Engineering Breadth (EB)", cssVar: "cat-eb" },
    { key: "gened", label: "General Education Core", cssVar: "cat-gened" },
    { key: "any_level", label: "ECE/EE (grad & other)", cssVar: "cat-any-level" },
    { key: "h_focus", label: "Focus course (W / H / E / O) — amber outline", cssVar: "cat-h-focus", marker: true },
  ];
  // Lightness steps for every category ramp, lightest (depth 0) to
  // darkest (depth 7+) -- same direction and step count as --depth-0..7,
  // just applied to each category's own hue instead of always blue.
  var LIGHT_LIGHTNESS = [93, 86, 79, 71, 63, 55, 48, 42];
  var DARK_LIGHTNESS = [42, 36, 31, 26, 22, 18, 14, 10];
  var DEFAULT_COURSE = "BIOL 172"; // what the page opens on

  // Credits implied by each open diversification/foundation gen-ed tag, for
  // the "My Progress" panel (renderProgressPane()) -- the checksheet's own
  // gened_codes only carries a free-text description, not a machine-usable
  // credit number, and these are the same every catalog year 2020-2026
  // (same reasoning as technical_electives' hardcoded 7/3/1 -- see
  // build_ee_relevant_courses.py). FG is 6cr across two separate courses
  // (minCourses), not a single 6cr course -- see checksheets/data/*.json's
  // own gened_codes.FG note. W/H/O/E Focus aren't here on purpose: they come
  // from STAR's per-section data (state.focusByCode, see focusOf()) and are
  // counted in courses, not credits.
  var GENED_CREDIT_RULES = {
    FW: { credits: 3 }, FQ: { credits: 3 }, FG: { credits: 6, minCourses: 2 },
    DA: { credits: 3 }, DB: { credits: 3 }, DH: { credits: 3 }, DL: { credits: 3 },
    DP: { credits: 3 }, DS: { credits: 3 }, DY: { credits: 3 },
  };
  var FOCUS_LABELS = {
    H: "Hawaiian, Asian & Pacific Issues (H Focus)",
    E: "Contemporary Ethical Issues (E Focus)",
    O: "Oral Communication (O Focus)",
    W: "Writing Intensive — 5 courses total, 2+ upper-division (W Focus)",
  };
  // What each Focus takes to satisfy: W is 5 courses, at least 2 of them
  // upper-division (300+); the other three are a single course each.
  var FOCUS_NEEDS = { W: { courses: 5, upper: 2 }, H: { courses: 1, upper: 0 }, E: { courses: 1, upper: 0 }, O: { courses: 1, upper: 0 } };

  // Graduation Map's abstract "open slot" nodes (renderGradMap()) -- the
  // real named/enumerable requirement courses (fixed/track/TE/EB) render as
  // normal graph nodes; these four don't have one specific real course, so
  // they render as dashed placeholder tiles instead (same concept as
  // scripts/build_ece_fixture.py's PLACEHOLDERS, for the same reason). The
  // Focus ones deliberately reuse takenSet's existing "__focus_<letter>"
  // keys (see toggleTaken() and the progress panel's own Focus checkboxes)
  // so checking one off here or in the sidebar updates both; FG/DH-DL/DS
  // get their own new keys since nothing else in the app tracked them
  // individually before now.
  var GRAD_PLACEHOLDERS = [
    // gened: the GENED_CREDIT_RULES tags that satisfy the slot -- any one
    // being complete drops it off the map (see renderGradMap()).
    { id: "__gened_FG1", label: "FG #1", title: "Foundation: Global & Multicultural", gened: ["FG"] },
    { id: "__gened_FG2", label: "FG #2", title: "Foundation: Global & Multicultural", gened: ["FG"] },
    { id: "__gened_DHDL", label: "DH or DL", title: "Diversification: Humanities or Literature", gened: ["DH", "DL"] },
    { id: "__gened_DS", label: "DS", title: "Diversification: Social Science", gened: ["DS"] },
    { id: "__focus_H", label: "H Focus", title: FOCUS_LABELS.H, focus: "H" },
    { id: "__focus_E", label: "E Focus", title: FOCUS_LABELS.E, focus: "E" },
    { id: "__focus_O", label: "O Focus", title: FOCUS_LABELS.O, focus: "O" },
    { id: "__focus_W", label: "W Focus", title: FOCUS_LABELS.W, focus: "W" },
  ];

  // expandedMore: keys are "<focal>|unlock", "<focal>|unlock-outside", "<focal>|coreq",
  // or "<focal>|prereq|<level>" -- any truncated "+N more" column a viewer has
  // clicked to fully expand for that specific focal course.
  var state = {
    graph: null, index: null, cy: null, focal: null, expandedMore: {}, history: [], historyIndex: -1,
    nodePositions: {}, mobile: false, peek: null, suspendAutoResize: false, catalogId: CATALOGS[0].id,
    highlightTab: "deepest",
    // "none" or a PROGRAMS id; relevantSet is a plain object used as a
    // Set (code -> true) once that program's course list has loaded.
    // relevantCategories is that same fetch's category_by_code (code ->
    // one of CATEGORIES' keys), used to color-code the filtered graph --
    // see nodeColor() and addNode().
    filterProgram: "none", relevantSet: null, relevantCategories: null,
    // Degree-audit ("My Progress") state -- see renderProgressPane().
    // takenSet is a plain object used as a Set (code -> true), persisted to
    // TAKEN_KEY. track is "EP"/"SDS"/null (persisted to TRACK_KEY); the rest
    // (fixedGroups/trackGroups/technicalElectives/engineeringBreadth/
    // genedCodes) come straight off the active program's fetched JSON,
    // alongside relevantSet/relevantCategories above, and are null whenever
    // that is.
    // focusByCode: course code -> ["W","H","E","O"] subset, indexed off the
    // loaded catalog's own node.focus lists (see indexFocus()); null when that
    // catalog has none -- see focusOf().
    focusByCode: null, focusOpen: {},
    // "Find by requirement" tab (renderFindPane): focus letters / gen-ed tags
    // picked (code -> true), "all" or "any" match, course levels ("3" for
    // 3XX -> true), plus the optional extras.
    // terms: STAR term keys ("202630" -> true) a course must have run in --
    // in any one of them, or in every one, per termMode.
    find: { focus: {}, gened: {}, levels: {}, terms: {}, termMode: "any", mode: "all", hideTaken: false, dimGraph: false, query: "" },
    takenSet: {}, track: null, fixedGroups: null,
    trackGroups: null, technicalElectives: null, engineeringBreadth: null, genedCodes: null,
    // Majors other than EE (see scripts/build_major_relevance.js) describe
    // their electives as generic "pools" instead of EE's track_groups /
    // technical_electives / engineering_breadth: pools is the active
    // program's list (or null), majorTracks its per-track variants (Civil's
    // alternative senior years; null when the major has none), and
    // categoryLabels what each legend color means for it.
    pools: null, majorTracks: null, categoryLabels: null,
    // "graph" (the normal windowed prereq view) / "checklist" / "gradmap" --
    // see setViewMode(). gradCy is the second, independent Cytoscape
    // instance Graduation Map mode draws into (#gradmap-cy) -- kept
    // separate from the main state.cy so switching modes never has to tear
    // down and rebuild the windowed graph's own instance.
    viewMode: "graph", gradCy: null,
    // star_offerings.json payload once fetched -- see offeringPattern().
    offerings: null,
    // Checklist mode's collapsible lists (key -> open), kept across the
    // full rebuild every taken toggle does -- see foldout() there.
    checklistOpen: {},
    // Graduation Map's "Deepest chains" toggle -- see applyGradDeepest().
    gradDeepest: false,
  };

  // Wires a control only if it exists. A missing optional button (say an older
  // cached index.html paired with a newer app.js) must never stop this script
  // before the graph starts loading.
  function on(id, type, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(type, handler);
  }
  function setAttr(id, name, value) {
    var el = document.getElementById(id);
    if (el) el.setAttribute(name, value);
  }

  // If something still throws while the page starts up, say so, rather than
  // leaving "loading catalog graph…" on screen forever with no clue why.
  window.addEventListener("error", function (evt) {
    var el = document.getElementById("loading");
    if (el && el.style.display !== "none" && !state.graph) {
      el.textContent = "Something went wrong starting the page (" + (evt.message || "unknown error") +
        "). Try a hard refresh: Ctrl+F5, or Cmd+Shift+R on a Mac.";
    }
  });

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
    setAttr("open-sidebar", "aria-expanded", "false");
    var searchEl = document.getElementById("search");
    if (searchEl) searchEl.blur();
  }
  function setDetailOpen(open) {
    rootEl.classList.toggle("detail-open", open);
    setAttr("detail-toggle", "aria-expanded", String(open));
  }
  function setLegendOpen(open) {
    rootEl.classList.toggle("legend-open", open);
    setAttr("btn-legend", "aria-expanded", String(open));
  }

  // ---------- desktop: giving the graph the room ----------
  // The sidebar, details panel and key can each be put away, and "Full view"
  // hides everything but the graph. The first three are remembered in this
  // browser; full view isn't, so nobody comes back to a page with no search box.
  var LAYOUT_KEY = "prereqMapLayout";
  function readLayoutPrefs() {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveLayoutPref(name, value) {
    var prefs = readLayoutPrefs();
    prefs[name] = value;
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  // Cytoscape keeps its top-left corner and zoom fixed when its box resizes,
  // so hiding the sidebar would just leave the same small graph hugging the
  // left edge of a bigger box. On desktop, a graph that was entirely on screen
  // is re-fitted so the freed-up room actually makes it bigger; one the viewer
  // has zoomed into keeps its zoom, with whatever was in the middle kept in
  // the middle. (Phone zoom is picked for readable text; never refit there.)
  // Matches the CSS transition on #sidebar's width and #detail's max-height
  // (see styles.css) -- the panels these toggles show/hide slide rather than
  // snap now, so the graph's own container resizes gradually too. The
  // corrective fit/pan below has to wait for that to finish, or it measures
  // the box mid-slide and gets the wrong answer.
  var LAYOUT_TRANSITION_MS = 260;

  function keepGraphCentered(change, immediate) {
    var cy = state.cy;
    if (!cy) { change(); return; }
    var w = cy.width(), h = cy.height(), z = cy.zoom(), pan = cy.pan();
    var mid = { x: (w / 2 - pan.x) / z, y: (h / 2 - pan.y) / z };
    var bb = cy.elements().renderedBoundingBox();
    var allVisible = bb.x1 >= -2 && bb.y1 >= -2 && bb.x2 <= w + 2 && bb.y2 <= h + 2;
    // The passive ResizeObserver below (which just keeps Cytoscape's canvas
    // matched to #cy for *other* causes of resize, like the window itself)
    // would otherwise also fire many times a second while this transition is
    // in flight -- each call clears and redraws the canvas, and interleaved
    // with the transition's own paints that was producing a visibly blank
    // graph for a good chunk of the animation. Pausing it here leaves the
    // graph's last frame in place (just increasingly clipped or padded by
    // the container's own animated edge, never blank) until the one
    // resize+fit below runs once things have settled.
    if (!immediate) state.suspendAutoResize = true;
    change();
    function settle() {
      // Always clear the suspend this transition set, even below, if
      // something else already replaced state.cy -- otherwise the passive
      // ResizeObserver would stay paused indefinitely (nothing else would
      // ever clear it).
      state.suspendAutoResize = false;
      // Something else (a course navigation, the major filter, a catalog
      // switch...) destroyed and replaced state.cy while this transition's
      // settle was still pending -- cy here is a stale, already-destroyed
      // instance now, and calling into it crashes deep inside Cytoscape
      // (a null internal renderer reference). Whatever replaced it already
      // set its own correct view, so there's nothing left for this settle
      // to do.
      if (state.cy !== cy) return;
      cy.resize();
      if (!state.mobile && allVisible) { cy.fit(undefined, 40); return; }
      cy.pan({ x: cy.width() / 2 - mid.x * z, y: cy.height() / 2 - mid.y * z });
    }
    // Full view (see setGraphMax) still snaps its layout instantly (display:
    // none, not a transition), so measuring right away is correct there and
    // skipping the wait keeps it feeling immediate.
    if (immediate) settle();
    else setTimeout(settle, LAYOUT_TRANSITION_MS);
  }

  function setSidebarCollapsed(collapsed) {
    rootEl.classList.toggle("sidebar-collapsed", collapsed);
    setAttr("toggle-sidebar", "aria-expanded", String(!collapsed));
    var label = document.querySelector("#toggle-sidebar span");
    if (label) label.textContent = collapsed ? "Show sidebar" : "Hide sidebar";
  }
  function setGraphMax(max) {
    rootEl.classList.toggle("graph-max", max);
    setAttr("btn-max", "aria-pressed", String(max));
    var btn = document.getElementById("btn-max");
    if (btn) btn.textContent = max ? "Exit full view" : "Full view";
  }
  // First-time desktop visitors get the graph front and center: sidebar and
  // details tucked away, key still up since it explains the graph itself.
  // Once someone's touched a control, their choice is remembered instead.
  function applyDesktopLayout() {
    var prefs = readLayoutPrefs();
    setSidebarCollapsed(prefs.sidebarCollapsed !== false);
    setDetailOpen(!!prefs.detailOpen);
    setLegendOpen(prefs.legendOpen !== false);
  }
  // The search box lives in the header on desktop, so putting the sidebar away
  // costs nothing, and in the phone's search sheet otherwise. Moving the element
  // keeps its listeners, so the search code never needs to know which it's in.
  function placeSearchBox() {
    var box = document.querySelector(".search-box");
    var slot = state.mobile ? document.querySelector("#sidebar .sheet-top") : document.getElementById("header-search");
    if (!box || !slot || box.parentNode === slot) return;
    if (state.mobile) slot.insertBefore(box, slot.firstChild);
    else slot.appendChild(box);
  }
  // Same idea for the catalog-year select: the mobile header has no spare
  // room for it (title + nav + Search already fill it), so it moves into
  // the search sheet instead, inside the labeled row that's just there to
  // hold it -- desktop has no equivalent row since the header itself gives
  // it context.
  function placeCatalogSelect() {
    var sel = document.getElementById("catalog-year");
    var mobileRow = document.getElementById("mobile-catalog-row");
    var navHistory = document.querySelector(".nav-history");
    if (!sel) return;
    if (state.mobile) {
      if (sel.parentNode !== mobileRow) mobileRow.appendChild(sel);
    } else if (sel.parentNode !== navHistory.parentNode || sel.nextSibling !== navHistory) {
      navHistory.parentNode.insertBefore(sel, navHistory);
    }
  }
  // Same again for the major filter -- lands right after #catalog-year
  // either way, since both insert immediately before .nav-history.
  function placeFilterSelect() {
    var sel = document.getElementById("major-filter");
    var mobileRow = document.getElementById("mobile-filter-row");
    var navHistory = document.querySelector(".nav-history");
    if (!sel) return;
    if (state.mobile) {
      if (sel.parentNode !== mobileRow) mobileRow.appendChild(sel);
    } else if (sel.parentNode !== navHistory.parentNode || sel.nextSibling !== navHistory) {
      navHistory.parentNode.insertBefore(sel, navHistory);
    }
  }
  placeSearchBox();
  placeCatalogSelect();
  placeFilterSelect();
  placeTrackSelect();
  if (!state.mobile) applyDesktopLayout();

  // "/" jumps to the search box from anywhere (leaving full view first, since
  // that hides the header it sits in).
  function openSearch() {
    if (state.mobile) { openSidebar(); return; }
    if (rootEl.classList.contains("graph-max")) keepGraphCentered(function () { setGraphMax(false); }, true);
    var input = document.getElementById("search");
    if (input) { input.focus(); input.select(); }
  }

  // Tapping a course on a phone opens this small action bar instead of the
  // desktop click (toggle its prereqs) / double-click (go there) pair --
  // double-tapping is undiscoverable and fights the browser's own gestures.
  function hideNodeActions() {
    state.peek = null;
    var actions = document.getElementById("node-actions");
    if (actions) actions.hidden = true;
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
    var takenBtn = document.getElementById("na-taken");
    if (takenBtn) takenBtn.textContent = isTaken(id) ? "Mark as not taken" : "Mark as taken";
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
    // Gradmap's layout keeps moving (settling physics, or an outlying
    // cluster drifting further out) well after the one-time fit its own
    // mode-switch already does -- this button is its only way to re-frame
    // after that, so it stays live in that mode (see the CSS for
    // html.gradmap-mode) while btn-focus (no single focal course here)
    // stays hidden.
    var cy = state.viewMode === "gradmap" ? state.gradCy : state.cy;
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

  on("open-sidebar", "click", openSidebar);
  on("close-sidebar", "click", closeSidebar);
  on("detail-toggle", "click", function () {
    var open = !rootEl.classList.contains("detail-open");
    keepGraphCentered(function () { setDetailOpen(open); });
    if (!state.mobile) saveLayoutPref("detailOpen", open);
  });
  // Dragging the strip along the top of the course details sets the panel's
  // height (remembered with the other layout choices); double-click, or
  // Home on the keyboard, goes back to the default content-sized panel.
  // Arrow keys nudge it for anyone not using a pointer.
  var DETAIL_MIN_H = 80;
  function detailMaxHeight() {
    // Leave the graph its own minimum (#cy-wrap's 340px) where the window
    // allows, and never take more than three quarters of it.
    return Math.max(DETAIL_MIN_H, Math.min(window.innerHeight * 0.75, window.innerHeight - 260));
  }
  function setDetailHeight(px) {
    if (px == null) {
      rootEl.classList.remove("detail-sized");
      rootEl.style.removeProperty("--detail-h");
      return;
    }
    var h = Math.round(Math.max(DETAIL_MIN_H, Math.min(detailMaxHeight(), px)));
    rootEl.style.setProperty("--detail-h", h + "px");
    rootEl.classList.add("detail-sized");
    return h;
  }
  function setupDetailResize() {
    var handle = document.getElementById("detail-resize");
    var panel = document.getElementById("detail");
    if (!handle || !panel) return;
    var saved = readLayoutPrefs().detailHeight;
    if (typeof saved === "number") setDetailHeight(saved);
    var drag = null;
    function finish(h) {
      saveLayoutPref("detailHeight", h == null ? null : h);
      if (state.cy) state.cy.resize();
    }
    handle.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      drag = { y: e.clientY, h: panel.getBoundingClientRect().height, last: null };
      rootEl.classList.add("detail-resizing");
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* older browsers: the move/up listeners below still work */ }
      e.preventDefault();
    });
    handle.addEventListener("pointermove", function (e) {
      if (!drag) return;
      // Dragging up makes the panel taller.
      drag.last = setDetailHeight(drag.h + (drag.y - e.clientY));
    });
    function end() {
      if (!drag) return;
      var h = drag.last;
      drag = null;
      rootEl.classList.remove("detail-resizing");
      if (h != null) finish(h);
    }
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("dblclick", function () { setDetailHeight(null); finish(null); });
    handle.addEventListener("keydown", function (e) {
      var step = e.key === "ArrowUp" ? 24 : e.key === "ArrowDown" ? -24 : 0;
      if (step) {
        e.preventDefault();
        finish(setDetailHeight(panel.getBoundingClientRect().height + step));
      } else if (e.key === "Home") {
        e.preventDefault();
        setDetailHeight(null); finish(null);
      }
    });
    // A saved height can be too tall for a smaller window.
    window.addEventListener("resize", function () {
      var h = parseFloat(rootEl.style.getPropertyValue("--detail-h"));
      if (h && h > detailMaxHeight()) setDetailHeight(h);
    });
  }
  setupDetailResize();

  on("btn-legend", "click", function () {
    var open = !rootEl.classList.contains("legend-open");
    setLegendOpen(open);
    if (!state.mobile) saveLayoutPref("legendOpen", open);
  });
  on("toggle-sidebar", "click", function () {
    var collapsed = !rootEl.classList.contains("sidebar-collapsed");
    keepGraphCentered(function () { setSidebarCollapsed(collapsed); });
    saveLayoutPref("sidebarCollapsed", collapsed);
  });
  on("btn-max", "click", function () {
    var max = !rootEl.classList.contains("graph-max");
    keepGraphCentered(function () { setGraphMax(max); }, true);
  });
  // Three mutually-exclusive stage views: "graph" (the normal windowed
  // prereq view, the default), "checklist" (renderChecklistView()'s grid),
  // "gradmap" (renderGradMap()'s second Cytoscape instance). Each swap is
  // an instant display:none/block toggle, no CSS transition to wait out --
  // same "immediate" path btn-max already uses for the same reason, so the
  // (still-visible) graph resettles to the right size whichever way you
  // move between modes.
  function setViewMode(mode) {
    state.viewMode = mode;
    rootEl.classList.toggle("checklist-mode", mode === "checklist");
    rootEl.classList.toggle("gradmap-mode", mode === "gradmap");
    setAttr("btn-checklist", "aria-pressed", String(mode === "checklist"));
    setAttr("btn-gradmap", "aria-pressed", String(mode === "gradmap"));
    if (mode === "checklist") renderChecklistView();
    if (mode === "gradmap") {
      // Only builds if nothing's there yet -- renderGradMap() is a full
      // rebuild (new Cytoscape instance + layout), reserved for genuine
      // structural changes (see its call sites); merely re-entering the
      // mode should find the last build still live and just resettle it,
      // the same way the main graph's own ResizeObserver does after
      // anything else hides/shows #cy.
      if (!state.gradCy) renderGradMap();
      if (state.gradCy) { state.gradCy.resize(); state.gradCy.fit(undefined, 30); }
    }
  }
  function toggleViewMode(mode) {
    var next = state.viewMode === mode ? "graph" : mode;
    trackEvent("view-mode", next);
    keepGraphCentered(function () { setViewMode(next); }, true);
  }
  on("btn-checklist", "click", function () { toggleViewMode("checklist"); });
  on("btn-gradmap", "click", function () { toggleViewMode("gradmap"); });
  on("btn-deepest", "click", function () {
    state.gradDeepest = !state.gradDeepest;
    setAttr("btn-deepest", "aria-pressed", String(state.gradDeepest));
    trackEvent("grad-deepest", String(state.gradDeepest));
    var len = applyGradDeepest();
    var cy = state.gradCy;
    if (!cy) return;
    if (state.gradDeepest && len) {
      showToast(len > 1 ? "Longest chain left: " + len + " semesters (by prereqs alone)" : "No prereq chains left — everything can be taken now");
      cy.animate({ fit: { eles: cy.elements(".deep"), padding: 50 } }, { duration: 300 });
    } else if (!state.gradDeepest) {
      cy.animate({ fit: { eles: cy.elements(), padding: 30 } }, { duration: 300 });
    }
  });
  on("btn-focus", "click", function () { if (state.focal) focusOn(state.focal, true); });
  on("btn-fit", "click", function () { fitAll(true); });

  // ---------- share ----------
  // Shares the course on screen as a link that opens straight on it. The link
  // is rebuilt from scratch (not copied from the address bar) so a QR code's
  // campaign tags never leak into what people forward; "ref=share" tags it so
  // visits that came from a share show up as their own source in GoatCounter.
  function shareUrl(code) {
    var url = location.origin + location.pathname + "?course=" + encodeURIComponent(code);
    // Omitted for the default catalog so the common case's link doesn't grow
    // a param nobody asked for; a link shared while viewing another year
    // carries it, so opening the link lands back on that same year.
    if (state.catalogId !== CATALOGS[0].id) url += "&catoid=" + encodeURIComponent(state.catalogId);
    return url + "&ref=share";
  }

  function trackEvent(name, title) {
    var gc = window.goatcounter;
    if (gc && typeof gc.count === "function") gc.count({ event: true, path: name, title: title });
  }

  var toastTimer = null;
  function showToast(message) {
    var el = document.getElementById("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2400);
  }

  // Clipboard API where allowed (needs https / localhost); an old-school
  // hidden-textarea copy otherwise; finally a prompt the person can copy from.
  function copyLink(url, done) {
    function legacy() {
      var ta = document.createElement("textarea");
      ta.value = url; ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, url.length);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
      if (ok) done(true);
      else { window.prompt("Copy this link:", url); done(false); }
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(function () { done(true); }, legacy);
    else legacy();
  }

  function shareCurrent() {
    var code = state.focal;
    if (!code || !state.graph) return;
    var n = state.graph.nodes[code] || {};
    var name = n.title ? code + " (" + n.title + ")" : code;
    var data = {
      title: "Mānoa Prereq Map: " + code,
      text: "Prerequisites for " + name + " at UH Mānoa",
      url: shareUrl(code)
    };
    // The OS share sheet (Messages, AirDrop, Instagram, ...) is the whole
    // point on a phone; on a desktop a copied link is what people expect.
    var touch = state.mobile || (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    var canNative = touch && navigator.share && (!navigator.canShare || navigator.canShare(data));
    if (canNative) {
      navigator.share(data).then(function () {
        trackEvent("share-native", code);
      }, function (err) {
        if (err && err.name === "AbortError") return; // they opened the sheet and closed it: not an error
        copyLink(data.url, function (ok) { if (ok) { showToast("Link copied"); trackEvent("share-copied", code); } });
      });
      return;
    }
    copyLink(data.url, function (ok) { if (ok) { showToast("Link copied"); trackEvent("share-copied", code); } });
  }
  on("btn-share", "click", shareCurrent);
  on("btn-share-header", "click", shareCurrent);
  on("na-expand", "click", function () {
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
  on("na-taken", "click", function () {
    if (!state.peek) return;
    toggleTaken(state.peek);
  });
  on("na-open", "click", function () {
    var id = state.peek;
    hideNodeActions();
    if (id) select(id);
  });
  window.addEventListener("keydown", function (evt) {
    if (evt.key === "/" && !evt.ctrlKey && !evt.metaKey && !evt.altKey) {
      var t = evt.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      evt.preventDefault();
      openSearch();
      return;
    }
    if (evt.key !== "Escape") return;
    // Leaving full view is what Esc means there; don't also shut the key.
    if (rootEl.classList.contains("graph-max")) {
      keepGraphCentered(function () { setGraphMax(false); }, true);
      return;
    }
    if (state.viewMode !== "graph") {
      keepGraphCentered(function () { setViewMode("graph"); }, true);
      return;
    }
    closeSidebar(); setLegendOpen(false); hideNodeActions();
  });

  // The graph container resizes when the details sheet opens or the phone
  // rotates; Cytoscape doesn't notice a container resize on its own.
  if (window.ResizeObserver) {
    var cyEl = document.getElementById("cy");
    if (cyEl) new ResizeObserver(function () {
      if (state.cy && !state.suspendAutoResize) state.cy.resize();
    }).observe(cyEl);
  }

  function onDeviceModeChange() {
    var now = detectMobile();
    if (now === state.mobile) return;
    state.mobile = now;
    rootEl.classList.toggle("is-mobile", now);
    placeSearchBox();
    placeCatalogSelect();
    placeFilterSelect();
    placeTrackSelect();
    closeSidebar(); setGraphMax(false);
    if (now) { setLegendOpen(false); setDetailOpen(false); }
    else applyDesktopLayout();
    // Node sizing, dragging and the opening view all differ by mode, so
    // rebuild the graph rather than patching the live instance.
    if (state.focal) renderGraph(state.focal);
  }
  mobileMqls.forEach(function (m) {
    if (m.addEventListener) m.addEventListener("change", onDeviceModeChange);
    else if (m.addListener) m.addListener(onDeviceModeChange);
  });

  // ---------- catalog year ----------
  var CATALOG_KEY = "prereqMapCatalog";
  function catalogById(id) {
    for (var i = 0; i < CATALOGS.length; i++) if (CATALOGS[i].id === id) return CATALOGS[i];
    return null;
  }
  function readStoredCatalogId() {
    try { return localStorage.getItem(CATALOG_KEY); } catch (e) { return null; }
  }
  function saveCatalogId(id) {
    try { localStorage.setItem(CATALOG_KEY, id); } catch (e) {}
  }

  var catalogSelect = document.getElementById("catalog-year");
  CATALOGS.forEach(function (c) {
    var opt = document.createElement("option");
    opt.value = c.id; opt.textContent = c.label;
    catalogSelect.appendChild(opt);
  });
  catalogSelect.addEventListener("change", function () {
    var entry = catalogById(catalogSelect.value);
    if (!entry || entry.id === state.catalogId) return;
    saveCatalogId(entry.id);
    trackEvent("catalog-switch", entry.label);
    // Most courses carry a code straight across catalog years; loadGraph
    // falls back to DEFAULT_COURSE (then any real course at all) if this
    // one happens not to exist in the year just switched to.
    loadGraph(entry, state.focal).then(updateFilterAvailability);
  });

  // Opens on the catalog a shared link points at (?catoid=2), else whatever
  // this browser last had selected, else the first (current) entry.
  var requestedCatalogId = new URLSearchParams(location.search).get("catoid");
  var initialCatalog = catalogById(requestedCatalogId) || catalogById(readStoredCatalogId()) || CATALOGS[0];
  catalogSelect.value = initialCatalog.id;

  function loadGraph(entry, preferCourse) {
    document.getElementById("loading").style.display = "flex";
    document.getElementById("loading").textContent = "loading catalog graph…";
    return fetch(entry.url)
      .then(function (r) {
        if (!r.ok) {
          throw new Error("HTTP " + r.status + " fetching " + entry.url);
        }
        return r.json();
      })
      .then(function (graph) {
        state.catalogId = entry.id;
        state.graph = graph;
        indexFocus(graph);
        state.index = buildIndex(graph);
        // A different catalog year means a different graph entirely -- none
        // of this carries across.
        state.expandedMore = {};
        state.nodePositions = {};
        state.history = [];
        state.historyIndex = -1;
        hideNodeActions();
        // Not .hidden = true: #loading has its own "display: flex" rule (an
        // ID selector), which beats the browser's default (non-!important)
        // "[hidden] { display: none }" UA rule on plain specificity. The
        // published Artifact papers over this with an auto-injected
        // "[hidden]{display:none!important}" reset, which is exactly why this
        // worked there but not when the file is served standalone locally.
        // An inline style always wins, everywhere, regardless of context.
        document.getElementById("loading").style.display = "none";
        buildHighlights(graph, state.index);
        var countEl = document.getElementById("course-count");
        if (countEl) {
          var realCount = Object.keys(graph.nodes).filter(function (c) { return graph.nodes[c].in_catalog; }).length;
          countEl.textContent = realCount.toLocaleString();
        }
        // Prefer, in order: the course being carried over from a catalog
        // switch, one requested in the address (?course=ECE%20367), then
        // DEFAULT_COURSE; if that ever drops out of the catalog data, fall
        // back to a genuinely deep, real course rather than an empty shell.
        var opener = (preferCourse && graph.nodes[preferCourse] ? preferCourse : null) ||
          requestedCourse(graph) ||
          (graph.nodes[DEFAULT_COURSE] ? DEFAULT_COURSE : pickOpener(graph));
        select(opener);
      })
      .catch(function (err) {
        console.error(err);
        document.getElementById("loading").style.display = "flex";
        document.getElementById("loading").textContent =
          "Couldn't load " + entry.url + ": " + err.message +
          ". If you're viewing this from disk (a file:// URL), browsers block " +
          "loading local JSON that way -- serve this repo with a static server " +
          "(e.g. `python -m http.server` from the repo root) and open " +
          "/visualizer/index.html instead.";
      });
  }

  // ---------- major filter ----------
  var FILTER_KEY = "prereqMapFilter";
  function programById(id) {
    for (var i = 0; i < PROGRAMS.length; i++) if (PROGRAMS[i].id === id) return PROGRAMS[i];
    return null;
  }
  function readStoredFilterId() {
    try { return localStorage.getItem(FILTER_KEY); } catch (e) { return null; }
  }
  function saveFilterId(id) {
    try { localStorage.setItem(FILTER_KEY, id); } catch (e) {}
  }
  function filterActive() { return state.filterProgram !== "none" && !!state.relevantSet; }
  // A course counts as "relevant" only once its program's course list has
  // actually loaded -- before that (or with the filter off) nothing is
  // dimmed or hidden, same as an unfiltered view.
  function isRelevant(code) { return !!(state.relevantSet && state.relevantSet[code]); }

  var filterSelect = document.getElementById("major-filter");
  var noneOption = document.createElement("option");
  noneOption.value = "none"; noneOption.textContent = "All courses";
  filterSelect.appendChild(noneOption);
  PROGRAMS.forEach(function (p) {
    var opt = document.createElement("option");
    opt.value = p.id; opt.textContent = p.label;
    filterSelect.appendChild(opt);
  });

  // A program's relevant-courses data is per catalog year (PROGRAMS[].urls)
  // -- switching to a catalog year with no matching data disables the
  // filter rather than leave it silently applying a different catalog's
  // courses. Switching to one the *active* program does cover instead
  // re-fetches that year's own data and keeps the filter on -- the whole
  // point of a major covering multiple catalogs is that switching catalogs
  // shouldn't force the filter off just because the courses underneath it
  // changed.
  function updateFilterAvailability() {
    Array.prototype.forEach.call(filterSelect.options, function (opt) {
      if (opt.value === "none") { opt.disabled = false; return; }
      var p = programById(opt.value);
      opt.disabled = !p || !p.urls[state.catalogId];
    });
    var active = programById(state.filterProgram);
    if (!active) { filterSelect.title = ""; return; }
    if (active.urls[state.catalogId]) {
      filterSelect.title = "";
      setFilterProgram(active.id); // re-fetch for the new catalog
    } else {
      filterSelect.title = "Not available for this catalog year -- no relevant-courses data has been built for it yet.";
      setFilterProgram("none");
    }
  }

  function setFilterProgram(id) {
    var program = programById(id);
    var url = program && program.urls[state.catalogId];
    if (program && !url) program = null; // no relevance data for this catalog year
    var resolvedId = program ? program.id : "none";
    state.filterProgram = resolvedId;
    filterSelect.value = resolvedId;
    filterSelect.classList.toggle("active", resolvedId !== "none");
    saveFilterId(resolvedId);
    function rerender() {
      if (state.focal) renderGraph(state.focal, { preserveViewport: true });
      if (state.graph) buildHighlights(state.graph, state.index);
      refreshDegreeAudit();
      renderGradMap(); // structural change (program/catalog) -- rebuilds the whole map, unlike a plain taken toggle
    }
    function clearProgressData() {
      state.fixedGroups = null; state.trackGroups = null; state.technicalElectives = null;
      state.engineeringBreadth = null; state.genedCodes = null;
      state.pools = null; state.majorTracks = null; state.categoryLabels = null;
      updateTrackOptions();
    }
    if (!program) {
      state.relevantSet = null; state.relevantCategories = null;
      clearProgressData();
      updateLegendCategories(); rerender(); return;
    }
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
        return r.json();
      })
      .then(function (data) {
        var set = {};
        (data.courses || []).forEach(function (c) { set[c] = true; });
        state.relevantSet = set;
        state.relevantCategories = data.category_by_code || null;
        // Degree-audit data for renderProgressPane() -- see build_ee_relevant_courses.py's
        // "fixed_groups"/"track_groups"/"technical_electives"/"engineering_breadth"/"gened_codes" fields.
        state.fixedGroups = data.fixed_groups || null;
        state.trackGroups = data.track_groups || null;
        state.technicalElectives = data.technical_electives || null;
        state.engineeringBreadth = data.engineering_breadth || null;
        state.genedCodes = data.gened_codes || null;
        state.pools = data.pools || null;
        state.majorTracks = data.tracks || null;
        state.categoryLabels = data.category_labels || null;
        updateTrackOptions();
        updateLegendCategories();
        rerender();
      })
      .catch(function (err) {
        console.error(err);
        showToast("Couldn't load the " + program.label + " filter");
        state.filterProgram = "none"; state.relevantSet = null; state.relevantCategories = null;
        clearProgressData();
        filterSelect.value = "none"; updateLegendCategories();
      });
  }

  filterSelect.addEventListener("change", function () {
    trackEvent("major-filter", filterSelect.value);
    setFilterProgram(filterSelect.value);
  });

  // ---------- my progress (taken courses, track, degree audit) ----------
  var TAKEN_KEY = "prereqMapTaken";
  var TRACK_KEY = "prereqMapTrack";
  // Focus (H/E/O/W) checkboxes and the EB "approved science course"
  // override aren't real course codes -- they live in the same takenSet Set
  // under these synthetic keys so they persist through the exact same
  // toggleTaken()/localStorage machinery as real courses.
  var EB_MANUAL_KEY = "__eb_manual_science";

  function readStoredTakenSet() {
    try {
      var raw = JSON.parse(localStorage.getItem(TAKEN_KEY) || "[]");
      var set = {};
      raw.forEach(function (c) { set[c] = true; });
      return set;
    } catch (e) { return {}; }
  }
  function saveTakenSet(set) {
    try { localStorage.setItem(TAKEN_KEY, JSON.stringify(Object.keys(set))); } catch (e) {}
  }
  function readStoredTrack() {
    try { return localStorage.getItem(TRACK_KEY); } catch (e) { return null; }
  }
  function saveTrack(id) {
    try { if (id) localStorage.setItem(TRACK_KEY, id); else localStorage.removeItem(TRACK_KEY); } catch (e) {}
  }

  state.takenSet = readStoredTakenSet();
  state.track = readStoredTrack();

  function isTaken(code) { return !!state.takenSet[code]; }

  // ---------- focus (W / H / E / O) ----------
  // Focus designations come from STAR's per-section data, collapsed to one
  // set of letters per course code by scripts/build_star_focus.py -- i.e. a
  // course's focus is treated as constant across terms (see that script's
  // docstring for what that assumption costs). Courses STAR never listed
  // (retired, or only ever offered before the data starts) read as no focus.
  function focusOf(code) { return (state.focusByCode && state.focusByCode[code]) || []; }
  function isUpperDivision(code) {
    var m = /\s(\d+)/.exec(code);
    return !!m && parseInt(m[1], 10) >= 300;
  }
  // Where the user stands on one Focus: taken courses that carry it, checked
  // against FOCUS_NEEDS -- or satisfied by the manual "__focus_<letter>"
  // override (transfer credit, an exception, a course STAR's data missed).
  function focusProgress(letter) {
    var need = FOCUS_NEEDS[letter];
    var taken = Object.keys(state.takenSet).filter(function (c) {
      return c.indexOf("__") !== 0 && focusOf(c).indexOf(letter) !== -1;
    });
    var upper = taken.filter(isUpperDivision).length;
    var manual = !!state.takenSet["__focus_" + letter];
    var auto = taken.length >= need.courses && upper >= need.upper;
    return { need: need, taken: taken, upper: upper, manual: manual, auto: auto, satisfied: manual || auto };
  }
  // Focus lives on each catalog node as node.focus (embedded by
  // scripts/build_star_focus.py, next to node.gened) -- this just builds the
  // code -> letters lookup focusOf() reads, once per graph load. A catalog
  // with no focus lists at all (an older build) leaves it null, which is what
  // switches the progress pane back to its manual Focus checkboxes.
  function indexFocus(graph) {
    var map = {}, any = false;
    Object.keys(graph.nodes).forEach(function (c) {
      var f = graph.nodes[c].focus;
      if (f && f.length) { map[c] = f; any = true; }
    });
    state.focusByCode = any ? map : null;
  }

  // ---------- offerings (when a course runs, how big, how full) ----------
  // data/star_offerings.json, built by scripts/build_star_offerings.py from
  // the same STAR captures as Focus: per course code, per term, [sections,
  // seats, seats taken]. Catalog-independent (one file for every catalog
  // year; EE/ECE renames are already recorded under both codes), so it's
  // fetched once at startup. Until it arrives -- or if it never does --
  // offeringPattern() returns null and every offering UI simply stays hidden.
  var OFFERING_SEASONS = ["Fall", "Spring", "Summer"];
  fetch("data/star_offerings.json")
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (data) {
      state.offerings = data;
      if (state.graph) { renderFindPane(); refreshDegreeAudit(); if (state.focal) renderDetail(state.focal); }
    })
    .catch(function (err) { console.error("star_offerings.json:", err); });

  function offeringRows(code) { return (state.offerings && state.offerings.offerings[code]) || {}; }
  // The newest captured term of each season ("Fall" -> the Fall 2026 term).
  function latestTermBySeason() {
    var out = {};
    (state.offerings ? state.offerings.terms : []).forEach(function (t) { if (t.season) out[t.season] = t; });
    return out;
  }
  // A course's offering pattern across every captured term: which seasons
  // it runs in, always or only sometimes. "kind" drives the badge color:
  // "both" (Fall & Spring every time), "fall"/"spring" (only that one --
  // the time-sensitive case), "irregular", "summer", "none".
  function offeringPattern(code) {
    if (!state.offerings) return null;
    var terms = state.offerings.terms, rows = offeringRows(code);
    var by = {};
    OFFERING_SEASONS.forEach(function (s) { by[s] = { n: 0, of: 0 }; });
    terms.forEach(function (t) { var s = by[t.season]; if (!s) return; s.of++; if (rows[t.key]) s.n++; });
    function lvl(s) { return !s.n ? "never" : s.n === s.of ? "always" : "some"; }
    var f = lvl(by.Fall), sp = lvl(by.Spring), su = by.Summer.n > 0;
    var label, kind;
    if (f === "always" && sp === "always") { label = "Fall & Spring"; kind = "both"; }
    else if (f === "always" && sp === "never") { label = "Fall only"; kind = "fall"; }
    else if (sp === "always" && f === "never") { label = "Spring only"; kind = "spring"; }
    else if (f === "never" && sp === "never") { label = su ? "Summer only" : "Not offered lately"; kind = su ? "summer" : "none"; }
    else {
      label = ["Fall", "Spring"].filter(function (s) { return by[s].n; }).map(function (s) {
        return by[s].n === by[s].of ? s : s + " " + by[s].n + "/" + by[s].of;
      }).join(", ");
      kind = "irregular";
    }
    if (su && kind !== "summer") label += " + Summer";
    var span = terms.length ? terms[0].name + " – " + terms[terms.length - 1].name : "";
    var title = "Offered " + OFFERING_SEASONS.map(function (s) { return s + " " + by[s].n + "/" + by[s].of; }).join(" · ") +
      " (" + span + ", from STAR)";
    // How full it got the last time it ran -- "fills up" past 95%.
    var last = null;
    terms.forEach(function (t) { if (rows[t.key]) last = { term: t, row: rows[t.key] }; });
    var fill = last && last.row[1] ? last.row[2] / last.row[1] : null;
    return { label: label, kind: kind, title: title, span: span, by: by, last: last, fill: fill, full: fill != null && fill >= 0.95 };
  }
  function offeringBadge(code, cls) {
    var p = offeringPattern(code);
    if (!p) return null;
    var b = document.createElement("span");
    b.className = cls + " offer-" + p.kind;
    b.textContent = p.label + (p.full ? " · fills up" : "");
    b.title = p.title + (p.last ? "\nLast run " + p.last.term.name + ": " + p.last.row[2] + " of " + p.last.row[1] + " seats taken" : "");
    return b;
  }

  // ---------- rated difficulty (local only) ----------
  // How hard reviewers rate each course, from Rate My Professors: the same
  // gitignored file the degree planner reads (web/private/difficulty.json,
  // built by scripts/private/build_planner_difficulty.py). It names
  // instructors, so it is only ever requested on localhost: the published
  // map never asks for it, state.difficulty stays null, and everything below
  // (the Difficulty button, the node colors, the details section) stays off.
  // Difficulty is a 1-5 average; a course needs DIFF_MIN_REVIEWS reviews to
  // count as rated. The cut-offs match the planner's.
  var DIFF_MIN_REVIEWS = 5, DIFF_LIGHT = 2.8, DIFF_HARD = 3.7, DIFF_VERY_HARD = 4.2;
  var DIFF_BANDS = ["light", "typical", "hard", "vhard"];
  var DIFF_BAND_LABEL = { light: "lighter than most", typical: "typical", hard: "hard", vhard: "very hard" };
  var DIFF_VIEW_KEY = "prereqMapDifficultyView";
  // Catalogs before 2024-25 call the department EE; the reviews are filed under ECE.
  function diffOf(code) {
    var c = state.difficulty && state.difficulty.courses;
    return (c && (c[code] || c[code.replace(/^EE /, "ECE ")])) || null;
  }
  // The course's numbers, or null when too few reviews back them.
  function diffRated(code) { var d = diffOf(code); return d && d.n >= DIFF_MIN_REVIEWS ? d : null; }
  function diffBand(d) { return d >= DIFF_VERY_HARD ? "vhard" : d >= DIFF_HARD ? "hard" : d < DIFF_LIGHT ? "light" : "typical"; }
  // What a graph node says: the code, plus its score while the difficulty view is on.
  function diffLabel(code) {
    var d = state.diffView ? diffRated(code) : null;
    return d ? code + " · " + d.d.toFixed(1) : code;
  }
  function diffBadge(code, cls) {
    var d = diffRated(code);
    if (!d) return null;
    var b = document.createElement("span");
    b.className = cls + " diff-" + diffBand(d.d);
    b.textContent = "difficulty " + d.d.toFixed(1);
    b.title = "Rated " + d.d.toFixed(1) + " of 5 (" + DIFF_BAND_LABEL[diffBand(d.d)] + ") across " + d.n + " Rate My Professors reviews, " +
      Math.round(d.hard * 100) + "% of them 4 or 5. Local only.";
    return b;
  }
  function updateLegendDifficulty() {
    var legend = document.querySelector(".legend"), line = document.getElementById("legend-difficulty");
    if (!legend) return;
    // While the view is on, the depth/category key describes colors that
    // aren't being drawn, so styles.css hides those lines.
    legend.classList.toggle("diff-on", !!(state.diffView && state.difficulty));
    if (!state.diffView || !state.difficulty) { if (line) line.remove(); return; }
    if (!line) {
      line = document.createElement("span"); line.id = "legend-difficulty";
      legend.insertBefore(line, document.getElementById("legend-categories"));
    }
    var t = tokens();
    line.innerHTML = "";
    DIFF_BANDS.forEach(function (band) {
      var sw = document.createElement("span"); sw.className = "swatch diff-swatch"; sw.style.background = t.diff[band];
      line.appendChild(sw); line.appendChild(document.createTextNode(DIFF_BAND_LABEL[band].replace(" than most", "")));
    });
    line.appendChild(document.createTextNode("— node color = rated difficulty (blank = under " + DIFF_MIN_REVIEWS + " reviews)"));
  }
  function setDiffView(on) {
    state.diffView = !!on && !!state.difficulty;
    try { localStorage.setItem(DIFF_VIEW_KEY, state.diffView ? "1" : "0"); } catch (e) { /* private mode */ }
    setAttr("btn-difficulty", "aria-pressed", String(state.diffView));
    updateLegendDifficulty();
    if (!state.graph) return;
    if (state.focal) renderGraph(state.focal, { preserveViewport: true });
    if (state.gradCy) renderGradMap({ preserveViewport: true });
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    fetch("../web/private/difficulty.json")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        // Scores are shown to one decimal, so that's what they're judged at.
        Object.keys(data.courses).forEach(function (code) {
          var c = data.courses[code];
          if (c.n) c.d = Math.round(c.d * 10) / 10;
          c.by.forEach(function (b) { b.d = Math.round(b.d * 10) / 10; });
        });
        state.difficulty = data;
        // The button exists only once there is something for it to show.
        var before = document.getElementById("btn-max");
        if (before && !document.getElementById("btn-difficulty")) {
          var btn = document.createElement("button");
          btn.id = "btn-difficulty"; btn.className = "ctl-btn"; btn.type = "button"; btn.textContent = "Difficulty";
          btn.setAttribute("aria-pressed", "false");
          btn.title = "Color every course by how hard reviewers rate it (Rate My Professors, local only)";
          btn.addEventListener("click", function () { setDiffView(!state.diffView); });
          before.parentNode.insertBefore(btn, before);
        }
        var on = false;
        try { on = localStorage.getItem(DIFF_VIEW_KEY) === "1"; } catch (e) { /* private mode */ }
        if (on) setDiffView(true);
        if (state.graph) {
          if (state.viewMode === "checklist") renderChecklistView();
          if (state.focal) renderDetail(state.focal);
        }
      })
      .catch(function () { /* no local difficulty data: the feature stays off */ });
  }

  // ---------- find by requirement (focus + gen-ed filter) ----------
  // Gen-ed tags as the catalog prints them (a course's node.gened). Labels are
  // only for tooltips -- the tag list itself comes from whichever catalog is
  // loaded, so an older year's tags (e.g. FS before FQ) just show up unlabeled
  // rather than being dropped.
  var GENED_LABELS = {
    FW: "Foundations: Written Communication", FQ: "Foundations: Quantitative Reasoning",
    FS: "Foundations: Symbolic Reasoning (before Fall 2018)",
    FGA: "Foundations: Global & Multicultural, list A", FGB: "Foundations: Global & Multicultural, list B",
    FGC: "Foundations: Global & Multicultural, list C",
    DA: "Diversification: Arts", DB: "Diversification: Biological Science", DH: "Diversification: Humanities",
    DL: "Diversification: Literatures", DP: "Diversification: Physical Science",
    DS: "Diversification: Social Science", DY: "Diversification: Laboratory",
  };
  var FIND_MAX_ROWS = 150;

  function findCriteriaCount() {
    return Object.keys(state.find.focus).length + Object.keys(state.find.gened).length +
      Object.keys(state.find.levels).length + Object.keys(state.find.terms).length;
  }
  // "ECE 213" -> "2", "BIOL 171L" -> "1", "ANAT 599B" -> "5"; null if the
  // code has no 3-digit course number to read a level from.
  function courseLevel(code) {
    var m = /\s(\d)\d\d/.exec(code);
    return m ? m[1] : null;
  }
  function findActive() { return findCriteriaCount() > 0 || !!state.find.query; }
  // Does a course satisfy the picked chips (all of them or any of them, per
  // the mode) and the optional text box? With nothing picked, everything does.
  function matchesFind(code) {
    var f = state.find, n = state.graph && state.graph.nodes[code];
    if (!n) return false;
    var hits = Object.keys(f.focus).map(function (k) { return focusOf(code).indexOf(k) !== -1; })
      .concat(Object.keys(f.gened).map(function (t) { return (n.gened || []).indexOf(t) !== -1; }));
    if (hits.length && !(f.mode === "any" ? hits.some(Boolean) : hits.every(Boolean))) return false;
    // Levels are their own constraint, independent of all/any: a course has
    // exactly one level, so picking 3XX and 4XX means "either of those".
    if (Object.keys(f.levels).length && !f.levels[courseLevel(code)]) return false;
    // Terms have their own any/all switch: Fall 2026 + Spring 2026 means ran
    // in either ("any"), or ran in both ("all").
    var pickedTerms = Object.keys(f.terms);
    if (pickedTerms.length) {
      var rows = offeringRows(code);
      function ran(k) { return !!rows[k]; }
      if (!(f.termMode === "all" ? pickedTerms.every(ran) : pickedTerms.some(ran))) return false;
    }
    if (f.query) {
      var q = f.query.toLowerCase();
      if (code.toLowerCase().indexOf(q) === -1 && (n.title || "").toLowerCase().indexOf(q) === -1) return false;
    }
    return true;
  }
  function onFindChanged() {
    updateFindResults();
    // Dimming rides on the same data.relevance flag the major filter uses, so
    // the graph has to be rebuilt to pick a change up.
    if (state.find.dimGraph && state.focal && state.cy) renderGraph(state.focal, { preserveViewport: true });
  }
  function catalogLevels() {
    var seen = {};
    var nodes = state.graph.nodes;
    Object.keys(nodes).forEach(function (c) {
      var l = nodes[c].in_catalog && courseLevel(c);
      if (l) seen[l] = true;
    });
    return Object.keys(seen).sort();
  }
  function catalogGenedTags() {
    var seen = {};
    var nodes = state.graph.nodes;
    Object.keys(nodes).forEach(function (c) {
      if (nodes[c].in_catalog) (nodes[c].gened || []).forEach(function (t) { seen[t] = true; });
    });
    // Foundations first, then Diversification, each alphabetical.
    return Object.keys(seen).sort(function (a, b) {
      var ra = a.charAt(0) === "F" ? 0 : 1, rb = b.charAt(0) === "F" ? 0 : 1;
      return ra - rb || (a < b ? -1 : a > b ? 1 : 0);
    });
  }

  // Builds the controls once per catalog/focus-data change and leaves the
  // results list to updateFindResults() -- so typing in the text box or
  // toggling a chip never rebuilds (and steals focus from) the controls.
  function renderFindPane() {
    var pane = document.getElementById("pane-find");
    if (!pane) return;
    pane.textContent = "";
    if (!state.graph) return;
    var f = state.find;

    function group(title) {
      var wrap = document.createElement("div"); wrap.className = "find-group";
      var h = document.createElement("div"); h.className = "find-group-title"; h.textContent = title;
      wrap.appendChild(h);
      var chips = document.createElement("div"); chips.className = "find-chips";
      wrap.appendChild(chips);
      pane.appendChild(wrap);
      return chips;
    }
    function chip(parent, label, title, selected, onToggle) {
      var b = document.createElement("button"); b.type = "button"; b.className = "find-chip";
      b.textContent = label; b.title = title || label;
      b.setAttribute("aria-pressed", selected ? "true" : "false");
      b.addEventListener("click", function () {
        var now = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", now ? "true" : "false");
        onToggle(now);
        onFindChanged();
      });
      parent.appendChild(b);
    }
    function option(parent, label, checked, onChange) {
      var row = document.createElement("label"); row.className = "progress-manual";
      var input = document.createElement("input"); input.type = "checkbox"; input.checked = checked;
      input.addEventListener("change", function () { onChange(input.checked); onFindChanged(); });
      var span = document.createElement("span"); span.textContent = label;
      row.appendChild(input); row.appendChild(span); parent.appendChild(row);
    }

    // Focus
    var focusChips = group("Focus");
    if (state.focusByCode) {
      ["W", "H", "E", "O"].forEach(function (k) {
        chip(focusChips, k + " Focus", FOCUS_LABELS[k], !!f.focus[k], function (on) { if (on) f.focus[k] = true; else delete f.focus[k]; });
      });
    } else {
      var miss = document.createElement("span"); miss.className = "progress-note"; miss.textContent = "Focus data didn't load.";
      focusChips.appendChild(miss);
    }
    // Gen-ed
    var genedChips = group("General education");
    var tags = catalogGenedTags();
    if (!tags.length) {
      var none = document.createElement("span"); none.className = "progress-note"; none.textContent = "No gen-ed tags in this catalog year.";
      genedChips.appendChild(none);
    }
    tags.forEach(function (t) {
      chip(genedChips, t, GENED_LABELS[t] ? t + " — " + GENED_LABELS[t] : t, !!f.gened[t], function (on) { if (on) f.gened[t] = true; else delete f.gened[t]; });
    });

    // Course level
    var levelChips = group("Course level");
    catalogLevels().forEach(function (l) {
      chip(levelChips, l + "XX", l + "00-level courses", !!f.levels[l], function (on) { if (on) f.levels[l] = true; else delete f.levels[l]; });
    });

    // Offered in: the latest captured term of each season (from STAR).
    if (state.offerings) {
      var termChips = group("Offered in");
      var latest = latestTermBySeason();
      OFFERING_SEASONS.forEach(function (s) {
        var t = latest[s];
        if (!t) return;
        chip(termChips, t.name, "Had at least one section in " + t.name + " (STAR)", !!f.terms[t.key],
          function (on) { if (on) f.terms[t.key] = true; else delete f.terms[t.key]; });
      });
      var termModeRow = document.createElement("div"); termModeRow.className = "find-mode";
      termModeRow.appendChild(document.createTextNode("Ran in "));
      var termSel = document.createElement("select"); termSel.className = "find-select";
      termSel.setAttribute("aria-label", "Offered in any or all of the selected terms");
      [["any", "any selected term (Fall or Spring)"], ["all", "every selected term (Fall and Spring)"]].forEach(function (o) {
        var opt = document.createElement("option"); opt.value = o[0]; opt.textContent = o[1]; termSel.appendChild(opt);
      });
      termSel.value = f.termMode;
      termSel.addEventListener("change", function () { f.termMode = termSel.value; onFindChanged(); });
      termModeRow.appendChild(termSel);
      termChips.parentNode.appendChild(termModeRow);
    }

    // Match mode
    var modeRow = document.createElement("div"); modeRow.className = "find-mode";
    modeRow.appendChild(document.createTextNode("Match "));
    var sel = document.createElement("select"); sel.className = "find-select"; sel.setAttribute("aria-label", "Match all or any of the selected requirements");
    [["all", "all selected Focus/gen-ed (e.g. W and DS)"], ["any", "any selected Focus/gen-ed (W or DS)"]].forEach(function (o) {
      var opt = document.createElement("option"); opt.value = o[0]; opt.textContent = o[1]; sel.appendChild(opt);
    });
    sel.value = f.mode;
    sel.addEventListener("change", function () { f.mode = sel.value; onFindChanged(); });
    modeRow.appendChild(sel);
    pane.appendChild(modeRow);

    // Narrow by text, plus options
    var input = document.createElement("input"); input.type = "text"; input.className = "find-query";
    input.placeholder = "Narrow by code or title, e.g. ENG or history"; input.value = f.query;
    input.setAttribute("aria-label", "Narrow the results by course code or title");
    input.addEventListener("input", function () { f.query = input.value.trim(); onFindChanged(); });
    pane.appendChild(input);
    option(pane, "Hide courses I've marked taken", f.hideTaken, function (v) { f.hideTaken = v; });
    option(pane, "Dim everything else in the graph", f.dimGraph, function (v) { f.dimGraph = v; });
    var clear = document.createElement("button"); clear.type = "button"; clear.className = "find-clear"; clear.textContent = "Clear";
    clear.addEventListener("click", function () {
      f.focus = {}; f.gened = {}; f.levels = {}; f.terms = {}; f.query = "";
      renderFindPane(); onFindChanged();
    });
    pane.appendChild(clear);

    var results = document.createElement("div"); results.id = "find-results";
    pane.appendChild(results);
    updateFindResults();
  }

  function updateFindResults() {
    var el = document.getElementById("find-results");
    if (!el || !state.graph) return;
    el.textContent = "";
    function msg(text) {
      var p = document.createElement("p"); p.className = "progress-note"; p.textContent = text; el.appendChild(p);
    }
    if (!findActive()) { msg("Pick a Focus, gen-ed requirement, or course level above to list the courses that match."); return; }
    var nodes = state.graph.nodes;
    var matches = Object.keys(nodes).filter(function (c) {
      return nodes[c].in_catalog && matchesFind(c) && !(state.find.hideTaken && isTaken(c));
    }).sort();
    var head = document.createElement("div"); head.className = "find-count";
    head.textContent = matches.length + " course" + (matches.length === 1 ? "" : "s") +
      (matches.length > FIND_MAX_ROWS ? " (showing the first " + FIND_MAX_ROWS + " — narrow it down)" : "");
    el.appendChild(head);
    var ul = document.createElement("ul"); ul.className = "rank-list";
    matches.slice(0, FIND_MAX_ROWS).forEach(function (code) {
      var n = nodes[code];
      var li = document.createElement("li");
      var b = document.createElement("button");
      var codeSpan = document.createElement("span"); codeSpan.className = "code"; codeSpan.textContent = code;
      var titleSpan = document.createElement("span"); titleSpan.className = "title"; titleSpan.textContent = n.title || "";
      var tagSpan = document.createElement("span"); tagSpan.className = "value";
      tagSpan.textContent = focusOf(code).map(function (k) { return k + " Focus"; }).concat(n.gened || []).join(" · ") +
        (isTaken(code) ? " ✓" : "");
      b.appendChild(codeSpan); b.appendChild(titleSpan); b.appendChild(tagSpan);
      b.addEventListener("click", function () { select(code); });
      li.appendChild(b); ul.appendChild(li);
    });
    el.appendChild(ul);
    if (!matches.length) msg("No courses match.");
  }
  // Pushes a taken-state change into the main graph without rebuilding it
  // -- a plain data() write is enough there, since a taken course still
  // shows on state.cy, just with a border (see the node[?taken] style
  // rule). Graduation Map is different: a taken course is omitted from it
  // entirely (see renderGradMap()'s own comment on why), so it needs an
  // actual rebuild, not a data patch -- refreshDegreeAudit() handles that
  // side, once per toggle action rather than once per node here.
  function syncTakenVisual(code) {
    var ele = state.cy && state.cy.getElementById(code);
    if (ele && ele.length) ele.data("taken", !!state.takenSet[code]);
  }
  function toggleTaken(code) {
    if (state.takenSet[code]) delete state.takenSet[code]; else state.takenSet[code] = true;
    saveTakenSet(state.takenSet);
    syncTakenVisual(code);
    refreshDegreeAudit();
    renderDetail(state.focal);
    if (state.peek === code) showNodeActions(code);
  }

  // Every course anywhere in code's prereq_tree, transitively (prereqs of
  // prereqs too) -- reuses collectAllCourseLeaves() (below, already used by
  // computeRequirementUnits() to flatten a requirement tree) rather than a
  // second tree-walker. Deliberately blind to AND/OR structure, same as
  // collectAllCourseLeaves() itself: for "mark everything this course
  // implies you've already done", which specific OR branch was actually
  // satisfied is unknowable from this data, so Checklist mode marks every
  // alternative rather than guessing one. "seen" both dedupes and guards
  // against a cycle-involved course recursing forever.
  function collectTransitivePrereqs(code, seen) {
    seen = seen || {};
    var n = state.graph.nodes[code];
    if (!n || !n.prereq_tree) return seen;
    collectAllCourseLeaves(n.prereq_tree).forEach(function (c) {
      if (seen[c]) return;
      seen[c] = true;
      collectTransitivePrereqs(c, seen);
    });
    return seen;
  }

  // Checklist mode's click handler: toggling a course ON also marks its
  // whole prereq chain taken (you can't have finished an advanced course
  // without its prereqs) -- toggling OFF only un-marks that one course,
  // since un-taking one course doesn't mean you un-took what came before it.
  function toggleTakenCascade(code) {
    var turningOn = !state.takenSet[code];
    toggleTaken(code);
    if (!turningOn) return;
    var prereqs = collectTransitivePrereqs(code);
    var changed = false;
    Object.keys(prereqs).forEach(function (c) {
      if (state.takenSet[c]) return;
      state.takenSet[c] = true;
      changed = true;
      syncTakenVisual(c);
    });
    if (changed) { saveTakenSet(state.takenSet); refreshDegreeAudit(); }
  }

  // ---------- track picker (EP/SDS) ----------
  var trackSelect = document.getElementById("track-filter");
  function updateTrackOptions() {
    var mobileRow = document.getElementById("mobile-track-row");
    trackSelect.textContent = "";
    // mobileRow's "hidden" attribute alone isn't enough: .is-mobile
    // .mobile-catalog-row's own "display: flex" rule (two classes) outranks
    // the plain [hidden] UA rule (one attribute) on specificity, so it would
    // win and show the row anyway on mobile -- an explicit inline
    // style.display, which always wins regardless of specificity, is the
    // same fix #loading's own comment documents for the same reason.
    // EE's tracks (EP/SDS) or another major's (Civil's senior-year tracks).
    var tracks = state.trackGroups || state.majorTracks;
    if (!tracks) {
      trackSelect.hidden = true;
      if (mobileRow) { mobileRow.hidden = true; mobileRow.style.display = "none"; }
      return;
    }
    var placeholder = document.createElement("option");
    placeholder.value = ""; placeholder.textContent = "Choose your track…";
    trackSelect.appendChild(placeholder);
    Object.keys(tracks).forEach(function (id) {
      var opt = document.createElement("option");
      opt.value = id; opt.textContent = tracks[id].name;
      trackSelect.appendChild(opt);
    });
    // A track chosen under one catalog year/program carries over as long as
    // this year's data still has that track id; otherwise falls back to the
    // placeholder rather than silently pinning to whatever's first.
    // The stored track is tried too: switching to a major with different
    // tracks blanks state.track for that major, but shouldn't lose the one
    // chosen for this major before.
    var stored = readStoredTrack();
    trackSelect.value = state.track && tracks[state.track] ? state.track : (stored && tracks[stored] ? stored : "");
    state.track = trackSelect.value || null;
    trackSelect.hidden = false;
    if (mobileRow) { mobileRow.hidden = false; mobileRow.style.display = ""; }
  }
  trackSelect.addEventListener("change", function () {
    state.track = trackSelect.value || null;
    saveTrack(state.track);
    trackEvent("track-filter", state.track || "none");
    refreshDegreeAudit();
    renderGradMap(); // structural change (track) -- Group I/II node membership changes
  });
  // Mirrors placeFilterSelect()'s desktop/mobile relocation -- see its own
  // comment. Called from the same spots that call placeFilterSelect().
  function placeTrackSelect() {
    var sel = document.getElementById("track-filter");
    var mobileRow = document.getElementById("mobile-track-row");
    var navHistory = document.querySelector(".nav-history");
    if (!sel) return;
    if (state.mobile) {
      if (sel.parentNode !== mobileRow) mobileRow.appendChild(sel);
    } else if (sel.parentNode !== navHistory.parentNode || sel.nextSibling !== navHistory) {
      navHistory.parentNode.insertBefore(sel, navHistory);
    }
  }
  // Establishes the correct initial hidden state (no program selected yet)
  // right away -- setFilterProgram() only reaches this when a stored major
  // filter id actually gets restored, so a fresh visitor with no stored
  // filter would otherwise leave index.html's static "hidden" attribute as
  // the only thing hiding #mobile-track-row, which loses to
  // ".is-mobile .mobile-catalog-row"'s own display rule (see the comment
  // in updateTrackOptions() above).
  updateTrackOptions();

  // ---------- degree-audit evaluation ----------
  // Builds the "My Progress" pane's whole content from scratch on every
  // call (cheap -- a few dozen DOM nodes) rather than patching it, same
  // approach buildHighlights() already takes for the other tabs. Called
  // whenever anything it depends on changes: catalog/filter switch (via
  // buildHighlights and setFilterProgram), a taken-course toggle, or the
  // track picker.
  // Shared by renderProgressPane() and renderChecklistView() -- both work
  // off the same active-program data (state.relevantCategories/trackGroups),
  // just presented differently (a narrow sidebar checklist with credit
  // bars vs. a big all-at-once grid).
  function creditsOf(code) {
    var n = state.graph.nodes[code];
    return n && typeof n.credits_min === "number" ? n.credits_min : 0;
  }
  function titleOf(code) { var n = state.graph.nodes[code]; return n ? (n.title || "") : ""; }
  function codesWithCategory(cat) {
    return Object.keys(state.relevantCategories).filter(function (c) { return state.relevantCategories[c] === cat; }).sort();
  }
  function sumCredits(codes) { return codes.reduce(function (sum, c) { return sum + creditsOf(c); }, 0); }
  function isLab(code) { return /L$/.test(code); }
  function courseNumber(code) { var m = /\s(\d+)/.exec(code); return m ? parseInt(m[1], 10) : NaN; }

  // Engineering Breadth's open-ended rule (every check sheet 2020-2026,
  // note 7/8): any CEE, ME, OE or BE course at the 300 level or higher, on
  // top of the named CEE 270. "OE" is Ocean Engineering, whose catalog
  // subject code is ORE -- there is no "OE" subject, so matching the sheet's
  // abbreviation literally never found a single course.
  var EB_SUBJECTS = ["CEE", "ME", "ORE", "BE"];
  var EB_SUBJECT_LABELS = { CEE: "Civil & Environmental", ME: "Mechanical", ORE: "Ocean (OE)", BE: "Biological" };
  function isEbSubjectCourse(code) {
    var n = state.graph.nodes[code];
    return !!n && EB_SUBJECTS.indexOf(n.subject) !== -1 && courseNumber(code) >= 300;
  }

  // Where one track stands. Group I is every listed course, so it's a plain
  // credit sum. Group II only needs its minimum: taken Group II courses fill
  // it lecture-first, and whatever's left over spills to Technical Electives
  // (note 9: TEs are drawn from the track lists) -- labs spill first since
  // TE is the requirement that needs one.
  function trackStatus(id) {
    var t = state.trackGroups[id];
    var g1 = sumCredits(t.group1.filter(isTaken));
    var g2Taken = t.group2.filter(isTaken);
    var ordered = g2Taken.filter(function (c) { return !isLab(c); }).concat(g2Taken.filter(isLab));
    var g2 = 0, used = [], spill = [];
    ordered.forEach(function (c) {
      if (g2 < t.group2_required_credits) { used.push(c); g2 += creditsOf(c); } else spill.push(c);
    });
    var g1Done = g1 >= t.group1_required_credits, g2Done = g2 >= t.group2_required_credits;
    return { id: id, track: t, g1: g1, g2: g2, g1Done: g1Done, g2Done: g2Done, complete: g1Done && g2Done, used: used, spill: spill };
  }
  function trackCodeSet(id) {
    var set = {}, t = state.trackGroups[id];
    t.group1.concat(t.group2).forEach(function (c) { set[c] = true; });
    return set;
  }

  // Technical Electives: the explicit TE list, plus -- once a track is
  // chosen -- the chosen track's spilled Group II courses and any taken
  // course from another track's lists. "Outside your track" is everything
  // in that pool except the chosen track's own spill.
  function teStatus() {
    var rule = state.technicalElectives || { required_credits: 7, outside_track_credits: 3, lab_credits: 1 };
    var explicit = codesWithCategory("te").filter(isTaken);
    var chosen = state.track && state.trackGroups[state.track] ? state.track : null;
    var spill = [], otherTrack = [];
    if (chosen) {
      spill = trackStatus(chosen).spill;
      var mine = trackCodeSet(chosen), seen = {};
      explicit.forEach(function (c) { seen[c] = true; });
      Object.keys(state.trackGroups).forEach(function (id) {
        if (id === chosen) return;
        Object.keys(trackCodeSet(id)).forEach(function (c) {
          if (mine[c] || seen[c] || !isTaken(c)) return;
          seen[c] = true; otherTrack.push(c);
        });
      });
      otherTrack.sort();
    }
    var pool = explicit.concat(otherTrack, spill);
    var total = sumCredits(pool);
    var outside = sumCredits(explicit.concat(otherTrack));
    var lab = sumCredits(pool.filter(isLab));
    var totalDone = total >= rule.required_credits, outsideDone = outside >= rule.outside_track_credits, labDone = lab >= rule.lab_credits;
    return {
      rule: rule, trackChosen: !!chosen, explicit: explicit, otherTrack: otherTrack, spill: spill, pool: pool,
      total: total, outside: outside, lab: lab, totalDone: totalDone, outsideDone: outsideDone, labDone: labDone,
      complete: totalDone && outsideDone && labDone,
    };
  }

  function ebStatus() {
    var rule = state.engineeringBreadth || { required_credits: 3 };
    var named = codesWithCategory("eb");
    var subjectTaken = Object.keys(state.takenSet).filter(function (c) {
      return c.indexOf("__") !== 0 && named.indexOf(c) === -1 && isEbSubjectCourse(c);
    }).sort();
    var counted = named.filter(isTaken).concat(subjectTaken);
    var credits = sumCredits(counted);
    var manual = isTaken(EB_MANUAL_KEY);
    return { rule: rule, named: named, subjectTaken: subjectTaken, counted: counted, credits: credits, manual: manual, complete: manual || credits >= rule.required_credits };
  }

  // The degree audit for a major described by pools rather than EE's track
  // structure -- null for EE (which has its own trackStatus/teStatus/ebStatus
  // above) and whenever no such major is the active filter.
  //   fixed   the required-course groups (the chosen track's, for a major
  //           with tracks; the standard ones until one is picked)
  //   pools   one status per elective pool, in the check sheet's order: a
  //           taken course counts toward the first pool that takes it, a
  //           pool that isn't "greedy" stops counting once it's full (so the
  //           rest can count further down), and a pool's "at most N of
  //           these" limits leave the extras uncounted.
  function genericAudit() {
    if (!state.pools || state.trackGroups || !state.relevantCategories) return null;
    var track = state.majorTracks && state.track && state.majorTracks[state.track] ? state.majorTracks[state.track] : null;
    var fixed = (track ? track.fixed_groups : state.fixedGroups) || [];
    var pools = (track ? track.pools : state.pools) || [];
    var used = {};
    fixed.forEach(function (g) { g.forEach(function (c) { used[c] = true; }); });
    var statuses = pools.map(function (pool) {
      var counted = (pool.limits || []).map(function () { return 0; });
      var taken = [], skipped = [], credits = 0;
      pool.codes.filter(isTaken).forEach(function (c) {
        if (used[c]) return;
        if (!pool.greedy && credits >= pool.need) return;
        var hits = (pool.limits || []).map(function (l) { return l.codes.indexOf(c) !== -1; });
        var over = false;
        hits.forEach(function (hit, i) { if (hit && counted[i] >= pool.limits[i].count) over = true; });
        if (over) { skipped.push(c); return; }
        hits.forEach(function (hit, i) { if (hit) counted[i]++; });
        used[c] = true; taken.push(c); credits += creditsOf(c);
      });
      return { pool: pool, taken: taken, skipped: skipped, credits: credits, complete: credits >= pool.need };
    });
    return {
      fixed: fixed, pools: statuses, track: track, needsTrack: !!state.majorTracks && !track,
      fixedDone: fixed.filter(function (g) { return g.some(isTaken); }).length,
    };
  }

  function genedStatus(tag) {
    var rule = GENED_CREDIT_RULES[tag], nodes = state.graph.nodes;
    // The catalog tags FG courses by list (FGA/FGB/FGC), never plain "FG".
    function matches(t) { return t === tag || (tag === "FG" && /^FG[A-C]$/.test(t)); }
    var taken = Object.keys(state.takenSet).filter(function (c) { return nodes[c] && (nodes[c].gened || []).some(matches); });
    var done = sumCredits(taken);
    return { rule: rule, taken: taken, done: done, complete: done >= rule.credits && taken.length >= (rule.minCourses || 1) };
  }
  function genedTags() {
    if (!state.genedCodes) return [];
    return Object.keys(GENED_CREDIT_RULES).filter(function (tag) { return tag in state.genedCodes; });
  }

  // "My Progress" (sidebar), Checklist mode, and Graduation Map all depend
  // on the same taken-course/track state, so anything that changes any of
  // them refreshes all three together rather than each caller remembering
  // three separate calls. Graduation Map only rebuilds if it's ever been
  // built at all (state.gradCy) -- no point paying for a rebuild of a view
  // nobody's opened yet -- and keeps the viewport where it was (see
  // renderGradMap()'s own preserveViewport handling), since unlike a
  // filter/track/catalog switch this isn't a "the whole node set changed,
  // show me a fresh view" moment.
  function refreshDegreeAudit() {
    updateFindResults();
    renderProgressPane();
    renderChecklistView();
    if (state.gradCy) renderGradMap({ preserveViewport: true });
  }

  function renderProgressPane() {
    var pane = document.getElementById("pane-progress");
    if (!pane) return; // no catalog loaded yet
    pane.textContent = "";
    if (!state.graph || !state.relevantCategories || (!state.trackGroups && !state.pools)) {
      var empty = document.createElement("p");
      empty.className = "progress-empty";
      empty.textContent = "Select your major in the filter above to see your progress toward the degree.";
      pane.appendChild(empty);
      return;
    }
    var nodes = state.graph.nodes;

    function heading(text) {
      var h = document.createElement("h4"); h.textContent = text; return h;
    }
    function section(text) {
      var wrap = document.createElement("div"); wrap.className = "progress-section";
      wrap.appendChild(heading(text));
      pane.appendChild(wrap);
      return wrap;
    }
    function note(text) {
      var p = document.createElement("p"); p.className = "progress-note"; p.textContent = text;
      return p;
    }
    function progressBar(wrap, done, total, label) {
      var barWrap = document.createElement("div"); barWrap.className = "progress-bar-wrap";
      var bar = document.createElement("div"); bar.className = "progress-bar";
      if (done >= total && total > 0) bar.classList.add("complete");
      var fill = document.createElement("div"); fill.className = "progress-bar-fill";
      fill.style.width = (total > 0 ? Math.min(100, (done / total) * 100) : 0) + "%";
      bar.appendChild(fill);
      var lab = document.createElement("div"); lab.className = "progress-bar-label";
      lab.textContent = label;
      barWrap.appendChild(bar); barWrap.appendChild(lab);
      wrap.appendChild(barWrap);
    }
    function makeRowButton(code) {
      var b = document.createElement("button"); b.type = "button";
      var mark = document.createElement("span"); mark.className = "progress-mark"; mark.textContent = isTaken(code) ? "✓" : "";
      var codeSpan = document.createElement("span"); codeSpan.className = "code"; codeSpan.textContent = code;
      var titleSpan = document.createElement("span"); titleSpan.className = "title"; titleSpan.textContent = titleOf(code);
      b.appendChild(mark); b.appendChild(codeSpan); b.appendChild(titleSpan);
      b.addEventListener("click", function () { toggleTaken(code); });
      return b;
    }
    // A clickable checklist of real course codes -- clicking a row toggles
    // its taken state (this panel's whole point), not navigation; the other
    // four tabs already cover browsing to a course.
    function checklist(wrap, codes) {
      var ul = document.createElement("ul"); ul.className = "progress-checklist";
      codes.forEach(function (code) {
        var li = document.createElement("li");
        li.className = "progress-item" + (isTaken(code) ? " done" : "");
        li.appendChild(makeRowButton(code));
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
    // Fixed requirements only: a group of >1 codes is a real either/or
    // alternative (see build_ee_relevant_courses.py's "fixed_groups") --
    // one row holding every alternative's own button with "or" between
    // them, satisfied once any one of them is taken.
    function fixedChecklist(wrap, groups) {
      var ul = document.createElement("ul"); ul.className = "progress-checklist";
      groups.forEach(function (codes) {
        var li = document.createElement("li");
        li.className = "progress-item" + (codes.some(isTaken) ? " done" : "") + (codes.length > 1 ? " or-group" : "");
        codes.forEach(function (code, i) {
          if (i > 0) {
            var orLabel = document.createElement("span"); orLabel.className = "progress-or"; orLabel.textContent = "or";
            li.appendChild(orLabel);
          }
          li.appendChild(makeRowButton(code));
        });
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
    // A single manual (non-course) checkbox, for whatever this data can't
    // verify on its own (Focus designations, the EB "approved science
    // course" escape hatch) -- backed by the same takenSet/toggleTaken.
    function manualCheckbox(wrap, key, label) {
      var row = document.createElement("label"); row.className = "progress-manual";
      var input = document.createElement("input"); input.type = "checkbox"; input.checked = isTaken(key);
      input.addEventListener("change", function () { toggleTaken(key); });
      var span = document.createElement("span"); span.textContent = label;
      row.appendChild(input); row.appendChild(span);
      wrap.appendChild(row);
    }

    // A major other than EE: its elective pools replace sections 2-4 below.
    var generic = genericAudit();

    // 1. Fixed requirements
    (function () {
      var groups = (generic && generic.fixed) || state.fixedGroups || codesWithCategory("fixed").map(function (c) { return [c]; });
      var done = groups.filter(function (g) { return g.some(isTaken); }).length;
      var wrap = section("Fixed requirements (" + done + " of " + groups.length + ")");
      fixedChecklist(wrap, groups);
    })();

    // 2. Major track (Group I / Group II)
    (function () {
      if (generic) return;
      var wrap = section("Major track");
      if (!state.track || !state.trackGroups[state.track]) {
        wrap.appendChild(note("Pick your track above (Electro-Physics or Systems & Data Sciences) to see Group I/II progress."));
        return;
      }
      var ts = trackStatus(state.track), track = ts.track;
      ["group1", "group2"].forEach(function (key, i) {
        var codes = track[key];
        var done = i === 0 ? ts.g1 : ts.g2;
        var required = track[key + "_required_credits"];
        var label = (i === 0 ? "Group I" : "Group II") + ": " + done + " / " + required + " credits";
        progressBar(wrap, done, required, label);
        checklist(wrap, codes);
      });
    })();

    // 3. Technical electives
    (function () {
      if (generic) return;
      var wrap = section("Technical electives");
      var te = teStatus(), rule = te.rule;
      progressBar(wrap, te.total, rule.required_credits, te.total + " / " + rule.required_credits + " credits");
      var subWrap = document.createElement("div"); subWrap.className = "progress-subchecks";
      var sub1 = document.createElement("span"); sub1.className = "progress-subcheck" + (te.outsideDone ? " done" : "");
      sub1.textContent = (te.outsideDone ? "✓ " : "○ ") + rule.outside_track_credits + " credits outside your track";
      var sub2 = document.createElement("span"); sub2.className = "progress-subcheck" + (te.labDone ? " done" : "");
      sub2.textContent = (te.labDone ? "✓ " : "○ ") + rule.lab_credits + " credit lab";
      subWrap.appendChild(sub1); subWrap.appendChild(sub2);
      wrap.appendChild(subWrap);
      checklist(wrap, codesWithCategory("te"));
      if (te.otherTrack.length || te.spill.length) {
        wrap.appendChild(note("Also counting from the track lists:"));
        checklist(wrap, te.otherTrack.concat(te.spill));
      }
      wrap.appendChild(note(te.trackChosen
        ? "Other tracks' courses and Group II courses past your track's minimum count here too (check sheet note 9)."
        : "Pick a track to also count other tracks' courses and extra Group II courses (check sheet note 9)."));
    })();

    // 4. Engineering breadth
    (function () {
      if (generic) return;
      var wrap = section("Engineering breadth");
      var eb = ebStatus(), rule = eb.rule;
      progressBar(wrap, eb.manual ? rule.required_credits : eb.credits, rule.required_credits,
        (eb.manual ? "satisfied via approved science course" : eb.credits + " / " + rule.required_credits + " credits"));
      checklist(wrap, eb.named.concat(eb.subjectTaken));
      wrap.appendChild(note("Any CEE, ME, ORE (Ocean) or BE course at the 300 level or higher also counts — find them in Checklist view."));
      manualCheckbox(wrap, EB_MANUAL_KEY, "Satisfied via a department-approved science course (not auto-detected)");
    })();

    // 2-4 for every other major: one section per elective pool. The taken
    // courses show outright; the full list of what counts (dozens of courses
    // for a technical-elective pool) folds away until asked for.
    (function () {
      if (!generic) return;
      if (generic.needsTrack) {
        section("Track").appendChild(note("Pick your track above to count its senior-year courses. Until then this shows the standard senior year."));
      }
      generic.pools.forEach(function (ps) {
        var pool = ps.pool;
        var wrap = section(pool.name);
        progressBar(wrap, ps.credits, pool.need, ps.credits + " / " + pool.need + " credits");
        if (pool.hint) wrap.appendChild(note(pool.hint));
        if (ps.taken.length) checklist(wrap, ps.taken);
        if (ps.skipped.length) {
          wrap.appendChild(note("Taken but not counting (over the limit of " +
            pool.limits.map(function (l) { return l.count + " " + l.label; }).join("; ") + "): " + ps.skipped.join(", ")));
        }
        var rest = pool.codes.filter(function (c) { return ps.taken.indexOf(c) === -1; });
        if (rest.length <= 12) { checklist(wrap, rest); return; }
        var det = document.createElement("details"); det.className = "progress-focus-list";
        var key = "pool-" + pool.id;
        det.open = !!state.focusOpen[key];
        var sum = document.createElement("summary"); sum.textContent = "Courses that count (" + rest.length + ")";
        det.appendChild(sum);
        function fill() {
          if (det.querySelector("ul")) return;
          var holder = document.createElement("div");
          checklist(holder, rest);
          det.appendChild(holder.firstChild);
        }
        if (det.open) fill();
        det.addEventListener("toggle", function () { state.focusOpen[key] = det.open; if (det.open) fill(); });
        wrap.appendChild(det);
      });
    })();

    // 5. Gen-ed diversification / foundations
    (function () {
      var wrap = section("General education");
      if (!state.genedCodes) { wrap.appendChild(note("No gen-ed data for this catalog year.")); return; }
      var tags = genedTags();
      tags.forEach(function (tag) {
        var g = genedStatus(tag);
        progressBar(wrap, g.complete ? g.rule.credits : g.done, g.rule.credits, tag + ": " + g.done + " / " + g.rule.credits + " credits");
      });
      if (!tags.length) wrap.appendChild(note("No diversification/foundation gen-ed data for this catalog year."));
    })();

    // 6. Focus (W/H/E/O). Counted from the courses marked taken, using STAR's
    // per-section data (state.focusByCode, treated as constant per course --
    // see focusOf()). The manual checkbox stays as an override for whatever
    // that can't see: transfer credit, an exception, a section STAR's data
    // missed. If the focus data never loaded, only the checkboxes show.
    (function () {
      var wrap = section("Focus requirements");
      if (!state.focusByCode) {
        wrap.appendChild(note("Focus course data didn't load — check these off yourself."));
        Object.keys(FOCUS_LABELS).forEach(function (k) { manualCheckbox(wrap, "__focus_" + k, FOCUS_LABELS[k]); });
        return;
      }
      ["W", "H", "E", "O"].forEach(function (k) {
        var p = focusProgress(k);
        var label = FOCUS_LABELS[k];
        var extra = Math.max(0, p.taken.length - p.need.courses);
        var text = k + ": " + (p.manual ? "satisfied manually"
          : Math.min(p.taken.length, p.need.courses) + " / " + p.need.courses + " course" + (p.need.courses === 1 ? "" : "s") +
            (p.need.upper ? " (" + Math.min(p.upper, p.need.upper) + " / " + p.need.upper + " upper-division)" : "") +
            (extra ? " +" + extra + " extra" : ""));
        // Only "satisfied" fills the bar: W with its course count met but too
        // few upper-division courses stops one short.
        var done = p.satisfied ? p.need.courses : Math.min(p.taken.length, p.need.courses - 1);
        var h = document.createElement("div"); h.className = "progress-focus-title"; h.textContent = label;
        wrap.appendChild(h);
        progressBar(wrap, done, p.need.courses, text);
        if (p.taken.length) {
          var ul = document.createElement("ul"); ul.className = "progress-checklist";
          p.taken.sort().forEach(function (code) {
            var li = document.createElement("li"); li.className = "progress-item done";
            li.appendChild(makeRowButton(code)); ul.appendChild(li);
          });
          wrap.appendChild(ul);
        }
        manualCheckbox(wrap, "__focus_" + k, "Satisfied another way (transfer credit, exception)");
        // Every catalog course that carries this Focus -- built only while
        // open, so the four lists (hundreds of rows for W) aren't paid for
        // on every taken-course toggle.
        var codes = Object.keys(state.focusByCode).filter(function (c) {
          return state.focusByCode[c].indexOf(k) !== -1 && nodes[c] && nodes[c].in_catalog;
        }).sort();
        var det = document.createElement("details"); det.className = "progress-focus-list";
        det.open = !!state.focusOpen[k];
        var sum = document.createElement("summary"); sum.textContent = "Courses with " + k + " Focus (" + codes.length + ")";
        det.appendChild(sum);
        function fill() {
          if (det.querySelector("ul")) return;
          var list = document.createElement("ul"); list.className = "progress-checklist";
          codes.forEach(function (code) {
            var li = document.createElement("li"); li.className = "progress-item" + (isTaken(code) ? " done" : "");
            li.appendChild(makeRowButton(code)); list.appendChild(li);
          });
          det.appendChild(list);
        }
        if (det.open) fill();
        det.addEventListener("toggle", function () { state.focusOpen[k] = det.open; if (det.open) fill(); });
        wrap.appendChild(det);
      });
      wrap.appendChild(note("Focus comes from STAR's Fall 2026 and earlier (back to Spring 2024) section data and is assumed never to change for a course — a course counts if any of its sections ever carried it."));
    })();
  }

  // Checklist mode (#btn-checklist): every enumerable requirement course
  // (fixed + the chosen track's Group I/II + Technical Electives +
  // Engineering Breadth) laid out as one big grid instead of the graph, so
  // there's no navigating/expanding to reach any of them. Each requirement
  // sits in its own box that lights up once met, the major track as one big
  // box around its Group I/II boxes. Gen-ed and Focus get status pills only
  // (credit buckets over the *whole* catalog, not a handful of named
  // courses), and EB's open-ended CEE/ME/ORE/BE rule gets collapsible
  // per-subject lists.
  // Clicking a tile is toggleTakenCascade(), not select()/navigation --
  // this view's whole point is "mark taken", not "go look at this course".
  function renderChecklistView() {
    var view = document.getElementById("checklist-view");
    if (!view) return;
    // Every taken toggle rebuilds this whole view; keep the reader's place.
    // Read before clearing -- emptying the view clamps its scroll to 0.
    var scrollTop = view.scrollTop;
    view.textContent = "";
    if (!state.graph || !state.relevantCategories || (!state.trackGroups && !state.pools)) {
      var empty = document.createElement("p");
      empty.className = "checklist-empty";
      empty.textContent = "Select your major in the filter above to see every requirement course on one screen.";
      view.appendChild(empty);
      return;
    }
    var intro = document.createElement("p");
    intro.className = "checklist-section-sub";
    intro.textContent = "Click a course to mark it taken — its whole prereq chain gets marked too. Click a taken course again to undo just that one. A box lights up once its requirement is met.";
    view.appendChild(intro);

    function sub(parent, text) {
      var p = document.createElement("p"); p.className = "checklist-section-sub"; p.textContent = text;
      parent.appendChild(p);
      return p;
    }
    // One requirement as a bordered box: title and status on top, an
    // optional progress bar, then whatever the caller fills into .body.
    // "complete" is what lights it up (see .req-box.complete in styles.css).
    function reqBox(parent, opts) {
      var box = document.createElement("section");
      box.className = "req-box" + (opts.cls ? " " + opts.cls : "") + (opts.complete ? " complete" : "");
      var head = document.createElement("div"); head.className = "req-head";
      var h = document.createElement(opts.sub ? "h4" : "h3"); h.textContent = opts.title;
      head.appendChild(h);
      if (opts.status) {
        var st = document.createElement("span"); st.className = "req-status";
        st.textContent = (opts.complete ? "✓ " : "") + opts.status;
        head.appendChild(st);
      }
      box.appendChild(head);
      if (opts.note) sub(box, opts.note);
      if (typeof opts.total === "number" && opts.total > 0) {
        var bar = document.createElement("div"); bar.className = "progress-bar req-bar";
        var fill = document.createElement("div"); fill.className = "progress-bar-fill";
        fill.style.width = Math.min(100, (opts.done / opts.total) * 100) + "%";
        bar.appendChild(fill); box.appendChild(bar);
      }
      parent.appendChild(box);
      return box;
    }
    function pill(parent, text, done, title) {
      var s = document.createElement("span"); s.className = "req-pill" + (done ? " done" : "");
      s.textContent = (done ? "✓ " : "○ ") + text;
      if (title) s.title = title;
      parent.appendChild(s);
    }
    function pills(parent) {
      var row = document.createElement("div"); row.className = "req-pills";
      parent.appendChild(row);
      return row;
    }
    // A collapsible extra list whose open state survives the rebuild every
    // taken toggle causes; its grid is only built while open.
    function foldout(parent, key, label, build) {
      var det = document.createElement("details"); det.className = "req-foldout";
      det.open = !!state.checklistOpen[key];
      var s = document.createElement("summary"); s.textContent = label;
      det.appendChild(s);
      function fill() { if (!det.querySelector(".req-foldout-body")) { var b = document.createElement("div"); b.className = "req-foldout-body"; det.appendChild(b); build(b); } }
      if (det.open) fill();
      det.addEventListener("toggle", function () { state.checklistOpen[key] = det.open; if (det.open) fill(); });
      parent.appendChild(det);
    }
    function creditsText(done, total) { return done + " / " + total + " credits"; }
    function makeTile(code) {
      var tile = document.createElement("button");
      tile.type = "button";
      tile.className = "checklist-tile" + (isTaken(code) ? " done" : "");
      var codeLine = document.createElement("span"); codeLine.className = "code";
      var mark = document.createElement("span"); mark.className = "mark"; mark.textContent = isTaken(code) ? "✓" : "";
      codeLine.appendChild(mark);
      codeLine.appendChild(document.createTextNode(code));
      var titleLine = document.createElement("span"); titleLine.className = "title"; titleLine.textContent = titleOf(code);
      tile.appendChild(codeLine); tile.appendChild(titleLine);
      var offer = offeringBadge(code, "tile-offer");
      if (offer) tile.appendChild(offer);
      var hard = diffBadge(code, "tile-offer tile-diff");
      if (hard) tile.appendChild(hard);
      tile.addEventListener("click", function () { toggleTakenCascade(code); });
      return tile;
    }
    function grid(wrap, codes) {
      var g = document.createElement("div"); g.className = "checklist-grid";
      codes.forEach(function (code) { g.appendChild(makeTile(code)); });
      wrap.appendChild(g);
    }
    // Fixed requirements only: a group of >1 codes is a real either/or
    // alternative (see build_ee_relevant_courses.py's "fixed_groups") --
    // rendered as one grid cell holding both/all tiles with "or" between
    // them, marked satisfied once any one of them is taken, instead of as
    // separate always-required tiles.
    function fixedGrid(wrap, groups) {
      var g = document.createElement("div"); g.className = "checklist-grid";
      groups.forEach(function (codes) {
        if (codes.length === 1) { g.appendChild(makeTile(codes[0])); return; }
        var orWrap = document.createElement("div");
        orWrap.className = "checklist-or-group" + (codes.some(isTaken) ? " done" : "");
        codes.forEach(function (code, i) {
          if (i > 0) {
            var orLabel = document.createElement("span"); orLabel.className = "checklist-or"; orLabel.textContent = "or";
            orWrap.appendChild(orLabel);
          }
          orWrap.appendChild(makeTile(code));
        });
        g.appendChild(orWrap);
      });
      wrap.appendChild(g);
    }

    var nodes = state.graph.nodes;

    // Every major but EE: required courses, then one box per elective pool.
    var generic = genericAudit();
    if (generic) {
      var gTags = genedTags();
      var gGenedDone = gTags.filter(function (t) { return genedStatus(t).complete; }).length;
      var gLetters = ["W", "H", "E", "O"];
      var gFocusDone = gLetters.filter(function (k) { return focusProgress(k).satisfied; }).length;
      var gSummary = document.createElement("div"); gSummary.className = "req-summary";
      var gChip = function (label, status, done) {
        var c = document.createElement("div"); c.className = "req-chip" + (done ? " done" : "");
        var l = document.createElement("span"); l.className = "req-chip-label"; l.textContent = (done ? "✓ " : "") + label;
        var st = document.createElement("span"); st.className = "req-chip-status"; st.textContent = status;
        c.appendChild(l); c.appendChild(st); gSummary.appendChild(c);
      };
      gChip("Fixed courses", generic.fixedDone + " / " + generic.fixed.length, generic.fixedDone === generic.fixed.length);
      generic.pools.forEach(function (ps) { gChip(ps.pool.name, ps.credits + " / " + ps.pool.need + " cr", ps.complete); });
      if (gTags.length) gChip("Gen-ed", gGenedDone + " / " + gTags.length, gGenedDone === gTags.length);
      gChip("Focus", gFocusDone + " / " + gLetters.length, gFocusDone === gLetters.length);
      view.appendChild(gSummary);

      if (generic.needsTrack) sub(view, "Pick your track above to count its senior-year courses — until then, the standard senior year is shown.");
      var gFixedBox = reqBox(view, {
        title: "Fixed requirements" + (generic.track ? " — " + generic.track.name : ""),
        status: generic.fixedDone + " of " + generic.fixed.length + " done",
        complete: generic.fixedDone === generic.fixed.length, done: generic.fixedDone, total: generic.fixed.length,
      });
      fixedGrid(gFixedBox, generic.fixed);

      generic.pools.forEach(function (ps) {
        var pool = ps.pool;
        var box = reqBox(view, {
          title: pool.name, status: creditsText(ps.credits, pool.need),
          complete: ps.complete, done: Math.min(ps.credits, pool.need), total: pool.need, note: pool.hint,
        });
        var row = pills(box);
        pill(row, pool.need + " credits", ps.complete);
        (pool.limits || []).forEach(function (l) {
          pill(row, "at most " + l.count + " " + l.label, true, l.codes.join(", "));
        });
        if (ps.skipped.length) sub(box, "Taken but not counting (over a limit above): " + ps.skipped.join(", "));
        // A short list shows whole; a long one (a technical-elective pool
        // is dozens of courses) shows what's taken and folds the rest away.
        if (pool.codes.length <= 24) { grid(box, pool.codes); return; }
        if (ps.taken.length) grid(box, ps.taken);
        var rest = pool.codes.filter(function (c) { return ps.taken.indexOf(c) === -1; });
        foldout(box, "pool-" + pool.id, "Every course that counts (" + rest.length + " more)", function (b) { grid(b, rest); });
      });

      var gAllDone = gGenedDone === gTags.length && gFocusDone === gLetters.length;
      var gBox = reqBox(view, {
        title: "General education & Focus", status: gAllDone ? "All met" : (gGenedDone + gFocusDone) + " of " + (gTags.length + gLetters.length) + " met",
        complete: gAllDone, note: "Mark these courses taken from the graph or the Find tab; they light up here automatically.",
      });
      if (gTags.length) {
        var gRow = pills(gBox);
        gTags.forEach(function (tag) {
          var g = genedStatus(tag);
          pill(gRow, tag + " " + Math.min(g.done, g.rule.credits) + "/" + g.rule.credits + " cr", g.complete, GENED_LABELS[tag] || tag);
        });
      }
      var gfRow = pills(gBox);
      gLetters.forEach(function (k) {
        var fp = focusProgress(k);
        pill(gfRow, k + " Focus " + (fp.manual ? "(manual)" : Math.min(fp.taken.length, fp.need.courses) + "/" + fp.need.courses), fp.satisfied, FOCUS_LABELS[k]);
      });
      view.scrollTop = scrollTop;
      return;
    }

    var fixedGroups = state.fixedGroups || codesWithCategory("fixed").map(function (c) { return [c]; });
    var fixedDone = fixedGroups.filter(function (g) { return g.some(isTaken); }).length;
    var chosen = state.track && state.trackGroups[state.track] ? state.track : null;
    var trackIds = chosen ? [chosen] : Object.keys(state.trackGroups);
    var tracks = trackIds.map(trackStatus);
    var te = teStatus(), eb = ebStatus();
    var tags = genedTags();
    var genedDone = tags.filter(function (t) { return genedStatus(t).complete; }).length;
    var focusLetters = ["W", "H", "E", "O"];
    var focusDone = focusLetters.filter(function (k) { return focusProgress(k).satisfied; }).length;

    // At-a-glance strip: one chip per requirement, lit once it's met.
    var summary = document.createElement("div"); summary.className = "req-summary";
    function chip(label, status, done) {
      var c = document.createElement("div"); c.className = "req-chip" + (done ? " done" : "");
      var l = document.createElement("span"); l.className = "req-chip-label"; l.textContent = (done ? "✓ " : "") + label;
      var s = document.createElement("span"); s.className = "req-chip-status"; s.textContent = status;
      c.appendChild(l); c.appendChild(s); summary.appendChild(c);
    }
    chip("Fixed courses", fixedDone + " / " + fixedGroups.length, fixedDone === fixedGroups.length);
    if (chosen) chip("Major track (" + chosen + ")", tracks[0].complete ? "complete" : (tracks[0].g1 + tracks[0].g2) + " / " +
      (tracks[0].track.group1_required_credits + tracks[0].track.group2_required_credits) + " cr", tracks[0].complete);
    else chip("Major track", "pick a track", false);
    chip("Technical electives", te.total + " / " + te.rule.required_credits + " cr", te.complete);
    chip("Engineering breadth", eb.manual ? "approved" : eb.credits + " / " + eb.rule.required_credits + " cr", eb.complete);
    if (tags.length) chip("Gen-ed", genedDone + " / " + tags.length, genedDone === tags.length);
    chip("Focus", focusDone + " / " + focusLetters.length, focusDone === focusLetters.length);
    view.appendChild(summary);

    // Fixed requirements
    var fixedBox = reqBox(view, {
      title: "Fixed requirements", status: fixedDone + " of " + fixedGroups.length + " done",
      complete: fixedDone === fixedGroups.length, done: fixedDone, total: fixedGroups.length,
    });
    fixedGrid(fixedBox, fixedGroups);

    // Major track: one big box per track, Group I and Group II boxed inside
    // it. With no track picked, every track shows so you can compare.
    if (!chosen) sub(view, "Pick your track above to count only that one — until then, every track is shown.");
    tracks.forEach(function (ts) {
      var t = ts.track;
      var need = t.group1_required_credits + t.group2_required_credits;
      var have = Math.min(ts.g1, t.group1_required_credits) + Math.min(ts.g2, t.group2_required_credits);
      var box = reqBox(view, {
        title: "Major track — " + t.name, status: ts.complete ? "Track complete" : creditsText(have, need),
        complete: ts.complete, done: have, total: need, cls: "req-track",
      });
      var inner = document.createElement("div"); inner.className = "req-track-groups";
      box.appendChild(inner);
      var g1 = reqBox(inner, {
        title: "Group I — all of these", status: creditsText(ts.g1, t.group1_required_credits),
        complete: ts.g1Done, done: ts.g1, total: t.group1_required_credits, sub: true,
      });
      grid(g1, t.group1);
      var g2 = reqBox(inner, {
        title: "Group II — pick " + t.group2_required_credits + " credits", status: creditsText(ts.g2, t.group2_required_credits),
        complete: ts.g2Done, done: Math.min(ts.g2, t.group2_required_credits), total: t.group2_required_credits, sub: true,
        note: ts.spill.length ? "Extra beyond " + t.group2_required_credits + " credits counts toward Technical Electives: " + ts.spill.join(", ") : null,
      });
      grid(g2, t.group2);
    });

    // Technical electives
    var teBox = reqBox(view, {
      title: "Technical electives", status: creditsText(te.total, te.rule.required_credits),
      complete: te.complete, done: Math.min(te.total, te.rule.required_credits), total: te.rule.required_credits,
      note: "ECE 300+ courses from the track lists (note 9), plus the extra courses below.",
    });
    var teRow = pills(teBox);
    pill(teRow, te.rule.required_credits + " credits total", te.totalDone);
    pill(teRow, te.rule.outside_track_credits + " credits outside your track", te.outsideDone,
      te.trackChosen ? "" : "Pick a track to count other tracks' courses here");
    pill(teRow, te.rule.lab_credits + " credit lab", te.labDone);
    grid(teBox, codesWithCategory("te"));
    if (te.otherTrack.length || te.spill.length) {
      sub(teBox, "Also counting from the track lists:");
      grid(teBox, te.otherTrack.concat(te.spill));
    }
    if (chosen) {
      var mine = trackCodeSet(chosen), others = {};
      Object.keys(state.trackGroups).forEach(function (id) {
        if (id !== chosen) Object.keys(trackCodeSet(id)).forEach(function (c) { if (!mine[c]) others[c] = true; });
      });
      var otherCodes = Object.keys(others).sort();
      if (otherCodes.length) {
        foldout(teBox, "te-other", "Other tracks' courses — count as TE outside your track (" + otherCodes.length + ")",
          function (b) { grid(b, otherCodes); });
      }
    }

    // Engineering breadth
    var ebBox = reqBox(view, {
      title: "Engineering breadth", status: eb.manual ? "Approved science course" : creditsText(eb.credits, eb.rule.required_credits),
      complete: eb.complete, done: eb.manual ? eb.rule.required_credits : Math.min(eb.credits, eb.rule.required_credits), total: eb.rule.required_credits,
      note: "CEE 270, or any CEE, ME, Ocean (ORE) or BE course at the 300 level or higher. A 300+ physical, biological or computer science course also works with department approval.",
    });
    grid(ebBox, eb.named.concat(eb.subjectTaken));
    var ebManual = document.createElement("label"); ebManual.className = "progress-manual";
    var ebInput = document.createElement("input"); ebInput.type = "checkbox"; ebInput.checked = eb.manual;
    ebInput.addEventListener("change", function () { toggleTaken(EB_MANUAL_KEY); });
    var ebSpan = document.createElement("span"); ebSpan.textContent = "Satisfied with a department-approved science course";
    ebManual.appendChild(ebInput); ebManual.appendChild(ebSpan); ebBox.appendChild(ebManual);
    EB_SUBJECTS.forEach(function (subj) {
      // 300-400 level only: 500+ are graduate courses an undergrad rarely takes.
      var codes = Object.keys(nodes).filter(function (c) {
        var n = nodes[c];
        return n.in_catalog && n.subject === subj && courseNumber(c) >= 300 && courseNumber(c) < 500;
      }).sort();
      if (!codes.length) return;
      foldout(ebBox, "eb-" + subj, subj + " — " + EB_SUBJECT_LABELS[subj] + " Engineering, 300–400 level (" + codes.length + ")",
        function (b) { grid(b, codes); });
    });

    // Gen-ed and Focus: open buckets over the whole catalog, not a short
    // course list, so these are status pills only -- mark the courses taken
    // from the graph or the "Find by requirement" tab.
    var gfDone = genedDone === tags.length && focusDone === focusLetters.length;
    var gfBox = reqBox(view, {
      title: "General education & Focus", status: gfDone ? "All met" : (genedDone + focusDone) + " of " + (tags.length + focusLetters.length) + " met",
      complete: gfDone, note: "Mark these courses taken from the graph or the Find tab; they light up here automatically.",
    });
    if (tags.length) {
      var gRow = pills(gfBox);
      tags.forEach(function (tag) {
        var g = genedStatus(tag);
        pill(gRow, tag + " " + Math.min(g.done, g.rule.credits) + "/" + g.rule.credits + " cr", g.complete, GENED_LABELS[tag] || tag);
      });
    }
    var fRow = pills(gfBox);
    focusLetters.forEach(function (k) {
      var p = focusProgress(k);
      pill(fRow, k + " Focus " + (p.manual ? "(manual)" : Math.min(p.taken.length, p.need.courses) + "/" + p.need.courses), p.satisfied, FOCUS_LABELS[k]);
    });

    view.scrollTop = scrollTop;
  }

  // Graduation Map (#btn-gradmap): a real prereq graph -- actual courses,
  // actual prereq edges -- of every graduation-requirement course at once,
  // instead of one focal course's windowed chain. Built into its own
  // Cytoscape instance (state.gradCy, #gradmap-cy) so toggling modes never
  // tears down the main windowed graph's own instance (state.cy).
  //
  // Node set: the same enumerable requirement courses as the Checklist grid
  // (fixed + chosen track's Group I/II + TE + EB), PLUS every course
  // transitively reachable from those via a real prereq_tree (so the actual
  // dependency chains feeding into a requirement course are visible, not
  // just the requirement courses in isolation) -- those extra "context"
  // courses render dimmed (relevance="dim", the same style rule the main
  // graph's major filter already uses for "outside your major"), same as a
  // normal search result you haven't required. Gen-ed's open slots (no one
  // specific required course -- see GRAD_PLACEHOLDERS above) and the
  // "any_level" bucket (not actually required, just other ECE/EE courses)
  // are both left off deliberately. A course (or placeholder) already
  // marked taken is left off too -- this map's whole point is showing what's
  // still ahead, and a course you've finished has nothing left to plan
  // around; its edges just drop with it, so whatever depended on it now
  // shows one fewer incoming arrow instead of a dangling one.
  //
  // Edges are direct (one-hop) prereq relationships only, flattened past
  // AND/OR the same way collectAllCourseLeaves()/toggleTakenCascade()
  // already are -- the main graph's dashed "pick one of N" group boxes need
  // a single focal course to anchor each group's layout, which this
  // multi-root view doesn't have; showing every real edge plainly, without
  // that grouping, is the tradeoff made for a legible "everything at once"
  // map instead.
  //
  // Layout is a force-directed spring embedder -- repulsion between every
  // pair of nodes, springs along real edges -- the same idea a knowledge-
  // graph tool like Obsidian's graph view uses, NOT the main graph's own
  // rigid column-per-depth layout. A hard column pinned to depth actively
  // fights the one thing this view is for: a course chain with no other
  // connection to the rest of the requirements (ECE 296 -> 396 -> 496 was
  // the case that gave this away -- three nodes whose only edges are to
  // each other, forced to sit in the middle of the busiest part of the map
  // purely because their *depth* landed there) has nothing pulling it
  // toward everyone else, so with no rigid column pull in the way, mutual
  // repulsion alone pushes it out to its own space -- exactly where an
  // unconnected cluster belongs.
  //
  // Two things hold the picture together without reintroducing that
  // problem: a very weak spring toward the live centroid of every node
  // (centerGravity), just enough that the graph doesn't drift off into
  // empty space forever; and depthPullX, an even weaker *directional* bias
  // nudging each node's x only (never y) toward its own prereq-depth
  // column (same "fewer prereqs on the left, more on the right" reading
  // the main graph uses) without pinning it there -- a stray isolated node
  // still gets pushed well clear of a crowd at a similar depth by
  // repulsion, it's just nudged toward roughly the right neighborhood
  // first. Both are an order of magnitude weaker than repulsion/springEdge
  // on purpose: strong enough to read as "generally flows left to right",
  // nowhere near strong enough to drag an outlying cluster back into a
  // crowd or recreate the original column-based overlap.
  //
  // A parallel engine (gradPhysicsBuild/gradPhysicsTick below), not the
  // main graph's own PHYSICS/physicsBuild/physicsTick -- those are
  // hardwired to state.cy and to compound "pick one of N" group boxes this
  // map doesn't draw; reworking them to serve two very different layouts
  // off one shared implementation risked regressing the main graph's own
  // carefully-tuned behavior for no real benefit.
  //
  // minDistance is generous relative to a typical node's drawn width/height
  // (nodeWidthEstimate()/28px tall) specifically so settled nodes end up
  // with real visible gaps between them, not just non-overlapping by a
  // pixel -- the whole point of switching off the column layout was more
  // breathing room, not just moving the crowding around.
  var GRAD_PHYSICS = {
    repulsion: 9000, minDistance: 110, springEdge: 0.02, edgeLength: 130,
    centerGravity: 0.0025, depthPullX: 0.006, colWidth: 150,
    damping: 0.82, settleEnergy: 3,
  };
  var gradPhysics = { bodies: {}, edges: [], running: false, rafId: null };

  function gradPhysicsBuild() {
    var cy = state.gradCy;
    if (!cy) return;
    // Placeholders (no prereq depth of their own -- see GRAD_PLACEHOLDERS)
    // target one column past the deepest real course, the same "open
    // requirement, nothing feeds into it" spot renderGradMap()'s own
    // initial seed already puts them in.
    var maxDepth = 0;
    cy.nodes().forEach(function (n) {
      var d = n.data("depth");
      if (typeof d === "number" && d > maxDepth) maxDepth = d;
    });
    var bodies = {};
    cy.nodes().forEach(function (n) {
      var id = n.id();
      var pos = n.position();
      var prev = gradPhysics.bodies[id];
      var depth = n.data("depth");
      var targetX = (typeof depth === "number" ? depth : maxDepth + 1) * GRAD_PHYSICS.colWidth;
      // The preset column/row position (renderGradMap()'s initial seed) is
      // just a starting point for x/y -- targetX is the ongoing, much
      // weaker directional pull (see the big comment above GRAD_PHYSICS);
      // there's still no homeY at all, y stays fully free.
      bodies[id] = { x: pos.x, y: pos.y, vx: prev ? prev.vx : 0, vy: prev ? prev.vy : 0, targetX: targetX, grabbed: false };
    });
    gradPhysics.bodies = bodies;

    var edges = [];
    cy.edges().forEach(function (e) {
      var a = e.source().id(), b = e.target().id();
      if (bodies[a] && bodies[b]) edges.push([a, b]);
    });
    gradPhysics.edges = edges;

    gradPhysicsWake();
  }

  function gradPhysicsWake() {
    if (gradPhysics.running) return;
    gradPhysics.running = true;
    gradPhysics.rafId = requestAnimationFrame(gradPhysicsTick);
  }

  function gradPhysicsTick() {
    var cy = state.gradCy;
    if (!cy) { gradPhysics.running = false; return; }
    var bodies = gradPhysics.bodies;
    var ids = Object.keys(bodies);
    var forces = {};
    ids.forEach(function (id) { forces[id] = { x: 0, y: 0 }; });

    for (var i = 0; i < ids.length; i++) {
      var a = bodies[ids[i]];
      for (var j = i + 1; j < ids.length; j++) {
        var b = bodies[ids[j]];
        var dx = a.x - b.x, dy = a.y - b.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var d = Math.max(dist, GRAD_PHYSICS.minDistance);
        var f = GRAD_PHYSICS.repulsion / (d * d);
        var fx = (dx / dist) * f, fy = (dy / dist) * f;
        forces[ids[i]].x += fx; forces[ids[i]].y += fy;
        forces[ids[j]].x -= fx; forces[ids[j]].y -= fy;
      }
    }

    gradPhysics.edges.forEach(function (pair) {
      var a = bodies[pair[0]], b = bodies[pair[1]];
      if (!a || !b) return;
      var dx = b.x - a.x, dy = b.y - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      var f = GRAD_PHYSICS.springEdge * (dist - GRAD_PHYSICS.edgeLength);
      var fx = (dx / dist) * f, fy = (dy / dist) * f;
      forces[pair[0]].x += fx; forces[pair[0]].y += fy;
      forces[pair[1]].x -= fx; forces[pair[1]].y -= fy;
    });

    // Weak pull toward the live centroid, not any node's own fixed home --
    // see the big comment above GRAD_PHYSICS for why: this is the only
    // thing keeping the whole picture from drifting apart indefinitely,
    // and it's deliberately too weak to drag an isolated cluster back
    // in against its own repulsion from everything else.
    var cx = 0, cy0 = 0;
    ids.forEach(function (id) { cx += bodies[id].x; cy0 += bodies[id].y; });
    cx /= ids.length; cy0 /= ids.length;
    ids.forEach(function (id) {
      forces[id].x += (cx - bodies[id].x) * GRAD_PHYSICS.centerGravity;
      forces[id].y += (cy0 - bodies[id].y) * GRAD_PHYSICS.centerGravity;
    });

    // Weak directional bias, x only -- "fewer prereqs on the left, more on
    // the right" (see the big comment above GRAD_PHYSICS for how this
    // differs from a hard column pin).
    ids.forEach(function (id) {
      forces[id].x += (bodies[id].targetX - bodies[id].x) * GRAD_PHYSICS.depthPullX;
    });

    var totalSpeed = 0;
    ids.forEach(function (id) {
      var body = bodies[id];
      if (body.grabbed) { body.vx = 0; body.vy = 0; return; }
      body.vx = (body.vx + forces[id].x) * GRAD_PHYSICS.damping;
      body.vy = (body.vy + forces[id].y) * GRAD_PHYSICS.damping;
      body.x += body.vx;
      body.y += body.vy;
      totalSpeed += Math.abs(body.vx) + Math.abs(body.vy);
    });

    cy.batch(function () {
      ids.forEach(function (id) {
        var body = bodies[id];
        var n = cy.getElementById(id);
        if (n.length) n.position({ x: body.x, y: body.y });
      });
    });

    if (totalSpeed < GRAD_PHYSICS.settleEnergy) {
      gradPhysics.running = false;
      return;
    }
    gradPhysics.rafId = requestAnimationFrame(gradPhysicsTick);
  }

  // The most courses an open elective pool can have and still be drawn on
  // the Graduation Map (see the generic branch in renderGradMap()).
  var GRAD_POOL_MAX = 16;
  function renderGradMap(opts) {
    opts = opts || {};
    var view = document.getElementById("gradmap-cy");
    if (!view) return;
    if (!state.graph || !state.relevantCategories || (!state.trackGroups && !state.pools)) {
      if (state.gradCy) { state.gradCy.destroy(); state.gradCy = null; }
      view.textContent = "";
      var empty = document.createElement("p");
      empty.className = "checklist-empty";
      empty.textContent = "Select your major in the filter above to see the graduation map.";
      view.appendChild(empty);
      return;
    }
    // A taken toggle rebuilds this map (taken courses are omitted below, not
    // just re-styled, so the node set itself changes) -- without this,
    // marking one course would snap the view back to a fresh fit every
    // time, which is disorienting mid-click. Structural changes (filter/
    // track/catalog switch, or the first build) don't pass this: a fresh
    // view is exactly right there, since the whole node set is new anyway.
    var savedPan = opts.preserveViewport && state.gradCy ? state.gradCy.pan() : null;
    var savedZoom = opts.preserveViewport && state.gradCy ? state.gradCy.zoom() : null;
    view.textContent = "";
    var nodes = state.graph.nodes;
    var t = tokens();
    var FONT = state.mobile ? 13 : 11;

    // Only requirements still open contribute courses: once one is met, its
    // remaining untaken options (the other half of an either/or, the rest
    // of Group II, every other TE or EB choice) have nothing left to plan
    // around and drop off the map, prereq chains and all.
    var required = {};
    // The untaken half of a satisfied either/or ("ECE 160 or ECE 110") --
    // kept out of the prereq chains below too, or it'd sneak back in as
    // context (ECE 110 is also an OR-prereq of ECE 260).
    var settled = {};
    function add(c) { required[c] = true; }
    var generic = genericAudit();
    ((generic && generic.fixed) || state.fixedGroups || codesWithCategory("fixed").map(function (c) { return [c]; })).forEach(function (g) {
      if (!g.some(isTaken)) g.forEach(add);
      else g.forEach(function (c) { if (!isTaken(c)) settled[c] = true; });
    });
    if (generic) {
      // An open pool's options go on the map only when it's a short list (a
      // handful of named courses). "Any ME 400-level course" is dozens of
      // nodes with nothing tying them together -- that's what Checklist's
      // foldout is for, not this map.
      generic.pools.forEach(function (ps) {
        if (!ps.complete && ps.pool.codes.length <= GRAD_POOL_MAX) ps.pool.codes.forEach(add);
      });
    } else {
      if (state.track && state.trackGroups[state.track]) {
        var ts = trackStatus(state.track);
        if (!ts.g1Done) ts.track.group1.forEach(add);
        if (!ts.g2Done) ts.track.group2.forEach(add);
      }
      if (!teStatus().complete) codesWithCategory("te").forEach(add);
      if (!ebStatus().complete) codesWithCategory("eb").forEach(add);
    }

    // Transitive closure -> every course that belongs on the map at all
    // (required courses plus whatever real prereq chain feeds into them).
    var included = {};
    Object.keys(required).forEach(function (c) { included[c] = true; });
    Object.keys(required).forEach(function (c) {
      var trans = collectTransitivePrereqs(c);
      Object.keys(trans).forEach(function (p) { if (nodes[p] && !settled[p]) included[p] = true; });
    });

    // colWidth matches GRAD_PHYSICS.colWidth (the ongoing depthPullX target
    // spacing) so the initial seed already roughly agrees with where
    // physics will keep nudging things -- one number, not two that could
    // drift out of sync.
    var colWidth = GRAD_PHYSICS.colWidth, rowH = 42;
    var columns = {};
    Object.keys(included).sort().forEach(function (code) {
      if (state.takenSet[code]) return; // already done -- see the big comment above
      var n = nodes[code];
      var depth = (n && typeof n.depth === "number") ? Math.max(0, Math.min(9, n.depth)) : 0;
      (columns[depth] = columns[depth] || []).push(code);
    });

    var els = [];
    var edgeSeen = {};
    Object.keys(columns).forEach(function (depthKey) {
      var depth = Number(depthKey);
      columns[depthKey].forEach(function (code, i) {
        var n = nodes[code];
        var data = {
          id: code, label: diffLabel(code), title: n.title || "", depth: n.depth, status: n.depth_status,
          inCatalog: !!n.in_catalog,
        };
        if (!required[code]) data.relevance = "dim";
        var cat = state.relevantCategories[code];
        if (cat) data.category = cat;
        els.push({ data: data, position: { x: depth * colWidth, y: i * rowH } });

        if (n.prereq_tree) {
          collectAllCourseLeaves(n.prereq_tree).forEach(function (p) {
            // Not on the map at all -- either genuinely unreachable (shouldn't
            // happen, but don't draw a dangling edge if it does) or already
            // taken and left off on purpose.
            if (!included[p] || state.takenSet[p]) return;
            var key = p + "->" + code;
            if (edgeSeen[key]) return;
            edgeSeen[key] = true;
            els.push({ data: { id: key, source: p, target: code, kind: "prereq" } });
          });
        }
      });
    });

    var placeholderDepth = Object.keys(columns).length
      ? Math.max.apply(null, Object.keys(columns).map(Number)) + 1 : 0;
    GRAD_PLACEHOLDERS.forEach(function (ph, i) {
      if (state.takenSet[ph.id]) return;
      // A Focus placeholder drops off once the courses marked taken already
      // satisfy it (or the manual override is on) -- same as a taken course.
      if (ph.focus && focusProgress(ph.focus).satisfied) return;
      // Same for gen-ed slots, once the courses marked taken cover them.
      if (ph.gened && ph.gened.some(function (tag) { return state.genedCodes && tag in state.genedCodes && genedStatus(tag).complete; })) return;
      els.push({
        data: { id: ph.id, label: ph.label, title: ph.title, placeholder: true },
        position: { x: placeholderDepth * colWidth, y: i * rowH }
      });
    });

    if (state.gradCy) state.gradCy.destroy();
    state.gradCy = cytoscape({
      container: view,
      elements: els,
      layout: { name: "preset" },
      userZoomingEnabled: true, userPanningEnabled: true, boxSelectionEnabled: false,
      autoungrabify: state.mobile,
      minZoom: 0.05, maxZoom: 4,
      style: [
        { selector: "node", style: {
          "shape": "round-rectangle",
          "width": function (ele) { return nodeWidthEstimate(ele.data("label")); },
          "height": 28, "padding": "7px",
          "background-color": function (ele) { return nodeColor(t, ele); },
          "label": "data(label)", "color": t.ink, "font-family": "IBM Plex Mono, monospace",
          "font-size": FONT, "font-weight": 600, "text-valign": "center", "text-halign": "center",
          "border-width": 1, "border-color": t.hairline
        }},
        { selector: "node[?placeholder]", style: { "border-style": "dashed", "background-color": t.surface, "color": t.ink2 } },
        { selector: "node[status = 'cycle']", style: { "border-width": 2, "border-color": t.critical } },
        { selector: "node[!inCatalog]", style: { "border-style": "dashed", "background-opacity": 0.5, "color": t.ink2 } },
        // No node[?taken] rule here (unlike the main graph's own) -- a
        // taken course is never added to this map at all (see above), so
        // there's nothing left to style differently for it.
        { selector: "node[relevance = 'dim']", style: { "opacity": 0.4 } },
        { selector: "edge", style: {
          "curve-style": "bezier", "width": 1.4, "target-arrow-shape": "triangle", "arrow-scale": 0.8,
          "line-color": t.edgePrereq, "target-arrow-color": t.edgePrereq
        }},
        // "Deepest chains" (applyGradDeepest()) -- last so they win over the
        // relevance dimming above: a context prereq on the longest chain
        // matters as much as the requirement it feeds.
        { selector: ".deep-dim", style: { "opacity": 0.12 } },
        { selector: "node.deep", style: { "opacity": 1, "border-width": 3, "border-color": t.accent } },
        { selector: "edge.deep", style: {
          "opacity": 1, "width": 3, "line-color": t.accent, "target-arrow-color": t.accent, "z-index": 10
        }},
        // The course whose details are open (single click).
        { selector: "node.viewing", style: { "opacity": 1, "border-width": 3, "border-color": t.ink } }
      ]
    });

    gradPhysicsBuild();
    // Same grab/drag/free -> physics-body handoff as the main graph's own
    // (see the "Dragging a node..." comment above physicsBuild's own
    // wiring): while held, physics stops writing that node's position but
    // everything else keeps reacting to wherever the mouse puts it in real
    // time; releasing it hands it back.
    state.gradCy.on("grab", "node", function (evt) {
      var body = gradPhysics.bodies[evt.target.id()];
      if (body) body.grabbed = true;
    });
    state.gradCy.on("drag", "node", function (evt) {
      var body = gradPhysics.bodies[evt.target.id()];
      if (!body) return;
      var p = evt.target.position();
      body.x = p.x; body.y = p.y; body.vx = 0; body.vy = 0;
      gradPhysicsWake();
    });
    state.gradCy.on("free", "node", function (evt) {
      var body = gradPhysics.bodies[evt.target.id()];
      if (body) body.grabbed = false;
      gradPhysicsWake();
    });

    // Single click views the course, double click marks it done. Viewing
    // doesn't touch the map, so it runs right away (no waiting out a
    // possible second click); only the second click of a double -- by the
    // browser's own click count, or a second tap on the same node within
    // CLICK_DELAY_MS for touch -- marks it taken, which rebuilds the map.
    var lastTap = null;
    state.gradCy.on("tap", "node", function (evt) {
      var d = evt.target.data(), now = Date.now();
      var isRepeat = (evt.originalEvent && evt.originalEvent.detail > 1) ||
        (lastTap && lastTap.id === d.id && now - lastTap.at < CLICK_DELAY_MS);
      lastTap = isRepeat ? null : { id: d.id, at: now };
      if (isRepeat) {
        if (d.placeholder) toggleTaken(d.id); else toggleTakenCascade(d.id);
        return;
      }
      // View this course's details without leaving the map (no
      // renderGraph()/select() -- those would replace this view).
      if (d.placeholder) return;
      state.gradCy.nodes(".viewing").removeClass("viewing");
      evt.target.addClass("viewing");
      state.focal = d.id; renderDetail(d.id); setDetailOpen(true);
    });
    state.gradCy.on("mouseover", "node", function () { view.style.cursor = "pointer"; });
    state.gradCy.on("mouseout", "node", function () { view.style.cursor = ""; });

    if (savedPan && savedZoom != null) {
      state.gradCy.zoom(savedZoom);
      state.gradCy.pan(savedPan);
    }
    applyGradDeepest();
  }

  // "Deepest chains" on the Graduation Map: the prereq chain(s) that take
  // the most semesters to get through, counting only courses still on the
  // map (taken ones are gone, so this is what's *left*). Evaluated on the
  // real prereq_tree with graph.py's compute_depths() rules, not the map's
  // flattened edges -- those draw every OR alternative as an arrow, so a
  // plain longest path would march through all of them. Here:
  //   - sem(c) = 1 + tree(c's prereqs): the earliest semester c can finish
  //   - course leaf: sem(leaf); "(or concurrent)" leaf: sem(leaf) - 1, since
  //     it can share c's semester; a leaf not on the map (taken) is 0
  //   - AND: max; OR: min, preferring course-bearing branches over a bare
  //     consent/standing/placement escape (same as graph.py, or "or consent"
  //     would flatten everything); N_OF(n): the n-th smallest
  // The courses that actually bind a maximal sem() -- walked back through
  // whichever branch set each value -- get .deep, everything else
  // .deep-dim. Returns that semester count (0 when off or empty).
  function applyGradDeepest() {
    var cy = state.gradCy;
    if (!cy) return 0;
    cy.elements().removeClass("deep deep-dim");
    if (!state.gradDeepest) return 0;
    var nodes = state.graph.nodes;
    function onMap(code) { var n = cy.getElementById(code); return n.length > 0 && !n.data("placeholder"); }
    function mentionsCourse(t) { return !!t && (!!t.course || (t.children || []).some(mentionsCourse)); }

    var semMemo = {}, visiting = {};
    function sem(code) {
      if (semMemo[code] != null) return semMemo[code];
      if (visiting[code]) return 0; // prereq cycle: the back edge doesn't extend the chain
      visiting[code] = true;
      var n = nodes[code];
      var v = 1 + (n && n.prereq_tree ? treeVal(n.prereq_tree) : 0);
      visiting[code] = false;
      return (semMemo[code] = v);
    }
    function leafVal(t) {
      if (!onMap(t.course)) return 0;
      return t.concurrent ? sem(t.course) - 1 : sem(t.course);
    }
    function orPool(t) {
      var idx = t.children.map(function (c, i) { return i; });
      var courseIdx = idx.filter(function (i) { return mentionsCourse(t.children[i]); });
      return courseIdx.length ? courseIdx : idx;
    }
    function childVals(t) { return (t.children || []).map(treeVal); }
    function treeVal(t) {
      if (t.course) return leafVal(t);
      var vals = childVals(t);
      if (!vals.length) return 0;
      if (t.op === "AND") return Math.max.apply(null, vals);
      if (t.op === "OR") return Math.min.apply(null, orPool(t).map(function (i) { return vals[i]; }));
      if (t.op === "N_OF") {
        var sorted = vals.slice().sort(function (a, b) { return a - b; });
        return sorted[Math.min(t.n || sorted.length, sorted.length) - 1];
      }
      return 0;
    }
    // Course leaves inside t whose contribution equals target -- the ones
    // actually holding the value up (every tying branch, not just one).
    function binding(t, target, out) {
      if (target <= 0) return out;
      if (t.course) { if (onMap(t.course) && leafVal(t) === target) out.push(t.course); return out; }
      var kids = t.children || [];
      var vals = childVals(t);
      var pool = t.op === "OR" ? orPool(t) : kids.map(function (c, i) { return i; });
      pool.forEach(function (i) { if (vals[i] === target) binding(kids[i], target, out); });
      return out;
    }

    var max = 0;
    cy.nodes().forEach(function (n) { if (!n.data("placeholder")) max = Math.max(max, sem(n.id())); });
    if (!max) return 0;
    var deep = {}, deepEdges = {}, queue = [];
    cy.nodes().forEach(function (n) { if (!n.data("placeholder") && sem(n.id()) === max) { deep[n.id()] = true; queue.push(n.id()); } });
    while (queue.length) {
      var code = queue.shift(), n = nodes[code];
      if (!n || !n.prereq_tree) continue;
      // leafVal() already folds in the concurrent -1, so one target covers both.
      binding(n.prereq_tree, sem(code) - 1, []).forEach(function (p) {
        deepEdges[p + "->" + code] = true;
        if (!deep[p]) { deep[p] = true; queue.push(p); }
      });
    }
    cy.batch(function () {
      cy.elements().addClass("deep-dim");
      Object.keys(deep).forEach(function (id) { cy.getElementById(id).removeClass("deep-dim").addClass("deep"); });
      Object.keys(deepEdges).forEach(function (id) { cy.getElementById(id).removeClass("deep-dim").addClass("deep"); });
    });
    return max;
  }

  loadGraph(initialCatalog).then(function () {
    updateFilterAvailability();
    var storedFilterId = readStoredFilterId();
    if (storedFilterId && storedFilterId !== "none") setFilterProgram(storedFilterId);
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

  // The course named by ?course= in the address, if it exists in the data.
  // Forgiving about letter case and stray spaces ("ece  367" finds ECE 367).
  function requestedCourse(graph) {
    var raw = new URLSearchParams(location.search).get("course");
    if (!raw) return null;
    var code = raw.trim().replace(/\s+/g, " ").toUpperCase();
    return graph.nodes[code] ? code : null;
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
    // "Deepest chain in the whole 8,700-course catalog" is nearly always
    // some unrelated sequence with nothing to do with the filtered major --
    // rank among only the relevant courses instead, same as everywhere else
    // the filter applies.
    if (filterActive()) codes = codes.filter(isRelevant);

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
      { id: "cycles", label: "Circular (" + cyclic.length + ")", items: cyclic },
      // Unlike the other four (ranked lists over the whole catalog), this
      // pane's content depends on per-student state (taken courses, chosen
      // track) that changes far more often than a catalog/filter switch --
      // its DOM is filled separately by renderProgressPane() right below,
      // not from an "items" list like the others.
      { id: "progress", label: "My Progress", progress: true },
      // Also not a ranked list: a filter (focus + gen-ed chips, text box)
      // whose controls and results renderFindPane() builds.
      { id: "find", label: "Find by requirement", find: true }
    ];

    var tabsEl = document.getElementById("tabs");
    var panesEl = document.getElementById("highlight-panes");
    // Switching catalogs calls this again on the same page -- without
    // clearing first, the old tabs/panes (and their duplicate "pane-<id>"
    // element ids) just stayed and a second identical set piled up next to
    // them.
    tabsEl.textContent = "";
    panesEl.textContent = "";
    // Reopens on whichever tab was open before (e.g. after a catalog
    // switch) rather than always resetting to the first one; falls back to
    // that first tab if the remembered id doesn't match one of these (it
    // always will today -- the four ids never change -- but a viewer's
    // stored id from a future version with different tabs shouldn't crash).
    var openId = tabs.some(function (t) { return t.id === state.highlightTab; }) ? state.highlightTab : tabs[0].id;
    state.highlightTab = openId;
    tabs.forEach(function (tab) {
      var isOpen = tab.id === openId;
      var btn = document.createElement("button");
      btn.textContent = tab.label; btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", isOpen ? "true" : "false");
      btn.addEventListener("click", function () {
        state.highlightTab = tab.id;
        tabsEl.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-selected", "false"); });
        panesEl.querySelectorAll(".highlight-pane").forEach(function (p) { p.hidden = true; });
        btn.setAttribute("aria-selected", "true");
        document.getElementById("pane-" + tab.id).hidden = false;
      });
      tabsEl.appendChild(btn);

      var pane = document.createElement("div");
      pane.className = "highlight-pane"; pane.id = "pane-" + tab.id; pane.hidden = !isOpen;
      if (!tab.progress && !tab.find) {
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
      }
      panesEl.appendChild(pane);
    });
    renderFindPane();
    refreshDegreeAudit();
    renderGradMap(); // structural change (catalog switch / initial load) -- new graph entirely
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
    // "color-scheme" is set explicitly on :root/:root[data-theme] in
    // styles.css (light or dark, never both) -- reading the computed value
    // back is a cheap, single source of truth for which theme is active,
    // instead of re-deriving it from matchMedia + the data-theme attribute
    // ourselves. Only used to pick which lightness ramp matches the hue/
    // saturation tokens CSS is already giving us for the active theme.
    var isDark = s.colorScheme === "dark";
    var lightness = isDark ? DARK_LIGHTNESS : LIGHT_LIGHTNESS;
    var categoryRamps = {};
    CATEGORIES.forEach(function (c) {
      var h = v("--" + c.cssVar + "-h");
      var sat = v("--" + c.cssVar + "-s");
      categoryRamps[c.key] = lightness.map(function (l) { return "hsl(" + h + ", " + sat + ", " + l + "%)"; });
    });
    return {
      ink: v("--ink"), ink2: v("--ink-2"), surface: v("--surface"), hairline: v("--hairline"),
      accent: v("--accent"), accentInk: v("--accent-ink"),
      focus: "hsl(" + v("--cat-h-focus-h") + ", " + v("--cat-h-focus-s") + ", 50%)",
      edgePrereq: v("--edge-prereq"), edgeCoreq: v("--edge-coreq"),
      critical: v("--status-critical"), warning: v("--status-warning"),
      // The difficulty view's fills: pale in the light theme, deep in the
      // dark one, so the node's ink stays readable on all four.
      diff: isDark
        ? { light: "hsl(150, 38%, 26%)", typical: "hsl(210, 10%, 30%)", hard: "hsl(36, 70%, 30%)", vhard: "hsl(4, 58%, 36%)" }
        : { light: "hsl(150, 42%, 80%)", typical: "hsl(210, 14%, 88%)", hard: "hsl(40, 92%, 72%)", vhard: "hsl(6, 82%, 72%)" },
      depth: [v("--depth-0"), v("--depth-1"), v("--depth-2"), v("--depth-3"), v("--depth-4"), v("--depth-5"), v("--depth-6"), v("--depth-7")],
      categoryRamps: categoryRamps
    };
  }

  function nodeColor(t, ele) {
    var depth = ele.data("depth"), inCatalog = ele.data("inCatalog"), category = ele.data("category");
    // The difficulty view replaces depth/category shading outright: rated
    // courses take their band's color, everything else goes blank.
    if (state.diffView && state.difficulty) {
      var rated = diffRated(ele.id());
      return rated ? t.diff[diffBand(rated.d)] : t.surface;
    }
    // External/dangling refs get a cached depth of 0 as a side effect of
    // dependency resolution (see graph.py's compute_depths) -- that's not a
    // real "0 prereqs deep" claim, so they stay unshaded regardless.
    if (!inCatalog || typeof depth !== "number") return t.surface;
    var i = Math.max(0, Math.min(t.depth.length - 1, depth));
    var ramp = category && t.categoryRamps[category];
    return ramp ? ramp[i] : t.depth[i];
  }

  // Swaps the legend's generic "node shade = depth" line for a chip per
  // requirement category once a program with category data is the active
  // filter -- called from setFilterProgram whenever relevantCategories
  // changes (on, off, or switched to a different program/catalog).
  function updateLegendCategories() {
    var container = document.getElementById("legend-categories");
    var depthLine = document.getElementById("legend-depth");
    if (!container || !depthLine) return;
    if (!state.relevantCategories) {
      container.hidden = true; container.innerHTML = "";
      depthLine.hidden = false;
      return;
    }
    var present = {};
    Object.keys(state.relevantCategories).forEach(function (code) {
      present[state.relevantCategories[code]] = true;
    });
    var t = tokens();
    container.innerHTML = "";
    CATEGORIES.forEach(function (c) {
      // The focus marker shows whenever the focus data loaded; every
      // other category only if this program/catalog actually used it.
      if (c.marker ? !state.focusByCode : !present[c.key]) return;
      var span = document.createElement("span");
      var swatch = document.createElement("span");
      swatch.className = "swatch";
      if (c.marker) {
        // An outline, not a fill -- that's how it reads on the graph.
        swatch.style.background = t.surface;
        swatch.style.boxShadow = "inset 0 0 0 2px " + t.focus;
      } else {
        var ramp = t.categoryRamps[c.key];
        if (ramp) swatch.style.background = ramp[4]; // mid-depth shade, representative of the whole ramp
      }
      span.appendChild(swatch);
      // A major can say what a color means for it (Civil reuses the EB
      // color for its sustainability electives).
      span.appendChild(document.createTextNode(" " + ((!c.marker && state.categoryLabels && state.categoryLabels[c.key]) || c.label)));
      container.appendChild(span);
    });
    container.hidden = false;
    depthLine.hidden = true;
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
    if (state.mobile) { setLegendOpen(false); setDetailOpen(false); }
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
    u.codes.forEach(function (code) { cellW = Math.max(cellW, nodeWidthEstimate(diffLabel(code))); });
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
        // Nodes are wider while the difficulty view adds a score to every
        // label, so they push each other further apart to stay readable.
        var f = PHYSICS.repulsion * (state.diffView ? 1.7 : 1) / (d * d);
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
    var outsideKey = focal + "|unlock-outside";
    // Prereqs (the chain above) always render in full regardless of the
    // filter -- hiding what a course actually needs would defeat the point
    // of a *prereq* map. "Required by" is the one column that narrows: when
    // the focal course is itself relevant, courses it unlocks outside the
    // filtered set aren't hidden either, just tucked behind their own "+N
    // outside your major" stub (outsideUnlocks below) instead of cluttering
    // "what does this lead to" with things you wouldn't go on to take. A
    // focal course that's itself outside the filter shows its full,
    // unrestricted unlocks list -- there's no "your major" framing to apply
    // to a course that isn't part of it.
    var outsideUnlocks = [];
    if (filterActive() && isRelevant(focal)) {
      outsideUnlocks = allUnlocks.filter(function (c) { return !isRelevant(c); });
      allUnlocks = allUnlocks.filter(function (c) { return isRelevant(c); });
    }
    var unlocks = state.expandedMore[unlockKey] ? { shown: allUnlocks, extra: 0 } : capped(allUnlocks);
    var outsideShown = state.expandedMore[outsideKey] ? outsideUnlocks : [];
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
      var data = { id: code, label: diffLabel(code), title: n.title || "", depth: n.depth, status: n.depth_status, inCatalog: !!n.in_catalog, focal: !!opts.isFocal, homeX: x, homeY: y };
      if (opts.parent) data.parent = opts.parent;
      if (state.takenSet[code]) data.taken = true;
      // Amber outline on Focus courses -- only while a major filter is
      // active, where the legend that explains it is showing (see
      // updateLegendCategories()).
      if (filterActive() && focusOf(code).length) data.hasFocus = true;
      // Applies uniformly wherever a course node gets drawn -- prereq chain,
      // coreqs, group members, unlocks -- so "dim what's outside your major"
      // needs no special-casing per column, just this one shared spot.
      if (filterActive() && !isRelevant(code)) data.relevance = "dim";
      // "Find by requirement" -> "Dim everything else": same flag, same style.
      if (state.find.dimGraph && findCriteriaCount() > 0 && !matchesFind(code)) data.relevance = "dim";
      // Same spot, same reasoning: a relevant course's requirement-type
      // category (nodeColor() above uses this to pick which hue's depth
      // ramp to shade it with instead of the default blue one). Absent
      // for a course this program's relevance data has no category for
      // (falls back to the default ramp in nodeColor).
      if (filterActive() && isRelevant(code) && state.relevantCategories) {
        var cat = state.relevantCategories[code];
        if (cat) data.category = cat;
      }
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

    // One row per thing that actually appears in the "required by" column,
    // in display order -- courses, then the ordinary length-cap "+more"
    // stub (if any), then the filtered-out courses' own stub or (once
    // clicked) their own rows -- so every row can be centered together by
    // one shared index/count instead of two different columns' worth of ad
    // hoc position math.
    var unlockRows = [];
    unlocks.shown.forEach(function (c) { unlockRows.push({ kind: "course", code: c }); });
    if (unlocks.extra > 0) unlockRows.push({ kind: "more", count: unlocks.extra });
    if (outsideShown.length) {
      outsideShown.forEach(function (c) { unlockRows.push({ kind: "course", code: c }); });
    } else if (outsideUnlocks.length) {
      unlockRows.push({ kind: "outside-more", count: outsideUnlocks.length });
    }
    unlockRows.forEach(function (row, i) {
      var y = (i - (unlockRows.length - 1) / 2) * rowHeight;
      if (row.kind === "course") { addNode(row.code, unlockX, y); return; }
      var isOutside = row.kind === "outside-more";
      var id = isOutside ? "__more_unlock_outside" : "__more_unlock";
      var label = isOutside ? "+" + row.count + " outside your major" : "+" + row.count + " more";
      els.push({ data: { id: id, label: label, isMore: true, moreKey: isOutside ? outsideKey : unlockKey, expandable: true }, position: { x: unlockX, y: y } });
      els.push({ data: { id: focal + "->" + id, source: focal, target: id, kind: "prereq", isMoreEdge: true } });
    });
    unlockRows.forEach(function (row) {
      if (row.kind !== "course") return;
      els.push({ data: { id: focal + "->" + row.code, source: focal, target: row.code, kind: "prereq" } });
      markEdge(focal, row.code, "prereq");
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
          "background-color": function (ele) { return nodeColor(t, ele); },
          "label": "data(label)", "color": t.ink, "font-family": "IBM Plex Mono, monospace",
          "font-size": FONT.node, "font-weight": 600, "text-valign": "center", "text-halign": "center",
          "border-width": 1, "border-color": t.hairline
        }},
        // Focus (W/H/E/O) marker -- first of the border rules so a taken
        // course's green border, a cycle's red one, and the focal node's
        // own all still win over it.
        { selector: "node[?hasFocus]", style: { "border-width": 2, "border-color": t.focus } },
        { selector: "node[?focal]", style: { "background-color": t.accent, "color": t.accentInk, "border-width": 2, "border-color": t.accent, "font-weight": 700 } },
        { selector: "node[status = 'cycle']", style: { "border-width": 2, "border-color": t.critical } },
        { selector: "node[status = 'unresolved_prereq']", style: { "border-style": "dashed", "border-width": 2, "border-color": t.warning } },
        // Cytoscape selector syntax: falsy/absent data fields use "[!field]",
        // not "[field = false]" (which is an invalid selector -- silently
        // dropped, not applied, logged as an error in the console).
        { selector: "node[!inCatalog]", style: { "border-style": "dashed", "background-opacity": 0.5, "color": t.ink2 } },
        // "My Progress" taken-course marking -- layers independently of
        // nodeColor()'s category/depth fill, same as the status/peek border
        // rules around it, rather than touching nodeColor() itself.
        { selector: "node[?taken]", style: { "border-width": 3, "border-color": t.accent } },
        // Major filter: everything still renders (see renderGraph's unlocks
        // section for the one place that's not also true), this just mutes
        // whatever's outside the selected program. Full-node opacity, not
        // just background, so it reads as de-emphasized against every
        // other rule above rather than fighting the depth-color/status/
        // focal styling those already apply.
        { selector: "node[relevance = 'dim']", style: { "opacity": 0.35 } },
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
    var handleLabel = document.querySelector("#detail-toggle .dt-label");
    if (handleLabel) handleLabel.textContent = code + " · " + (n.title || "(untitled)");

    var codeEl = document.createElement("div"); codeEl.className = "code"; codeEl.textContent = code;
    var h2 = document.createElement("h2"); h2.textContent = n.title || "(untitled)";

    var takenBtn = document.createElement("button");
    takenBtn.type = "button";
    takenBtn.className = "taken-toggle" + (isTaken(code) ? " active" : "");
    takenBtn.textContent = isTaken(code) ? "✓ Taken — click to undo" : "Mark as taken";
    takenBtn.addEventListener("click", function () { toggleTaken(code); });

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
    if (filterActive() && !isRelevant(code)) {
      var b4 = document.createElement("span"); b4.className = "badge outside"; b4.textContent = "outside your major requirements";
      meta.appendChild(b4);
    }
    (n.gened || []).forEach(function (g) {
      var bg = document.createElement("span"); bg.className = "badge gened"; bg.textContent = g;
      meta.appendChild(bg);
    });
    focusOf(code).forEach(function (f) {
      var bf = document.createElement("span"); bf.className = "badge focus"; bf.textContent = f + " Focus";
      bf.title = FOCUS_LABELS[f] + " — from STAR section data, assumed constant across terms";
      meta.appendChild(bf);
    });

    var bd = diffBadge(code, "badge diff");
    if (bd) meta.appendChild(bd);

    el.appendChild(codeEl); el.appendChild(h2); el.appendChild(takenBtn); el.appendChild(meta);

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
    renderOfferings(el, code);
    renderDifficulty(el, code);

    if (n.source_url) {
      var l = document.createElement("div"); l.className = "field-label"; l.textContent = "Source";
      var a = document.createElement("a"); a.href = n.source_url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "catalog.manoa.hawaii.edu ↗"; a.style.fontSize = "0.82rem";
      el.appendChild(l); el.appendChild(a);
    }
  }

  // "How hard it's rated" in the course details (local only): the course's
  // numbers across every instructor, then who teaches it -- newest first --
  // with their own scores, since the instructor is most of the difference.
  function renderDifficulty(el, code) {
    if (!state.difficulty) return;
    var d = diffOf(code);
    if (!d) return;
    var l = document.createElement("div"); l.className = "field-label"; l.textContent = "How hard it's rated";
    el.appendChild(l);
    var note = function (text) { var x = document.createElement("div"); x.className = "offer-note"; x.textContent = text; el.appendChild(x); return x; };
    if (d.n >= DIFF_MIN_REVIEWS) {
      el.appendChild(diffBadge(code, "badge diff"));
      note(DIFF_BAND_LABEL[diffBand(d.d)] + " · " + Math.round(d.hard * 100) + "% of " + d.n + " reviews rated it 4 or 5 · quality " + d.q.toFixed(1) +
        " · " + Math.round(d.again * 100) + "% would take it again · " + d.first + "–" + d.last);
    } else {
      note(d.n ? "Only " + d.n + " review" + (d.n === 1 ? "" : "s") + " (difficulty " + d.d.toFixed(1) + "): too few to rate." : "No reviews of this course itself.");
    }
    var by = d.by.slice(0, 8);
    if (by.length) {
      var table = document.createElement("table"); table.className = "offer-table diff-table";
      var head = document.createElement("tr");
      ["Instructor", "Last taught it", "Difficulty", "Quality", "Reviews"].forEach(function (h) { var th = document.createElement("th"); th.textContent = h; head.appendChild(th); });
      table.appendChild(head);
      by.forEach(function (b) {
        var tr = document.createElement("tr"); if (b.n < 3) tr.className = "off";
        [b.name, b.taught || "not since " + state.difficulty.star_terms[0], b.d.toFixed(1), b.q.toFixed(1), b.overall ? b.n + ", none for this course" : String(b.n)]
          .forEach(function (text) { var td = document.createElement("td"); td.textContent = text; tr.appendChild(td); });
        table.appendChild(tr);
      });
      el.appendChild(table);
    }
    var foot = note((d.by.length > by.length ? "…and " + (d.by.length - by.length) + " more. " : "") +
      "Rate My Professors, collected " + state.difficulty.collected + ". Self-selected reviews: read the count before the score. Local only. ");
    var a = document.createElement("a"); a.href = "analysis.html#profs"; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Comments and themes";
    foot.appendChild(a);
  }

  // "When it's offered" in the course details: the pattern badge, then one
  // row per captured term (newest first) -- sections, seats, how many were
  // taken, as a bar. Terms it didn't run in stay in the table, dimmed, since
  // "not offered Spring 2025" is exactly what a planner needs to see.
  function renderOfferings(el, code) {
    if (!state.offerings) return;
    var p = offeringPattern(code), rows = offeringRows(code);
    var l = document.createElement("div"); l.className = "field-label"; l.textContent = "When it's offered";
    el.appendChild(l);
    var badge = offeringBadge(code, "badge offer");
    if (badge) el.appendChild(badge);
    if (p.kind === "none") {
      var none = document.createElement("div"); none.className = "offer-note";
      none.textContent = "No sections in any captured term (" + p.span + ").";
      el.appendChild(none);
      return;
    }
    var table = document.createElement("table"); table.className = "offer-table";
    var head = document.createElement("tr");
    ["Term", "Sections", "Seats", "Taken", ""].forEach(function (h) { var th = document.createElement("th"); th.textContent = h; head.appendChild(th); });
    table.appendChild(head);
    state.offerings.terms.slice().reverse().forEach(function (t) {
      var r = rows[t.key];
      var tr = document.createElement("tr"); if (!r) tr.className = "off";
      function td(text, cls) { var c = document.createElement("td"); c.textContent = text; if (cls) c.className = cls; tr.appendChild(c); return c; }
      td(t.name + (t.status === "live" ? " (as of " + t.captured + ")" : ""));
      if (!r) { td("not offered", "muted"); td(""); td(""); td(""); }
      else {
        var pct = r[1] ? Math.round((r[2] / r[1]) * 100) : 0;
        td(String(r[0])); td(String(r[1])); td(r[2] + " (" + pct + "%)");
        var barCell = td("", "bar-cell");
        var bar = document.createElement("div"); bar.className = "offer-bar" + (pct >= 95 ? " full" : "");
        var fill = document.createElement("div"); fill.style.width = Math.min(100, pct) + "%";
        bar.appendChild(fill); barCell.appendChild(bar);
      }
      table.appendChild(tr);
    });
    el.appendChild(table);
    var live = state.offerings.terms.filter(function (t) { return t.status === "live"; });
    var noteEl = document.createElement("div"); noteEl.className = "offer-note";
    noteEl.textContent = "From STAR. Seats taken are final enrollment for terms captured after add/drop closed" +
      (live.length ? "; " + live.map(function (t) { return t.name; }).join(", ") + " is still a live snapshot." : ".");
    el.appendChild(noteEl);
  }

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (state.focal) renderGraph(state.focal, { preserveViewport: true });
      // The graph nodes above re-color themselves live (nodeColor reads
      // CSS var() fresh on every renderGraph) -- the legend's category
      // swatches don't, since updateLegendCategories bakes each one into
      // a plain JS-computed hsl() string rather than a live var()
      // reference, so it needs its own nudge here to stay in sync.
      updateLegendCategories();
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
