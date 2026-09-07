// One head script initializes the theme before paint, then enhances server-rendered content.
export const REPORT_SCRIPT = `(() => {
  const root = document.documentElement;
  const query = matchMedia('(prefers-color-scheme: light)');
  const storedTheme = () => {
    try { const value = localStorage.getItem('theme'); return value === 'light' || value === 'dark' ? value : ''; } catch { return ''; }
  };
  const fragmentTheme = () => {
    const value = new URLSearchParams(location.hash.slice(1)).get('theme');
    return value === 'light' || value === 'dark' ? value : '';
  };
  root.dataset.theme = fragmentTheme() || storedTheme() || (query.matches ? 'light' : 'dark');
  document.addEventListener('DOMContentLoaded', () => {
    root.dataset.js = 'true';
    const applyTheme = (theme, persist) => {
      root.dataset.theme = theme;
      if (persist) {
        try { localStorage.setItem('theme', theme); } catch {}
        history.replaceState(null, '', '#theme=' + theme);
      }
      // Opaque-origin frames cannot use storage; carry their choice through report links.
      const basePath = root.dataset.reportBasePath;
      for (const link of document.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href');
        const target = new URL(href, location.href);
        const internal = target.origin === location.origin &&
          (target.pathname === basePath || target.pathname.startsWith(basePath + '/'));
        if (internal || link.hasAttribute('data-report-open-window')) {
          link.setAttribute('href', href.split('#')[0] + '#theme=' + theme);
        }
      }
      for (const button of document.querySelectorAll('[data-theme-toggle]')) {
        button.setAttribute('aria-label', 'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' theme');
      }
    };
    applyTheme(root.dataset.theme, false);
    query.addEventListener('change', event => { if (!fragmentTheme() && !storedTheme()) applyTheme(event.matches ? 'light' : 'dark', false); });
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.addEventListener('click', () => applyTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true));
    }
    const relative = new Intl.RelativeTimeFormat('en', {numeric:'auto'});
    const units = [['year',31536000000],['month',2592000000],['week',604800000],['day',86400000],['hour',3600000],['minute',60000],['second',1000]];
    const refresh = () => {
      for (const node of document.querySelectorAll('[data-relative-time]')) {
        const diff = Date.parse(node.getAttribute('datetime')) - Date.now();
        if (!Number.isFinite(diff)) continue;
        const [unit, ms] = units.find(([unit, ms]) => Math.abs(diff) >= ms || unit === 'second');
        node.textContent = relative.format(Math.round(diff / ms), unit);
      }
      for (const node of document.querySelectorAll('[data-day-countdown]')) {
        const until = Date.parse(node.dataset.until);
        if (!Number.isFinite(until)) continue;
        const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
        const remaining = minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm' : minutes + 'm';
        const close = new Date(until).toISOString().slice(11,16) + ' UTC';
        node.textContent = until <= Date.now() ? 'day closed at ' + close : 'closes in ' + remaining + ' (' + close + ')';
      }
    };
    refresh();
    setInterval(refresh, 60000);
    const nav = document.querySelector('.site-nav');
    const scrolled = () => { if (nav) nav.dataset.scrolled = window.scrollY > 0 ? 'true' : 'false'; };
    scrolled();
    window.addEventListener('scroll', scrolled, {passive:true});
    for (const button of document.querySelectorAll('[data-toggle]')) {
      const list = document.querySelector('[data-list="' + button.dataset.toggle + '"]');
      if (!list) continue;
      button.addEventListener('click', () => {
        const rows = [...list.querySelectorAll('[data-extra]')];
        const show = rows.some(row => row.hidden);
        for (const row of rows) row.hidden = !show;
        button.setAttribute('aria-expanded', String(show));
        button.textContent = show ? 'Show latest only' : 'Show all ' + list.querySelectorAll('.row').length;
      });
    }
    const filter = document.querySelector('[data-maintainer-filter]');
    const status = document.querySelector('[data-maintainer-filter-status]');
    const empty = document.querySelector('[data-maintainer-filter-empty]');
    if (filter) {
      const applyFilter = () => {
        const value = filter.value.trim().replace(/^@/, '').toLocaleLowerCase();
        const rows = [...document.querySelectorAll('[data-maintainer-search]')];
        for (const row of rows) row.hidden = !row.dataset.maintainerSearch.toLocaleLowerCase().includes(value);
        const shown = rows.filter(row => !row.hidden).length;
        if (status) status.textContent = shown + ' of ' + rows.length + ' members shown';
        if (empty) empty.hidden = shown > 0;
      };
      const params = new URLSearchParams(location.search);
      filter.value = params.get('person') || params.get('q') || '';
      filter.addEventListener('input', applyFilter);
      applyFilter();
    }
    const quiet = document.querySelector('[data-hide-inactive-toggle]');
    if (quiet) quiet.addEventListener('change', () => {
      root.dataset.peopleHideInactive = quiet.checked ? 'true' : 'false';
    });
  });
})();`;
