/* Stage – internship desk. Runs inside a claude.ai artifact.
   Capabilities: db (private store), user, sample (Claude writes), mcp (Gmail),
   assets (archive of sent PDFs), downloads (save PDFs). */
'use strict';

// ---------- tiny helpers ----------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v == null || v === false ? '' : esc(v));
const html = (strings, ...vals) => raw(strings.reduce((a, s, i) => a + s + (i < vals.length ? fmt(vals[i]) : ''), ''));
const nowIso = () => new Date().toISOString();
const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtDate = (iso, time = false) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  const s = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return time ? `${s}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : s;
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u || ''; } };
const words = (s) => String(s || '').split(/\s+/).filter(Boolean).length;
const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function bytesToB64(bytes) { let s = ''; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s); }
let toastTimer;
function toast(msg, kind = '') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.setAttribute('role', 'status'); el.textContent = msg;
  document.body.append(el); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3800);
}

// ---------- state ----------
const C = {}; // capabilities
const S = {
  ready: false, timedOut: false, noRuntime: false,
  profile: null, profileDoc: null, handbook: null, library: null,
  opps: [], apps: [], drafts: [], activity: [], requests: [],
  busy: {}, // per-application running work: {appId: 'Writing…'}
  ui: { discoverTab: 'new', area: '', appTab: {}, actFilter: '', profileTab: 'facts', confirm: null, replies: {}, preview: null },
  dirty: false,
};
const STATUS = { draft: 'Draft', awaiting_approval: 'Awaiting approval', unknown: 'Check Sent folder', sent: 'Sent', follow_up: 'Follow-up needed', interview: 'Interview', rejected: 'Rejected', accepted: 'Accepted', withdrawn: 'Discarded' };
const POST_SEND = ['sent', 'follow_up', 'interview', 'rejected', 'accepted'];
const AREA = { orleans: 'Orléans area', paris: 'Paris area', other: 'Other' };
const FIT = { strong: 'Strong match', possible: 'Possible match', weak: 'Weak match' };
const blobUrl = (d) => (d?.assetId ? `/_blob/${d.assetId}` : '#');
const pill = (s) => html`<span class="pill ${s}">${STATUS[s] || s}</span>`;
const appById = (id) => S.apps.find((a) => a.id === id);
const oppById = (id) => S.opps.find((o) => o.id === id);

// ---------- persistence ----------
async function log(type, message, ref = null) {
  if (!C.db) return;
  try { await C.db.collection('activity').doc(uid('a')).set({ ts: nowIso(), type, message, ref }); } catch (e) { console.warn(e); }
}
async function saveApp(id, patch) {
  const cur = appById(id);
  const next = { ...cur, ...patch, updatedAt: nowIso() };
  delete next.id;
  await C.db.collection('applications').doc(id).set(next);
}
async function saveDraftVersion(app, source) {
  const n = S.drafts.filter((d) => d.appId === app.id).reduce((m, d) => Math.max(m, d.n || 0), 0) + 1;
  await C.db.collection('drafts').doc(`${app.id}_v${n}`).set({ appId: app.id, orgName: app.orgName, n, source, cv: app.cv, letter: app.letter, emailSubject: app.emailSubject || '', emailBody: app.emailBody || '', language: app.language, createdAt: nowIso() });
  return n;
}

function subscribe() {
  const db = C.db;
  const loaded = new Set();
  const done = (k) => { loaded.add(k); if (loaded.size >= 5 && !S.ready) { S.ready = true; clearTimeout(S.loadTimer); render(); } };
  S.loadTimer = setTimeout(() => { S.timedOut = true; render(); }, 10000);
  const onErr = (k) => (e) => { console.warn(k, e); done(k); toast(`Could not load ${k}: ${e?.message || e?.code || 'error'}`, 'error'); };
  db.doc('profile/current').onSnapshot((s) => { S.profileDoc = s.exists ? s.data() : null; S.profile = S.profileDoc?.data || null; if (!s.metadata.fromCache) done('profile'); renderSoon(); }, onErr('profile'));
  db.doc('handbook/current').onSnapshot((s) => { S.handbook = s.exists ? s.data() : null; renderSoon(); }, onErr('handbook'));
  db.doc('library/originals').onSnapshot((s) => { S.library = s.exists ? s.data() : null; renderSoon(); }, onErr('library'));
  db.collection('opportunities').onSnapshot((q) => { S.opps = q.docs.map((d) => ({ id: d.id, ...d.data() })); if (!q.metadata.fromCache) done('opps'); renderSoon(); }, onErr('opps'));
  db.collection('applications').onSnapshot((q) => { S.apps = q.docs.map((d) => ({ id: d.id, ...d.data() })); if (!q.metadata.fromCache) done('apps'); renderSoon(); }, onErr('apps'));
  db.collection('drafts').onSnapshot((q) => { S.drafts = q.docs.map((d) => ({ id: d.id, ...d.data() })); renderSoon(); }, onErr('drafts'));
  db.collection('activity').orderBy('ts', 'desc').limit(400).onSnapshot((q) => { S.activity = q.docs.map((d) => ({ id: d.id, ...d.data() })); if (!q.metadata.fromCache) done('activity'); renderSoon(); }, onErr('activity'));
  db.collection('requests').onSnapshot((q) => { S.requests = q.docs.map((d) => ({ id: d.id, ...d.data() })); if (!q.metadata.fromCache) done('requests'); renderSoon(); }, onErr('requests'));
}

// Re-render on data changes, but never under the user's cursor while editing.
let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const a = document.activeElement;
    if (S.dirty || (a && main.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) { renderNav(); return; }
    render();
  });
}

// ---------- the agent's writing rules ----------
const HONESTY = `Ground rules about the candidate (non-negotiable):
- The CANDIDATE FACTS block is the only source of truth about her. Use nothing else about her.
- Never invent or imply: professional experience, responsibilities, achievements, figures, software skills, technical skills, certifications, qualifications, projects, language levels or test scores.
- Do not upgrade anything: an observation internship stays an observation internship; "Excel (bases)" stays basic; a summer job stays a summer job.
- Skills listed in "confirmed_transferable_skills" may be used as written. Nothing else may be inferred and presented as a skill.
- She is a student looking for a short internship to learn. The tone stays modest and credible.
- If something useful is missing, do not fill the gap: put a question in "notes_for_candidate".`;
const STYLE = {
  fr: `Style (French):
- Write like a thoughtful third-year student, not like marketing copy or an AI assistant. Plain, precise sentences of varied length. No rhetorical questions, no exclamation marks.
- Be specific about the organization: refer to concrete activities, markets, products or services that appear in the ORGANIZATION SOURCES, and only those.
- No flattery, no superlatives, no over-enthusiasm.
- Never use: passionnée, passion, dynamique, je suis convaincue, intimement, véritable, valeur ajoutée, atout, pleinement, parfaitement, idéal, riche expérience, défi, challenge, synergie, prestigieuse, renommée, leader incontesté, n'hésitez pas, je serais ravie, c'est avec un grand intérêt, c'est avec enthousiasme, fort intérêt, en tant que, forte de, je mets à votre disposition.
- No em dashes (—). Classic French letter conventions ("Madame, Monsieur,", short classic closing formula).`,
  en: `Style (English):
- Write like a thoughtful third-year student, not like marketing copy or an AI assistant. Plain, precise sentences. No rhetorical questions, no exclamation marks.
- Be specific about the organization, using only what appears in the ORGANIZATION SOURCES.
- No flattery, superlatives or over-enthusiasm. Never use: passionate, passion, thrilled, excited, eager, delighted, dynamic, leverage, synergy, delve, tapestry, cutting-edge, world-class, renowned, I am confident that, I am convinced, unique opportunity, perfect fit, add value.
- No em dashes (—).`,
};
const BANNED = {
  fr: ['passionnée', 'passionné', 'passion', 'dynamique', 'je suis convaincue', 'intimement', 'véritable', 'valeur ajoutée', 'atout', 'pleinement', 'parfaitement', 'idéal', 'riche expérience', 'défi', 'challenge', 'synergie', 'prestigieu', 'renommée', 'leader incontesté', "n'hésitez pas", 'je serais ravie', 'avec un grand intérêt', 'avec enthousiasme', 'fort intérêt', 'en tant que', 'forte de', 'je mets à votre disposition', '—', '!'],
  en: ['passionate', 'passion', 'thrilled', 'excited', 'eager', 'delighted', 'dynamic', 'leverage', 'synergy', 'delve', 'tapestry', 'cutting-edge', 'world-class', 'renowned', 'i am confident that', 'i am convinced', 'unique opportunity', 'perfect fit', 'add value', '—', '!'],
};

function factsForAI(p) {
  return {
    identity: p.identity, internship: p.internship, languages: p.languages, education: p.education, experiences: p.experiences, skills: p.skills, interests: p.interests,
    confirmed_transferable_skills: (p.transferable || []).filter((t) => t.status === 'confirmed').map((t) => ({ text: t.text, basis: t.basis })),
    answers_from_candidate: (p.questions || []).filter((q) => q.answer?.trim()).map((q) => ({ question: q.question, answer: q.answer })),
  };
}

function contextBlock(app, opp) {
  const hb = S.handbook?.requirements?.length ? `UNIVERSITY HANDBOOK REQUIREMENTS (verbatim quotes; the handbook is the ${S.handbook.academicYear || 'unknown'} edition, dates may be outdated):\n${JSON.stringify(S.handbook.requirements.map((r) => ({ topic: r.topic, quote: r.quote })), null, 1)}\n\n` : '';
  return `CANDIDATE FACTS (only source of truth about her):
${JSON.stringify(factsForAI(S.profile), null, 1)}

${hb}TARGET ORGANIZATION: ${opp.name}
Website: ${opp.website}
Location: ${opp.city || ''} (${AREA[opp.area] || ''})
Industry: ${opp.industry || 'unknown'}
Application type: ${opp.kind === 'published' ? `reply to a published internship offer (${opp.listingUrl})` : 'spontaneous application (no published offer)'}
Internship idea (AI suggestion): ${opp.position || 'not defined'}
Possible tasks (AI suggestion): ${(opp.responsibilities || []).join(' | ')}

ORGANIZATION SOURCES (text of pages fetched from its website):
${opp.sourcesText || '(no page text available: stay general about the organization and say so in notes_for_candidate)'}

LANGUAGE OF THE LETTER AND EMAIL: ${app.language === 'en' ? 'English' : 'French'}. The CV stays in French.`;
}

const GEN_SHAPE = `Reply with only a JSON object of this exact shape:
{"cv":{"headline":"...","profile":"...","experience_order":["<experience id>",...],"experiences":[{"id":"<experience id>","include":true,"bullet_indices":[0,1]}],"course_highlights":["<course name copied exactly>"],"skills_order":["<skill id>"]},
 "letter":{"subject_line":"...","recipient_line":"","salutation":"...","paragraphs":["...","...","..."],"closing":"..."},
 "email":{"subject":"...","body":"..."},
 "notes_for_candidate":["..."]}`;

function generationPrompt(app, opp, feedback, previous) {
  let p = `You write an internship application for one specific student, for this organization only. Refer to what the organization actually does according to the sources and explain plainly why this internship makes sense for her studies. Never reuse a generic template.

${HONESTY}

${STYLE[app.language] || STYLE.fr}

CV rules: you do not write CV content. You only (1) write a short factual headline and a 3–4 sentence profile paragraph that mentions the internship duration and period exactly as in the facts, (2) order her real experiences and choose which existing bullets to show (ids and bullet indices from the facts; keep the Service Civique and the logistics experiences unless clearly irrelevant), (3) choose real courses to highlight (copied exactly), (4) order skill groups by id.

Cover letter: 250–330 words in the paragraphs. 1: who she is and what she asks for (dates). 2: what she understood of the organization's activity and why it relates to her LEA international-trade studies, citing concrete activities from the sources. 3: what she can realistically bring as an intern, based only on her facts, and what she wants to learn. Optional short 4: availability for a meeting. Do not repeat the CV line by line.
Email: 60–120 words presenting the application, mentioning the two attachments (CV and cover letter), signed with her name and phone.

${contextBlock(app, opp)}`;
  if (feedback?.length && previous) p += `\n\nA PREVIOUS DRAFT had these problems; fix every one:\n${feedback.map((f) => `- ${f}`).join('\n')}\n\nPrevious draft:\n${JSON.stringify(previous)}`;
  else if (feedback?.length) p += `\n\nINSTRUCTIONS FROM THE CANDIDATE FOR THIS VERSION:\n${feedback.join('\n')}`;
  return `${p}\n\n${GEN_SHAPE}`;
}

function reviewPrompt(app, opp, draft) {
  return `You are a strict fact-checker. Compare this internship application with the candidate's facts and the organization's web pages. Flag every claim about the candidate not directly supported by her facts (invented experience, tasks, skills, software, achievements, certifications, upgraded language levels, exaggerations) and every claim about the organization not supported by the sources. Modest statements of motivation or learning goals are fine.

${contextBlock(app, opp)}

APPLICATION TO CHECK:
CV headline: ${draft.cv.headline}
CV profile: ${draft.cv.profile}
Letter subject: ${draft.letter.subject_line}
${draft.letter.salutation}
${draft.letter.paragraphs.join('\n\n')}
${draft.letter.closing}
Email subject: ${draft.email.subject}
Email body:
${draft.email.body}

