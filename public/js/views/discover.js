import { api, html, bind, toast, waitForJob, fmtDate, AREA_LABEL, hostOf, spinner } from '../core.js';

const TABS = [['new', 'New'], ['saved', 'Saved for later'], ['interested', 'Interested'], ['not_interested', 'Not interested'], ['all', 'All']];
const FIT = { strong: 'Strong match', possible: 'Possible match', weak: 'Weak match' };

function card(o) {
  const published = o.kind === 'published';
  const emailTag = o.best_email
    ? html`<span class="tag verified" title="Found by this app on the organization's own website">Verified</span>`
    : '';
  return html`
  <article class="opp" id="opp-${o.id}">
    <div class="opp-head">
      <div>
        <h3>${o.name}</h3>
        <div class="where">${o.city || AREA_LABEL[o.area] || ''}${o.city && o.area !== 'other' ? ` · ${AREA_LABEL[o.area]}` : ''} · ${o.industry || 'Sector not determined'}</div>
      </div>
      <div class="tags">
        ${published ? html`<span class="tag solid">Published internship</span>` : html`<span class="tag">Spontaneous application</span>`}
        ${o.fit ? html`<span class="tag ai" title="AI assessment">${FIT[o.fit]}</span>` : ''}
        ${o.origin === 'manual' ? html`<span class="tag">Added by you</span>` : ''}
      </div>
    </div>
    <div class="opp-body">
      <div>
        <dl class="kv"><dt>Organization <span class="tag ai">AI summary of its website</span></dt><dd>${o.description || html`<span class="muted">No description available.</span>`}</dd></dl>
        <dl class="kv"><dt>Potential internship ${published ? html`<span class="tag verified">From published offer</span>` : html`<span class="tag ai">AI suggestion</span>`}</dt>
          <dd class="position">${o.position_title || html`<span class="muted">Not defined</span>`}</dd></dl>
        ${o.responsibilities.length ? html`<dl class="kv"><dt>Possible responsibilities <span class="tag ai">AI suggestion</span></dt><dd><ul>${o.responsibilities.map((r) => html`<li>${r}</li>`)}</ul></dd></dl>` : ''}
        ${o.match_reasons.length ? html`<dl class="kv"><dt>Why it matches your profile <span class="tag ai">AI suggestion</span></dt><dd><ul>${o.match_reasons.map((r) => html`<li>${r}</li>`)}</ul></dd></dl>` : ''}
      </div>
      <div>
        <dl class="kv"><dt>Website <span class="tag verified" title="Fetched by this app">Reachable</span></dt><dd class="break"><a href="${o.website}" target="_blank" rel="noopener noreferrer">${hostOf(o.website)}</a></dd></dl>
        <dl class="kv"><dt>Contact email ${emailTag}</dt><dd class="break">${o.best_email ? html`${o.best_email}<div class="xs muted">Found on <a href="${o.best_email_source}" target="_blank" rel="noopener noreferrer">${o.best_email_source}</a></div>` : html`<span class="muted">No verified address yet</span>`}</dd></dl>
        ${published ? html`<dl class="kv"><dt>Internship offer <span class="tag verified">Page checked</span></dt><dd class="break"><a href="${o.listing_url}" target="_blank" rel="noopener noreferrer">${o.listing_url}</a></dd></dl>` : ''}
        <dl class="kv"><dt>Sources</dt><dd class="small break">
          ${o.origin === 'manual' ? html`<div>Added by you</div>` : ''}
          ${o.search_sources.length ? html`<div class="muted xs">Web search results:</div>${o.search_sources.slice(0, 3).map((u) => html`<div><a href="${u}" target="_blank" rel="noopener noreferrer">${hostOf(u)}</a></div>`)}` : ''}
          ${o.location_evidence ? html`<div class="muted xs">Location: ${o.location_evidence}</div>` : ''}
        </dd></dl>
        ${o.concerns.length ? html`<dl class="kv"><dt>Points to consider <span class="tag ai">AI suggestion</span></dt><dd><ul class="small">${o.concerns.map((r) => html`<li>${r}</li>`)}</ul></dd></dl>` : ''}
        ${o.handbook_notes ? html`<dl class="kv"><dt>Handbook check <span class="tag ai">AI suggestion</span></dt><dd class="small">${o.handbook_notes}</dd></dl>` : ''}
        ${o.evaluation_status === 'unavailable' ? html`<div class="notice warn small">Not evaluated: AI is not configured. Facts above come only from the website check.</div>` : ''}
      </div>
    </div>
    <details data-org="${o.organization_id}"><summary>Contacts and evidence</summary><div class="details-body" data-details="${o.id}"></div></details>
    <div class="opp-actions">
      ${o.application_id
        ? html`<a class="btn primary" href="#/applications/${o.application_id}">Open application</a>`
        : html`<button class="btn primary" data-action="decide" data-id="${o.id}" data-decision="interested" data-busy="Opening…">Interested</button>`}
      ${o.status !== 'saved' ? html`<button class="btn" data-action="decide" data-id="${o.id}" data-decision="saved">Save for later</button>` : ''}
      ${o.status !== 'not_interested' ? html`<button class="btn ghost" data-action="decide" data-id="${o.id}" data-decision="not_interested">Not interested</button>` : html`<button class="btn ghost" data-action="decide" data-id="${o.id}" data-decision="new">Move back to new</button>`}
      <span class="muted xs">Found ${fmtDate(o.created_at)}. Nobody is contacted at this stage.</span>
    </div>
  </article>`;
}

