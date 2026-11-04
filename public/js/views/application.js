import { api, html, bind, toast, fmtDate, statusPill, spinner, hostOf, STATUS_LABEL } from '../core.js';

const POST_SEND = ['sent', 'follow_up', 'interview', 'rejected', 'accepted'];
let dirty = false;
window.__stageBlockNav = () => {
  if (dirty && !confirm('You have unsaved changes. Leave without saving?')) { history.back(); return true; }
  dirty = false;
  return false;
};

function steps(a) {
  const s = a.status;
  const idx = POST_SEND.includes(s) ? 4 : s === 'awaiting_approval' ? 2 : a.cv ? 1 : 0;
  const list = ['Documents written', 'Reviewed & approved', 'Final approval & send', 'Archived'];
  return html`<div class="steps">${list.map((l, i) => html`<div class="step ${i < idx ? 'done' : i === idx ? 'current' : ''}"><span class="num">${i < idx ? '✓' : i + 1}</span>${l}</div>`)}</div>`;
}

const preview = (id, which, v) => html`<div class="preview">
  <div class="btn-row section-head"><span class="eyebrow">Preview</span><span class="btn-row"><a class="btn small ghost" target="_blank" rel="noopener" href="/api/applications/${id}/preview/${which}.pdf?v=${v}">Open</a><a class="btn small ghost" href="/api/applications/${id}/preview/${which}.pdf?download=1">Download</a></span></div>
  <iframe title="${which} preview" src="/api/applications/${id}/preview/${which}.pdf?v=${v}#view=FitH"></iframe>
  <div class="pdf-fallback"><span class="small muted">PDF previews open in a new tab on this screen size.</span><a class="btn small primary" target="_blank" rel="noopener" href="/api/applications/${id}/preview/${which}.pdf?v=${v}">Open ${which === 'cv' ? 'CV' : 'letter'}</a></div></div>`;

function cvEditor(d, editable) {
  const a = d.application; const cv = a.cv;
  const exps = d.profileExperiences;
  const order = [...(cv.experience_order || []).filter((id) => exps.some((e) => e.id === id)), ...exps.map((e) => e.id).filter((id) => !(cv.experience_order || []).includes(id))];
  const sel = Object.fromEntries((cv.experiences || []).map((e) => [e.id, e]));
  const dis = editable ? '' : 'disabled';
  return html`<form data-form="cv">
    <div class="notice small">The facts in your CV (experiences, dates, languages, skills) always come from your <a href="#/profile">profile</a>. Here you choose what to emphasise for this organization. To correct a fact, edit the profile.</div>
    <div class="section field"><label>Headline</label><input name="headline" type="text" value="${cv.headline || ''}" ${dis} data-on="dirty"></div>
    <div class="field"><label>Profile paragraph</label><textarea name="profile" class="tall serif" ${dis} data-on="dirty">${cv.profile || ''}</textarea></div>
    <div class="field"><label>Experiences (order and content)</label>
      <div id="exps">${order.map((id) => {
        const e = exps.find((x) => x.id === id); const s = sel[id];
        const include = s ? s.include !== false : true;
        const idx = s?.bullet_indices?.length ? s.bullet_indices : e.bullets.map((_, i) => i);
        return html`<div class="exp ${include ? '' : 'excluded'}" data-exp="${id}">
          <div class="exp-head"><label class="check"><input type="checkbox" name="inc_${id}" ${include ? 'checked' : ''} ${dis} data-on="toggle-exp"><span>${e.title}<div class="xs muted">${e.organization}${e.dates ? ` · ${e.dates}` : ''}</div></span></label>
          ${editable ? html`<div class="order-btns"><button type="button" data-action="up" aria-label="Move up">↑</button><button type="button" data-action="down" aria-label="Move down">↓</button></div>` : ''}</div>
          <div class="bullets">${e.bullets.map((b, i) => html`<label class="check"><input type="checkbox" name="b_${id}_${i}" ${idx.includes(i) ? 'checked' : ''} ${dis} data-on="dirty"><span>${b}</span></label>`)}</div>
        </div>`;
      })}</div></div>
    <div class="field"><label>Courses to highlight</label><div class="stack">${d.profileCourses.map((c) => html`<label class="check"><input type="checkbox" name="course" value="${c}" ${(cv.course_highlights || []).includes(c) ? 'checked' : ''} ${dis} data-on="dirty"><span>${c}</span></label>`)}</div></div>
    ${editable ? html`<button class="btn primary" type="submit" data-busy="Saving…">Save CV</button>` : ''}
  </form>`;
}