Reply with only a JSON object: {"unsupported_claims":[{"excerpt":"...","problem":"...","severity":"high|medium|low"}],"organization_claims_not_in_sources":["..."],"style_remarks":["..."]}`;
}

function sanitizeDraft(d) {
  const p = S.profile;
  if (!d || !d.cv || !d.letter || !d.email || !Array.isArray(d.letter.paragraphs)) throw new Error('The answer did not have the expected shape. Try again.');
  const ids = p.experiences.map((e) => e.id);
  const courses = p.education.flatMap((e) => e.courses || []);
  d.cv.experience_order = (d.cv.experience_order || []).filter((id) => ids.includes(id));
  d.cv.experiences = (d.cv.experiences || []).filter((e) => ids.includes(e.id)).map((e) => ({ id: e.id, include: e.include !== false, bullet_indices: (e.bullet_indices || []).filter(Number.isInteger) }));
  d.cv.course_highlights = (d.cv.course_highlights || []).filter((c) => courses.includes(c));
  d.cv.skills_order = (d.cv.skills_order || []).filter((id) => p.skills.some((s) => s.id === id));
  d.letter.recipient_line ||= '';
  d.notes_for_candidate = (d.notes_for_candidate || []).map(String);
  return d;
}

function localChecks(draft, lang) {
  const p = S.profile;
  const texts = [draft.cv.headline, draft.cv.profile, draft.letter.subject_line, ...draft.letter.paragraphs, draft.letter.closing, draft.email?.subject ?? '', draft.email?.body ?? ''];
  const out = [];
  const low = texts.join(' \n ').toLowerCase().replace(/’/g, "'");
  const hits = (BANNED[lang] || BANNED.fr).filter((w) => low.includes(w));
  if (hits.length) out.push(`Expressions to avoid found: ${hits.join(', ')}`);
  const w = words(draft.letter.paragraphs.join(' '));
  if (w > 380) out.push(`The letter is long (${w} words).`);
  if (w < 150) out.push(`The letter is short (${w} words).`);
  const all = texts.join(' ');
  for (const lvl of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) if (new RegExp(`\\b${lvl}\\b`).test(all) && !p.languages.some((l) => l.level.includes(lvl))) out.push(`Mentions level ${lvl}, which is not in your profile.`);
  const known = JSON.stringify(p).toLowerCase();
  for (const m of all.matchAll(/\b(SAP|Salesforce|CRM|ERP|Excel avancé|advanced Excel|VBA|Power ?BI|Tableau|SQL|Python|Photoshop|Canva|HubSpot|TOEIC|TOEFL|IELTS|Cambridge|DELE)\b/gi)) if (!known.includes(m[0].toLowerCase())) out.push(`Mentions "${m[0]}", which is not in your profile.`);
  return [...new Set(out)];
}

async function generate(appId, { language, instructions } = {}) {
  const app = appById(appId); const opp = oppById(app.oppId);
  if (!C.sample) throw new Error('Writing with Claude is not available in this view.');
  if (!S.profile) throw new Error('Your profile has not loaded yet.');
  const lang = language || app.language || 'fr';
  const work = { ...app, language: lang };
  S.busy[appId] = 'Writing the CV and cover letter…'; render();
  try {
    let draft = sanitizeDraft(await C.sample.json(generationPrompt(work, opp, instructions ? [instructions] : null), { modelTier: 'complex', cache: false }));
    S.busy[appId] = 'Fact-checking against your profile…'; render();
    let review = await C.sample.json(reviewPrompt(work, opp, draft), { modelTier: 'default', cache: false });
    let local = localChecks(draft, lang);
    let regenerated = false;
    const serious = (review.unsupported_claims || []).filter((c) => c.severity !== 'low');
    if (serious.length || (review.organization_claims_not_in_sources || []).length || local.some((x) => x.startsWith('Expressions'))) {
      S.busy[appId] = 'Correcting what the fact-check found…'; render();
      const fb = [...serious.map((c) => `Unsupported claim: "${c.excerpt}" – ${c.problem}`), ...(review.organization_claims_not_in_sources || []).map((c) => `Claim about the organization not in the sources: ${c}`), ...local, ...(instructions ? [`Candidate instructions: ${instructions}`] : [])];
      draft = sanitizeDraft(await C.sample.json(generationPrompt(work, opp, fb, draft), { modelTier: 'complex', cache: false }));
      review = await C.sample.json(reviewPrompt(work, opp, draft), { modelTier: 'default', cache: false });
      local = localChecks(draft, lang);
      regenerated = true;
    }
    const patch = {
      status: 'draft', language: lang, cv: draft.cv, letter: draft.letter, emailSubject: draft.email.subject, emailBody: draft.email.body,
      review: { unsupported: review.unsupported_claims || [], orgClaims: review.organization_claims_not_in_sources || [], style: review.style_remarks || [], local, notes: draft.notes_for_candidate, regenerated, at: nowIso() },
      approvedHash: null, approvedAt: null, profileVersion: S.profileDoc?.version || 1, generationError: null,
    };
    await saveApp(appId, patch);
    const n = await saveDraftVersion({ ...app, ...patch, id: appId }, 'ai');
    const flagged = patch.review.unsupported.length + patch.review.orgClaims.length;
    await log('generate', `Wrote CV and cover letter for ${app.orgName} (version ${n}${regenerated ? ', corrected after fact-check' : ''}${flagged ? `, ${flagged} point(s) to review` : ''})`, { app: appId });
    S.ui.appTab[appId] = 'cv';
  } catch (e) {
    const msg = sampleErrorText(e);
    await saveApp(appId, { generationError: msg }).catch(() => {});
    throw new Error(msg);
  } finally { delete S.busy[appId]; render(); }
}

function sampleErrorText(e) {
  switch (e?.code) {
    case 'not_granted': return 'Claude was not allowed to write for this page. Reload and choose Allow when asked.';
    case 'sampling_disabled': return 'Writing with Claude is not available for your account.';
    case 'rate_limited': return 'You have reached a usage limit for now. Try again a little later.';
    case 'invalid_json': return 'The answer could not be read. Try again.';
    case 'refused': return 'Claude declined this request. Try again with different instructions.';
    case 'prompt_too_large': return 'Too much text was sent. Try again.';
    case 'session_expired': return 'Your claude.ai session expired. Sign in again.';
    default: return e?.message || 'Writing failed. Try again.';
  }
}

// ---------- CV / letter content (shared by the on-screen paper and the PDF) ----------
function resolveCv(p, cv) {
  const exps = p.experiences;
  const ord = cv.experience_order || [];
  const order = [...ord.filter((id) => exps.some((e) => e.id === id)), ...exps.map((e) => e.id).filter((id) => !ord.includes(id))];
  const sel = Object.fromEntries((cv.experiences || []).map((e) => [e.id, e]));
  const experiences = order.map((id) => {
    const e = exps.find((x) => x.id === id); const s = sel[id];
    const include = s ? s.include !== false : true;
    const idx = s?.bullet_indices?.length ? s.bullet_indices.filter((i) => i >= 0 && i < e.bullets.length) : e.bullets.map((_, i) => i);
    return { ...e, include, bullets: idx.map((i) => e.bullets[i]) };
  }).filter((e) => e.include);
  const hi = cv.course_highlights || [];
  const education = p.education.map((ed) => ({ ...ed, courses: (ed.courses || []).length ? [...hi.filter((c) => ed.courses.includes(c)), ...ed.courses.filter((c) => !hi.includes(c))] : [] }));
  const so = cv.skills_order || [];
  const skills = [...so.filter((id) => p.skills.some((s) => s.id === id)), ...p.skills.map((s) => s.id).filter((id) => !so.includes(id))].map((id) => p.skills.find((s) => s.id === id));
  return { identity: p.identity, headline: cv.headline || p.identity.headline, profileText: cv.profile || p.internship.cv_profile_text, languages: p.languages, education, experiences, skills, interests: p.interests };
}
const MONTHS = { fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'], en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] };
function letterDate(date, lang, city) {
  const d = new Date(date);
  return lang === 'en' ? `${city}, ${d.getDate()} ${MONTHS.en[d.getMonth()]} ${d.getFullYear()}` : `${city}, le ${d.getDate() === 1 ? '1er' : d.getDate()} ${MONTHS.fr[d.getMonth()]} ${d.getFullYear()}`;
}
const LBL = { profile: 'Profil', languages: 'Langues', education: 'Formation', experience: 'Expériences', skills: 'Compétences', interests: "Centres d'intérêt", courses: 'Enseignements' };

function cvPaper(p, cv) {
  const r = resolveCv(p, cv);
  return html`<div class="paper" aria-label="CV preview">
    <div class="p-name">${r.identity.full_name}</div><div class="p-head">${r.headline}</div>
    <div class="p-contact">${[r.identity.phone, r.identity.email, r.identity.city].filter(Boolean).join('  ·  ')}</div>
    <div class="p-sec">${LBL.profile}</div><div>${r.profileText}</div>
    <div class="p-sec">${LBL.languages}</div><div class="p-langs">${r.languages.map((l) => html`<div><b>${l.name}</b><div class="p-small">${l.level}</div></div>`)}</div>
    <div class="p-sec">${LBL.education}</div>${r.education.map((e) => html`<div class="p-entry"><b>${e.title}</b><span class="p-date">${e.dates}</span></div><div class="p-sub">${e.institution}</div>${e.courses.length ? html`<div class="p-small"><b>${LBL.courses} :</b> ${e.courses.join(' · ')}</div>` : ''}`)}
    <div class="p-sec">${LBL.experience}</div>${r.experiences.map((e) => html`<div class="p-entry"><b>${e.title}</b><span class="p-date">${e.dates}</span></div><div class="p-sub">${e.organization}</div>${e.summary ? html`<div>${e.summary}</div>` : ''}<ul>${e.bullets.map((b) => html`<li>${b}</li>`)}</ul>`)}
    <div class="p-sec">${LBL.skills}</div>${r.skills.map((s) => html`<div class="p-small"><b>${s.label} :</b> ${s.value}</div>`)}
    ${r.interests ? html`<div class="p-sec">${LBL.interests}</div><div class="p-small">${r.interests}</div>` : ''}
  </div>`;
}
function letterPaper(p, app, letter, date = new Date()) {
  const id = p.identity; const lang = app.language;
  return html`<div class="paper p-letter" aria-label="Letter preview">
    <div class="p-name">${id.full_name}</div><div class="p-contact">${[id.city, id.phone, id.email].filter(Boolean).join('  ·  ')}</div>
    <div class="p-recipient"><br><b>${app.orgName}</b>${letter.recipient_line ? html`<br>${letter.recipient_line}` : ''}${app.city ? html`<br>${app.city}` : ''}<br><br>${letterDate(date, lang, id.city)}</div>
    <div><br><b>${lang === 'en' ? 'Subject' : 'Objet'} : ${letter.subject_line}</b><br><br></div>
    <div>${letter.salutation}</div><br>
    ${letter.paragraphs.map((x) => html`<p>${x}</p>`)}<p>${letter.closing}</p>
    <div class="p-recipient"><br>${id.full_name}</div>
  </div>`;
}

// ---------- PDF (pdfkit, fonts embedded in this page) ----------
const FONT_FILES = window.__STAGE_FONTS__ || {};
function newPdf(title, author) {
  if (typeof PDFDocument === 'undefined') throw new Error('The PDF library did not load. Reload the page.');
  const doc = new PDFDocument({ size: 'A4', margins: { top: 44, bottom: 36, left: 56, right: 56 }, info: { Title: title, Author: author, Creator: 'Stage internship desk' } });
  for (const [k, b64] of Object.entries(FONT_FILES)) doc.registerFont(k, b64ToBytes(b64).buffer);
  return doc;
}
function pdfBytes(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c)));
    doc.on('end', () => { const n = chunks.reduce((s, c) => s + c.length, 0); const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } resolve(out); });
    doc.on('error', reject); doc.end();
  });
}
const INK = '#2a2926', MUTED = '#6b6a64', ACC = '#5c6338', RULE = '#d9d5c8';
function renderCvPdf(p, cv) {
  const r = resolveCv(p, cv);
  const doc = newPdf(`CV – ${r.identity.full_name}`, r.identity.full_name);
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right; const x0 = doc.page.margins.left;
  doc.font('serif').fontSize(24).fillColor(INK).text(r.identity.full_name, { characterSpacing: 0.3 });
  doc.moveDown(0.15); doc.font('sans').fontSize(10.5).fillColor(ACC).text(r.headline);
  doc.moveDown(0.3); doc.font('sans').fontSize(9).fillColor(MUTED).text([r.identity.phone, r.identity.email, r.identity.city].filter(Boolean).join('  ·  '));
  doc.moveDown(0.8);
  const section = (t) => { if (doc.y > doc.page.height - 85) doc.addPage(); doc.moveDown(0.4); doc.font('sans-semibold').fontSize(8.5).fillColor(ACC).text(t.toUpperCase(), { characterSpacing: 1.4 }); const y = doc.y + 3; doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(0.6).strokeColor(RULE).stroke(); doc.y = y + 7; };
  const body = (t, o = {}) => doc.font('serif').fontSize(10.2).fillColor(INK).text(t, { lineGap: 1.5, ...o });
  const entry = (title, right, sub) => { const y = doc.y; doc.font('serif-semibold').fontSize(10.8).fillColor(INK).text(title, x0, y, { width: W - 110 }); const ya = doc.y; if (right) doc.font('sans').fontSize(9).fillColor(MUTED).text(right, x0 + W - 105, y + 1, { width: 105, align: 'right' }); doc.x = x0; doc.y = ya; if (sub) doc.font('serif-italic').fontSize(10.2).fillColor(MUTED).text(sub, x0, doc.y, { width: W }); };
  section(LBL.profile); body(r.profileText, { align: 'justify' });
  section(LBL.languages);
  { const cw = W / r.languages.length; const y = doc.y; r.languages.forEach((l, i) => { doc.font('serif-semibold').fontSize(10.5).fillColor(INK).text(l.name, x0 + i * cw, y, { width: cw - 8 }); doc.font('sans').fontSize(9).fillColor(MUTED).text(l.level, x0 + i * cw, doc.y + 1, { width: cw - 8 }); }); doc.x = x0; doc.y = y + 30; }
  section(LBL.education);
  for (const ed of r.education) { entry(ed.title, ed.dates, ed.institution); if (ed.courses.length) { doc.moveDown(0.15); doc.font('sans-semibold').fontSize(9).fillColor(INK).text(`${LBL.courses} : `, x0, doc.y, { continued: true }); doc.font('sans').fontSize(9).text(ed.courses.join(' · ')); } doc.moveDown(0.5); }
  section(LBL.experience);
  for (const e of r.experiences) {
    if (doc.y > doc.page.height - 75) doc.addPage();
    entry(e.title, e.dates, e.organization);
    if (e.summary) { doc.moveDown(0.1); body(e.summary, { width: W }); }
    for (const b of e.bullets) { doc.moveDown(0.02); const y = doc.y; doc.font('serif').fontSize(10.2).fillColor(ACC).text('–', x0 + 2, y, { width: 10 }); doc.font('serif').fontSize(10.2).fillColor(INK).text(b, x0 + 14, y, { width: W - 14, lineGap: 0.8 }); }
    doc.x = x0; doc.moveDown(0.4);
  }
  section(LBL.skills);
  for (const s of r.skills) { doc.font('sans-semibold').fontSize(9.5).fillColor(INK).text(`${s.label} : `, x0, doc.y, { continued: true, lineGap: 2 }); doc.font('sans').fontSize(9.5).text(s.value, { lineGap: 2 }); }
  if (r.interests) { section(LBL.interests); doc.font('sans').fontSize(9.5).fillColor(INK).text(r.interests); }
  return pdfBytes(doc);
}
function renderLetterPdf(p, app, letter, date = new Date()) {
  const id = p.identity; const lang = app.language;
  const doc = newPdf(`${lang === 'en' ? 'Cover letter' : 'Lettre de motivation'} – ${id.full_name}`, id.full_name);
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right; const x0 = doc.page.margins.left; const rx = x0 + W * 0.55;
  doc.font('serif').fontSize(17).fillColor(INK).text(id.full_name);
  doc.font('sans').fontSize(9).fillColor(MUTED).text([id.city, id.phone, id.email].filter(Boolean).join('  ·  '));
  doc.moveDown(2);
  const y = doc.y;
  doc.font('serif-semibold').fontSize(11).fillColor(INK).text(app.orgName, rx, y, { width: W * 0.45 });
  if (letter.recipient_line) doc.font('serif').fontSize(10.5).text(letter.recipient_line, rx, doc.y, { width: W * 0.45 });
  if (app.city) doc.font('serif').fontSize(10.5).text(app.city, rx, doc.y, { width: W * 0.45 });
  doc.moveDown(1.2); doc.font('serif').fontSize(10.5).text(letterDate(date, lang, id.city), rx, doc.y, { width: W * 0.45 });
  doc.x = x0; doc.moveDown(2);
  doc.font('serif-semibold').fontSize(10.8).text(`${lang === 'en' ? 'Subject' : 'Objet'} : ${letter.subject_line}`, x0, doc.y, { width: W });
  doc.moveDown(1.4); doc.font('serif').fontSize(11).text(letter.salutation, { width: W }); doc.moveDown(0.8);
  for (const para of letter.paragraphs) { doc.font('serif').fontSize(11).fillColor(INK).text(para, { width: W, align: 'justify', lineGap: 2.2, indent: lang === 'fr' ? 18 : 0 }); doc.moveDown(0.75); }
  doc.font('serif').fontSize(11).text(letter.closing, { width: W, align: 'justify', lineGap: 2.2, indent: lang === 'fr' ? 18 : 0 });
  doc.moveDown(2); doc.font('serif').fontSize(11).text(id.full_name, rx, doc.y, { width: W * 0.45 });
  return pdfBytes(doc);
}
const safeName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
function fileNames(app) {
  const who = safeName(S.profile.identity.full_name);
  return { cv: `CV_${who}.pdf`, letter: `${app.language === 'en' ? 'Cover_letter' : 'Lettre_de_motivation'}_${who}_${safeName(app.orgName)}.pdf` };
}
async function savePdf(bytes, filename) {
  if (!C.downloads) throw new Error('Saving files is not available in this view.');
  try { await C.downloads.save({ filename, data: bytes }); } catch (e) { if (e?.code !== 'cancelled' && e?.code !== 'declined') throw new Error(`The file was not saved (${e?.code || e?.message || 'error'}).`); }
}

// ---------- application lifecycle ----------
function bestContact(opp) {
  const v = (opp.contacts || []).filter((c) => c.status === 'verified');
  return v.find((c) => c.recommended) || v.find((c) => /^(rh|recrutement|jobs|careers|stage)/i.test(c.email)) || v[0] || null;
}
async function decide(oppId, decision) {
  const opp = oppById(oppId);
  await C.db.collection('opportunities').doc(oppId).update({ status: decision, decidedAt: nowIso() });
  const label = { interested: 'Interested', not_interested: 'Not interested', saved: 'Saved for later', new: 'Moved back to new' }[decision];
  await log('decision', `${label}: ${opp.name}`, { opp: oppId });
  if (decision !== 'interested') { toast(label); return; }
  let app = S.apps.find((a) => a.oppId === oppId && a.status !== 'withdrawn');
  if (!app) {
    const id = uid('app');
    const c = bestContact(opp);
    const doc = { oppId, orgName: opp.name, website: opp.website, city: opp.city || '', area: opp.area || '', kind: opp.kind, listingUrl: opp.listingUrl || '', position: opp.position || '', status: 'draft', language: 'fr', contact: c ? { email: c.email, evidenceUrl: c.evidenceUrl, detail: c.detail, checkedAt: c.checkedAt } : null, cv: null, letter: null, emailSubject: '', emailBody: '', review: null, approvedHash: null, approvedAt: null, events: [], failedAttempts: [], createdAt: nowIso(), updatedAt: nowIso() };
    await C.db.collection('applications').doc(id).set(doc);
    await log('decision', `Application opened for ${opp.name}`, { app: id });
    app = { id, ...doc };
    S.apps.push(app);
  }
  go(`app-${app.id}`);
  if (!app.cv && C.sample) generate(app.id).catch((e) => toast(e.message, 'error'));
}

async function approvalHash(app) {
  return sha256Hex(stable({ cv: app.cv, letter: app.letter, subject: app.emailSubject, body: app.emailBody, language: app.language, to: app.contact?.email || null }));
}
function readiness(app) {
  const p = [];
  if (!app.cv || !app.letter) p.push('The CV and cover letter are not written yet.');
  if (!app.emailSubject?.trim() || !app.emailBody?.trim()) p.push('The email subject and body are required.');
  if (!app.contact) p.push('No recipient is selected.');
  else if (!verifiedFor(app)) p.push(`The recipient ${app.contact.email} is not verified.`);
  return p;
}
function verifiedFor(app) {
  const opp = oppById(app.oppId);
  const c = (opp?.contacts || []).find((x) => x.email === app.contact?.email);
  return Boolean(c && c.status === 'verified');
}
async function updateDraft(appId, patch, label) {
  const app = appById(appId);
  if (!['draft', 'awaiting_approval'].includes(app.status)) throw new Error('This application can no longer be edited.');
  const next = { ...app, ...patch };
  const review = { ...(app.review || {}), local: next.cv && next.letter ? localChecks({ cv: next.cv, letter: next.letter, email: { subject: next.emailSubject, body: next.emailBody } }, next.language) : [] };
  const wasApproved = app.status === 'awaiting_approval';
  await saveApp(appId, { ...patch, review, status: 'draft', approvedHash: null, approvedAt: null });
  if (patch.cv || patch.letter || 'emailSubject' in patch || 'emailBody' in patch) {
    const n = await saveDraftVersion({ ...next, id: appId }, 'edit');
    await log('edit', `${label} edited for ${app.orgName} (version ${n})`, { app: appId });
  }
  if (wasApproved) await log('approve', `Approval withdrawn for ${app.orgName} because it was edited`, { app: appId });
  S.dirty = false;
}
async function approve(appId) {
  const app = appById(appId);
  const pr = readiness(app);
  if (pr.length) throw new Error(pr.join(' '));
  await saveApp(appId, { status: 'awaiting_approval', approvedHash: await approvalHash(app), approvedAt: nowIso() });
  await log('approve', `Documents approved for ${app.orgName}; waiting for your final send approval`, { app: appId });
  S.ui.appTab[appId] = 'send';
}
async function revoke(appId) {
  const app = appById(appId);
  await saveApp(appId, { status: 'draft', approvedHash: null, approvedAt: null });
  await log('approve', `Approval withdrawn for ${app.orgName}`, { app: appId });
}

const DEFINITELY_NOT_SENT = ['tool_error', 'not_in_manifest', 'needs_reauth', 'server_not_connected', 'selection_required', 'blocked_by_policy', 'approval_required', 'not_granted', 'capability_disabled', 'capability_removed', 'bad_request', 'server_not_found', 'self_only', 'transform_error'];
function mcpErrorText(e) {
  switch (e?.code) {
    case 'server_not_connected': return 'Gmail is not connected to your Claude account. Add it in claude.ai Settings → Connectors.';
    case 'needs_reauth': return 'Your Gmail connection expired. Reconnect Gmail in claude.ai Settings → Connectors.';
    case 'not_in_manifest': case 'approval_required': case 'not_granted': return 'This page was not allowed to use Gmail. Allow it when asked (or in the page\'s Permissions menu) and try again.';
    case 'selection_required': return 'You have more than one Gmail connector. Choose which one this page should use when asked.';
    case 'blocked_by_policy': return 'Your organization blocks this Gmail action.';
    case 'tool_error': return `Gmail refused the message: ${e.message}`;
    default: return e?.message || 'Gmail could not be reached.';
  }
}

async function send(appId) {
  const app = appById(appId);
  if (app.status !== 'awaiting_approval') throw new Error('This application has not been approved for sending.');
  const pr = readiness(app);
  if (pr.length) throw new Error(pr.join(' '));
  if ((await approvalHash(app)) !== app.approvedHash) throw new Error('The application changed after approval. Review it and approve it again.');
  if (!C.mcp) throw new Error('Gmail cannot be used from this view. Open the page on claude.ai while signed in.');
  if (!C.assets) throw new Error('The archive (file storage) is not available in this view, so nothing was sent. Open the page on claude.ai as its owner.');
  S.busy[appId] = 'Preparing the PDFs…'; render();
  try {
    const date = new Date();
    const [cvBytes, letterBytes] = await Promise.all([renderCvPdf(S.profile, app.cv), renderLetterPdf(S.profile, app, app.letter, date)]);
    const names = fileNames(app);
    const [cvSha, letterSha] = await Promise.all([sha256Hex(cvBytes), sha256Hex(letterBytes)]);
    S.busy[appId] = 'Archiving the exact files…'; render();
    const cvAsset = await C.assets.upload(new Blob([cvBytes], { type: 'application/pdf' }), { type: 'application/pdf' });
    const letterAsset = await C.assets.upload(new Blob([letterBytes], { type: 'application/pdf' }), { type: 'application/pdf' });
    const attempt = {
      to: app.contact.email, subject: app.emailSubject, body: app.emailBody, startedAt: nowIso(), from: 'Gmail',
      cv: { assetId: cvAsset.id, sha256: cvSha, filename: names.cv, size: cvBytes.length },
      letter: { assetId: letterAsset.id, sha256: letterSha, filename: names.letter, size: letterBytes.length },
      profileVersion: S.profileDoc?.version || 1,
    };
    await saveApp(appId, { attempt });
    S.busy[appId] = 'Sending from your Gmail…'; render();
    let result;
    try {
      result = await C.mcp.callTool('Gmail', 'send_message', {
        to: [app.contact.email], subject: app.emailSubject, body: app.emailBody,
        attachments: [
          { content: bytesToB64(cvBytes), filename: names.cv, mimeType: 'application/pdf' },
          { content: bytesToB64(letterBytes), filename: names.letter, mimeType: 'application/pdf' },
        ],
      });
    } catch (e) {
      if (DEFINITELY_NOT_SENT.includes(e?.code)) {
        await saveApp(appId, { attempt: null, failedAttempts: [...(app.failedAttempts || []), { ...attempt, error: mcpErrorText(e), at: nowIso() }] });
        await log('error', `Not sent to ${app.orgName}: ${mcpErrorText(e)}`, { app: appId });
        throw new Error(`Not sent. ${mcpErrorText(e)}`);
      }
      await saveApp(appId, { status: 'unknown', attempt: { ...attempt, error: mcpErrorText(e) } });
      await log('error', `Sending to ${app.orgName}: Gmail did not confirm (${e?.code || 'error'}). Check the Sent folder before trying again.`, { app: appId });
      throw new Error('Gmail did not confirm whether the email left. Use "Check Gmail Sent folder" before trying again.');
    }
    const pl = result?.payload || {};
    const gmailId = pl.id || pl.message?.id || null;
    if (!gmailId) {
      await saveApp(appId, { status: 'unknown', attempt: { ...attempt, error: 'Gmail returned no message id' } });
      throw new Error('Gmail answered without a message ID. Use "Check Gmail Sent folder" to confirm.');
    }
    await markSent(appId, { ...attempt, gmailId, threadId: pl.threadId || null, sentAt: nowIso() });
    toast('Sent from your Gmail');
  } finally { delete S.busy[appId]; render(); }
}
async function markSent(appId, sent) {
  const app = appById(appId);
  await saveApp(appId, { status: 'sent', sent, attempt: null, events: [...(app.events || []), { type: 'status', date: nowIso().slice(0, 10), content: `Sent to ${sent.to} from Gmail (message ${sent.gmailId})` }] });
  await log('send', `Application sent to ${app.orgName} (${sent.to}) from Gmail; CV and letter archived (SHA-256 ${sent.cv.sha256.slice(0, 10)} / ${sent.letter.sha256.slice(0, 10)})`, { app: appId });
}
async function checkSentFolder(appId) {
  const app = appById(appId); const at = app.attempt;
  if (!at) return;
  const d = new Date(at.startedAt); const day = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  let res;
  try { res = await C.mcp.callTool('Gmail', 'search_threads', { query: `in:sent to:${at.to} after:${day}`, pageSize: 10 }, { cache: false }); } catch (e) { throw new Error(mcpErrorText(e)); }
  const threads = res?.payload?.threads || [];
  const hit = threads.find((t) => (t.messages || []).some((m) => (m.subject || '').trim() === at.subject.trim()));
  if (hit) {
    const m = hit.messages.find((x) => (x.subject || '').trim() === at.subject.trim());
    await markSent(appId, { ...at, gmailId: m.id, threadId: hit.id, sentAt: m.date || at.startedAt, confirmedVia: 'Sent folder' });
    toast('Found in your Sent folder: marked as sent');
  } else {
    await saveApp(appId, { status: 'awaiting_approval', attempt: null, failedAttempts: [...(app.failedAttempts || []), { ...at, error: 'Not found in the Sent folder', at: nowIso() }] });
    await log('error', `Sending to ${app.orgName}: not found in Gmail's Sent folder, so it was not sent. The application is ready to send again.`, { app: appId });
    toast('Not in your Sent folder: it was not sent. You can send it again.', 'error');
  }
}
async function checkReplies(appId) {
  const app = appById(appId); const s = app.sent;
  const domain = s.to.split('@')[1];
  const d = new Date(s.sentAt); const day = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  let res;
  try { res = await C.mcp.callTool('Gmail', 'search_threads', { query: `from:${domain} after:${day}`, pageSize: 20 }, { cache: false }); } catch (e) { throw new Error(mcpErrorText(e)); }
  S.ui.replies[appId] = (res?.payload?.threads || []).map((t) => { const ms = t.messages || []; const m = ms.find((x) => String(x.sender || '').toLowerCase().includes(domain)) || ms[0] || {}; return { threadId: t.id, subject: m.subject || '', snippet: m.snippet || '', sender: m.sender || '', date: m.date || '', url: t.viewUrl || m.viewUrl || '' }; });
  await log('archive', `Checked Gmail for replies from ${domain}: ${S.ui.replies[appId].length} found`, { app: appId });
}
async function addEvent(appId, ev) {
  const app = appById(appId);
  const events = [...(app.events || []), ev];
  const patch = { events };
  if (ev.type === 'interview' && ['sent', 'follow_up'].includes(app.status)) patch.status = 'interview';
  await saveApp(appId, patch);
  await log('archive', `${app.orgName}: ${{ response: 'response', follow_up: 'follow-up', interview: 'interview', note: 'note' }[ev.type]} recorded`, { app: appId });
}

