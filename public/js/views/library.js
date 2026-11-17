import { api, html, fmtDate } from '../core.js';

const docRow = (d, extra = '') => html`<div class="doc-row"><div class="doc-main"><span class="doc-icon"></span><div class="break">
  <div>${d.label}</div><div class="xs muted">${d.filename} · ${(d.size / 1024).toFixed(0)} KB · ${fmtDate(d.created_at, true)}${d.immutable ? ' · locked' : ''} · <span class="mono" title="SHA-256 of the stored file">${d.sha256.slice(0, 12)}…</span>${extra}</div></div></div>
  <div class="btn-row">${d.mime === 'application/pdf' ? html`<a class="btn small" target="_blank" rel="noopener" href="/api/documents/${d.id}/file">Open</a>` : ''}<a class="btn small ghost" href="/api/documents/${d.id}/file?download=1">Download</a></div></div>`;

export async function mount(el) {
  const { documents, versions, profileVersions } = await api('documents');
  const originals = documents.filter((d) => d.kind === 'original_cv');
  const handbooks = documents.filter((d) => d.kind === 'handbook');
  const sent = documents.filter((d) => ['sent_cv', 'sent_letter'].includes(d.kind));
  const byApp = new Map();
  for (const d of sent) { if (!byApp.has(d.application_id)) byApp.set(d.application_id, []); byApp.get(d.application_id).push(d); }

  el.innerHTML = html`
  <div class="page-head"><div>
    <div class="eyebrow">Document library</div>
    <h1>Documents</h1>
    <p class="lede">Your original CV, every document sent (stored exactly as sent and locked) and every draft version.</p>
  </div></div>

  <div class="section"><h2>Original CV</h2>
    ${originals.map((d) => docRow(d))}
    <div class="doc-row"><div class="doc-main"><span class="doc-icon"></span><div><div>Base CV from your current profile</div><div class="xs muted">Generated from the profile facts, without tailoring</div></div></div>
      <div class="btn-row"><a class="btn small" target="_blank" rel="noopener" href="/api/base-cv.pdf">Open</a><a class="btn small ghost" href="/api/base-cv.pdf?download=1">Download</a></div></div>
  </div>

  <div class="section"><h2>Sent documents</h2>
    <p class="small muted">These files are the exact bytes attached to each email. They cannot be modified or deleted, and do not change when your profile changes.</p>
    ${byApp.size ? [...byApp.entries()].map(([appId, docs]) => html`<div class="section">
      <div class="section-head"><h3><a href="#/applications/${appId}">${docs[0].org_name}</a></h3><span class="small muted">${docs[0].recipient || ''}</span></div>
      ${docs.map((d) => docRow(d, d.send_status === 'sent' ? html` · <span class="tag verified">sent</span>` : d.send_status === 'failed' ? html` · <span class="tag danger">attempt failed, not delivered</span>` : ''))}</div>`) : html`<div class="empty"><div class="serif">Nothing sent yet</div>Documents appear here once an application has been sent.</div>`}
  </div>

  <div class="section"><h2>Draft versions</h2>
    ${versions.length ? html`<ul class="list">${versions.map((v) => html`<li><div><a href="#/applications/${v.application_id}?tab=history">${v.org_name}</a> · version ${v.version_no} <span class="tag ${v.source === 'ai' ? 'ai' : ''}">${v.source === 'ai' ? 'agent' : 'your edit'}</span><div class="xs muted">${fmtDate(v.created_at, true)}</div></div>
      <span class="btn-row"><a class="btn small ghost" target="_blank" rel="noopener" href="/api/versions/${v.id}/cv.pdf">CV</a><a class="btn small ghost" target="_blank" rel="noopener" href="/api/versions/${v.id}/letter.pdf">Letter</a></span></li>`)}</ul>` : html`<p class="muted">No drafts yet.</p>`}
  </div>

  <div class="section"><h2>University handbook</h2>${handbooks.length ? handbooks.map((d) => docRow(d)) : html`<p class="muted">Not uploaded yet. <a href="#/profile?tab=handbook">Upload it</a>.</p>`}</div>

  <div class="section"><h2>Profile versions</h2><p class="small muted">Each application records the profile version it was written from.</p>
    <ul class="list">${profileVersions.map((p) => html`<li><span>Version ${p.id} · ${p.note || ''}</span><span class="meta">${fmtDate(p.created_at, true)}</span></li>`)}</ul></div>`.s;
}
