// Loads GoatCounter (https://www.goatcounter.com) using the site code from config.js.
// GoatCounter is cookie-free and deliberately ignores localhost / file:// pages,
// so testing locally won't add to your numbers.
(function () {
  "use strict";
  var code = (window.PLANNER_CONFIG || {}).goatcounterCode;
  if (!code) {
    console.info("[analytics] GoatCounter is off: set goatcounterCode in shared/config.js");
    return;
  }
  if (!/^[a-z0-9-]+$/i.test(code)) {
    console.warn("[analytics] goatcounterCode should be just the site code (e.g. \"myname\"), got: " + code);
    return;
  }
  var s = document.createElement("script");
  s.async = true;
  s.dataset.goatcounter = "https://" + code + ".goatcounter.com/count";
  s.src = "https://gc.zgo.at/count.js";
  document.head.appendChild(s);
})();
