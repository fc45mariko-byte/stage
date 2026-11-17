import { api, html, fmtDate, fmtTime } from '../core.js';

export async function mount(el, { overview }) {
  const ov = overview || await api('overview');
  const s = ov.stats;
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const todo = [];
  if (!ov.integrations.ai) todo.push(['#/settings', 'Activate AI research and writing', 'Needs an Anthropic API key']);
  if (!ov.integrations.email) todo.push(['#/settings', 'Connect your Gmail account', 'Applications cannot be sent until an email account is connected']);
  if (!ov.handbook) todo.push(['#/profile?tab=handbook', 'Upload your university internship handbook', 'Requirements are not checked until it is provided']);
  if (ov.openQuestions) todo.push(['#/profile?tab=questions', `${ov.openQuestions} question${ov.openQuestions > 1 ? 's' : ''} about your profile`, 'Answers make the documents more precise; nothing is guessed meanwhile']);
  if (ov.suggestedSkills) todo.push(['#/profile?tab=transferable', `${ov.suggestedSkills} suggested transferable skill${ov.suggestedSkills > 1 ? 's' : ''} to confirm or reject`, 'Not used in documents until you confirm them']);
  if (s.newOpportunities) todo.push(['#/discover', `${s.newOpportunities} new opportunit${s.newOpportunities > 1 ? 'ies' : 'y'} to review`, 'Discover']);
  for (const a of ov.awaiting) todo.push([`#/applications/${a.id}`, `${a.name}`, a.status === 'awaiting_approval' ? 'Ready: waiting for your final approval to send' : a.status === 'queued' ? 'In the outbox, waiting to be sent from Gmail' : a.status === 'generating' ? 'Documents being written' : 'Draft documents to review']);
  for (const f of ov.followUps) todo.push([`#/applications/${f.id}`, `Follow up with ${f.name}?`, `Sent ${fmtDate(f.finished_at)}, no response recorded`]);

  el.innerHTML = html`
  <div class="page-head"><div>
    <div class="eyebrow">${today}</div>
    <h1>Your internship search</h1>
    <p class="lede">Licence 3 LEA, Commerce international. A 6-week internship from 15 May to the end of June 2027, in Orléans or Paris.</p>
  </div>
  <a class="btn primary" href="#/discover">Review opportunities</a></div>

  <div class="stats">
    <div class="stat"><div class="n">${s.organizations}</div><div class="l">Organizations discovered</div></div>
    <div class="stat"><div class="n">${s.saved}</div><div class="l">Saved for later</div></div>
    <div class="stat"><div class="n">${s.sent}</div><div class="l">Applications sent</div></div>
    <div class="stat"><div class="n">${s.responses}</div><div class="l">Responses received</div></div>
    <div class="stat"><div class="n">${s.interviews}</div><div class="l">Interviews</div></div>
  </div>

  ${ov.activeJobs.length ? html`<div class="section">${ov.activeJobs.map((j) => html`<div class="progress"><span class="spinner"></span><span>${{ search: 'Searching for organizations', generate: 'Writing an application', add_organization: 'Checking an organization', handbook: 'Reading the handbook' }[j.type] || j.type}${j.progress ? ` – ${j.progress}` : ''}</span></div>`)}</div>` : ''}

  <div class="section"><h2>Needs your attention</h2>
    ${todo.length ? html`<div class="todo">${todo.map(([href, t, d]) => html`<a href="${href}"><span>${t}</span><span class="muted small">${d}</span></a>`)}</div>` : html`<p class="muted">Nothing waiting. You can start a new search from Discover.</p>`}
  </div>

  <div class="section"><div class="section-head"><h2>Recent activity</h2><a href="#/activity" class="small">Full history</a></div>
    ${ov.recentActivity.length ? html`<ul class="list">${ov.recentActivity.map((a) => html`<li><span>${a.message}</span><span class="meta">${fmtDate(a.ts)} ${fmtTime(a.ts)}</span></li>`)}</ul>` : html`<p class="muted">No activity yet.</p>`}
  </div>`.s;
}