function details(o) {
  return html`
    <div class="grid-2">
      <div>
        <div class="eyebrow">Email addresses</div>
        ${o.contacts.length ? html`<ul class="list">${o.contacts.map((c) => html`<li><div><div class="break">${c.email} ${c.status === 'verified' ? html`<span class="tag verified">Verified</span>` : c.status === 'failed' ? html`<span class="tag danger">Invalid</span>` : html`<span class="tag warn">Not verified</span>`} ${c.label ? html`<span class="tag">${c.label}</span>` : ''}</div><div class="xs muted break">${c.status_detail || ''}</div></div></li>`)}</ul>` : html`<p class="muted small">No address was found on the pages checked.</p>`}
        <form data-form="contact" class="stack" data-org="${o.organization.id}">
          <div class="eyebrow">Add an address you found</div>
          <input name="email" type="email" placeholder="contact@organization.fr" required>
          <input name="evidence_url" type="url" placeholder="Page on their website showing this address" required>
          <div class="hint xs muted">The app fetches this page and checks the address appears on it. Addresses that cannot be verified are never used for sending.</div>
          <button class="btn small" type="submit" data-busy="Checking…">Verify and add</button>
        </form>
      </div>
      <div>
        <div class="eyebrow">Pages fetched by this app</div>
        <ul class="list small">${o.organization.pages.map((p) => html`<li><div class="break"><a href="${p.url}" target="_blank" rel="noopener noreferrer">${p.title || p.url}</a><div class="xs muted">${p.url}</div></div><span class="meta">${fmtDate(p.fetchedAt)}</span></li>`)}</ul>
        ${o.organization.search_sources.length ? html`<div class="eyebrow section">Web search results mentioning it</div><ul class="list small">${o.organization.search_sources.map((u) => html`<li class="break"><a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a></li>`)}</ul>` : ''}
      </div>
    </div>`;
}

