import { api, html, fmtTime, bind } from '../core.js';

const TYPES = [['', 'All'], ['search', 'Searches'], ['discover', 'Discoveries'], ['decision', 'Decisions'], ['generate', 'Generated'], ['edit', 'Edits'], ['approve', 'Approvals'], ['send', 'Sent'], ['archive', 'Follow-up'], ['profile', 'Profile'], ['error', 'Errors']];

export async function mount(el, { query }) {
  const type = query.type || '';
  let items = await api(`activity${type ? `?type=${type}` : ''}`);
  const render = () => {
    const days = new Map();
    for (const a of items) {
      const k = new Date(a.ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(a);
    }
    el.innerHTML = html`
    <div class="page-head"><div><div class="eyebrow">Activity</div><h1>What the agent has done</h1>
      <p class="lede">A permanent, chronological record of searches, discoveries, generated documents, approvals and emails sent.</p></div></div>
    <div class="chips">${TYPES.map(([k, l]) => html`<a class="chip ${type === k ? 'active' : ''}" href="#/activity${k ? `?type=${k}` : ''}">${l}</a>`)}</div>
    ${items.length ? [...days.entries()].map(([day, list]) => html`<div class="day"><h3>${day}</h3>${list.map((a) => html`<div class="act"><span class="time">${fmtTime(a.ts)}</span><span class="type ${a.type}">${a.type}</span><span class="msg break">${a.ref_type === 'application' ? html`<a href="#/applications/${a.ref_id}">${a.message}</a>` : a.message}</span></div>`)}</div>`) : html`<div class="empty section">No activity recorded.</div>`}
    ${items.length && items.length % 100 === 0 ? html`<div class="section"><button class="btn" data-action="more">Load earlier</button></div>` : ''}`.s;
  };
  render();
  bind(el, { click: { more: async () => { items = items.concat(await api(`activity?before=${items[items.length - 1].id}${type ? `&type=${type}` : ''}`)); render(); } } });
}
