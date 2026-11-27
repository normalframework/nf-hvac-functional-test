// Apply the saved light/dark theme before first paint. Same storage key as Open-FDD, so one choice covers both apps.
(function () {
  'use strict';
  try {
    const saved = localStorage.getItem('openfdd-ui-theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
  } catch {
    // storage blocked: keep the default light theme
  }
})();
