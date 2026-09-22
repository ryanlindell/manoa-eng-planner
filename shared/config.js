// Settings for visitor tracking (GoatCounter) and the feedback popup.
// Shared by the planner (web/) and the visualizer (visualizer/)
window.PLANNER_CONFIG = {
  goatcounterCode: "cyanic",

  // Where the popup's button sends people.
  feedbackUrl: "https://forms.gle/BFRBAz8N9AXigaBS8",

  // How long someone has to spend on a page (with the tab visible) before the
  // popup appears.
  feedbackDelayMs: 3 * 60 * 1000,

  // After "Maybe later", don't show the popup again in this browser for this
  // many days. Clicking through to the form silences it for a year.
  feedbackSnoozeDays: 30,
};
