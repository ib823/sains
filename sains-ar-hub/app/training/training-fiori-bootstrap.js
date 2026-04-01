/* ═══════════════════════════════════════════════════════════════
   SAINS AR Hub — Fiori Training Bootstrap
   Polls for SAPUI5 shell readiness, then injects training overlay.
   ═══════════════════════════════════════════════════════════════ */
;(function () {
  'use strict';

  var MAX_ATTEMPTS = 60;
  var POLL_INTERVAL = 500;
  var attempts = 0;

  function tryInit() {
    attempts++;
    var shell = document.querySelector('.sapUshellShellHead');
    var table = document.querySelector('.sapUiCompSmartTable, .sapMList, .sapMTable');

    if (shell && table) {
      if (window.TrainingOverlay && window.TrainingContent) {
        TrainingOverlay.init({
          pageId: 'fiori',
          steps: TrainingContent.fiori,
          autoShow: false
        });
      }
    } else if (attempts < MAX_ATTEMPTS) {
      setTimeout(tryInit, POLL_INTERVAL);
    }
  }

  if (document.readyState === 'complete') {
    tryInit();
  } else {
    window.addEventListener('load', function () {
      setTimeout(tryInit, 1000);
    });
  }
})();