function letterEditor(d, editable) {
  const l = d.application.letter; const dis = editable ? '' : 'disabled';
  return html`<form data-form="letter">
    <div class="field"><label>Subject line (Objet)</label><input name="subject_line" type="text" value="${l.subject_line}" ${dis} data-on="dirty"></div>
    <div class="field"><label>Department line under the organization name (optional)</label><input name="recipient_line" type="text" value="${l.recipient_line || ''}" ${dis} data-on="dirty"></div>
    <div class="field"><label>Salutation</label><input name="salutation" type="text" value="${l.salutation}" ${dis} data-on="dirty"></div>
    <div class="field"><label>Paragraphs</label><div id="paras" class="stack">${l.paragraphs.map((p) => html`<div class="para-row"><textarea name="paragraph" class="tall serif" ${dis} data-on="dirty">${p}</textarea>${editable ? html`<button type="button" class="btn small ghost" data-action="rm-para" aria-label="Remove paragraph">✕</button>` : ''}</div>`)}</div>
      ${editable ? html`<button type="button" class="btn small ghost section" data-action="add-para">+ Add a paragraph</button>` : ''}</div>
    <div class="field"><label>Closing</label><textarea name="closing" class="serif" ${dis} data-on="dirty">${l.closing}</textarea></div>
    <p class="xs muted">${l.paragraphs.join(' ').split(/\s+/).filter(Boolean).length} words in the body.</p>
    ${editable ? html`<button class="btn primary" type="submit" data-busy="Saving…">Save letter</button>` : ''}
  </form>`;
}

function contactBlock(d, editable) {
  const a = d.application;
  return html`<div class="field"><label>Recipient</label>
    ${d.contacts.length ? html`<select name="contact_id" ${editable ? '' : 'disabled'} data-on="dirty">
      <option value="">— Choose a verified address —</option>
      ${d.contacts.map((c) => html`<option value="${c.id}" ${c.id === a.contact_id ? 'selected' : ''} ${c.status === 'verified' ? '' : 'disabled'}>${c.email}${c.status === 'verified' ? '' : ' (not verified)'}${c.label ? ` · ${c.label}` : ''}</option>`)}</select>` : html`<div class="notice warn small">No address has been found for this organization. Add one below; it will be checked on their website.</div>`}
    ${d.contact ? html`<div class="hint">${d.contact.status === 'verified' ? '✓ ' : ''}${d.contact.status_detail}</div>` : ''}
  </div>`;
}

function emailEditor(d, editable) {
  const a = d.application; const dis = editable ? '' : 'disabled';
  return html`<div class="split"><form data-form="email">
    ${contactBlock(d, editable)}
    <div class="field"><label>Email subject</label><input name="email_subject" type="text" value="${a.email_subject || ''}" ${dis} data-on="dirty"></div>
    <div class="field"><label>Email body</label><textarea name="email_body" class="tall serif" ${dis} data-on="dirty">${a.email_body || ''}</textarea></div>
    <div class="field"><label>Attachments</label><div class="small">CV (PDF) · ${a.language === 'en' ? 'Cover letter' : 'Lettre de motivation'} (PDF), generated from the versions you approve</div></div>
    ${editable ? html`<button class="btn primary" type="submit" data-busy="Saving…">Save email</button>` : ''}
  </form>
  <div>${editable ? html`<form data-form="contact" class="panel stack">
    <h3>Add a recipient address</h3>
    <p class="small muted">Give the address and the page of ${hostOf(d.organization.website)} where it is published. The app fetches that page and only accepts the address if it is really there.</p>
    <input name="email" type="email" placeholder="stage@organization.fr" required>
    <input name="evidence_url" type="url" placeholder="${d.organization.website}" required>
    <button class="btn small" type="submit" data-busy="Checking…">Verify and add</button>
  </form>` : ''}</div></div>`;
}

