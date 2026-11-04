// Shared front-end helpers: safe HTML templates, API client, toasts, jobs.

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v == null || v === false ? '' : esc(v));
/** Tagged template: interpolations are escaped unless wrapped in raw()/html``. */
export const html = (strings, ...vals) => raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: { 'x-requested-with': 'stage-app' }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(path.startsWith('/') ? path : `/api/${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.includes('auth/')) { location.hash = '#/login'; throw new ApiError('Please sign in', 401); }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

let toastTimer;
export function toast(msg, kind = '') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

/** Polls a background job until it finishes. */
export async function waitForJob(id, onProgress) {
  for (;;) {
    const j = await api(`jobs/${id}`);
    onProgress?.(j);
    if (j.status === 'done') return j;
    if (j.status === 'failed') throw new ApiError(j.error || 'The task failed');
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export const fmtDate = (iso, withTime = false) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return withTime ? `${date}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : date;
};
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export const STATUS_LABEL = {
  draft: 'Draft', generating: 'Writing…', awaiting_approval: 'Awaiting approval', sent: 'Sent', follow_up: 'Follow-up needed',
  interview: 'Interview', rejected: 'Rejected', accepted: 'Accepted', withdrawn: 'Discarded',
};
export const statusPill = (s) => html`<span class="pill ${s}">${STATUS_LABEL[s] || s}</span>`;
export const AREA_LABEL = { orleans: 'Orléans area', paris: 'Paris area', other: 'Other' };
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

export function formData(form) {
  const fd = new FormData(form);
  const out = {};
  for (const [k, v] of fd.entries()) {
    if (k in out) out[k] = [].concat(out[k], v); else out[k] = v;
  }
  return out;
}

/**
 * Delegated events for a view container.
 * handlers: { click: { action: fn(el, ev) }, submit: { form: fn(data, formEl, ev) }, change: { name: fn(el, ev) }, input: {...} }
 */
export function bind(root, handlers) {
  root.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const fn = handlers.click?.[el.dataset.action];
    if (!fn) return;
    ev.preventDefault();
    if (el.disabled) return;
    await guard(el, () => fn(el, ev));
  });
  root.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('form[data-form]');
    const fn = form && handlers.submit?.[form.dataset.form];
    if (!fn) return;
    ev.preventDefault();
    const btn = form.querySelector('[type=submit]');
    await guard(btn, () => fn(formData(form), form, ev));
  });
  for (const type of ['change', 'input']) {
    if (!handlers[type]) continue;
    root.addEventListener(type, (ev) => {
      const el = ev.target.closest('[data-on]');
      const fn = el && handlers[type][el.dataset.on];
      if (fn) fn(el, ev);
    });
  }
}

async function guard(btn, fn) {
  const label = btn?.dataset.busy;
  const prev = btn?.innerHTML;
  if (btn) { btn.disabled = true; if (label) btn.textContent = label; }
  try { await fn(); } catch (e) { if (e.status !== 401) toast(e.message || 'Something went wrong', 'error'); console.error(e); } finally {
    if (btn && btn.isConnected) { btn.disabled = false; if (label) btn.innerHTML = prev; }
  }
}

export const spinner = (text) => html`<div class="progress"><span class="spinner"></span><span>${text}</span></div>`;
