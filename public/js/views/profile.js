import { api, html, bind, toast, fmtDate, waitForJob, spinner } from '../core.js';

const TABS = [['facts', 'Confirmed facts'], ['transferable', 'Transferable skills'], ['questions', 'Open questions'], ['handbook', 'University handbook'], ['files', 'CV files']];
const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
const uid = () => Math.random().toString(36).slice(2, 9);

function block(list, obj, fields, removable = true) {
  return html`<div class="exp" data-list="${list}" data-id="${obj.id || uid()}">
    ${removable ? html`<div class="exp-head"><span></span><button type="button" class="btn small ghost danger" data-action="rm-block">Remove</button></div>` : ''}
    <div class="grid-2">${fields.map(([k, label, type]) => html`<div class="field ${type === 'area' || type === 'lines' ? 'full' : ''}"><label>${label}</label>${type === 'area' || type === 'lines'
      ? html`<textarea data-k="${k}" data-type="${type}">${type === 'lines' ? (obj[k] || []).join('\n') : obj[k] || ''}</textarea>${type === 'lines' ? html`<div class="hint">One per line</div>` : ''}`
      : html`<input type="text" data-k="${k}" value="${obj[k] || ''}">`}</div>`)}</div></div>`;
}

const F = {
  languages: [['name', 'Language'], ['level', 'Level (as you want it written)']],
  education: [['title', 'Degree'], ['institution', 'Institution'], ['dates', 'Dates'], ['courses', 'Courses', 'lines']],
  experiences: [['title', 'Role'], ['organization', 'Organization'], ['dates', 'Dates'], ['summary', 'Short description (optional)', 'area'], ['bullets', 'What you did', 'lines']],
  skills: [['label', 'Group'], ['value', 'Content', 'area']],
};

function collect(root, list) {
  return [...root.querySelectorAll(`[data-list="${list}"]`)].map((b) => {
    const o = { id: b.dataset.id };
    for (const i of b.querySelectorAll('[data-k]')) o[i.dataset.k] = i.dataset.type === 'lines' ? lines(i.value) : i.value.trim();
    return o;
  });
}

