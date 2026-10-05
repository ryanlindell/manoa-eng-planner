// The majors the Degree Planner knows, each transcribed from its August 2026
// curriculum check sheet (checksheets/2026.pdf for EE, "2026 CENG.pdf",
// "2026 ME.pdf", "2026 CE.pdf"). Loaded before app.js, which calls
// buildPrograms(data) once the catalog is in.
//
// A program is data, not code paths -- app.js evaluates every major the same
// way:
//   grid(track)   the sheet's recommended 8 semesters, Freshman Fall (0) to
//                 Senior Spring (7): {code}, {alt: [...]} for a real "X or Y"
//                 on the sheet, or {slot} for a requirement the student fills.
//                 Every {code} and {alt} is a required course.
//   substitutes   the sheet's substitution notes: required course -> what may
//                 stand in for it. An entry that is itself a list means "all
//                 of these together" (ICS 141 and 241 for ECE 362).
//   equivalents   courses the sheet treats as the same course under two
//                 department prefixes ("CEE 271 or ME 271"). The catalog's
//                 prerequisite text names only one of them, so either one
//                 satisfies a prerequisite that asks for the other.
//   pools(track)  the elective requirements, checked in order after the
//                 required courses; a course counts toward the first one that
//                 takes it. Each pool:
//       id         also the "Counts toward" value saved on a course
//       kind       "all" (every course in `codes`) or "credits" (`need` of them)
//       codes / eligible(code)   what counts
//       core(code) the pool's own list, without the "one may be substituted"
//                  extras -- what the prereq map shows as this requirement
//                  (scripts/build_major_relevance.js); defaults to eligible
//       greedy     take every eligible course, not just enough to reach `need`
//                  (so later extras, like a lab credit, can be found)
//       extras     further conditions inside the pool: {name, label, need, counts(code)}
//       limits     "at most `count` of these": {label, count, test(code)}
//       approval(code)  true when it counts only with someone's sign-off
//       slots      the placeholder tiles / picker filters that belong to it:
//                  {label, title, credits, only(code), chip}
//       cat        which tile color to use (styles.css .cat-*)
//   minima(track) credit totals across several pools.
//   checks(ev, add, helpers)  anything else the sheet says, as rule-check lines.
//
// Wherever the sheet is ambiguous the reading taken is said in a comment, and
// the planner's hint text tells the student to confirm it.
(function () {
  "use strict";

  function numberOf(code) {
    var m = /\s(\d+)/.exec(code);
    return m ? Number(m[1]) : 0;
  }
  function subjectOf(code) { return code.split(" ")[0]; }
  function isLab(code) { return /\dL$/.test(code); }
  function notLab(code) { return !isLab(code); }
  function oneOf(list) { return function (code) { return list.indexOf(code) >= 0; }; }
  function merge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      Object.keys(src).forEach(function (k) { out[k] = src[k]; });
    }
    return out;
  }

  // Notes 2 and 3 on every sheet. The accelerated calculus sequence is a
  // whole-sequence substitution (3 courses for 4), so 253A stands in for both
  // MATH 243 and 244; likewise one CHEM 171/181 covers CHEM 161 and 162.
  var MATH_CHEM = {
    "MATH 241": ["MATH 251A"], "MATH 242": ["MATH 252A"], "MATH 243": ["MATH 253A"], "MATH 244": ["MATH 253A"],
    "CHEM 161": ["CHEM 171", "CHEM 181A"], "CHEM 162": ["CHEM 171", "CHEM 181A"], "CHEM 161L": ["CHEM 171L", "CHEM 181L"],
  };
  // "ENGR 196/296/396 may substitute for ECE 196/296/396."
  var VIP = { "ECE 296": ["ENGR 296"], "ECE 396": ["ENGR 396"] };
  var ECON = { alt: ["ECON 120", "ECON 130", "ECON 131"] };
  // Dynamics and fluid mechanics, each offered by both Civil and Mechanical;
  // both sheets print them as "CEE 271 or ME 271" / "ME 371 or CEE 370".
  var CEE_ME = [["CEE 271", "ME 271"], ["CEE 370", "ME 371"]];
  // Credits for variable-credit project courses, as the sheets' grids print them.
  var ECE_GRID_CREDITS = { "ECE 296": 1, "ECE 396": 2, "ECE 496": 3, "ECE 495": 1 };

  // Engineering Breadth, as the EE and CENG sheets define it: CEE 270, or a
  // CEE / ME / OE / BE course at the 300 level or higher. (Ocean Engineering's
  // catalog prefix is ORE.) The third option, an approved 300+ science
  // course, can't be recognized automatically: the student sets it by hand.
  var EB_SUBJECTS = ["CEE", "ME", "ORE", "BE"];
  function isEb(code) {
    return code === "CEE 270" || (EB_SUBJECTS.indexOf(subjectOf(code)) >= 0 && numberOf(code) >= 300);
  }

  // ---------- Electrical Engineering ----------
  // The requirement lists come from data.program (built from
  // checksheets/data/2026.json, the same file the prereq map's major filter
  // uses); only the grid is written out here.
  function electrical(data) {
    var P = data.program;
    var tracks = P.tracks;
    function inAnyTrack(code) {
      return Object.keys(tracks).some(function (k) { return tracks[k].group1.indexOf(code) >= 0 || tracks[k].group2.indexOf(code) >= 0; });
    }
    function teListed(code) { return P.technical_electives.additional_eligible.indexOf(code) >= 0 || inAnyTrack(code); }
    // ECE 491 (special topics) counts case by case -- eligible, but flagged.
    function teCaseByCase(code) { return P.technical_electives.case_by_case.some(function (base) { return code.indexOf(base) === 0; }); }
    var trackNames = {};
    Object.keys(tracks).forEach(function (k) { trackNames[k] = { name: tracks[k].name }; });

    return {
      id: "EE", name: "Electrical Engineering", effective: P.checksheet_effective,
      tracks: trackNames, defaultTrack: "EP", gridCredits: ECE_GRID_CREDITS,
      substitutes: merge(MATH_CHEM, VIP),
      grid: function () {
        return [
          [{ code: "ENG 100" }, { code: "MATH 241" }, { code: "CHEM 161" }, { code: "CHEM 161L" }, { alt: ["ECE 160", "ECE 110"] }],
          [{ code: "MATH 242" }, { code: "PHYS 170" }, { code: "PHYS 170L" }, { code: "CHEM 162" }, { slot: "FG" }],
          [{ code: "ECE 211" }, { code: "ECE 260" }, { code: "MATH 243" }, { code: "PHYS 272" }, { code: "PHYS 272L" }],
          [{ code: "ECE 213" }, { code: "MATH 244" }, { code: "PHYS 274" }, { code: "ECE 296" }, { code: "COMG 251" }, { slot: "FG" }],
          [{ code: "ECE 315" }, { code: "ECE 324" }, { code: "ECE 371" }, { alt: ["ECE 345", "MATH 307"] }, { slot: "EB" }],
          [{ code: "ECE 323" }, { code: "ECE 323L" }, { code: "ECE 342" }, { slot: "TE" }, { slot: "G1" }, { slot: "G1L" }, { code: "ECE 396" }],
          [{ slot: "G1" }, { slot: "G1L" }, { slot: "G1" }, { slot: "TE" }, { slot: "TEL" }, { slot: "DHDL" }],
          [{ code: "ECE 496" }, { code: "ECE 495" }, { slot: "G2" }, { slot: "G2" }, ECON, { slot: "DS" }],
        ];
      },
      pools: function (trackKey) {
        var t = tracks[trackKey];
        function own(code) { return t.group1.indexOf(code) >= 0 || t.group2.indexOf(code) >= 0; }
        var te = P.technical_electives;
        return [
          {
            id: "group1", kind: "all", label: "Group I", name: trackKey + " Group I", section: "Major track: " + trackKey,
            cat: "group1", codes: t.group1,
            hint: "Your track's core courses: all of them are required. (" + t.name + ")",
            slots: {
              G1: { label: "Group I", title: "Major track: Group I course", credits: 3, only: notLab },
              G1L: { label: "Group I lab", title: "Major track: Group I lab", credits: 1, only: isLab, chip: false },
            },
          },
          {
            id: "group2", kind: "credits", need: t.group2_required_credits, label: "Group II", name: trackKey + " Group II",
            section: "Major track: " + trackKey, cat: "group2", codes: t.group2,
            blurb: "Pick from " + t.group2.length + " " + trackKey + " electives",
            hint: "Your track's electives: at least " + t.group2_required_credits + " credits. Credits past that count as technical electives. (" + t.name + ")",
            slots: { G2: { label: "Group II", title: "Major track: Group II course", credits: 3 } },
          },
          {
            id: "te", kind: "credits", need: te.required_credits, greedy: true, label: "Tech elective", name: "Technical electives",
            rowName: te.required_credits + " credits from the track lists", cat: "te",
            eligible: function (code) { return (teListed(code) || teCaseByCase(code)) && t.group1.indexOf(code) < 0; },
            approval: function (code) { return !teListed(code) && !teCaseByCase(code); },
            approvalNote: "isn't on the check sheet's technical elective lists. It counts only with department approval.",
            caseByCase: teCaseByCase,
            caseNote: "(special topics) counts as a technical elective case by case. Confirm with the department.",
            extras: [
              { name: te.outside_track_credits + " of them outside the " + trackKey + " track", label: "that must come from outside the " + trackKey + " track", need: te.outside_track_credits, counts: function (code) { return !own(code); } },
              { name: te.lab_credits + " lab credit", label: "of lab", need: te.lab_credits, counts: isLab, slot: "TEL" },
            ],
            hint: te.required_credits + " credits from the track lists and the extra TE-eligible courses: " + te.outside_track_credits + " of them outside your track, " + te.lab_credits + " a lab. Group II credits past the minimum count here automatically.",
            slots: {
              TE: { label: "TE", chipLabel: "Tech elective", title: "Technical elective", credits: 3 },
              TEL: { label: "TE lab", title: "Technical elective lab", credits: 1, only: isLab, hint: "Technical elective labs: " + te.lab_credits + " lab credit is required." },
            },
          },
          {
            id: "eb", kind: "credits", need: P.engineering_breadth.required_credits, label: "Eng. breadth", name: "Engineering breadth",
            rowName: "EB — Engineering breadth", section: "gened", cat: "eb", eligible: isEb, manualKey: "__eb_manual_science",
            blurb: "CEE 270, or CEE / ME / ORE / BE 300+",
            approval: function (code) { return !isEb(code); },
            approvalNote: "counts as engineering breadth only with approval from the department's Undergraduate Curriculum Committee.",
            hint: "CEE 270, or a CEE / ME / ORE / BE course at the 300 level or higher. An approved 300+ science course also counts: add it, then set “Counts toward” to Engineering breadth.",
            slots: { EB: { label: "EB", chipLabel: "Eng. breadth", title: "Engineering Breadth", credits: 3 } },
          },
        ];
      },
      minima: function (trackKey) {
        return [{ name: "Major track", label: "credits required in the " + trackKey + " track", pools: ["group1", "group2"], need: P.major_track_minimum }];
      },
    };
  }

  // ---------- Computer Engineering ----------
  function computer() {
    // "TE may be ECE courses 300 or above, or ICS courses listed below."
    var ICS_TE = [313, 321, 351, 355, 414, 415, 421, 423, 424, 425, 428, 431, 432, 441, 442, 451, 455, 461, 464, 465, 466, 469, 481]
      .map(function (n) { return "ICS " + n; });
    function listed(code) { return (subjectOf(code) === "ECE" && numberOf(code) >= 300) || ICS_TE.indexOf(code) >= 0; }
    return {
      id: "CENG", name: "Computer Engineering", effective: "August 2026",
      tracks: null, gridCredits: ECE_GRID_CREDITS,
      // Notes 4, 5 and 11. ICS 141 and 241 together replace ECE 362; ICS 311
      // replaces the ECE 367 lecture and its lab.
      substitutes: merge(MATH_CHEM, VIP, { "ECE 362": [["ICS 141", "ICS 241"]], "ECE 367": ["ICS 311"], "ECE 367L": ["ICS 311"] }),
      grid: function () {
        return [
          [{ code: "ENG 100" }, { code: "MATH 241" }, { code: "CHEM 161" }, { code: "CHEM 161L" }, { code: "ECE 160" }],
          [{ code: "MATH 242" }, { code: "PHYS 170" }, { code: "PHYS 170L" }, { code: "CHEM 162" }, { slot: "FG" }],
          [{ code: "ECE 211" }, { code: "ECE 260" }, { code: "MATH 243" }, { code: "PHYS 272" }, { code: "PHYS 272L" }, { code: "ECE 296" }],
          [{ code: "ECE 213" }, { code: "ECE 205" }, { code: "MATH 244" }, { code: "PHYS 274" }, { slot: "FG" }],
          [{ code: "ECE 324" }, { code: "ECE 371" }, { code: "ECE 361" }, { code: "ECE 361L" }, { code: "ECE 362" }, { alt: ["ECE 345", "MATH 307"] }],
          [{ code: "ECE 315" }, { code: "ECE 323" }, { code: "ECE 323L" }, { code: "ECE 367" }, { code: "ECE 367L" }, { code: "ECE 396" }, { slot: "TE" }],
          [{ code: "ECE 342" }, { alt: ["ECE 467", "ICS 314"] }, { code: "ECE 468" }, { slot: "DHDL" }, { code: "COMG 251" }],
          [{ code: "ECE 496" }, { code: "ECE 495" }, { slot: "TE" }, { slot: "TE" }, ECON, { slot: "DS" }],
        ];
      },
      pools: function () {
        return [{
          id: "te", kind: "credits", need: 9, greedy: true, label: "Tech elective", name: "Technical electives",
          rowName: "9 credits: ECE 300+ or the listed ICS courses", cat: "te",
          eligible: function (code) { return listed(code) || isEb(code); },
          core: listed,
          // Note 10: "One TE may be substituted with an Engineering Breadth
          // (EB) course" -- so at most one course from outside ECE / the ICS list.
          limits: [{ label: "Engineering Breadth course in place of a TE", count: 1, test: function (code) { return !listed(code); } }],
          approval: function (code) { return !listed(code) && !isEb(code); },
          approvalNote: "counts as a technical elective only as the one Engineering Breadth substitute, and a science course needs approval from the department's Undergraduate Curriculum Committee.",
          hint: "At least 9 credits: ECE courses numbered 300 or above, or the ICS courses the check sheet lists. One of them may instead be an Engineering Breadth course (CEE 270, or CEE / ME / ORE / BE 300+; an approved 300+ science course also counts: add it, then set “Counts toward” to Technical electives).",
          slots: { TE: { label: "TE", chipLabel: "Tech elective", title: "Technical elective", credits: 3 } },
        }];
      },
    };
  }

  // ---------- Mechanical Engineering ----------
  function mechanical() {
    function meUpper(code) { return subjectOf(code) === "ME" && numberOf(code) >= 400 && numberOf(code) < 500 && code !== "ME 499"; }
    function byApproval(code) { return subjectOf(code) === "ME" && (numberOf(code) >= 600 || code === "ME 499"); }
    return {
      id: "ME", name: "Mechanical Engineering", effective: "August 2026",
      tracks: null, gridCredits: {},
      // Notes 4 and 5.
      substitutes: merge(MATH_CHEM, { "ME 360": ["PHYS 305", "MATH 407"], "ECE 160": ["ECE 110", "ICS 111"] }),
      equivalents: CEE_ME,
      grid: function () {
        return [
          [{ code: "ENG 100" }, { code: "MATH 241" }, { code: "CHEM 161" }, { code: "CHEM 161L" }, { slot: "FG" }],
          [{ code: "MATH 242" }, { code: "PHYS 170" }, { code: "PHYS 170L" }, { code: "CHEM 162" }, { code: "ECE 160" }],
          [{ code: "CEE 270" }, { code: "MATH 243" }, { code: "PHYS 272" }, { code: "PHYS 272L" }, { code: "ECE 211" }, { code: "ME 213" }],
          [{ alt: ["CEE 271", "ME 271"] }, { code: "MATH 244" }, ECON, { alt: ["MATH 302", "MATH 307"] }, { code: "COMG 251" }, { slot: "FG" }],
          [{ code: "ME 311" }, { code: "ME 331" }, { code: "ME 360" }, { alt: ["ME 371", "CEE 370"] }, { slot: "DS" }],
          [{ code: "ME 322" }, { code: "ME 341" }, { code: "ME 372" }, { code: "ME 375" }],
          [{ code: "ME 422" }, { code: "ME 481" }, { code: "PHYS 274" }, { slot: "TE" }, { slot: "TE" }],
          [{ code: "ME 482" }, { slot: "TE" }, { slot: "DHDL" }, { slot: "TE" }],
        ];
      },
      pools: function () {
        return [{
          id: "te", kind: "credits", need: 12, greedy: true, label: "Tech elective", name: "Technical electives",
          rowName: "12 credits: ME 374 or ME 400-level", cat: "te",
          eligible: function (code) { return code === "ME 374" || meUpper(code) || code === "BIOL 171" || byApproval(code); },
          core: function (code) { return code === "ME 374" || meUpper(code) || code === "BIOL 171"; },
          // "one of which can be replaced with a non-ME course (with approval
          // from Dept. Chair) or Biol 171 without approval; and a second that
          // can be replaced with an ME 600-level course ... or ME 499".
          limits: [
            { label: "non-ME course (or BIOL 171)", count: 1, test: function (code) { return subjectOf(code) !== "ME"; } },
            { label: "ME 600-level course or ME 499", count: 1, test: byApproval },
          ],
          approval: function (code) { return byApproval(code) || (subjectOf(code) !== "ME" && code !== "BIOL 171"); },
          approvalNote: "counts as a technical elective only with approval from the Department Chair (an ME 600-level course also needs a 3.00 GPA).",
          hint: "Four courses, 12 credits: ME 374 or ME 400-level technical electives. One may be a non-ME course (Department Chair's approval; BIOL 171 needs none): add it, then set “Counts toward” to Technical electives. A second may be an ME 600-level course or ME 499, with approval. VIP credit (3 credits of ENGR 296/396 in one project, at least 2 of them ENGR 396) can stand in for one TE: ask the department.",
          slots: { TE: { label: "TE", chipLabel: "Tech elective", title: "Technical elective", credits: 3 } },
        }];
      },
    };
  }

  // ---------- Civil Engineering ----------
  function civil() {
    var BSE = ["BE 120", "MICR 130", "BIOL 171", "ZOOL 101"];
    var SME = ["ME 360", "PHYS 305", "MATH 307", "MATH 311"];
    // "NREM/SUST 442" is one cross-listed course.
    var TES = ["BE 410", "CEE 440", "CEE 441", "ERTH 407", "GEO 412", "GEO 410", "ME 453", "NREM 442", "SUST 442", "OCN 435", "PLAN 414", "SUST 402"];
    var TE_OUTSIDE = ["ECE 211", "ME 311", "ME 374", "ORE 411", "ERTH 454", "ERTH 461", "ME 331", "PLAN 473"];
    function ceeUpper(code) {
      var n = numberOf(code);
      return subjectOf(code) === "CEE" && ((n >= 400 && n < 500) || (n >= 600 && n < 700));
    }
    var lower = [
      [{ code: "ENG 100" }, { code: "MATH 241" }, { code: "CHEM 161" }, { code: "CHEM 161L" }, { alt: ["ECE 160", "ECE 110", "ICS 111"] }],
      [{ code: "MATH 242" }, { code: "PHYS 170" }, { code: "PHYS 170L" }, { code: "CHEM 162" }, { code: "COMG 251" }, { slot: "FG" }],
      [{ code: "CEE 270" }, { code: "MATH 243" }, { code: "PHYS 272" }, { code: "PHYS 272L" }, { code: "CEE 250" }, { slot: "FG" }],
      [{ alt: ["CEE 271", "ME 271"] }, { code: "MATH 244" }, { code: "CEE 370" }, { code: "CEE 370L" }, { code: "CEE 220" }, { slot: "BSE" }],
      [{ code: "CEE 305" }, { code: "CEE 320" }, { code: "CEE 361" }, ECON, { alt: ["MATH 302", "ERTH 312"] }, { slot: "DHDL" }],
      [{ code: "CEE 330" }, { code: "CEE 355" }, { code: "CEE 375" }, { code: "CEE 381" }, { slot: "DS" }],
    ];
    // The sheet's standard senior year and its two "alternative senior year
    // tracks". On the Sustainability track "CEE 440 or TES" is a TES slot
    // (CEE 440 is on the TES list) and "CEE 499 or TE" a TE slot (CEE 499 is
    // a 400-level CEE course, so it's a TE already).
    var senior = {
      GEN: [
        [{ code: "CEE 431" }, { alt: ["CEE 461", "CEE 462", "CEE 464"] }, { alt: ["CEE 471", "CEE 472"] }, { alt: ["CEE 485", "CEE 486"] }, { code: "CEE 489" }],
        [{ code: "CEE 421" }, { code: "CEE 455" }, { code: "CEE 490" }, { slot: "TES" }, { slot: "TE" }],
      ],
      STR: [
        [{ alt: ["CEE 471", "CEE 472"] }, { code: "CEE 484" }, { code: "CEE 485" }, { slot: "SME" }, { code: "CEE 489" }],
        [{ code: "CEE 421" }, { code: "CEE 455" }, { code: "CEE 486" }, { code: "CEE 490" }, { slot: "TES" }],
      ],
      SUS: [
        [{ code: "CEE 431" }, { alt: ["CEE 462", "CEE 464"] }, { alt: ["CEE 421", "CEE 424"] }, { alt: ["CEE 449", "CEE 499"] }, { code: "CEE 489" }],
        [{ slot: "TES" }, { slot: "TES" }, { code: "CEE 441" }, { slot: "TE" }, { code: "CEE 490" }],
      ],
    };
    var EXEMPT = ["CEE 305", "CEE 370", "CEE 370L"];
    var LOWER_CEE = [["CEE 220"], ["CEE 250"], ["CEE 270"], ["CEE 271", "ME 271"]];

    return {
      id: "CE", name: "Civil Engineering", effective: "August 2026",
      tracks: { GEN: { name: "Standard senior year" }, STR: { name: "Structures track" }, SUS: { name: "Sustainability and Innovation track" } },
      defaultTrack: "GEN", gridCredits: {},
      substitutes: merge(MATH_CHEM),
      equivalents: CEE_ME,
      grid: function (trackKey) { return lower.concat(senior[trackKey] || senior.GEN); },
      pools: function (trackKey) {
        var pools = [{
          id: "bse", kind: "credits", need: 3, label: "BSE", name: "Biological science elective", rowName: "BSE — Biological science elective",
          section: "gened", cat: "gened", codes: BSE, blurb: "BE 120, MICR 130, BIOL 171 or ZOOL 101",
          hint: "One of BE 120, MICR 130, BIOL 171 or ZOOL 101. The lab isn't required. For the environmental area the sheet suggests MICR 130 or BE 120.",
          slots: { BSE: { label: "BSE", title: "Biological Science Elective", credits: 3 } },
        }];
        if (trackKey === "STR") {
          pools.push({
            id: "sme", kind: "credits", need: 3, label: "SME", name: "Structural math elective", rowName: "SME — Structural math elective",
            cat: "group2", codes: SME, blurb: "ME 360, PHYS 305, MATH 307 or MATH 311",
            hint: "One of ME 360, PHYS 305, MATH 307 or MATH 311.",
            slots: { SME: { label: "SME", title: "Structural Math Elective", credits: 3 } },
          });
        }
        pools.push({
          id: "tes", kind: "credits", need: trackKey === "SUS" ? 6 : 3, label: "TES", name: "Sustainability technical electives",
          rowName: "TES — Technical elective with a sustainability focus", cat: "eb", codes: TES,
          blurb: "From the check sheet's TES list",
          hint: "From the sheet's sustainability list: BE 410, CEE 440, CEE 441, ERTH 407, GEO 410, GEO 412, ME 453, NREM/SUST 442, OCN 435, PLAN 414, SUST 402." + (trackKey === "SUS" ? " The Sustainability track needs two, besides the required CEE 441." : ""),
          slots: { TES: { label: "TES", title: "Technical elective, sustainability focus", credits: 3 } },
        });
        if (trackKey !== "STR") {
          pools.push({
            id: "te", kind: "credits", need: 3, greedy: true, label: "Tech elective", name: "Technical electives",
            rowName: "TE — any 400 or 600 level CEE course", cat: "te",
            eligible: function (code) { return ceeUpper(code) || TE_OUTSIDE.indexOf(code) >= 0; },
            limits: [{ label: "course from outside CEE", count: 1, test: oneOf(TE_OUTSIDE) }],
            approval: function (code) { return !ceeUpper(code) && TE_OUTSIDE.indexOf(code) < 0; },
            approvalNote: "isn't a 400 or 600 level CEE course or on the sheet's short outside list, so it counts as a technical elective only with the department's approval.",
            blurb: "Any 400 or 600 level CEE course",
            hint: "Any 400 or 600 level CEE course that isn't already one of your required courses. At most one may instead come from ECE 211, ME 311, ME 331, ME 374, ORE 411, ERTH 454, ERTH 461 or PLAN 473.",
            slots: { TE: { label: "TE", chipLabel: "Tech elective", title: "Technical elective", credits: 3 } },
          });
        }
        return pools;
      },
      // "All lower division CEE courses must be completed before taking upper
      // division CEE courses, except CEE 305, 370, and 370L."
      checks: function (ev, add) {
        var first = null;
        ev.courses.forEach(function (e) {
          var code = e.item.code;
          if (subjectOf(code) !== "CEE" || numberOf(code) < 300 || EXEMPT.indexOf(code) >= 0 || e.index < 0) return;
          if (!first || e.index < first.index) first = e;
        });
        if (!first) return;
        var late = [];
        LOWER_CEE.forEach(function (group) {
          var entry = ev.courses.filter(function (e) { return group.indexOf(e.item.code) >= 0; })
            .sort(function (a, b) { return a.index - b.index; })[0];
          if (!entry) late.push(group.join(" or ") + " (not in your plan)");
          else if (entry.index >= first.index) late.push(entry.item.code + " (" + (entry.sem.term || "") + ")");
        });
        if (late.length) {
          add("error", "Prerequisites", first.item.code + " in " + first.sem.term + " is an upper-division CEE course, but the lower-division CEE courses aren't all finished before it: " + late.join(", ") + ". Civil Engineering requires every lower-division CEE course first (CEE 305, 370 and 370L are the exceptions).", { itemId: first.item.id });
        }
      },
      notes: ["A grade of C or better is required in PHYS 170, CEE 270 and CEE 370.", "For a specialty track, ask the department office to assign you an advisor from that specialty."],
    };
  }

  window.buildPrograms = function (data) {
    var list = [electrical(data), computer(), mechanical(), civil()];
    var byId = {};
    list.forEach(function (p) { byId[p.id] = p; });
    return { list: list, byId: byId };
  };
})();
