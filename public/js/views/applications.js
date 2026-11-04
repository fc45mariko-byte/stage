import { api, html, fmtDate, statusPill, AREA_LABEL, STATUS_LABEL } from '../core.js';

const GROUPS = [
  ['In preparation', ['generating', 'draft', 'awaiting_approval']],
  ['Sent', ['sent', 'follow_up']],
  ['Interviews', ['interview']],
  ['Closed', ['accepted', 'rejected']],
];

export async function mount(el, { query }) {
  const items = await api('applications');
  const filter = query.status || '';
  const shown = filter ? items.filter((a) => a.status === filter) : items;
  const statuses = [...new Set(items.map((a) => a.status))];
  el.innerHTML = html`
  <div class="page-head"><div>
    <div class="eyebrow">Applications</div>
    <h1>Applications</h1>
    <p class="lede">Every application keeps its documents, the exact files sent and everything that happened afterwards.</p>
  </div></div>
  ${statuses.length > 1 ? html`<div class="chips">${[['', 'All'], ...statuses.map((s) => [s, null])].map(([s]) => html`<a class="chip ${filter === s ? 'active' : ''}" href="#/applications${s ? `?status=${s}` : ''}">${s ? STATUS_LABEL[s] : 'All'}</a>`)}</div>` : ''}
  ${!items.length ? html`<div class="empty section"><div class="serif">No applications yet</div>Mark an opportunity as <em>Interested</em> in <a href="#/discover">Discover</a> to start one.</div>` : ''}
  ${GROUPS.map(([title, sts]) => {
    const rows = shown.filter((a) => sts.includes(a.status));
    if (!rows.length) return '';
    return html`<div class="section"><h2>${title}</h2><ul class="list">${rows.map((a) => html`
      <li><a class="row-link" href="#/applications/${a.id}">
        <div class="title">${a.name}</div>
        <div class="small muted">${a.position_title || a.opp_position || (a.kind === 'published' ? 'Published internship' : 'Spontaneous application')} · ${a.city || AREA_LABEL[a.area] || ''}${a.recipient ? ` · ${a.recipient}` : ''}</div>
        ${a.generation_error ? html`<div class="xs"><span class="tag danger">Generation failed</span></div>` : ''}
      </a>
      <span class="meta">${statusPill(a.status)}<br><span class="xs">${a.sent_at ? `Sent ${fmtDate(a.sent_at)}` : `Updated ${fmtDate(a.updated_at)}`}${a.responses ? ` · ${a.responses} response${a.responses > 1 ? 's' : ''}` : ''}</span></span></li>`)}</ul></div>`;
  })}`.s;
}