// ---------- navigation ----------
const main = document.getElementById('main');
const nav = document.getElementById('nav');
function route() { return (location.hash || '#overview').slice(1) || 'overview'; }
function go(r) { if (location.hash !== `#${r}`) location.hash = r; else render(); }
window.addEventListener('hashchange', () => { S.dirty = false; S.ui.confirm = null; render(); window.scrollTo(0, 0); });

function renderNav() {
  const r = route();
  const newCount = S.opps.filter((o) => o.status === 'new').length;
  const prep = S.apps.filter((a) => ['draft', 'awaiting_approval', 'unknown'].includes(a.status)).length;
  const openQ = (S.profile?.questions || []).filter((q) => !q.answer?.trim()).length;
  const items = [['overview', 'Overview'], ['discover', 'Discover', newCount], ['applications', 'Applications', prep], ['library', 'Documents'], ['activity', 'Activity'], ['profile', 'Profile', openQ], ['setup', 'Connections']];
  nav.innerHTML = items.map(([k, l, n]) => html`<a href="#${k}" class="${r === k || (k === 'applications' && r.startsWith('app-')) ? 'active' : ''}">${l}${n ? html`<span class="count">${n}</span>` : ''}</a>`.s).join('');
}

function render() {
  renderNav();
  if (S.noRuntime) { main.innerHTML = html`<div class="notice warn">This workspace runs inside claude.ai. Open its link while signed in to your Claude account.</div>`.s; return; }
  if (!C.db && !S.capsResolved) { main.innerHTML = html`<div class="progress"><span class="spinner"></span>Opening your workspace…</div>`.s; return; }
  if (!C.db) { main.innerHTML = html`<div class="notice warn"><strong>Your workspace data can't be opened in this view.</strong> Open the link on claude.ai while signed in as its owner.</div>`.s; return; }
  if (!S.ready) { main.innerHTML = html`<div class="progress"><span class="spinner"></span>${S.timedOut ? 'Your data is taking longer than usual to load. It will appear here when it arrives.' : 'Loading your workspace…'}</div>`.s; return; }
  if (!S.profile) { main.innerHTML = html`<div class="empty"><div class="serif">Your profile is not set up yet</div>Ask Claude in your chat to load your profile into this workspace.</div>`.s; return; }
  const r = route();
  let v;
  if (r.startsWith('app-')) v = viewApp(r.slice(4));
  else v = ({ overview: viewOverview, discover: viewDiscover, applications: viewApplications, library: viewLibrary, activity: viewActivity, profile: viewProfile, setup: viewSetup }[r] || viewOverview)();
  main.innerHTML = v.s;
}