export async function mount(el, { query }) {
  const tab = TABS.some((t) => t[0] === query.tab) ? query.tab : 'facts';
  let p = await api('profile');
  const data = p.data;

  const save = async (note) => {
    p = { ...p, ...(await api('profile', { method: 'PUT', body: { data, note } })) };
    toast('Saved as a new profile version');
    mount(el, { query });
  };

  const facts = () => html`<form data-form="facts">
    <div class="notice small">These facts are the only source the agent may use about you. Documents already sent keep the profile version they were written from.</div>
    <h2 class="section">Identity</h2>
    <div class="grid-2 section">${[['full_name', 'Full name'], ['headline', 'Default headline'], ['email', 'Email'], ['phone', 'Phone'], ['city', 'City']].map(([k, l]) => html`<div class="field"><label>${l}</label><input type="text" name="id_${k}" value="${data.identity[k] || ''}"></div>`)}</div>
    <h2 class="section">Internship sought</h2>
    <div class="grid-2 section"><div class="field"><label>Duration</label><input type="text" name="duration" value="${data.internship.duration}"></div><div class="field"><label>Period</label><input type="text" name="period" value="${data.internship.period}"></div></div>
    <div class="field"><label>Default CV profile paragraph</label><textarea name="cv_profile_text" class="serif tall">${data.internship.cv_profile_text}</textarea></div>
    <div class="field"><label>Target areas</label><textarea name="target_areas">${data.internship.target_areas.join('\n')}</textarea><div class="hint">One per line</div></div>
    ${['languages', 'education', 'experiences', 'skills'].map((list) => html`<h2 class="section">${{ languages: 'Languages', education: 'Education', experiences: 'Experience', skills: 'Skills' }[list]}</h2>
      <div class="section" id="list-${list}">${data[list].map((o) => block(list, o, F[list]))}</div>
      <button type="button" class="btn small ghost" data-action="add-block" data-list="${list}">+ Add</button>`)}
    <h2 class="section">Interests</h2><div class="field section"><textarea name="interests">${data.interests || ''}</textarea></div>
    <div class="card section"><div class="field"><label>What changed (kept in the history)</label><input type="text" name="note" placeholder="e.g. Added TOEIC score"></div>
    <button class="btn primary" type="submit" data-busy="Saving…">Save profile</button></div>
  </form>`;

  const transferable = () => html`<p class="lede">Skills that can reasonably be inferred from your experience. They are used in documents <strong>only once you confirm them</strong>.</p>
    <form data-form="transferable" class="section">
      ${data.transferable.map((t) => html`<div class="exp" data-tid="${t.id}"><div class="exp-head"><div><div class="serif">${t.text}</div><div class="xs muted">Based on: ${t.basis}</div></div>
        <select data-k="status"><option value="suggested" ${t.status === 'suggested' ? 'selected' : ''}>To decide</option><option value="confirmed" ${t.status === 'confirmed' ? 'selected' : ''}>Confirmed – use it</option><option value="rejected" ${t.status === 'rejected' ? 'selected' : ''}>Rejected – never use</option></select></div></div>`)}
      <div class="panel section"><h3>Add a skill in your own words</h3><div class="grid-2"><div class="field"><label>Skill</label><input type="text" name="new_text"></div><div class="field"><label>What it is based on</label><input type="text" name="new_basis"></div></div></div>
      <button class="btn primary section" type="submit" data-busy="Saving…">Save</button>
    </form>`;

  const questions = () => html`<p class="lede">Information the agent needs and will not guess. Leave a question empty if it does not apply.</p>
    <form data-form="questions" class="section">${data.questions.map((q) => html`<div class="field"><label class="serif">${q.question}</label><textarea data-qid="${q.id}">${q.answer || ''}</textarea>${q.status === 'answered' ? html`<div class="hint">Answered</div>` : ''}</div>`)}
    <button class="btn primary" type="submit" data-busy="Saving…">Save answers</button></form>`;

  const handbook = () => {
    const h = p.handbook;
    return html`<p class="lede">The agent checks opportunities and letters against your university's rules only if the handbook is uploaded. Each requirement shown below is backed by a quote that was found in the document.</p>
    <form data-form="handbook" class="panel section"><h3>${h ? 'Replace the handbook' : 'Upload the handbook'}</h3><input type="file" name="file" accept=".pdf,.docx,.txt" required> <button class="btn primary" type="submit" data-busy="Uploading…">Upload</button></form>
    ${h ? html`<div class="section"><div class="section-head"><h2>${h.filename}</h2><span class="small muted">Uploaded ${fmtDate(h.createdAt)} · ${h.textLength.toLocaleString()} characters</span></div>
      ${h.status === 'pending' ? spinner('Reading the handbook…') : ''}
      ${h.status === 'unavailable' ? html`<div class="notice warn small">Stored, but not analysed: AI is not configured.</div>` : ''}
      ${h.status === 'failed' ? html`<div class="notice danger small">Analysis failed: ${h.error} <button class="btn small" data-action="extract" data-id="${h.id}">Retry</button></div>` : ''}
      ${h.status === 'done' ? html`
        ${h.extraction.academic_year_stated ? html`<div class="notice warn small">The handbook says it applies to: <strong>${h.extraction.academic_year_stated}</strong>. Check with your university that it is the current version for 2026–2027.</div>` : html`<div class="notice warn small">The handbook does not state which academic year it applies to. Check with your university that it is current.</div>`}
        <ul class="list section">${h.extraction.requirements.map((r) => html`<li><div><div><span class="tag">${r.topic}</span> ${r.requirement}</div><div class="quote">“${r.quote}”${r.page ? ` (p. ${r.page})` : ''}</div></div></li>`)}</ul>
        ${h.extraction.dropped_count ? html`<p class="xs muted">${h.extraction.dropped_count} extracted item(s) were discarded because their quote could not be found in the text.</p>` : ''}` : ''}
    </div>` : html`<div class="empty section"><div class="serif">No handbook yet</div>Requirements are shown as unknown until it is uploaded.</div>`}`;
  };

  const files = () => html`<p class="lede">Uploaded CV files are kept as-is in the document library. The agent works from the facts on this page, so after uploading a new CV, update the facts accordingly.</p>
    <ul class="list section">${p.originals.map((d) => html`<li><span>${d.label}</span><span class="btn-row"><a class="btn small ghost" href="/api/documents/${d.id}/file?download=1">Download</a></span></li>`)}</ul>
    <form data-form="cvfile" class="panel section"><h3>Upload a new version of your CV</h3><input type="file" name="file" accept=".pdf,.docx" required> <button class="btn" type="submit">Upload</button></form>`;

  el.innerHTML = html`<div class="page-head"><div><div class="eyebrow">Profile · version ${p.versionId}</div><h1>Your knowledge base</h1>
    <p class="lede">Everything the agent knows about you, separated into confirmed facts, possible transferable skills and missing information.</p></div></div>
    <div class="tabs">${TABS.map(([k, l]) => html`<a href="#/profile?tab=${k}" class="${k === tab ? 'active' : ''}">${l}${k === 'questions' ? html`<span class="count">${data.questions.filter((q) => q.status === 'open').length || ''}</span>` : ''}${k === 'transferable' ? html`<span class="count">${data.transferable.filter((t) => t.status === 'suggested').length || ''}</span>` : ''}</a>`)}</div>
    ${{ facts, transferable, questions, handbook, files }[tab]()}`.s;

  if (tab === 'handbook' && p.handbook?.status === 'pending') setTimeout(() => el.isConnected && mount(el, { query }), 3000);

  bind(el, {
    click: {
      'add-block': (b) => { const list = b.dataset.list; el.querySelector(`#list-${list}`).insertAdjacentHTML('beforeend', block(list, {}, F[list]).s); },
      'rm-block': (b) => b.closest('[data-list]').remove(),
      extract: async (b) => { await api(`profile/handbook/${b.dataset.id}/extract`, { method: 'POST' }); mount(el, { query }); },
    },
    submit: {
      facts: async (f, form) => {
        for (const k of ['full_name', 'headline', 'email', 'phone', 'city']) data.identity[k] = f[`id_${k}`].trim();
        Object.assign(data.internship, { duration: f.duration.trim(), period: f.period.trim(), cv_profile_text: f.cv_profile_text.trim(), target_areas: lines(f.target_areas) });
        for (const list of ['languages', 'education', 'experiences', 'skills']) data[list] = collect(form, list);
        data.education.forEach((e) => { e.courses ||= []; });
        data.experiences.forEach((e) => { e.bullets ||= []; e.summary ||= ''; });
        data.interests = f.interests.trim();
        await save(f.note?.trim() || 'Facts updated');
      },
      transferable: async (f, form) => {
        for (const n of form.querySelectorAll('[data-tid]')) data.transferable.find((t) => t.id === n.dataset.tid).status = n.querySelector('[data-k=status]').value;
        if (f.new_text?.trim()) data.transferable.push({ id: `t${uid()}`, text: f.new_text.trim(), basis: f.new_basis?.trim() || 'Stated by you', status: 'confirmed' });
        await save('Transferable skills reviewed');
      },
      questions: async (f, form) => {
        for (const t of form.querySelectorAll('[data-qid]')) data.questions.find((q) => q.id === t.dataset.qid).answer = t.value.trim();
        await save('Questions answered');
      },
      handbook: async (f, form) => {
        const fd = new FormData(form);
        const r = await api('profile/handbook', { method: 'POST', form: fd });
        toast(r.jobId ? 'Uploaded. Reading the handbook…' : 'Uploaded');
        mount(el, { query });
        if (r.jobId) { await waitForJob(r.jobId).catch((e) => toast(e.message, 'error')); if (el.isConnected) mount(el, { query }); }
      },
      cvfile: async (f, form) => { await api('profile/original-cv', { method: 'POST', form: new FormData(form) }); toast('CV file stored'); mount(el, { query }); },
    },
  });
}
