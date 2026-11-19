/* Applies the saved theme before first paint. External so the strict CSP can
   allow it without 'unsafe-inline'. */
(function () {
  try {
    var raw = localStorage.getItem('oa.settings');
    var theme = raw ? JSON.parse(raw).theme : 'system';
    if (theme !== 'light' && theme !== 'dark') theme = 'system';
    var resolved = theme;
    if (theme === 'system') {
      resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    }
    document.documentElement.setAttribute('data-theme', resolved);
  } catch (error) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