export async function mount(el, { query }) {
  const tab = TABS.some((t) => t[0] === query.tab) ? query.tab : 'new';
  const area = ['orleans', 'paris'].includes(query.area) ? query.area : '';
  const [data, opts, runs] = await Promise.all([api(`opportunities?status=${tab}${area ? `&area=${area}` : ''}`), api('search/options'), api('search-runs')]);
  const running = runs.filter((r) => r.status === 'running');

  const render = () => {
    el.innerHTML = html`
    <div class="page-head"><div>
      <div class="eyebrow">Discover</div>
      <h1>Organizations to consider</h1>
      <p class="lede">The agent searches the web, then this app checks every result itself: the website must exist, contact addresses must appear on the organization's own pages. Anything written by the AI is marked as a suggestion.</p>
    </div></div>

    <div class="panel">
      <h3>Run a new search</h3>
      ${opts.ai ? '' : html`<div class="notice warn small">Web search needs the AI to be configured (see <a href="#/settings">Settings</a>). You can still add an organization you know below.</div>`}
      <form data-form="search" class="search-box">
        <div class="field"><label for="area">Area</label><select id="area" name="area"><option value="orleans">Orléans and surroundings</option><option value="paris">Paris and Île-de-France</option></select></div>
        <div class="field"><label for="sector">Focus</label><select id="sector" name="sector">${Object.entries(opts.sectors).map(([k, v]) => html`<option value="${k}">${v[0].toUpperCase() + v.slice(1)}</option>`)}</select></div>
        <div class="field"><label for="count">How many</label><input id="count" name="count" type="number" min="1" max="10" value="6"></div>
        <button class="btn primary" type="submit" ${opts.ai ? '' : 'disabled'} data-busy="Starting…">Search</button>
      </form>
      <div id="runs">${running.map((r) => html`<div class="section">${spinner(`Search in progress: ${r.stage || ''}`)}</div>`)}</div>
      <details class="section"><summary>Add an organization you know</summary>
        <form data-form="add" class="details-body">
          <div class="grid-2">
            <div class="field"><label>Website</label><input name="website" type="url" placeholder="https://www.example.fr" required></div>
            <div class="field"><label>Name (optional)</label><input name="name" type="text"></div>
            <div class="field"><label>Area</label><select name="area"><option value="orleans">Orléans area</option><option value="paris">Paris area</option><option value="other">Other</option></select></div>
            <div class="field"><label>Published offer URL (optional)</label><input name="listingUrl" type="url"></div>
          </div>
          <button class="btn" type="submit" data-busy="Checking…">Check and add</button>
        </form>
      </details>
    </div>

    <div class="section">
      <div class="tabs">${TABS.map(([k, l]) => html`<a href="#/discover?tab=${k}${area ? `&area=${area}` : ''}" class="${k === tab ? 'active' : ''}">${l}${k !== 'all' && data.counts[k] ? html`<span class="count">${data.counts[k]}</span>` : ''}</a>`)}</div>
      <div class="section-head">
        <div class="chips">${[['', 'Both areas'], ['orleans', 'Orléans'], ['paris', 'Paris']].map(([k, l]) => html`<a class="chip ${area === k ? 'active' : ''}" href="#/discover?tab=${tab}${k ? `&area=${k}` : ''}">${l}</a>`)}</div>
        <div class="legend"><span class="tag verified">Verified</span> checked by this app <span class="tag ai">AI suggestion</span> to be judged by you</div>
      </div>
      ${data.items.length ? html`<div class="opps">${data.items.map(card)}</div>` : html`<div class="empty"><div class="serif">Nothing here yet</div>${tab === 'new' ? 'Run a search above, or add an organization you know.' : 'No opportunities with this status.'}</div>`}
    </div>`.s;
  };
  render();

  for (const r of running) watchRun(r.id);
  function watchRun() {
    const t = setInterval(async () => {
      if (!el.isConnected) return clearInterval(t);
      const rs = await api('search-runs').catch(() => []);
      const box = el.querySelector('#runs');
      const active = rs.filter((x) => x.status === 'running');
      if (box) box.innerHTML = active.map((x) => html`<div class="section">${spinner(`Search in progress: ${x.stage || ''}`)}<div class="log">${x.log.slice(-6).map((l) => html`<div>${l}</div>`)}</div></div>`.s).join('');
      if (!active.length) { clearInterval(t); const last = rs[0]; if (last?.status === 'failed') toast(`Search failed: ${last.error}`, 'error'); else toast(`Search finished: ${last?.candidates_accepted ?? 0} new opportunit${last?.candidates_accepted === 1 ? 'y' : 'ies'}`); mount(el, { query }); }
    }, 2500);
  }

  bind(el, {
    click: {
      decide: async (b) => {
        const r = await api(`opportunities/${b.dataset.id}/decision`, { method: 'POST', body: { decision: b.dataset.decision } });
        if (b.dataset.decision === 'interested') { location.hash = `#/applications/${r.applicationId}`; return; }
        toast({ saved: 'Saved for later', not_interested: 'Marked as not interested', new: 'Moved back to new' }[b.dataset.decision]);
        mount(el, { query });
      },
    },
    submit: {
      search: async (d) => {
        await api('search', { method: 'POST', body: { area: d.area, sector: d.sector, count: Number(d.count) } });
        toast('Search started. Results appear here as they are verified.');
        mount(el, { query });
      },
      add: async (d) => {
        const { jobId } = await api('organizations', { method: 'POST', body: d });
        toast('Checking the website…');
        const j = await waitForJob(jobId);
        const m = String(j.progress || '').match(/opportunity:(\d+)/);
        toast('Organization added');
        location.hash = '#/discover?tab=new';
        if (m) setTimeout(() => document.getElementById(`opp-${m[1]}`)?.scrollIntoView({ behavior: 'smooth' }), 400);
      },
      contact: async (d, form) => {
        const c = await api('contacts', { method: 'POST', body: { organization_id: Number(form.dataset.org), email: d.email, evidence_url: d.evidence_url } });
        toast(c.status === 'verified' ? 'Address verified and added' : `Not verified: ${c.status_detail}`, c.status === 'verified' ? '' : 'error');
        const det = form.closest('details');
        const oppId = det.querySelector('[data-details]').dataset.details;
        det.querySelector('.details-body').innerHTML = details(await api(`opportunities/${oppId}`)).s;
      },
    },
  });
  el.addEventListener('toggle', async (ev) => {
    const det = ev.target;
    if (det.tagName !== 'DETAILS' || !det.open || !det.dataset.org) return;
    const box = det.querySelector('[data-details]');
    if (box.dataset.loaded) return;
    box.innerHTML = spinner('Loading').s;
    box.innerHTML = details(await api(`opportunities/${box.dataset.details}`)).s;
    box.dataset.loaded = '1';
  }, true);
}