// ---------- views ----------
function viewOverview() {
  const sentApps = S.apps.filter((a) => a.sent);
  const responses = S.apps.filter((a) => (a.events || []).some((e) => e.type === 'response')).length;
  const interviews = S.apps.filter((a) => ['interview', 'accepted'].includes(a.status) || (a.events || []).some((e) => e.type === 'interview')).length;
  const todo = [];
  if (!S.handbook) todo.push(['profile', 'Add your university internship handbook', 'Requirements are not checked until it is there']);
  else if (S.handbook.academicYear && !/2026/.test(S.handbook.academicYear)) todo.push(['profile', `Your handbook is the ${S.handbook.academicYear} edition`, 'Dates may be outdated: ask the internship office for the current one']);
  const openQ = (S.profile.questions || []).filter((q) => !q.answer?.trim()).length;
  if (openQ) todo.push(['profile', `${openQ} question${openQ > 1 ? 's' : ''} about your profile`, 'Nothing is guessed until you answer']);
  const sug = (S.profile.transferable || []).filter((t) => t.status === 'suggested').length;
  if (sug) todo.push(['profile', `${sug} suggested skill${sug > 1 ? 's' : ''} to confirm or reject`, 'Not used in documents until confirmed']);
  const nnew = S.opps.filter((o) => o.status === 'new').length;
  if (nnew) todo.push(['discover', `${nnew} new organization${nnew > 1 ? 's' : ''} to review`, 'Discover']);
  for (const a of S.apps.filter((x) => ['draft', 'awaiting_approval', 'unknown'].includes(x.status))) todo.push([`app-${a.id}`, a.orgName, a.status === 'awaiting_approval' ? 'Ready: waiting for your final approval' : a.status === 'unknown' ? 'Check whether it was sent' : 'Draft to review']);
  for (const a of S.apps.filter((x) => x.status === 'sent' && x.sent && Date.now() - new Date(x.sent.sentAt) > 14 * 864e5 && !(x.events || []).some((e) => e.type === 'response' || e.type === 'follow_up'))) todo.push([`app-${a.id}`, `Follow up with ${a.orgName}?`, `Sent ${fmtDate(a.sent.sentAt)}, no response recorded`]);
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const pending = S.requests.filter((q) => q.status === 'pending');
  return html`
  <div class="page-head"><div><div class="eyebrow">${today}</div><h1>Your internship search</h1>
    <p class="lede">${S.profile.identity.headline}. ${S.profile.internship.duration}, ${S.profile.internship.period}, in Orléans or Paris.</p></div>
    <a class="btn primary" href="#discover">Review opportunities</a></div>
  <div class="stats">
    <div class="stat"><div class="n">${S.opps.length}</div><div class="l">Organizations discovered</div></div>
    <div class="stat"><div class="n">${S.opps.filter((o) => o.status === 'saved').length}</div><div class="l">Saved for later</div></div>
    <div class="stat"><div class="n">${sentApps.length}</div><div class="l">Applications sent</div></div>
    <div class="stat"><div class="n">${responses}</div><div class="l">Responses received</div></div>
    <div class="stat"><div class="n">${interviews}</div><div class="l">Interviews</div></div>
  </div>
  ${Object.keys(S.busy).length ? html`<div class="section stack">${Object.entries(S.busy).map(([id, t]) => html`<a class="progress" href="#app-${id}"><span class="spinner"></span>${appById(id)?.orgName}: ${t}</a>`)}</div>` : ''}
  ${pending.length ? html`<div class="section notice small">${pending.length} search request${pending.length > 1 ? 's' : ''} waiting for the research agent.</div>` : ''}
  <div class="section"><h2>Needs your attention</h2><div class="todo section">${todo.length ? todo.map(([h, t, d]) => html`<a href="#${h}"><span>${t}</span><span class="muted small">${d}</span></a>`) : html`<p class="muted">Nothing waiting right now.</p>`}</div></div>
  <div class="section"><div class="section-head"><h2>Recent activity</h2><a href="#activity" class="small">Full history</a></div>
    <ul class="list">${S.activity.slice(0, 7).map((a) => html`<li><span class="break">${a.message}</span><span class="meta">${fmtDate(a.ts, true)}</span></li>`)}</ul></div>`;
}

const SECTORS = { any: 'Any relevant sector', import_export: 'Import/export and trading', logistics: 'International logistics and transport', industry_export: 'Manufacturers with export activity', cosmetics_food: 'Cosmetics, perfume, food and wine exporters', institutions: 'Chambers of commerce and export support', services: 'International services' };

