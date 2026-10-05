(function () {
  "use strict";

  // Shared helpers for analysis.html's analyzers (star.js, ee.js): DOM/SVG
  // builders, number formatting, the tooltip, the hand-built SVG chart
  // primitives, and the course offering-pattern rule. Exposed as
  // window.StarViz. Charts follow the dataviz method: one axis per chart, thin
  // marks with 4px rounded data-ends, 2px lines, categorical slots in fixed
  // order (--viz-1..3, validated light and dark, all-pairs), a one-hue blue
  // ramp (--seq-0..7) for magnitude, text in ink tokens never series colors,
  // and a hover tooltip on every mark. Tokens live in star.css.

  var tip = document.getElementById("viz-tip");
  var SVGNS = "http://www.w3.org/2000/svg";
  var DAYS = [["M", "Mon"], ["T", "Tue"], ["W", "Wed"], ["R", "Thu"], ["F", "Fri"], ["S", "Sat"]];
  var HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  var SIZE_BUCKETS = [[1, 9, "1–9"], [10, 19, "10–19"], [20, 29, "20–29"], [30, 49, "30–49"], [50, 99, "50–99"], [100, 199, "100–199"], [200, 1e9, "200+"]];
  var ATTR_LABELS = {
    FW: "Written Communication", FQ: "Quantitative Reasoning", FGA: "Global & Multicultural A",
    FGB: "Global & Multicultural B", FGC: "Global & Multicultural C", DA: "Arts", DB: "Biological Science",
    DH: "Humanities", DL: "Literatures", DP: "Physical Science", DS: "Social Science", DY: "Science Lab",
    WI: "W Focus (Writing Intensive)", HAP: "H Focus (Hawaiian, Asian & Pacific)", ETH: "E Focus (Ethics)", OC: "O Focus (Oral Communication)",
  };

  // ---------- small utilities ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svg(tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function fmt(n) { return n == null || isNaN(n) ? "–" : Math.round(n).toLocaleString(); }
  function pct(x) { return x == null || isNaN(x) ? "–" : Math.round(x * 100) + "%"; }
  function signed(n, f) {
    var s = (f || fmt)(Math.abs(n));
    return (/^0(\.0+)?$/.test(s) ? "±" : n > 0 ? "+" : "−") + s;
  }
  function niceMax(max, ticks) {
    ticks = ticks || 4;
    if (!(max > 0)) return { max: ticks, step: 1 };
    var raw = max / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    return { max: Math.ceil(max / step) * step, step: step };
  }
  function shortTerm(t) {
    var parts = t.name.split(" ");
    var s = { Fall: "Fall", Spring: "Spr", Summer: "Sum" }[parts[0]] || parts[0];
    return s + " '" + parts[1].slice(2);
  }

  // ---------- tooltip ----------
  function showTip(evt, title, rows, note) {
    tip.textContent = "";
    tip.appendChild(el("div", "t", title));
    (rows || []).forEach(function (r) {
      var row = el("div", "r");
      if (r.color) { var k = el("span", "k"); k.style.background = r.color; row.appendChild(k); }
      row.appendChild(el("strong", null, r.value));
      if (r.label) row.appendChild(document.createTextNode(" " + r.label));
      tip.appendChild(row);
    });
    if (note) tip.appendChild(el("div", "m", note));
    tip.hidden = false;
    var x = evt.clientX + 14, y = evt.clientY + 14, w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = evt.clientY - h - 14;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
  }
  function hideTip() { tip.hidden = true; }
  function hover(target, fn) {
    target.addEventListener("pointermove", fn);
    target.addEventListener("pointerleave", hideTip);
  }

  // ---------- chart primitives ----------
  function frame(container, height, margin) {
    var W = Math.max(280, container.clientWidth || 600);
    var s = svg("svg", { "class": "viz", viewBox: "0 0 " + W + " " + height, width: W, height: height, role: "img" });
    container.appendChild(s);
    return { svg: s, W: W, H: height, l: margin.l, r: margin.r, t: margin.t, b: margin.b, iw: W - margin.l - margin.r, ih: height - margin.t - margin.b };
  }
  function yAxis(f, scale, fmtTick) {
    var g = svg("g", { "class": "grid" }, f.svg);
    for (var v = 0; v <= scale.max + 1e-9; v += scale.step) {
      var y = f.t + f.ih - (v / scale.max) * f.ih;
      if (v > 0) svg("line", { x1: f.l, x2: f.l + f.iw, y1: y, y2: y }, g);
      var t = svg("text", { x: f.l - 6, y: y + 4, "text-anchor": "end" }, f.svg);
      t.textContent = (fmtTick || fmt)(v);
    }
    svg("line", { "class": "base", x1: f.l, x2: f.l + f.iw, y1: f.t + f.ih, y2: f.t + f.ih }, f.svg);
  }
  function xLabels(f, labels, bold) {
    var band = f.iw / labels.length, every = band < 34 ? 2 : 1;
    labels.forEach(function (lab, i) {
      if (i % every) return;
      var t = svg("text", { x: f.l + band * (i + 0.5), y: f.H - 8, "text-anchor": "middle" }, f.svg);
      t.textContent = lab;
      if (bold === i) { t.setAttribute("class", "lab"); t.style.fontWeight = "700"; }
    });
  }
  function colPath(x, y, w, h, r) {
    r = Math.min(r, h, w / 2);
    return "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y + "H" + (x + w - r) +
      "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h) + "Z";
  }
  function barPath(x, y, w, h, r, leftward) {
    r = Math.min(r, w, h / 2);
    if (leftward) return "M" + (x + w) + "," + y + "H" + (x + r) + "Q" + x + "," + y + " " + x + "," + (y + r) + "V" + (y + h - r) +
      "Q" + x + "," + (y + h) + " " + (x + r) + "," + (y + h) + "H" + (x + w) + "Z";
    return "M" + x + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h - r) +
      "Q" + (x + w) + "," + (y + h) + " " + (x + w - r) + "," + (y + h) + "H" + x + "Z";
  }
  function legend(container, items, kind) {
    var lg = el("div", "viz-legend");
    items.forEach(function (it) {
      var k = el("span", "key");
      var sw = el("span", kind === "line" ? "ln" : "sw"); sw.style.background = it.color;
      k.appendChild(sw); k.appendChild(document.createTextNode(it.label));
      if (it.num != null) { k.appendChild(document.createTextNode(" ")); k.appendChild(el("span", "num", it.num)); }
      lg.appendChild(k);
    });
    container.appendChild(lg);
  }

  // Lines over the terms; null breaks a line. Crosshair + one tooltip with every series.
  function lineChart(container, o) {
    if (o.series.length > 1) legend(container, o.series.map(function (s) { return { label: s.name, color: s.color }; }), "line");
    var f = frame(container, o.height || 220, { l: 52, r: 56, t: 12, b: 26 });
    var max = 0;
    o.series.forEach(function (s) { s.values.forEach(function (v) { if (v != null && v > max) max = v; }); });
    var scale = niceMax(o.max != null ? o.max : max);
    yAxis(f, scale, o.fmtTick);
    var n = o.labels.length, band = f.iw / n;
    function X(i) { return f.l + band * (i + 0.5); }
    function Y(v) { return f.t + f.ih - (v / scale.max) * f.ih; }
    xLabels(f, o.labels, o.highlight);
    var cross = svg("line", { "class": "cross", y1: f.t, y2: f.t + f.ih, x1: 0, x2: 0, visibility: "hidden" }, f.svg);
    o.series.forEach(function (s) {
      var d = "", pen = false;
      s.values.forEach(function (v, i) {
        if (v == null) { pen = false; return; }
        d += (pen ? "L" : "M") + X(i) + "," + Y(v); pen = true;
      });
      var p = svg("path", { d: d, fill: "none", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, f.svg);
      p.style.stroke = s.color;
      s.values.forEach(function (v, i) {
        if (v == null) return;
        var c = svg("circle", { cx: X(i), cy: Y(v), r: 4, "stroke-width": 2 }, f.svg);
        c.style.fill = s.color; c.style.stroke = "var(--surface)";
      });
      // Selective direct label: the last value only.
      for (var i = s.values.length - 1; i >= 0; i--) {
        if (s.values[i] == null) continue;
        var t = svg("text", { x: X(i) + 8, y: Y(s.values[i]) + 4, "class": "val" }, f.svg);
        t.textContent = (o.fmt || fmt)(s.values[i]);
        break;
      }
    });
    for (var i = 0; i < n; i++) (function (i) {
      var hit = svg("rect", { "class": "hit", x: f.l + band * i, y: f.t, width: band, height: f.ih }, f.svg);
      hover(hit, function (evt) {
        cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
        showTip(evt, o.tipTitles ? o.tipTitles[i] : o.labels[i], o.series.map(function (s) {
          return { color: s.color, value: (o.fmt || fmt)(s.values[i]), label: s.name };
        }), o.tipNote ? o.tipNote(i) : null);
      });
      hit.addEventListener("pointerleave", function () { cross.setAttribute("visibility", "hidden"); });
    })(i);
  }

  // Single-series columns, value on each cap.
  function columnChart(container, o) {
    var f = frame(container, o.height || 200, { l: 44, r: 12, t: 18, b: 26 });
    var scale = niceMax(o.max != null ? o.max : Math.max.apply(null, o.values.concat([0])));
    yAxis(f, scale, o.fmtTick);
    var n = o.values.length, band = f.iw / n, w = Math.min(24, band * 0.62);
    xLabels(f, o.labels, o.highlight);
    o.values.forEach(function (v, i) {
      var x = f.l + band * (i + 0.5) - w / 2, h = scale.max ? (v / scale.max) * f.ih : 0, y = f.t + f.ih - h;
      var hit = svg("rect", { "class": "hit", x: f.l + band * i, y: f.t, width: band, height: f.ih }, f.svg);
      if (h > 0) {
        var p = svg("path", { "class": "mark", d: colPath(x, y, w, h, 4) }, f.svg);
        p.style.fill = o.color || "var(--viz-1)";
        if (o.highlight != null && o.highlight !== i) p.style.opacity = 0.55;
      }
      if (o.valueLabels !== false && v != null) {
        var t = svg("text", { x: x + w / 2, y: y - 5, "text-anchor": "middle", "class": "val" }, f.svg);
        t.textContent = (o.fmt || fmt)(v);
      }
      hover(hit, function (evt) {
        showTip(evt, o.tipTitles ? o.tipTitles[i] : o.labels[i], [{ value: (o.fmt || fmt)(v), label: o.name || "" }], o.tipNote ? o.tipNote(i) : null);
      });
      if (o.onClick) { hit.style.cursor = "pointer"; hit.addEventListener("click", function () { o.onClick(i); }); }
    });
  }

  // 100%-stacked columns: shares of each series per column, 2px surface gaps.
  function stackedShares(container, o) {
    var f = frame(container, o.height || 200, { l: 44, r: 12, t: 10, b: 26 });
    yAxis(f, { max: 1, step: 0.25 }, function (v) { return Math.round(v * 100) + "%"; });
    var n = o.labels.length, band = f.iw / n, w = Math.min(24, band * 0.62);
    xLabels(f, o.labels, o.highlight);
    for (var i = 0; i < n; i++) (function (i) {
      var total = o.series.reduce(function (s, se) { return s + se.values[i]; }, 0);
      var x = f.l + band * (i + 0.5) - w / 2, yBase = f.t + f.ih;
      var present = o.series.filter(function (se) { return se.values[i] > 0; });
      present.forEach(function (se, k) {
        var h = (se.values[i] / total) * f.ih, top = yBase - h;
        // Every segment above the bottom one gives up 2px at its base: the surface gap.
        var bottom = k === 0 ? yBase : yBase - 2;
        var p = svg("path", { "class": "mark", d: k === present.length - 1
          ? colPath(x, top, w, Math.max(0, bottom - top), 4)
          : "M" + x + "," + bottom + "V" + top + "H" + (x + w) + "V" + bottom + "Z" }, f.svg);
        p.style.fill = se.color;
        yBase = top;
      });
      var hit = svg("rect", { "class": "hit", x: f.l + band * i, y: f.t, width: band, height: f.ih }, f.svg);
      hover(hit, function (evt) {
        showTip(evt, o.tipTitles ? o.tipTitles[i] : o.labels[i], o.series.map(function (se) {
          return { color: se.color, value: pct(total ? se.values[i] / total : 0), label: se.name + " (" + fmt(se.values[i]) + ")" };
        }));
      });
    })(i);
  }

  // Horizontal bars: label column, bar, value at the tip. Rows are the hit targets.
  function hBars(container, o) {
    var rowH = o.rowH || 24, labelW = o.labelW || 150;
    var f = frame(container, o.items.length * rowH + 8, { l: labelW, r: 90, t: 4, b: 4 });
    var max = o.max != null ? o.max : Math.max.apply(null, o.items.map(function (it) { return it.value; }).concat([0]));
    o.items.forEach(function (it, i) {
      var y = f.t + i * rowH, h = Math.min(14, rowH - 8), w = max ? (it.value / max) * f.iw : 0;
      var lab = svg("text", { x: f.l - 8, y: y + rowH / 2 + 4, "text-anchor": "end", "class": "lab" }, f.svg);
      lab.textContent = it.label;
      var hit = svg("rect", { "class": "hit", x: 0, y: y, width: f.W, height: rowH }, f.svg);
      if (w > 0) {
        var p = svg("path", { "class": "mark", d: barPath(f.l, y + (rowH - h) / 2, w, h, 4) }, f.svg);
        p.style.fill = it.color || o.color || "var(--viz-1)";
      }
      var v = svg("text", { x: f.l + w + 6, y: y + rowH / 2 + 4, "class": "val" }, f.svg);
      v.textContent = it.valueText != null ? it.valueText : (o.fmt || fmt)(it.value);
      hover(hit, function (evt) { showTip(evt, it.tipTitle || it.label, it.tipRows || [{ value: v.textContent, label: o.name || "" }], it.tipNote); });
      if (o.onClick) { hit.style.cursor = "pointer"; hit.addEventListener("click", function () { o.onClick(it); }); }
    });
  }

  // Diverging bars around zero: growth to the right, cuts to the left.
  function divergingBars(container, o) {
    var rowH = 22, labelW = 86;
    var f = frame(container, o.items.length * rowH + 8, { l: labelW, r: 44, t: 4, b: 4 });
    var max = Math.max.apply(null, o.items.map(function (it) { return Math.abs(it.value); }).concat([1]));
    var mid = f.l + f.iw / 2, half = f.iw / 2 - 30;
    svg("line", { "class": "base", x1: mid, x2: mid, y1: f.t, y2: f.t + o.items.length * rowH }, f.svg);
    o.items.forEach(function (it, i) {
      var y = f.t + i * rowH, h = 12, w = (Math.abs(it.value) / max) * half, neg = it.value < 0;
      var lab = svg("text", { x: f.l - 8, y: y + rowH / 2 + 4, "text-anchor": "end", "class": "lab" }, f.svg);
      lab.textContent = it.label;
      var hit = svg("rect", { "class": "hit", x: 0, y: y, width: f.W, height: rowH }, f.svg);
      if (w > 0) {
        var p = svg("path", { "class": "mark", d: barPath(neg ? mid - w : mid, y + (rowH - h) / 2, w, h, 4, neg) }, f.svg);
        p.style.fill = neg ? "var(--div-neg)" : "var(--div-pos)";
      }
      var v = svg("text", { x: neg ? mid - w - 6 : mid + w + 6, y: y + rowH / 2 + 4, "text-anchor": neg ? "end" : "start", "class": "val" }, f.svg);
      v.textContent = signed(it.value);
      hover(hit, function (evt) { showTip(evt, it.tipTitle || it.label, it.tipRows, it.tipNote); });
      if (o.onClick) { hit.style.cursor = "pointer"; hit.addEventListener("click", function () { o.onClick(it); }); }
    });
  }

  function seqColor(v, max) {
    if (!v || !max) return "var(--seq-0)";
    return "var(--seq-" + Math.min(7, 1 + Math.floor((v / max) * 6.999)) + ")";
  }
  function seqIsDark(v, max) { return v && max && Math.min(7, 1 + Math.floor((v / max) * 6.999)) >= 5; }
  function rampLegend(container, lowText, highText) {
    var sc = el("div", "viz-scale");
    sc.appendChild(document.createTextNode(lowText));
    var ramp = el("span", "ramp");
    for (var i = 0; i <= 7; i++) { var s = el("span"); s.style.background = "var(--seq-" + i + ")"; ramp.appendChild(s); }
    sc.appendChild(ramp);
    sc.appendChild(document.createTextNode(highText));
    container.appendChild(sc);
  }

  // Day x hour heatmap of meetings in progress.
  function heatmap(container, o) {
    var f = frame(container, o.rows.length * 30 + 26, { l: 40, r: 8, t: 22, b: 4 });
    var cw = f.iw / o.cols.length, ch = 30, max = 0;
    o.matrix.forEach(function (r) { r.forEach(function (v) { if (v > max) max = v; }); });
    o.cols.forEach(function (c, j) {
      if (cw < 26 && j % 2) return;
      var t = svg("text", { x: f.l + cw * (j + 0.5), y: 14, "text-anchor": "middle" }, f.svg);
      t.textContent = c;
    });
    o.rows.forEach(function (r, i) {
      var t = svg("text", { x: f.l - 8, y: f.t + ch * i + ch / 2 + 4, "text-anchor": "end", "class": "lab" }, f.svg);
      t.textContent = r;
      o.cols.forEach(function (c, j) {
        var v = o.matrix[i][j];
        var cell = svg("rect", { "class": "cell", x: f.l + cw * j, y: f.t + ch * i, width: cw, height: ch, rx: 4 }, f.svg);
        cell.style.fill = seqColor(v, max);
        hover(cell, function (evt) { showTip(evt, o.tipTitle(i, j), [{ value: fmt(v), label: o.unit }], o.tipNote ? o.tipNote(i, j) : null); });
      });
    });
    rampLegend(container, "fewer", "more " + o.unit);
  }

  function sparkline(values, w, h) {
    w = w || 90; h = h || 22;
    var s = svg("svg", { "class": "spark", width: w, height: h, viewBox: "0 0 " + w + " " + h });
    var max = Math.max.apply(null, values.map(function (v) { return v || 0; }).concat([1]));
    var step = values.length > 1 ? (w - 6) / (values.length - 1) : 0, d = "", pen = false, last = null;
    values.forEach(function (v, i) {
      if (v == null) { pen = false; return; }
      var x = 3 + i * step, y = h - 3 - (v / max) * (h - 6);
      d += (pen ? "L" : "M") + x + "," + y; pen = true; last = [x, y];
    });
    svg("path", { d: d }, s);
    if (last) svg("circle", { cx: last[0], cy: last[1], r: 2.5 }, s);
    return s;
  }

  // Same rules as app.js's offeringPattern(), from per-term [sections, seats, taken].
  function patternOf(perTerm, terms) {
    var by = { Fall: { n: 0, of: 0 }, Spring: { n: 0, of: 0 }, Summer: { n: 0, of: 0 } };
    terms.forEach(function (t, i) { var s = by[t.season]; if (!s) return; s.of++; if (perTerm && perTerm[i]) s.n++; });
    function lvl(s) { return !s.n ? "never" : s.n === s.of ? "always" : "some"; }
    var f = lvl(by.Fall), sp = lvl(by.Spring), su = by.Summer.n > 0, kind, label;
    if (f === "always" && sp === "always") { kind = "both"; label = "Fall & Spring"; }
    else if (f === "always" && sp === "never") { kind = "fall"; label = "Fall only"; }
    else if (sp === "always" && f === "never") { kind = "spring"; label = "Spring only"; }
    else if (f === "never" && sp === "never") { kind = "summer"; label = "Summer only"; }
    else {
      kind = "irregular";
      label = ["Fall", "Spring"].filter(function (s) { return by[s].n; }).map(function (s) {
        return by[s].n === by[s].of ? s : s + " " + by[s].n + "/" + by[s].of;
      }).join(", ");
    }
    if (su && kind !== "summer") label += " + Summer";
    return { kind: kind, label: label, by: by, terms: (perTerm || []).filter(Boolean).length };
  }

  function sortable(th, state, key, onSort) {
    th.classList.add("sortable");
    if (state.key === key) th.appendChild(el("span", "arrow", state.dir < 0 ? "▼" : "▲"));
    th.addEventListener("click", function () {
      if (state.key === key) state.dir = -state.dir; else { state.key = key; state.dir = key === "code" || key === "title" || key === "subject" ? 1 : -1; }
      onSort();
    });
  }
  function fillCell(td, fill) {
    td.style.whiteSpace = "nowrap";
    if (fill == null) { td.textContent = "–"; return; }
    var b = el("span", "fillbar" + (fill >= 0.95 ? " full" : ""));
    var s = el("span"); s.style.width = Math.min(100, fill * 100) + "%"; b.appendChild(s);
    td.appendChild(b); td.appendChild(document.createTextNode(pct(fill)));
  }
  window.StarViz = {
    DAYS: DAYS, HOURS: HOURS, SIZE_BUCKETS: SIZE_BUCKETS, ATTR_LABELS: ATTR_LABELS,
    el: el, svg: svg, fmt: fmt, pct: pct, signed: signed, niceMax: niceMax, shortTerm: shortTerm, showTip: showTip, hideTip: hideTip, hover: hover, frame: frame, yAxis: yAxis, xLabels: xLabels, colPath: colPath, barPath: barPath, legend: legend, lineChart: lineChart, columnChart: columnChart, stackedShares: stackedShares, hBars: hBars, divergingBars: divergingBars, seqColor: seqColor, seqIsDark: seqIsDark, rampLegend: rampLegend, heatmap: heatmap, sparkline: sparkline, patternOf: patternOf, sortable: sortable, fillCell: fillCell,
  };
})();