function reviewPanel(d) {
  const r = d.application.review;
  if (!r) return html`<div class="notice warn small">No automatic fact-check for these documents (written manually or without AI). Read them carefully before approving.</div>`;
  const claims = r.unsupported_claims || [];
  return html`<div class="stack">
    ${claims.length ? html`<div class="notice danger"><strong>Statements the fact-check could not match to your profile</strong><ul>${claims.map((c) => html`<li><span class="quote">${c.excerpt}</span>${c.problem} <span class="tag">${c.severity}</span></li>`)}</ul></div>` : html`<div class="notice">Fact-check: every statement about you matched your profile.${r.regenerated ? ' (A first draft was corrected automatically.)' : ''}</div>`}
    ${r.organization_claims_not_in_sources?.length ? html`<div class="notice warn"><strong>Statements about the organization not found in the pages checked</strong><ul>${r.organization_claims_not_in_sources.map((c) => html`<li>${c}</li>`)}</ul></div>` : ''}
    ${r.local_warnings?.length ? html`<div class="notice warn"><strong>Style and consistency checks</strong><ul>${r.local_warnings.map((c) => html`<li>${c}</li>`)}</ul></div>` : ''}
    ${r.style_remarks?.length ? html`<div class="notice warn"><strong>Style remarks</strong><ul>${r.style_remarks.map((c) => html`<li>${c}</li>`)}</ul></div>` : ''}
    ${r.notes_for_candidate?.length ? html`<div class="notice"><strong>Questions for you</strong> (answering them in your profile improves the next version)<ul>${r.notes_for_candidate.map((c) => html`<li>${c}</li>`)}</ul></div>` : ''}
  </div>`;
}

