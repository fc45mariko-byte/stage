import { api, html, parseHash, bind, toast } from './core.js';
import * as overview from './views/overview.js';
import * as discover from './views/discover.js';
import * as applications from './views/applications.js';
import * as application from './views/application.js';
import * as library from './views/library.js';
import * as activity from './views/activity.js';
import * as profile from './views/profile.js';
import * as settings from './views/settings.js';
import * as auth from './views/auth.js';

const app = document.getElementById('app');
let authState = null;

const NAV = [
  ['/', 'Overview'], ['/discover', 'Discover', 'newOpportunities'], ['/applications', 'Applications', 'drafts'],
  ['/library', 'Document library'], ['/activity', 'Activity'], null, ['/profile', 'Profile', 'openQuestions'], ['/settings', 'Settings'],
];

function pick(parts) {
  switch (parts[0]) {
    case undefined: return overview;
    case 'discover': return discover;
    case 'applications': return parts[1] ? application : applications;
    case 'library': return library;
    case 'activity': return activity;
    case 'profile': return profile;
    case 'settings': return settings;
    default: return overview;
  }
}

function shell(path, counts, integrations) {
  const active = (p) => (p === '/' ? path === '/' : path.startsWith(p));
  return html`
  <div class="topbar"><div class="brand">Stage</div><button class="btn small" data-action="menu" aria-label="Menu">Menu</button></div>
  <div class="shell">
    <aside class="sidebar" id="sidebar">
      <div class="brand">Stage<small>Internship workspace</small></div>
      <nav class="nav">
        ${NAV.map((n) => (n ? html`<a href="#${n[0]}" class="${active(n[0]) ? 'active' : ''}"><span>${n[1]}</span>${n[2] && counts?.[n[2]] ? html`<span class="count">${counts[n[2]]}</span>` : ''}</a>` : html`<div class="nav-sep"></div>`))}
      </nav>
      <div class="sidebar-foot">
        <span><span class="dot ${integrations?.ai ? 'on' : 'off'}"></span>AI research &amp; writing ${integrations?.ai ? 'on' : 'off'}</span>
        <span><span class="dot ${integrations?.email ? 'on' : 'off'}"></span>Email sending ${integrations?.email ? 'on' : 'off'}</span>
        <a href="#" data-action="logout">Sign out</a>
      </div>
    </aside>
    <main id="view"></main>
  </div>`;
}

async function route() {
  const { path, parts, query } = parseHash();
  if (!authState) authState = await api('/api/auth/state');
  if (!authState.user) {
    app.innerHTML = '';
    const el = document.createElement('div');
    app.append(el);
    return auth.mount(el, { setup: authState.setupRequired, onDone: () => { authState = null; location.hash = '#/'; route(); } });
  }
  if (path === '/login') { location.hash = '#/'; return; }
  let ov = null;
  try { ov = await api('overview'); } catch { /* shell still renders */ }
  const counts = ov ? { newOpportunities: ov.stats.newOpportunities, drafts: ov.stats.drafts, openQuestions: ov.openQuestions } : {};
  app.innerHTML = shell(path, counts, ov?.integrations).s;
  bind(app.querySelector('.topbar'), { click: { menu: () => document.getElementById('sidebar').classList.toggle('open') } });
  bind(app.querySelector('.sidebar'), {
    click: {
      logout: async () => { await api('/api/auth/logout', { method: 'POST' }); authState = null; location.hash = '#/login'; route(); },
    },
  });
  app.querySelector('.nav').addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));
  const view = document.getElementById('view');
  window.scrollTo(0, 0);
  try {
    await pick(parts).mount(view, { parts, query, overview: ov });
  } catch (e) {
    if (e.status === 401) { authState = null; return route(); }
    view.innerHTML = html`<div class="notice danger"><strong>Could not load this page.</strong> ${e.message}</div>`.s;
  }
}

window.addEventListener('hashchange', () => { if (!window.__stageBlockNav?.()) route(); });
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.status !== 401) toast(e.reason?.message || 'Unexpected error', 'error'); });
route();
