// Feedback popup: after the visitor has spent feedbackDelayMs on the page (tab
// visible), slide in a card linking to the Google Form. Settings: config.js.
// Add ?feedback=test to a URL to ignore the "already dismissed" memory while testing.
(function () {
  "use strict";

  var cfg = window.PLANNER_CONFIG || {};
  var FORM_URL = cfg.feedbackUrl;
  var DELAY_MS = cfg.feedbackDelayMs || 3 * 60 * 1000;
  var SNOOZE_DAYS = cfg.feedbackSnoozeDays || 14;
  var DONE_DAYS = 365;
  var KEY = "plannerFeedbackHiddenUntil";
  var DAY_MS = 24 * 60 * 60 * 1000;

  if (!FORM_URL) return;

  // Storage can throw (private mode, blocked cookies); the popup must still work.
  function readHiddenUntil() {
    try { return Number(localStorage.getItem(KEY)) || 0; } catch (e) { return 0; }
  }
  function hideFor(days) {
    try { localStorage.setItem(KEY, String(Date.now() + days * DAY_MS)); } catch (e) {}
  }

  var testing = /[?&]feedback=test(&|$)/.test(location.search);
  if (!testing && Date.now() < readHiddenUntil()) return;

  // Shows up in GoatCounter as an "event" (if tracking is on), so you can
  // compare popups shown vs. clicked vs. dismissed.
  function track(name, title) {
    var gc = window.goatcounter;
    if (gc && typeof gc.count === "function") gc.count({ event: true, path: name, title: title });
  }

  // "Time on the page" = time the tab was actually visible, not just open.
  var visibleMs = 0;
  var visibleSince = document.hidden ? null : Date.now();
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (visibleSince !== null) visibleMs += Date.now() - visibleSince;
      visibleSince = null;
    } else {
      visibleSince = Date.now();
    }
  });

  var timer = setInterval(function () {
    var total = visibleMs + (visibleSince !== null ? Date.now() - visibleSince : 0);
    if (total < DELAY_MS) return;
    clearInterval(timer);
    show();
  }, 1000);

  function show() {
    var card = document.createElement("div");
    card.className = "pf-popup";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-labelledby", "pf-title");
    card.setAttribute("aria-describedby", "pf-body");
    card.innerHTML =
      '<button type="button" class="pf-close" aria-label="Dismiss">×</button>' +
      '<p class="pf-title" id="pf-title">Got a minute?</p>' +
      '<p class="pf-body" id="pf-body">Tell me what’s useful, what’s confusing, and what’s missing. It’s a quick Google Form and it helps me make this better.</p>' +
      '<div class="pf-actions">' +
        '<a class="pf-btn pf-primary" target="_blank" rel="noopener">Leave a review</a>' +
        '<button type="button" class="pf-btn pf-later">Maybe later</button>' +
      '</div>';
    card.querySelector(".pf-primary").href = FORM_URL;

    function close() {
      document.removeEventListener("keydown", onKey);
      card.classList.remove("pf-in");
      setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 250);
    }
    function dismiss() { hideFor(SNOOZE_DAYS); track("feedback-dismiss", "Feedback popup dismissed"); close(); }
    function onKey(e) { if (e.key === "Escape") dismiss(); }

    card.querySelector(".pf-close").addEventListener("click", dismiss);
    card.querySelector(".pf-later").addEventListener("click", dismiss);
    // The link opens the form in a new tab; the popup just goes away behind it.
    function openedForm() {
      hideFor(DONE_DAYS);
      track("feedback-click", "Feedback popup: opened the form");
      close();
    }
    var link = card.querySelector(".pf-primary");
    link.addEventListener("click", openedForm);
    // A middle-click also opens the link in a new tab, but only fires auxclick.
    link.addEventListener("auxclick", function (e) { if (e.button === 1) openedForm(); });
    document.addEventListener("keydown", onKey);

    document.body.appendChild(card);
    // Two frames so the browser paints the starting state before transitioning.
    requestAnimationFrame(function () { requestAnimationFrame(function () { card.classList.add("pf-in"); }); });
    track("feedback-shown", "Feedback popup shown");
  }
})();