function sendTab(d) {
  const a = d.application; const id = a.id;
  if (a.status === 'draft') {
    return html`
    <h2>Review before approval</h2>
    <div class="section">${reviewPanel(d)}</div>
    <div class="section grid-2">
      <div class="panel"><h3>Approve the documents</h3>
        <p class="small muted">Approving locks this version. Any later edit withdraws the approval. Sending still requires a separate, final confirmation.</p>
        <button class="btn primary" data-action="approve" data-busy="Approving…">Approve CV, letter and email</button></div>
      <form class="panel" data-form="regen"><h3>Write a new version</h3>
        <div class="field"><label>Letter and email language</label><select name="language"><option value="fr" ${a.language === 'fr' ? 'selected' : ''}>French</option><option value="en" ${a.language === 'en' ? 'selected' : ''}>English</option></select></div>
        <div class="field"><label>Instructions (optional)</label><textarea name="instructions" placeholder="e.g. mention my interest in their Spanish-speaking markets; shorter second paragraph"></textarea></div>
        <button class="btn" type="submit" data-busy="Starting…">Regenerate</button>
        <div class="hint">The current version stays in the document library.</div></form>
    </div>`;
  }
  // awaiting_approval: final review screen
  const ready = d.email.ready;
  return html`
  <h2>Final approval</h2>
  <p class="lede">This is exactly what will be sent. Read it through; nothing leaves this app until you confirm below.</p>
  <table class="summary-table section">
    <tr><th>Organization</th><td>${d.organization.name}<div class="xs muted"><a href="${d.organization.website}" target="_blank" rel="noopener noreferrer">${d.organization.website}</a></div></td></tr>
    <tr><th>Recipient</th><td class="break">${d.contact.email} <span class="tag verified">Verified</span><div class="xs muted">${d.contact.status_detail}. It will be checked again just before sending.</div></td></tr>
    <tr><th>Position</th><td>${a.position_title || d.opportunity.position_title || '—'} <span class="muted small">(${d.opportunity.kind === 'published' ? 'published offer' : 'spontaneous application'})</span></td></tr>
    <tr><th>From</th><td>${ready ? `${d.email.sender} via ${d.email.provider === 'gmail' ? 'Gmail' : 'SMTP'}` : html`<span class="tag warn">No email account connected</span>`}</td></tr>
    <tr><th>Subject</th><td>${a.email_subject}</td></tr>
    <tr><th>Message</th><td><div class="email-body">${a.email_body}</div></td></tr>
    <tr><th>Attachments</th><td>CV (PDF) · ${a.language === 'en' ? 'Cover letter' : 'Lettre de motivation'} (PDF)</td></tr>
  </table>
  <div class="section grid-2">
    <div><div class="eyebrow">Complete CV</div><iframe class="inline-doc" title="CV" src="/api/applications/${id}/preview/cv.pdf?v=${a.approved_at}#view=FitH"></iframe><div class="pdf-fallback"><a class="btn small primary" target="_blank" rel="noopener" href="/api/applications/${id}/preview/cv.pdf?v=${a.approved_at}">Open the complete CV</a></div></div>
    <div><div class="eyebrow">Complete cover letter</div><iframe class="inline-doc" title="Letter" src="/api/applications/${id}/preview/letter.pdf?v=${a.approved_at}#view=FitH"></iframe><div class="pdf-fallback"><a class="btn small primary" target="_blank" rel="noopener" href="/api/applications/${id}/preview/letter.pdf?v=${a.approved_at}">Open the complete letter</a></div></div>
  </div>
  <div class="section">${reviewPanel(d)}</div>
  <div class="section card final">
    ${ready ? html`
      <label class="check"><input type="checkbox" data-on="confirm-send"><span>I have read the CV, the cover letter and the email above, and I want this application sent to <strong>${d.contact.email}</strong> now.</span></label>
      <div class="btn-row section"><button class="btn primary" id="send-btn" data-action="send" disabled data-busy="Sending…">Send application</button><button class="btn ghost" data-action="revoke">Withdraw approval and edit</button></div>`
    : html`<div class="notice warn"><strong>Ready, but it cannot be sent yet.</strong> No email account is connected. Connect Gmail in <a href="#/settings">Settings</a>; the application will stay here, approved, until then.</div>
      <div class="btn-row section"><button class="btn ghost" data-action="revoke">Withdraw approval and edit</button></div>`}
  </div>`;
}