function oppCard(o) {
  const app = S.apps.find((a) => a.oppId === o.id && a.status !== 'withdrawn');
  const best = bestContact(o);
  const pub = o.kind === 'published';
  return html`<article class="opp">
    <div class="opp-head"><div><h3>${o.name}</h3><div class="where">${[o.city, AREA[o.area], o.industry].filter(Boolean).join(' · ')}</div></div>
      <div class="tags">${pub ? html`<span class="tag solid">Published internship</span>` : html`<span class="tag">Spontaneous application</span>`}${o.fit ? html`<span class="tag ai">${FIT[o.fit]}</span>` : ''}</div></div>
    <div class="opp-body"><div>
      <dl class="kv"><dt>Organization <span class="tag ai">AI summary of its website</span></dt><dd>${o.description || html`<span class="muted">No description.</span>`}</dd></dl>
      <dl class="kv"><dt>Potential internship ${pub ? html`<span class="tag verified">From the published offer</span>` : html`<span class="tag ai">AI suggestion</span>`}</dt><dd class="position">${o.position || '—'}</dd></dl>
      ${(o.responsibilities || []).length ? html`<dl class="kv"><dt>Possible responsibilities <span class="tag ai">AI suggestion</span></dt><dd><ul>${o.responsibilities.map((x) => html`<li>${x}</li>`)}</ul></dd></dl>` : ''}
      ${(o.matchReasons || []).length ? html`<dl class="kv"><dt>Why it matches your profile <span class="tag ai">AI suggestion</span></dt><dd><ul>${o.matchReasons.map((x) => html`<li>${x}</li>`)}</ul></dd></dl>` : ''}
    </div><div>
      <dl class="kv"><dt>Website ${o.websiteCheckedAt ? html`<span class="tag verified">Checked ${fmtDate(o.websiteCheckedAt)}</span>` : ''}</dt><dd class="break"><a href="${o.website}" target="_blank" rel="noopener noreferrer">${hostOf(o.website)}</a></dd></dl>
      <dl class="kv"><dt>Contact email ${best ? html`<span class="tag verified">Verified</span>` : ''}</dt><dd class="break">${best ? html`<span class="break">${best.email}</span><div class="xs muted">Found on <a href="${best.evidenceUrl}" target="_blank" rel="noopener noreferrer">${best.evidenceUrl}</a></div>` : html`<span class="muted">No verified address yet</span>`}</dd></dl>
      ${pub ? html`<dl class="kv"><dt>Internship offer <span class="tag verified">Page checked</span></dt><dd class="break"><a href="${o.listingUrl}" target="_blank" rel="noopener noreferrer">${o.listingUrl}</a></dd></dl>` : ''}
      <dl class="kv"><dt>Sources</dt><dd class="small break">${(o.sources || []).slice(0, 3).map((u) => html`<div><a href="${u}" target="_blank" rel="noopener noreferrer">${hostOf(u)}</a></div>`)}${o.locationEvidence ? html`<div class="xs muted">Location: ${o.locationEvidence}</div>` : ''}</dd></dl>
      ${(o.concerns || []).length ? html`<dl class="kv"><dt>Points to consider <span class="tag ai">AI suggestion</span></dt><dd><ul class="small">${o.concerns.map((x) => html`<li>${x}</li>`)}</ul></dd></dl>` : ''}
      ${o.handbookNotes ? html`<dl class="kv"><dt>Handbook check <span class="tag ai">AI suggestion</span></dt><dd class="small">${o.handbookNotes}</dd></dl>` : ''}
    </div></div>
    <div class="opp-actions">
      ${app ? html`<a class="btn primary" href="#app-${app.id}">Open application</a>` : html`<button class="btn primary" data-act="decide" data-id="${o.id}" data-v="interested">Interested</button>`}
      ${o.status !== 'saved' ? html`<button class="btn" data-act="decide" data-id="${o.id}" data-v="saved">Save for later</button>` : ''}
      ${o.status !== 'not_interested' ? html`<button class="btn ghost" data-act="decide" data-id="${o.id}" data-v="not_interested">Not interested</button>` : html`<button class="btn ghost" data-act="decide" data-id="${o.id}" data-v="new">Move back to new</button>`}
      <span class="xs muted">Nobody is contacted at this stage.</span>
    </div></article>`;
}

function viewDiscover() {
  const tab = S.ui.discoverTab; const area = S.ui.area;
  const tabs = [['new', 'New'], ['saved', 'Saved for later'], ['interested', 'Interested'], ['not_interested', 'Not interested'], ['all', 'All']];
  const fitRank = { strong: 0, possible: 1, weak: 2 };
  const list = S.opps.filter((o) => (tab === 'all' || o.status === tab) && (!area || o.area === area)).sort((a, b) => (fitRank[a.fit] ?? 3) - (fitRank[b.fit] ?? 3) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const reqs = S.requests.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5);
  return html`
  <div class="page-head"><div><div class="eyebrow">Discover</div><h1>Organizations to consider</h1>
    <p class="lede">The research agent searches the web, then keeps an organization only if its website was really fetched, and an email only if it appears on the organization's own pages. Anything written by the AI is marked as a suggestion.</p></div></div>
  <form class="panel stack" data-form="request">
    <h3>Ask for a new search</h3>
    <div class="grid-2">
      <div class="field"><label class="lbl" for="rq-area">Area</label><select id="rq-area" name="area"><option value="orleans">Orléans and surroundings</option><option value="paris">Paris and Île-de-France</option></select></div>
      <div class="field"><label class="lbl" for="rq-sector">Focus</label><select id="rq-sector" name="sector">${Object.entries(SECTORS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
      <div class="field"><label class="lbl" for="rq-site">Or an organization you know (website)</label><input id="rq-site" name="website" type="url" placeholder="https://www.example.fr"></div>
      <div class="field"><label class="lbl" for="rq-note">Note for the agent (optional)</label><input id="rq-note" name="note" type="text" placeholder="e.g. companies exporting to Spain"></div>
    </div>
    <div class="row"><button class="btn primary" type="submit">Add to the agent's list</button><span class="xs muted">The agent runs from your Claude chat; results appear here once verified.</span></div>
    ${reqs.length ? html`<ul class="list small">${reqs.map((q) => html`<li><span class="break">${q.website ? `Check ${q.website}` : `${AREA[q.area] || q.area} · ${SECTORS[q.sector] || q.sector}`}${q.note ? ` · ${q.note}` : ''}${q.result ? html`<div class="xs muted">${q.result}</div>` : ''}</span><span class="meta">${q.status === 'pending' ? 'Waiting' : q.status === 'done' ? 'Done' : q.status}</span></li>`)}</ul>` : ''}
  </form>
  <div class="section">
    <div class="tabs">${tabs.map(([k, l]) => html`<button data-act="dtab" data-v="${k}" class="${tab === k ? 'active' : ''}">${l}${k !== 'all' ? ` ${S.opps.filter((o) => o.status === k).length || ''}` : ''}</button>`)}</div>
    <div class="section-head"><div class="chips">${[['', 'Both areas'], ['orleans', 'Orléans'], ['paris', 'Paris']].map(([k, l]) => html`<button class="chip ${area === k ? 'active' : ''}" data-act="area" data-v="${k}">${l}</button>`)}</div>
      <div class="row xs muted"><span class="tag verified">Verified</span>checked on the website<span class="tag ai">AI suggestion</span>for you to judge</div></div>
    ${list.length ? html`<div class="opps">${list.map(oppCard)}</div>` : html`<div class="empty"><div class="serif">Nothing here yet</div>${tab === 'new' ? 'Verified organizations will appear here after the research agent runs.' : 'No organizations with this status.'}</div>`}
  </div>`;
}

function viewApplications() {
  const groups = [['In preparation', ['draft', 'awaiting_approval', 'unknown']], ['Sent', ['sent', 'follow_up']], ['Interviews', ['interview']], ['Closed', ['accepted', 'rejected']]];
  const apps = S.apps.filter((a) => a.status !== 'withdrawn').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return html`<div class="page-head"><div><div class="eyebrow">Applications</div><h1>Applications</h1><p class="lede">Each application keeps its documents, the exact files sent, and everything that happened afterwards.</p></div></div>
  ${apps.length ? '' : html`<div class="empty"><div class="serif">No applications yet</div>Choose <em>Interested</em> on an organization in <a href="#discover">Discover</a>.</div>`}
  ${groups.map(([t, sts]) => { const rows = apps.filter((a) => sts.includes(a.status)); return rows.length ? html`<div class="section"><h2>${t}</h2><ul class="list section">${rows.map((a) => html`<li><a class="row-link" href="#app-${a.id}"><div class="title">${a.orgName}</div><div class="small muted break">${a.position || (a.kind === 'published' ? 'Published internship' : 'Spontaneous application')}${a.city ? ` · ${a.city}` : ''}${a.contact ? ` · ${a.contact.email}` : ''}</div></a><span class="meta">${pill(S.busy[a.id] ? 'draft' : a.status)}<br><span class="xs">${a.sent ? `Sent ${fmtDate(a.sent.sentAt)}` : `Updated ${fmtDate(a.updatedAt)}`}</span></span></li>`)}</ul></div>` : ''; })}`;
}