function recordTab(d) {
  const a = d.application;
  const sent = d.attempts.find((x) => x.id === a.sent_attempt_id);
  const docById = Object.fromEntries(d.documents.map((x) => [x.id, x]));
  const docRow = (doc) => doc && html`<div class="doc-row"><div class="doc-main"><span class="doc-icon"></span><div class="break"><div>${doc.filename}</div><div class="xs muted">${doc.label} · ${(doc.size / 1024).toFixed(0)} KB · <span class="mono" title="SHA-256">${doc.sha256.slice(0, 16)}…</span></div></div></div>
    <div class="btn-row"><a class="btn small" target="_blank" rel="noopener" href="/api/documents/${doc.id}/file">Open</a><a class="btn small ghost" href="/api/documents/${doc.id}/file?download=1">Download</a></div></div>`;
  return html`
  <div class="split">
    <div>
      <h2>Sent application</h2>
      ${sent ? html`<table class="summary-table section">
        <tr><th>Sent</th><td>${fmtDate(sent.finished_at, true)} via ${sent.provider === 'gmail' ? 'Gmail' : 'SMTP'} from ${sent.sender}</td></tr>
        <tr><th>To</th><td class="break">${sent.recipient}</td></tr>
        <tr><th>Organization</th><td>${d.organization.name}<div class="xs"><a href="${d.organization.website}" target="_blank" rel="noopener noreferrer">${d.organization.website}</a></div></td></tr>
        <tr><th>Position</th><td>${a.position_title || '—'} · ${d.organization.city || ''}</td></tr>
        <tr><th>Subject</th><td>${sent.subject}</td></tr>
        <tr><th>Message</th><td><div class="email-body">${sent.body}</div></td></tr>
        <tr><th>Provider ID</th><td class="mono break">${sent.provider_message_id}</td></tr>
      </table>
      <div class="section"><div class="eyebrow">Exact documents sent (permanent, unchangeable)</div>${docRow(docById[sent.cv_document_id])}${docRow(docById[sent.letter_document_id])}</div>` : ''}
      ${d.attempts.filter((x) => x.status === 'failed').length ? html`<div class="section"><div class="eyebrow">Failed attempts (nothing was delivered)</div><ul class="list small">${d.attempts.filter((x) => x.status === 'failed').map((x) => html`<li><span>${x.error}</span><span class="meta">${fmtDate(x.created_at, true)}</span></li>`)}</ul></div>` : ''}
    </div>
    <div>
      <h2>Follow-up</h2>
      <form data-form="status" class="section btn-row"><select name="status">${POST_SEND.map((s) => html`<option value="${s}" ${a.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`)}</select><button class="btn small" type="submit">Update status</button></form>
      <form data-form="event" class="panel section stack">
        <h3>Record a response or follow-up</h3>
        <div class="grid-2"><div><label>Type</label><select name="type"><option value="response">Response received</option><option value="follow_up">Follow-up sent</option><option value="interview">Interview</option><option value="note">Note</option></select></div>
        <div><label>Date</label><input type="date" name="occurred_on" value="${new Date().toISOString().slice(0, 10)}"></div></div>
        <div><label>Details</label><textarea name="content" required placeholder="Paste or summarise the reply, the follow-up you sent, interview details…"></textarea></div>
        <button class="btn small primary" type="submit">Save</button>
      </form>
      <div class="section"><ul class="timeline">${d.events.map((e) => html`<li><div class="when">${fmtDate(e.occurred_on)} · ${{ response: 'Response', follow_up: 'Follow-up', interview: 'Interview', note: 'Note', status: 'Status' }[e.type]}</div><div class="break">${e.content}</div></li>`)}</ul></div>
    </div>
  </div>`;
}

export async function mount(el, { parts, query }) {
  const id = Number(parts[1]);
  let d = await api(`applications/${id}`);
  let v = Date.now();
  dirty = false;

  const defaultTab = () => (POST_SEND.includes(d.application.status) ? 'record' : d.application.status === 'awaiting_approval' ? 'send' : 'cv');
  let tab = query.tab || defaultTab();

  const render = () => {
    const a = d.application;
    const editable = ['draft'].includes(a.status) || a.status === 'awaiting_approval';
    const tabs = POST_SEND.includes(a.status)
      ? [['record', 'Record'], ['history', 'Draft versions']]
      : [['cv', 'CV'], ['letter', 'Cover letter'], ['email', 'Email & recipient'], ['send', a.status === 'awaiting_approval' ? 'Final approval' : 'Review & approve'], ['history', 'Versions']];
    if (!tabs.some((t) => t[0] === tab)) tab = tabs[0][0];
    let body;
    if (a.status === 'generating') body = spinner('The agent is writing the CV and cover letter, then fact-checking them against your profile. This usually takes one to three minutes.');
    else if (!a.cv && !POST_SEND.includes(a.status)) {
      body = html`${a.generation_error ? html`<div class="notice danger"><strong>Generation failed.</strong> ${a.generation_error}</div>` : ''}
        <div class="empty section"><div class="serif">No documents yet</div>
        <p>The agent writes a CV and a cover letter specific to ${d.organization.name}.</p>
        <div class="btn-row center">
          <button class="btn primary" data-action="generate" data-busy="Starting…">Write the documents</button>
          <button class="btn" data-action="manual">Write them myself</button></div></div>`;
    } else if (tab === 'cv') body = html`<div class="split">${cvEditor(d, editable && !POST_SEND.includes(a.status))}${preview(id, 'cv', v)}</div>`;
    else if (tab === 'letter') body = html`<div class="split">${letterEditor(d, editable && !POST_SEND.includes(a.status))}${preview(id, 'letter', v)}</div>`;
    else if (tab === 'email') body = emailEditor(d, editable);
    else if (tab === 'send') body = sendTab(d);
    else if (tab === 'record') body = recordTab(d);
    else if (tab === 'history') body = html`<h2>Versions of these documents</h2><p class="lede">Each generation and each saved edit is kept.</p>
      <ul class="list section">${d.versions.map((x) => html`<li><div>Version ${x.version_no} <span class="tag ${x.source === 'ai' ? 'ai' : ''}">${x.source === 'ai' ? 'Written by the agent' : 'Edited by you'}</span><div class="xs muted">${fmtDate(x.created_at, true)}</div></div>
        <span class="btn-row"><a class="btn small ghost" target="_blank" rel="noopener" href="/api/versions/${x.id}/cv.pdf">CV</a><a class="btn small ghost" target="_blank" rel="noopener" href="/api/versions/${x.id}/letter.pdf">Letter</a>${editable ? html`<button class="btn small" data-action="restore" data-vid="${x.id}">Restore</button>` : ''}</span></li>`)}</ul>`;

    el.innerHTML = html`
    <div class="page-head"><div>
      <div class="eyebrow"><a href="#/applications">Applications</a></div>
      <h1>${d.organization.name}</h1>
      <p class="lede">${a.position_title || d.opportunity.position_title || ''} · ${d.organization.city || ''} · <a href="${d.organization.website}" target="_blank" rel="noopener noreferrer">${hostOf(d.organization.website)}</a></p>
    </div><div class="btn-row">${statusPill(a.status)}${['draft', 'awaiting_approval'].includes(a.status) ? html`<button class="btn small ghost danger" data-action="discard">Discard</button>` : ''}</div></div>
    ${steps(a)}
    ${a.status !== 'generating' && (a.cv || POST_SEND.includes(a.status)) ? html`<div class="tabs">${tabs.map(([k, l]) => html`<a href="#/applications/${id}?tab=${k}" class="${tab === k ? 'active' : ''}">${l}</a>`)}</div>` : ''}
    ${a.status === 'awaiting_approval' && tab !== 'send' ? html`<div class="notice small">Approved ${fmtDate(a.approved_at, true)}. Editing will withdraw the approval.</div><div class="section"></div>` : ''}
    ${body}`.s;
    if (a.status === 'generating') pollGenerating();
  };

  async function reload(keepTab = true) { d = await api(`applications/${id}`); v = Date.now(); dirty = false; if (!keepTab) tab = defaultTab(); render(); }
  function pollGenerating() {
    const t = setInterval(async () => {
      if (!el.isConnected) return clearInterval(t);
      const nd = await api(`applications/${id}`).catch(() => null);
      if (nd && nd.application.status !== 'generating') { clearInterval(t); d = nd; v = Date.now(); tab = 'cv'; render(); if (nd.application.generation_error) toast(nd.application.generation_error, 'error'); else toast('Documents ready for review'); }
    }, 2500);
  }

  render();

  bind(el, {
    click: {
      generate: async () => { await api(`applications/${id}/generate`, { method: 'POST', body: {} }); await reload(); },
      manual: async () => { await api(`applications/${id}/start-manual`, { method: 'POST' }); tab = 'letter'; await reload(); },
      up: (b) => { const n = b.closest('.exp'); if (n.previousElementSibling) n.parentNode.insertBefore(n, n.previousElementSibling); dirty = true; },
      down: (b) => { const n = b.closest('.exp'); if (n.nextElementSibling) n.parentNode.insertBefore(n.nextElementSibling, n); dirty = true; },
      'add-para': () => { const box = el.querySelector('#paras'); box.insertAdjacentHTML('beforeend', html`<div class="para-row"><textarea name="paragraph" class="tall serif" data-on="dirty"></textarea><button type="button" class="btn small ghost" data-action="rm-para" aria-label="Remove paragraph">✕</button></div>`.s); dirty = true; },
      'rm-para': (b) => { b.closest('.para-row').remove(); dirty = true; },
      approve: async () => { if (dirty) throw new Error('Save your changes first.'); await api(`applications/${id}/approve`, { method: 'POST' }); toast('Approved. Please review the final summary.'); tab = 'send'; await reload(); },
      revoke: async () => { await api(`applications/${id}/revoke`, { method: 'POST' }); tab = 'send'; await reload(); },
      discard: async () => { if (!confirm('Discard this unsent application? Its versions stay in the library.')) return; await api(`applications/${id}/discard`, { method: 'POST' }); location.hash = '#/applications'; },
      restore: async (b) => { await api(`versions/${b.dataset.vid}/restore`, { method: 'POST' }); toast('Version restored as a new draft'); tab = 'cv'; await reload(); },
      send: async () => {
        const r = await api(`applications/${id}/send`, { method: 'POST', body: { confirm: true, approvedHash: d.application.approved_hash } });
        toast(`Sent. Message ID ${r.messageId}`);
        tab = 'record'; await reload();
      },
    },
    change: {
      'confirm-send': (c) => { el.querySelector('#send-btn').disabled = !c.checked; },
      'toggle-exp': (c) => { c.closest('.exp').classList.toggle('excluded', !c.checked); dirty = true; },
      dirty: () => { dirty = true; },
    },
    input: { dirty: () => { dirty = true; } },
    submit: {
      cv: async (f, form) => {
        const exps = [...form.querySelectorAll('.exp')].map((n) => {
          const eid = n.dataset.exp;
          const pe = d.profileExperiences.find((x) => x.id === eid);
          return { id: eid, include: form.querySelector(`[name="inc_${eid}"]`).checked, bullet_indices: pe.bullets.map((_, i) => i).filter((i) => form.querySelector(`[name="b_${eid}_${i}"]`)?.checked) };
        });
        const cv = { ...d.application.cv, headline: f.headline, profile: f.profile, experience_order: exps.map((e) => e.id), experiences: exps, course_highlights: [].concat(f.course || []) };
        d = await api(`applications/${id}`, { method: 'PATCH', body: { cv } }); v = Date.now(); dirty = false; toast('CV saved'); render();
      },
      letter: async (f) => {
        const letter = { subject_line: f.subject_line, recipient_line: f.recipient_line, salutation: f.salutation, paragraphs: [].concat(f.paragraph || []).map((p) => p.trim()).filter(Boolean), closing: f.closing };
        d = await api(`applications/${id}`, { method: 'PATCH', body: { letter } }); v = Date.now(); dirty = false; toast('Letter saved'); render();
      },
      email: async (f) => {
        d = await api(`applications/${id}`, { method: 'PATCH', body: { email_subject: f.email_subject, email_body: f.email_body, ...(f.contact_id !== undefined ? { contact_id: f.contact_id ? Number(f.contact_id) : null } : {}) } });
        dirty = false; toast('Email saved'); render();
      },
      contact: async (f) => {
        const c = await api('contacts', { method: 'POST', body: { organization_id: d.organization.id, email: f.email, evidence_url: f.evidence_url } });
        if (c.status === 'verified') {
          d = await api(`applications/${id}`, { method: 'PATCH', body: { contact_id: c.id } });
          toast('Address verified and selected'); render();
        } else toast(`Not verified: ${c.status_detail}`, 'error');
      },
      regen: async (f) => { await api(`applications/${id}/generate`, { method: 'POST', body: { language: f.language, instructions: f.instructions } }); await reload(); },
      status: async (f) => { d = await api(`applications/${id}/status`, { method: 'POST', body: { status: f.status } }); toast('Status updated'); render(); },
      event: async (f) => { d = await api(`applications/${id}/events`, { method: 'POST', body: f }); toast('Saved'); render(); },
    },
  });
}