// ----- application workspace -----
function steps(a) {
  const idx = POST_SEND.includes(a.status) ? 4 : a.status === 'awaiting_approval' || a.status === 'unknown' ? 2 : a.cv ? 1 : 0;
  return html`<div class="steps">${['Documents written', 'Reviewed & approved', 'Final approval & send', 'Archived'].map((l, i) => html`<div class="step ${i < idx ? 'done' : i === idx ? 'current' : ''}"><span class="num">${i < idx ? '✓' : i + 1}</span>${l}</div>`)}</div>`;
}
function reviewPanel(a) {
  const r = a.review;
  if (!r) return html`<div class="notice warn small">These documents were not fact-checked automatically. Read them carefully before approving.</div>`;
  return html`<div class="stack">
    ${(r.unsupported || []).length ? html`<div class="notice danger"><strong>Statements the fact-check could not match to your profile</strong><ul>${r.unsupported.map((c) => html`<li><span class="quote">${c.excerpt}</span>${c.problem} <span class="tag">${c.severity}</span></li>`)}</ul></div>` : html`<div class="notice small">Fact-check: every statement about you matched your profile.${r.regenerated ? ' A first draft was corrected automatically.' : ''}</div>`}
    ${(r.orgClaims || []).length ? html`<div class="notice warn"><strong>About the organization, not found in its pages</strong><ul>${r.orgClaims.map((c) => html`<li>${c}</li>`)}</ul></div>` : ''}
    ${(r.local || []).length ? html`<div class="notice warn"><strong>Style and consistency</strong><ul>${r.local.map((c) => html`<li>${c}</li>`)}</ul></div>` : ''}
    ${(r.style || []).length ? html`<div class="notice warn"><strong>Style remarks</strong><ul>${r.style.map((c) => html`<li>${c}</li>`)}</ul></div>` : ''}
    ${(r.notes || []).length ? html`<div class="notice"><strong>Questions for you</strong> (answer them in your profile to improve the next version)<ul>${r.notes.map((c) => html`<li>${c}</li>`)}</ul></div>` : ''}
  </div>`;
}
function cvEditor(a, editable) {
  const p = S.profile; const cv = a.cv;
  const ord = cv.experience_order || [];
  const order = [...ord.filter((id) => p.experiences.some((e) => e.id === id)), ...p.experiences.map((e) => e.id).filter((id) => !ord.includes(id))];
  const sel = Object.fromEntries((cv.experiences || []).map((e) => [e.id, e]));
  const dis = editable ? '' : 'disabled';
  return html`<form data-form="cv" class="stack">
    <div class="notice small">Facts (experiences, dates, languages, skills) always come from your <a href="#profile">profile</a>. Here you choose what to emphasise for this organization.</div>
    <div class="field"><label class="lbl" for="cv-head">Headline</label><input id="cv-head" name="headline" type="text" value="${cv.headline || ''}" ${dis} data-dirty></div>
    <div class="field"><label class="lbl" for="cv-prof">Profile paragraph</label><textarea id="cv-prof" name="profile" class="tall serif" ${dis} data-dirty>${cv.profile || ''}</textarea></div>
    <div class="field"><span class="lbl">Experiences (order and content)</span><div id="exps" class="stack">${order.map((id) => {
      const e = p.experiences.find((x) => x.id === id); const s = sel[id];
      const inc = s ? s.include !== false : true; const idx = s?.bullet_indices?.length ? s.bullet_indices : e.bullets.map((_, i) => i);
      return html`<div class="exp ${inc ? '' : 'off'}" data-exp="${id}"><div class="exp-head"><label class="check"><input type="checkbox" name="inc_${id}" ${inc ? 'checked' : ''} ${dis} data-dirty data-act-change="toggle-exp"><span><b>${e.title}</b><div class="xs muted">${e.organization}${e.dates ? ` · ${e.dates}` : ''}</div></span></label>
        ${editable ? html`<div class="order"><button type="button" data-act="up" aria-label="Move up">↑</button><button type="button" data-act="down" aria-label="Move down">↓</button></div>` : ''}</div>
        <div class="bullets">${e.bullets.map((b, i) => html`<label class="check small"><input type="checkbox" name="b_${id}_${i}" ${idx.includes(i) ? 'checked' : ''} ${dis} data-dirty><span>${b}</span></label>`)}</div></div>`;
    })}</div></div>
    <div class="field"><span class="lbl">Courses to highlight</span><div class="stack">${p.education.flatMap((e) => e.courses || []).map((c) => html`<label class="check"><input type="checkbox" name="course" value="${c}" ${(cv.course_highlights || []).includes(c) ? 'checked' : ''} ${dis} data-dirty><span>${c}</span></label>`)}</div></div>
    ${editable ? html`<div class="row"><button class="btn primary" type="submit">Save CV</button><button type="button" class="btn ghost" data-act="pdf" data-v="cv">Download PDF</button></div>` : ''}
  </form>`;
}
function letterEditor(a, editable) {
  const l = a.letter; const dis = editable ? '' : 'disabled';
  return html`<form data-form="letter" class="stack">
    <div class="field"><label class="lbl" for="lt-subj">Subject line (Objet)</label><input id="lt-subj" name="subject_line" type="text" value="${l.subject_line}" ${dis} data-dirty></div>
    <div class="field"><label class="lbl" for="lt-rec">Department line under the organization name (optional)</label><input id="lt-rec" name="recipient_line" type="text" value="${l.recipient_line || ''}" ${dis} data-dirty></div>
    <div class="field"><label class="lbl" for="lt-sal">Salutation</label><input id="lt-sal" name="salutation" type="text" value="${l.salutation}" ${dis} data-dirty></div>
    <div class="field"><span class="lbl">Paragraphs</span><div id="paras" class="stack">${l.paragraphs.map((x, i) => html`<div class="row"><textarea id="lt-p${i}" name="paragraph" class="tall serif" ${dis} data-dirty>${x}</textarea>${editable ? html`<button type="button" class="btn small ghost" data-act="rm-para" aria-label="Remove paragraph">Remove</button>` : ''}</div>`)}</div>
      ${editable ? html`<div><button type="button" class="btn small ghost" data-act="add-para">+ Add a paragraph</button></div>` : ''}</div>
    <div class="field"><label class="lbl" for="lt-close">Closing</label><textarea id="lt-close" name="closing" class="serif" ${dis} data-dirty>${l.closing}</textarea></div>
    <p class="xs muted">${words(l.paragraphs.join(' '))} words in the body.</p>
    ${editable ? html`<div class="row"><button class="btn primary" type="submit">Save letter</button><button type="button" class="btn ghost" data-act="pdf" data-v="letter">Download PDF</button></div>` : ''}
  </form>`;
}
function emailEditor(a, editable) {
  const opp = oppById(a.oppId); const dis = editable ? '' : 'disabled';
  const contacts = opp?.contacts || [];
  return html`<div class="split"><form data-form="email" class="stack">
    <div class="field"><label class="lbl" for="em-to">Recipient</label>
      ${contacts.length ? html`<select id="em-to" name="to" ${dis} data-dirty><option value="">Choose a verified address</option>${contacts.map((c) => html`<option value="${c.email}" ${c.email === a.contact?.email ? 'selected' : ''} ${c.status === 'verified' ? '' : 'disabled'}>${c.email}${c.status === 'verified' ? '' : ' (not verified)'}</option>`)}</select>` : html`<div class="notice warn small">No verified address for this organization yet.</div>`}
      ${a.contact ? html`<div class="hint break">${verifiedFor(a) ? '✓ ' : ''}${a.contact.detail || ''}</div>` : ''}</div>
    <div class="field"><label class="lbl" for="em-subj">Email subject</label><input id="em-subj" name="subject" type="text" value="${a.emailSubject || ''}" ${dis} data-dirty></div>
    <div class="field"><label class="lbl" for="em-body">Email body</label><textarea id="em-body" name="body" class="tall serif" ${dis} data-dirty>${a.emailBody || ''}</textarea></div>
    <div class="field"><span class="lbl">Attachments</span><div class="small">${fileNames(a).cv} · ${fileNames(a).letter}</div></div>
    ${editable ? html`<div><button class="btn primary" type="submit">Save email</button></div>` : ''}
  </form>
  ${editable ? html`<form class="panel stack" data-form="contact"><h3>Know a better address?</h3>
    <p class="small muted">Add it with the page of their website where it appears. The research agent checks that page; the address can be used once it is verified.</p>
    <input name="email" type="email" placeholder="stage@organization.fr" required aria-label="Email address">
    <input name="evidence" type="url" placeholder="${a.website}" required aria-label="Page showing the address">
    <div><button class="btn small" type="submit">Ask the agent to verify it</button></div></form>` : html`<div></div>`}</div>`;
}
function sendTab(a) {
  if (a.status === 'unknown') {
    return html`<div class="notice warn"><strong>Gmail did not confirm whether this email left.</strong> Before sending again, check your Sent folder: if the email is there, it is recorded as sent; if not, you can send it again.</div>
      <div class="section row"><button class="btn primary" data-act="check-sent">Check Gmail Sent folder</button></div>`;
  }
  if (a.status === 'draft') {
    return html`<h2>Review before approval</h2><div class="section">${reviewPanel(a)}</div>
    <div class="section grid-2">
      <div class="panel stack"><h3>Approve the documents</h3><p class="small muted">Approving locks this version. Any later edit withdraws the approval. Sending still needs a separate final confirmation.</p>
        <div><button class="btn primary" data-act="approve">Approve CV, letter and email</button></div></div>
      <form class="panel stack" data-form="regen"><h3>Write a new version</h3>
        <div class="field"><label class="lbl" for="rg-lang">Letter and email language</label><select id="rg-lang" name="language"><option value="fr" ${a.language === 'fr' ? 'selected' : ''}>French</option><option value="en" ${a.language === 'en' ? 'selected' : ''}>English</option></select></div>
        <div class="field"><label class="lbl" for="rg-ins">Instructions (optional)</label><textarea id="rg-ins" name="instructions" placeholder="e.g. mention their Spanish-speaking markets; shorter second paragraph"></textarea></div>
        <div><button class="btn" type="submit" ${C.sample ? '' : 'disabled'}>Regenerate</button></div><div class="hint">The current version stays in Documents.</div></form>
    </div>`;
  }
  const p = S.profile; const names = fileNames(a);
  const gmailOk = Boolean(C.mcp);
  return html`<h2>Final approval</h2><p class="lede">This is exactly what will be sent from your Gmail. Nothing leaves until you confirm below.</p>
  <table class="summary section">
    <tr><th>Organization</th><td>${a.orgName}<div class="xs"><a href="${a.website}" target="_blank" rel="noopener noreferrer">${a.website}</a></div></td></tr>
    <tr><th>Recipient</th><td>${a.contact.email} <span class="tag verified">Verified</span><div class="xs muted">${a.contact.detail || ''}</div></td></tr>
    <tr><th>Position</th><td>${a.position || '—'} <span class="small muted">(${a.kind === 'published' ? 'published offer' : 'spontaneous application'})</span></td></tr>
    <tr><th>From</th><td>Your Gmail account (through your Claude Gmail connector)</td></tr>
    <tr><th>Subject</th><td>${a.emailSubject}</td></tr>
    <tr><th>Message</th><td><div class="email-body">${a.emailBody}</div></td></tr>
    <tr><th>Attachments</th><td>${names.cv} · ${names.letter}</td></tr>
  </table>
  <div class="section grid-2"><div class="stack"><div class="eyebrow">Complete CV</div>${cvPaper(p, a.cv)}</div><div class="stack"><div class="eyebrow">Complete cover letter</div>${letterPaper(p, a, a.letter)}</div></div>
  <div class="section">${reviewPanel(a)}</div>
  ${(a.failedAttempts || []).length ? html`<div class="section notice warn small"><strong>Earlier attempts that did not send:</strong><ul>${a.failedAttempts.map((f) => html`<li>${fmtDate(f.at, true)}: ${f.error}</li>`)}</ul></div>` : ''}
  <div class="section final stack">
    ${gmailOk ? html`<label class="check"><input type="checkbox" id="confirm-send" data-act-change="confirm"><span>I have read the CV, the cover letter and the email above, and I want this application sent to <strong>${a.contact.email}</strong> now.</span></label>
      <div class="row"><button class="btn primary" id="send-btn" data-act="send" disabled>Send application</button><button class="btn ghost" data-act="revoke">Withdraw approval and edit</button></div>`
    : html`<div class="notice warn"><strong>Ready, but it cannot be sent from this view.</strong> Gmail is reached through your Claude connectors; open this page on claude.ai, signed in, with Gmail connected.</div><div><button class="btn ghost" data-act="revoke">Withdraw approval and edit</button></div>`}
  </div>`;
}
function recordTab(a) {
  const s = a.sent;
  const replies = S.ui.replies[a.id];
  const docRow = (d, label) => html`<div class="doc-row"><div class="break"><div>${d.filename}</div><div class="xs muted">${label} · ${(d.size / 1024).toFixed(0)} KB · <span class="mono" title="SHA-256">${d.sha256.slice(0, 16)}…</span></div></div>
    <div class="row"><a class="btn small" href="${blobUrl(d)}" target="_blank" rel="noopener">Open</a><button class="btn small ghost" data-act="verify-doc" data-v="${blobUrl(d)}" data-sha="${d.sha256}">Check integrity</button></div></div>`;
  return html`<div class="split"><div>
    <h2>Sent application</h2>
    <table class="summary section">
      <tr><th>Sent</th><td>${fmtDate(s.sentAt, true)} from your Gmail${s.confirmedVia ? ` (confirmed via ${s.confirmedVia})` : ''}</td></tr>
      <tr><th>To</th><td>${s.to}</td></tr>
      <tr><th>Organization</th><td>${a.orgName}<div class="xs"><a href="${a.website}" target="_blank" rel="noopener noreferrer">${a.website}</a></div></td></tr>
      <tr><th>Position</th><td>${a.position || '—'}${a.city ? ` · ${a.city}` : ''}</td></tr>
      <tr><th>Subject</th><td>${s.subject}</td></tr>
      <tr><th>Message</th><td><div class="email-body">${s.body}</div></td></tr>
      <tr><th>Gmail ID</th><td class="mono">${s.gmailId}</td></tr>
    </table>
    <div class="section"><div class="eyebrow">Exact documents sent</div>${docRow(s.cv, 'CV')}${docRow(s.letter, 'Cover letter')}</div>
  </div><div>
    <h2>Follow-up</h2>
    <form class="section row" data-form="status"><select name="status" aria-label="Status">${POST_SEND.map((k) => html`<option value="${k}" ${a.status === k ? 'selected' : ''}>${STATUS[k]}</option>`)}</select><button class="btn small" type="submit">Update status</button></form>
    <div class="section panel stack"><h3>Replies in Gmail</h3>
      <div><button class="btn small" data-act="replies" ${C.mcp ? '' : 'disabled'}>Check for replies from ${s.to.split('@')[1]}</button></div>
      ${replies ? (replies.length ? html`<ul class="list small">${replies.map((t) => html`<li><div class="break"><b>${t.subject || '(no subject)'}</b><div class="muted">${t.sender} · ${t.date ? fmtDate(t.date) : ''}</div><div>${t.snippet}</div>${t.url ? html`<a class="xs" href="${t.url}" target="_blank" rel="noopener noreferrer">Open in Gmail</a>` : ''}</div><button class="btn small" data-act="record-reply" data-v="${t.threadId}">Record as response</button></li>`)}</ul>` : html`<p class="small muted">No email from ${s.to.split('@')[1]} since you sent the application.</p>`) : ''}
    </div>
    <form class="section panel stack" data-form="event"><h3>Record something</h3>
      <div class="grid-2"><div class="field"><label class="lbl" for="ev-type">Type</label><select id="ev-type" name="type"><option value="response">Response received</option><option value="follow_up">Follow-up sent</option><option value="interview">Interview</option><option value="note">Note</option></select></div>
      <div class="field"><label class="lbl" for="ev-date">Date</label><input id="ev-date" type="date" name="date" value="${nowIso().slice(0, 10)}"></div></div>
      <div class="field"><label class="lbl" for="ev-content">Details</label><textarea id="ev-content" name="content" required></textarea></div>
      <div><button class="btn small primary" type="submit">Save</button></div></form>
    <ul class="timeline section">${(a.events || []).slice().reverse().map((e) => html`<li><div class="when">${fmtDate(e.date)} · ${{ response: 'Response', follow_up: 'Follow-up', interview: 'Interview', note: 'Note', status: 'Status' }[e.type] || e.type}</div><div class="break">${e.content}</div></li>`)}</ul>
  </div></div>`;
}
function viewApp(id) {
  const a = appById(id);
  if (!a) return html`<div class="notice warn">This application was not found. <a href="#applications">Back to applications</a></div>`;
  const editable = ['draft', 'awaiting_approval'].includes(a.status) && !S.busy[id];
  const archived = POST_SEND.includes(a.status);
  const tabs = archived ? [['record', 'Record'], ['versions', 'Draft versions']] : [['cv', 'CV'], ['letter', 'Cover letter'], ['email', 'Email & recipient'], ['send', a.status === 'awaiting_approval' ? 'Final approval' : a.status === 'unknown' ? 'Sending status' : 'Review & approve'], ['versions', 'Versions']];
  let tab = S.ui.appTab[id] || (archived ? 'record' : ['awaiting_approval', 'unknown'].includes(a.status) ? 'send' : 'cv');
  if (!tabs.some((t) => t[0] === tab)) tab = tabs[0][0];
  let body;
  if (S.busy[id]) body = html`<div class="progress"><span class="spinner"></span>${S.busy[id]} This usually takes one to three minutes. Keep this page open.</div>`;
  else if (!a.cv && !archived) body = html`${a.generationError ? html`<div class="notice danger"><strong>Writing failed.</strong> ${a.generationError}</div>` : ''}<div class="empty section"><div class="serif">No documents yet</div><p>Claude writes a CV and a cover letter for ${a.orgName}, using only your profile.</p><button class="btn primary" data-act="generate" ${C.sample ? '' : 'disabled'}>Write the documents</button>${C.sample ? '' : html`<p class="xs">Writing with Claude is not available in this view.</p>`}</div>`;
  else if (tab === 'cv') body = html`<div class="split">${cvEditor(a, editable)}<div class="stack"><div class="eyebrow">Preview</div>${cvPaper(S.profile, a.cv)}</div></div>`;
  else if (tab === 'letter') body = html`<div class="split">${letterEditor(a, editable)}<div class="stack"><div class="eyebrow">Preview</div>${letterPaper(S.profile, a, a.letter)}</div></div>`;
  else if (tab === 'email') body = emailEditor(a, editable);
  else if (tab === 'send') body = sendTab(a);
  else if (tab === 'record') body = recordTab(a);
  else if (tab === 'versions') { const vs = S.drafts.filter((d) => d.appId === id).sort((x, y) => y.n - x.n); body = html`<h2>Versions</h2><p class="lede">Every generated and edited version is kept.</p><ul class="list section">${vs.map((v) => html`<li><div>Version ${v.n} <span class="tag ${v.source === 'ai' ? 'ai' : ''}">${v.source === 'ai' ? 'Written by Claude' : 'Your edit'}</span><div class="xs muted">${fmtDate(v.createdAt, true)}</div></div><span class="row"><button class="btn small ghost" data-act="ver-pdf" data-v="${v.id}" data-w="cv">CV PDF</button><button class="btn small ghost" data-act="ver-pdf" data-v="${v.id}" data-w="letter">Letter PDF</button>${editable ? html`<button class="btn small" data-act="restore" data-v="${v.id}">Restore</button>` : ''}</span></li>`)}</ul>`; }
  const confirmDiscard = S.ui.confirm === `discard-${id}`;
  return html`<div class="page-head"><div><div class="eyebrow"><a href="#applications">Applications</a></div><h1>${a.orgName}</h1>
    <p class="lede break">${[a.position, a.city].filter(Boolean).join(' · ')} · <a href="${a.website}" target="_blank" rel="noopener noreferrer">${hostOf(a.website)}</a></p></div>
    <div class="row">${pill(S.busy[id] ? 'draft' : a.status)}${['draft', 'awaiting_approval'].includes(a.status) && !confirmDiscard ? html`<button class="btn small ghost danger" data-act="discard">Discard</button>` : ''}</div></div>
    ${confirmDiscard ? html`<div class="inline-confirm">Discard this unsent application? Its versions stay in Documents.<button class="btn small danger" data-act="discard-yes">Discard</button><button class="btn small ghost" data-act="cancel-confirm">Keep it</button></div>` : ''}
    ${steps(a)}
    ${!S.busy[id] && (a.cv || archived) ? html`<div class="tabs">${tabs.map(([k, l]) => html`<button data-act="atab" data-v="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)}</div>` : ''}
    ${a.status === 'awaiting_approval' && tab !== 'send' ? html`<div class="notice small">Approved ${fmtDate(a.approvedAt, true)}. Saving an edit withdraws the approval.</div><div class="section"></div>` : ''}
    ${body}`;
}

function viewLibrary() {
  const sent = S.apps.filter((a) => a.sent).sort((a, b) => String(b.sent.sentAt).localeCompare(String(a.sent.sentAt)));
  const vs = S.drafts.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 80);
  const orig = S.library?.items || [];
  return html`<div class="page-head"><div><div class="eyebrow">Documents</div><h1>Document library</h1><p class="lede">Your original files, every document sent (kept exactly as sent), and every draft version.</p></div></div>
  <div class="section"><h2>Original files</h2><div class="section">${orig.map((d) => html`<div class="doc-row"><div class="break"><div>${d.label}</div><div class="xs muted">${d.filename}</div></div><a class="btn small" href="${blobUrl(d)}" target="_blank" rel="noopener">Open</a></div>`)}
    <div class="doc-row"><div><div>Base CV from your current profile</div><div class="xs muted">Generated from your profile facts, without tailoring</div></div><button class="btn small" data-act="base-cv">Download PDF</button></div></div></div>
  <div class="section"><h2>Sent documents</h2><p class="small muted">The exact PDFs attached to each email, with their SHA-256 fingerprint. Editing your profile later never changes them.</p>
    ${sent.length ? sent.map((a) => html`<div class="section"><div class="section-head"><h3><a href="#app-${a.id}">${a.orgName}</a></h3><span class="small muted">${a.sent.to} · ${fmtDate(a.sent.sentAt)}</span></div>
      ${[a.sent.cv, a.sent.letter].map((d) => html`<div class="doc-row"><div class="break"><div>${d.filename}</div><div class="xs muted mono">${d.sha256.slice(0, 20)}…</div></div><a class="btn small" href="${blobUrl(d)}" target="_blank" rel="noopener">Open</a></div>`)}</div>`) : html`<div class="empty section">Nothing sent yet.</div>`}</div>
  <div class="section"><h2>Draft versions</h2>${vs.length ? html`<ul class="list section">${vs.map((v) => html`<li><div><a href="#app-${v.appId}">${v.orgName}</a> · version ${v.n} <span class="tag ${v.source === 'ai' ? 'ai' : ''}">${v.source === 'ai' ? 'Claude' : 'your edit'}</span><div class="xs muted">${fmtDate(v.createdAt, true)}</div></div><span class="row"><button class="btn small ghost" data-act="ver-pdf" data-v="${v.id}" data-w="cv">CV</button><button class="btn small ghost" data-act="ver-pdf" data-v="${v.id}" data-w="letter">Letter</button></span></li>`)}</ul>` : html`<p class="muted">No drafts yet.</p>`}</div>`;
}

function viewActivity() {
  const f = S.ui.actFilter;
  const types = [['', 'All'], ['search', 'Searches'], ['discover', 'Discoveries'], ['decision', 'Decisions'], ['generate', 'Generated'], ['edit', 'Edits'], ['approve', 'Approvals'], ['send', 'Sent'], ['archive', 'Follow-up'], ['profile', 'Profile'], ['error', 'Problems']];
  const items = S.activity.filter((a) => !f || a.type === f);
  const days = new Map();
  for (const a of items) { const k = new Date(a.ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); if (!days.has(k)) days.set(k, []); days.get(k).push(a); }
  return html`<div class="page-head"><div><div class="eyebrow">Activity</div><h1>What the agent has done</h1><p class="lede">Searches, discoveries, documents written, approvals and emails sent, in order.</p></div></div>
  <div class="chips">${types.map(([k, l]) => html`<button class="chip ${f === k ? 'active' : ''}" data-act="afilter" data-v="${k}">${l}</button>`)}</div>
  ${items.length ? [...days.entries()].map(([d, l]) => html`<div class="day"><h3>${d}</h3>${l.map((a) => html`<div class="act"><span class="xs muted">${new Date(a.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span><span class="type ${a.type}">${a.type}</span><span class="msg break">${a.ref?.app ? html`<a href="#app-${a.ref.app}">${a.message}</a>` : a.message}</span></div>`)}</div>`) : html`<div class="empty section">Nothing recorded yet.</div>`}`;
}

const PF = {
  languages: [['name', 'Language'], ['level', 'Level (as written)']],
  education: [['title', 'Degree'], ['institution', 'Institution'], ['dates', 'Dates'], ['courses', 'Courses (one per line)', 'lines']],
  experiences: [['title', 'Role'], ['organization', 'Organization'], ['dates', 'Dates'], ['summary', 'Short description (optional)', 'area'], ['bullets', 'What you did (one per line)', 'lines']],
  skills: [['label', 'Group'], ['value', 'Content', 'area']],
};
function block(list, o) {
  return html`<div class="exp" data-list="${list}" data-id="${o.id || uid()}"><div class="exp-head"><span></span><button type="button" class="btn small ghost danger" data-act="rm-block">Remove</button></div>
    <div class="grid-2">${PF[list].map(([k, l, t]) => html`<div class="field"><label class="lbl">${l}</label>${t ? html`<textarea data-k="${k}" data-t="${t}" data-dirty>${t === 'lines' ? (o[k] || []).join('\n') : o[k] || ''}</textarea>` : html`<input type="text" data-k="${k}" value="${o[k] || ''}" data-dirty>`}</div>`)}</div></div>`;
}
function viewProfile() {
  const p = S.profile; const tab = S.ui.profileTab;
  const tabs = [['facts', 'Confirmed facts'], ['transferable', 'Transferable skills'], ['questions', 'Open questions'], ['handbook', 'University handbook']];
  let body;
  if (tab === 'facts') body = html`<form data-form="facts" class="stack">
    <div class="notice small">These facts are the only things the agent may say about you. Documents already sent keep the version they were written from.</div>
    <h2 class="section">Identity</h2><div class="grid-2">${[['full_name', 'Full name'], ['headline', 'Default headline'], ['email', 'Email'], ['phone', 'Phone'], ['city', 'City']].map(([k, l]) => html`<div class="field"><label class="lbl" for="id-${k}">${l}</label><input id="id-${k}" type="text" name="id_${k}" value="${p.identity[k] || ''}" data-dirty></div>`)}</div>
    <h2 class="section">Internship sought</h2><div class="grid-2"><div class="field"><label class="lbl" for="in-dur">Duration</label><input id="in-dur" type="text" name="duration" value="${p.internship.duration}" data-dirty></div><div class="field"><label class="lbl" for="in-per">Period</label><input id="in-per" type="text" name="period" value="${p.internship.period}" data-dirty></div></div>
    <div class="field"><label class="lbl" for="in-prof">Default CV profile paragraph</label><textarea id="in-prof" name="cv_profile_text" class="serif tall" data-dirty>${p.internship.cv_profile_text}</textarea></div>
    ${['languages', 'education', 'experiences', 'skills'].map((l) => html`<h2 class="section">${{ languages: 'Languages', education: 'Education', experiences: 'Experience', skills: 'Skills' }[l]}</h2><div class="stack" id="list-${l}">${p[l].map((o) => block(l, o))}</div><div><button type="button" class="btn small ghost" data-act="add-block" data-v="${l}">+ Add</button></div>`)}
    <h2 class="section">Interests</h2><textarea name="interests" aria-label="Interests" data-dirty>${p.interests || ''}</textarea>
    <div class="panel section stack"><div class="field"><label class="lbl" for="pf-note">What changed</label><input id="pf-note" name="note" type="text" placeholder="e.g. added TOEIC score"></div><div><button class="btn primary" type="submit">Save profile</button></div></div></form>`;
  else if (tab === 'transferable') body = html`<p class="lede">Skills that can reasonably be inferred from your experience. They are used <strong>only once you confirm them</strong>.</p>
    <form data-form="transferable" class="section stack">${p.transferable.map((t) => html`<div class="exp" data-tid="${t.id}"><div class="exp-head"><div><div class="serif">${t.text}</div><div class="xs muted">Based on: ${t.basis}</div></div>
      <select aria-label="Decision" data-dirty>${[['suggested', 'To decide'], ['confirmed', 'Confirmed – use it'], ['rejected', 'Rejected – never use']].map(([k, l]) => html`<option value="${k}" ${t.status === k ? 'selected' : ''}>${l}</option>`)}</select></div></div>`)}
      <div class="panel grid-2"><div class="field"><label class="lbl" for="tr-new">Add a skill in your own words</label><input id="tr-new" name="text" type="text" data-dirty></div><div class="field"><label class="lbl" for="tr-basis">Based on</label><input id="tr-basis" name="basis" type="text" data-dirty></div></div>
      <div><button class="btn primary" type="submit">Save</button></div></form>`;
  else if (tab === 'questions') body = html`<p class="lede">Information the agent needs and will not guess. Leave a question empty if it does not apply.</p>
    <form data-form="questions" class="section stack">${p.questions.map((q) => html`<div class="field"><label class="lbl serif" for="q-${q.id}">${q.question}</label><textarea id="q-${q.id}" data-qid="${q.id}" data-dirty>${q.answer || ''}</textarea></div>`)}<div><button class="btn primary" type="submit">Save answers</button></div></form>`;
  else {
    const h = S.handbook;
    body = h ? html`<div class="section-head"><h2>${h.title || 'Internship handbook'}</h2><span class="small muted">${h.filename}</span></div>
      ${h.academicYear && !/2026/.test(h.academicYear) ? html`<div class="notice warn">This handbook is the <strong>${h.academicYear}</strong> edition. Its dates (for example the 30 June deadline) were written for that year. Ask the internship office (stages.llsh@univ-orleans.fr) for the 2026–2027 version.</div>` : ''}
      ${h.assetId ? html`<p class="section"><a class="btn small" href="${blobUrl(h)}" target="_blank" rel="noopener">Open the handbook PDF</a></p>` : ''}
      <ul class="list section">${(h.requirements || []).map((r) => html`<li><div><span class="tag">${r.topic}</span> ${r.requirement}<div class="quote">“${r.quote}”${r.page ? ` (p. ${r.page})` : ''}</div></div></li>`)}</ul>
      <p class="xs muted">Each requirement is kept only because its quote was found word for word in the handbook.</p>`
      : html`<div class="empty">No handbook yet. Ask Claude in your chat to import it.</div>`;
  }
  return html`<div class="page-head"><div><div class="eyebrow">Profile · version ${S.profileDoc?.version || 1}</div><h1>Your knowledge base</h1><p class="lede">Everything the agent knows about you: confirmed facts, possible transferable skills, and missing information.</p></div></div>
  <div class="tabs">${tabs.map(([k, l]) => html`<button data-act="ptab" data-v="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)}</div>${body}`;
}

function viewSetup() {
  const pend = S.requests.filter((q) => q.status === 'pending').length;
  const row = (name, ok, okText, offText) => html`<div class="doc-row"><div><div><b>${name}</b></div><div class="small muted">${ok ? okText : offText}</div></div>${ok ? html`<span class="tag verified">Available</span>` : html`<span class="tag warn">Not available</span>`}</div>`;
  return html`<div class="page-head"><div><div class="eyebrow">Connections</div><h1>What this workspace uses</h1><p class="lede">Everything runs on your Claude account: no passwords or keys are stored in this page.</p></div></div>
  <div class="section">
    ${row('Your private data', Boolean(C.db), 'Profile, opportunities, applications and history are stored with this page, readable only by you.', 'Open the page on claude.ai while signed in.')}
    ${row('Writing with Claude', Boolean(C.sample), 'CVs, letters and fact-checks are written on your Claude account. The first time, claude.ai asks you to allow it.', 'Not available in this view.')}
    ${row('Gmail', Boolean(C.mcp), 'Applications are sent from your Gmail through your Claude Gmail connector, only after your final confirmation. Replies can be checked from each sent application.', 'Connect Gmail in claude.ai Settings → Connectors, then reload this page.')}
    ${row('Archive of sent files', Boolean(C.assets), 'The exact PDFs are stored with this page before each email is sent.', 'Only the page owner can archive files; sending is disabled without it.')}
    ${row('Saving files', Boolean(C.downloads), 'PDFs can be saved to your device.', 'Not available in this view.')}
  </div>
  <div class="section panel stack"><h3>Research agent</h3>
    <p class="small">Web research and verification run from your Claude chat (Claude Code), which searches the web, fetches each organization's own website and writes only verified results here. ${pend ? `${pend} request${pend > 1 ? 's are' : ' is'} waiting.` : 'No request is waiting.'}</p></div>`;
}

// ---------- events ----------
function closestAct(t) { return t.closest('[data-act]'); }
document.addEventListener('input', (e) => { if (e.target.closest('[data-dirty]') || e.target.matches('[data-dirty]')) S.dirty = true; });
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-dirty]')) S.dirty = true;
  if (t.dataset.actChange === 'confirm') document.getElementById('send-btn').disabled = !t.checked;
  if (t.dataset.actChange === 'toggle-exp') t.closest('.exp').classList.toggle('off', !t.checked);
});

async function guarded(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { console.error(e); toast(e.message || 'Something went wrong', 'error'); } finally { if (btn?.isConnected) btn.disabled = false; }
}

const curAppId = () => (route().startsWith('app-') ? route().slice(4) : null);

document.addEventListener('click', (e) => {
  const b = closestAct(e.target);
  if (!b || !main.contains(b)) return;
  const act = b.dataset.act; const v = b.dataset.v; const id = curAppId();
  const A = {
    dtab: () => { S.ui.discoverTab = v; render(); },
    area: () => { S.ui.area = v; render(); },
    afilter: () => { S.ui.actFilter = v; render(); },
    ptab: () => { if (S.dirty) { toast('Save your changes first, or reload to discard them.', 'error'); return; } S.ui.profileTab = v; render(); },
    atab: () => { if (S.dirty) { toast('Save your changes first, or reload to discard them.', 'error'); return; } S.ui.appTab[id] = v; render(); },
    decide: () => guarded(b, () => decide(b.dataset.id, v)),
    generate: () => guarded(b, () => generate(id)),
    up: () => { const n = b.closest('.exp'); if (n.previousElementSibling) n.parentNode.insertBefore(n, n.previousElementSibling); S.dirty = true; },
    down: () => { const n = b.closest('.exp'); if (n.nextElementSibling) n.parentNode.insertBefore(n.nextElementSibling, n); S.dirty = true; },
    'add-para': () => { document.getElementById('paras').insertAdjacentHTML('beforeend', html`<div class="row"><textarea id="lt-p${uid()}" name="paragraph" class="tall serif" data-dirty></textarea><button type="button" class="btn small ghost" data-act="rm-para">Remove</button></div>`.s); S.dirty = true; },
    'rm-para': () => { b.closest('.row').remove(); S.dirty = true; },
    approve: () => guarded(b, async () => { if (S.dirty) throw new Error('Save your changes first.'); await approve(id); toast('Approved. Read the final summary before sending.'); render(); }),
    revoke: () => guarded(b, async () => { await revoke(id); S.ui.appTab[id] = 'send'; render(); }),
    send: () => guarded(b, () => send(id)),
    'check-sent': () => guarded(b, () => checkSentFolder(id)),
    discard: () => { S.ui.confirm = `discard-${id}`; render(); },
    'cancel-confirm': () => { S.ui.confirm = null; render(); },
    'discard-yes': () => guarded(b, async () => { const a = appById(id); await saveApp(id, { status: 'withdrawn', approvedHash: null }); await log('decision', `Unsent application for ${a.orgName} discarded`, { app: id }); S.ui.confirm = null; go('applications'); }),
    restore: () => guarded(b, async () => { const d = S.drafts.find((x) => x.id === v); await updateDraft(id, { cv: d.cv, letter: d.letter, emailSubject: d.emailSubject, emailBody: d.emailBody }, `Version ${d.n} restored`); S.ui.appTab[id] = 'cv'; toast('Version restored'); render(); }),
    pdf: () => guarded(b, async () => { const a = appById(id); const n = fileNames(a); if (v === 'cv') await savePdf(await renderCvPdf(S.profile, a.cv), n.cv); else await savePdf(await renderLetterPdf(S.profile, a, a.letter), n.letter); }),
    'ver-pdf': () => guarded(b, async () => { const d = S.drafts.find((x) => x.id === v); const a = appById(d.appId) || { orgName: d.orgName, language: d.language, city: '' }; const n = fileNames(a); if (b.dataset.w === 'cv') await savePdf(await renderCvPdf(S.profile, d.cv), n.cv.replace('.pdf', `_v${d.n}.pdf`)); else await savePdf(await renderLetterPdf(S.profile, { ...a, language: d.language }, d.letter, d.createdAt), n.letter.replace('.pdf', `_v${d.n}.pdf`)); }),
    'base-cv': () => guarded(b, async () => savePdf(await renderCvPdf(S.profile, {}), `CV_${safeName(S.profile.identity.full_name)}.pdf`)),
    replies: () => guarded(b, async () => { await checkReplies(id); render(); }),
    'record-reply': () => guarded(b, async () => { const t = (S.ui.replies[id] || []).find((x) => x.threadId === v); await addEvent(id, { type: 'response', date: (t.date ? new Date(t.date).toISOString() : nowIso()).slice(0, 10), content: `${t.sender}: ${t.subject} – ${t.snippet}`, gmailThread: t.threadId }); toast('Recorded'); render(); }),
    'verify-doc': () => guarded(b, async () => { const r = await fetch(v); if (!r.ok) throw new Error('The archived file could not be read.'); const h = await sha256Hex(new Uint8Array(await r.arrayBuffer())); toast(h === b.dataset.sha ? 'Intact: identical to the file sent' : 'Warning: the stored file does not match the fingerprint', h === b.dataset.sha ? '' : 'error'); }),
    'add-block': () => { document.getElementById(`list-${v}`).insertAdjacentHTML('beforeend', block(v, {}).s); S.dirty = true; },
    'rm-block': () => { b.closest('[data-list]').remove(); S.dirty = true; },
  };
  if (A[act]) { e.preventDefault(); A[act](); }
});

const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
async function saveProfile(data, note) {
  const version = (S.profileDoc?.version || 1) + 1;
  await C.db.collection('profileVersions').doc(`v${version}`).set({ data, note, version, createdAt: nowIso() });
  await C.db.doc('profile/current').set({ data, version, note, updatedAt: nowIso() });
  await log('profile', `${note} (profile version ${version})`);
  S.dirty = false; toast('Saved as a new profile version');
}

document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const fd = new FormData(f); const btn = f.querySelector('[type=submit]'); const id = curAppId();
  const F = {
    request: async () => {
      const site = String(fd.get('website') || '').trim();
      const doc = site ? { kind: 'check_site', website: site, area: fd.get('area'), note: String(fd.get('note') || ''), status: 'pending', createdAt: nowIso() } : { kind: 'search', area: fd.get('area'), sector: fd.get('sector'), note: String(fd.get('note') || ''), status: 'pending', createdAt: nowIso() };
      await C.db.collection('requests').doc(uid('rq')).set(doc);
      await log('search', site ? `Asked the agent to check ${site}` : `Asked the agent to search: ${AREA[doc.area]}, ${SECTORS[doc.sector]}`);
      f.reset(); toast('Added to the agent\'s list');
    },
    cv: async () => {
      const a = appById(id);
      const exps = [...f.querySelectorAll('.exp')].map((n) => { const eid = n.dataset.exp; const pe = S.profile.experiences.find((x) => x.id === eid); return { id: eid, include: f.querySelector(`[name="inc_${eid}"]`).checked, bullet_indices: pe.bullets.map((_, i) => i).filter((i) => f.querySelector(`[name="b_${eid}_${i}"]`)?.checked) }; });
      await updateDraft(id, { cv: { ...a.cv, headline: fd.get('headline'), profile: fd.get('profile'), experience_order: exps.map((x) => x.id), experiences: exps, course_highlights: fd.getAll('course') } }, 'CV');
      toast('CV saved'); render();
    },
    letter: async () => {
      await updateDraft(id, { letter: { subject_line: fd.get('subject_line'), recipient_line: fd.get('recipient_line'), salutation: fd.get('salutation'), paragraphs: fd.getAll('paragraph').map((x) => String(x).trim()).filter(Boolean), closing: fd.get('closing') } }, 'Letter');
      toast('Letter saved'); render();
    },
    email: async () => {
      const a = appById(id); const opp = oppById(a.oppId);
      const to = fd.get('to');
      const c = to ? (opp.contacts || []).find((x) => x.email === to) : null;
      await updateDraft(id, { emailSubject: fd.get('subject'), emailBody: fd.get('body'), ...(to !== null ? { contact: c ? { email: c.email, evidenceUrl: c.evidenceUrl, detail: c.detail, checkedAt: c.checkedAt } : null } : {}) }, 'Email');
      toast('Email saved'); render();
    },
    contact: async () => {
      const a = appById(id);
      await C.db.collection('requests').doc(uid('rq')).set({ kind: 'verify_email', oppId: a.oppId, website: a.website, email: String(fd.get('email')).trim().toLowerCase(), evidenceUrl: String(fd.get('evidence')).trim(), status: 'pending', createdAt: nowIso() });
      await log('discover', `Asked the agent to verify ${fd.get('email')} for ${a.orgName}`, { app: id });
      f.reset(); toast('The agent will verify it. It becomes selectable once verified.');
    },
    regen: async () => generate(id, { language: fd.get('language'), instructions: String(fd.get('instructions') || '').trim() || undefined }),
    status: async () => { const a = appById(id); await saveApp(id, { status: fd.get('status'), events: [...(a.events || []), { type: 'status', date: nowIso().slice(0, 10), content: `Status: ${STATUS[fd.get('status')]}` }] }); await log('archive', `${a.orgName}: status changed to ${STATUS[fd.get('status')]}`, { app: id }); toast('Status updated'); render(); },
    event: async () => { await addEvent(id, { type: fd.get('type'), date: fd.get('date') || nowIso().slice(0, 10), content: String(fd.get('content')).trim() }); f.reset(); toast('Saved'); render(); },
    facts: async () => {
      const p = clone(S.profile);
      for (const k of ['full_name', 'headline', 'email', 'phone', 'city']) p.identity[k] = String(fd.get(`id_${k}`) || '').trim();
      Object.assign(p.internship, { duration: String(fd.get('duration')).trim(), period: String(fd.get('period')).trim(), cv_profile_text: String(fd.get('cv_profile_text')).trim() });
      for (const l of ['languages', 'education', 'experiences', 'skills']) p[l] = [...f.querySelectorAll(`[data-list="${l}"]`)].map((n) => { const o = { id: n.dataset.id }; n.querySelectorAll('[data-k]').forEach((i) => { o[i.dataset.k] = i.dataset.t === 'lines' ? lines(i.value) : i.value.trim(); }); return o; });
      p.education.forEach((x) => { x.courses ||= []; }); p.experiences.forEach((x) => { x.bullets ||= []; x.summary ||= ''; });
      p.interests = String(fd.get('interests') || '').trim();
      await saveProfile(p, String(fd.get('note') || '').trim() || 'Facts updated'); render();
    },
    transferable: async () => {
      const p = clone(S.profile);
      f.querySelectorAll('[data-tid]').forEach((n) => { p.transferable.find((t) => t.id === n.dataset.tid).status = n.querySelector('select').value; });
      const t = String(fd.get('text') || '').trim();
      if (t) p.transferable.push({ id: uid('t'), text: t, basis: String(fd.get('basis') || '').trim() || 'Stated by you', status: 'confirmed' });
      await saveProfile(p, 'Transferable skills reviewed'); render();
    },
    questions: async () => {
      const p = clone(S.profile);
      f.querySelectorAll('[data-qid]').forEach((t) => { const q = p.questions.find((x) => x.id === t.dataset.qid); q.answer = t.value.trim(); q.status = q.answer ? 'answered' : 'open'; });
      await saveProfile(p, 'Questions answered'); render();
    },
  };
  if (F[f.dataset.form]) guarded(btn, F[f.dataset.form]);
});

// ---------- boot ----------
async function boot() {
  render();
  if (!window.claude?.use) { S.noRuntime = true; render(); return; }
  const names = ['db', 'user', 'sample', 'mcp', 'assets', 'downloads'];
  const got = await Promise.all(names.map((n) => window.claude.use(n).catch(() => null)));
  names.forEach((n, i) => { C[n] = got[i]; });
  S.capsResolved = true;
  if (!C.db) { render(); return; }
  subscribe();
  render();
}
boot();
