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
  opps: [], apps: [], drafts: [], activity: [], requests: [], notifications: [], runs: [],
  agentStatus: null, agentConfig: null, agentConfigVersion: null, trigger: null, triggerError: null,
  busy: {}, // per-application running work: {appId: 'Writing…'}
  ui: { editing: {}, actFilter: '', profileTab: 'facts', confirm: null, replies: {}, shownHash: {}, showEarlier: false },
  dirty: false,
};
const STATUS = { preparing: 'Being prepared', ready: 'Waiting for your approval', unknown: 'Check Sent folder', sent: 'Sent', follow_up: 'Follow-up needed', interview: 'Interview', rejected: 'Rejected', accepted: 'Accepted', withdrawn: 'Discarded' };
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
  db.collection('notifications').orderBy('ts', 'desc').limit(300).onSnapshot((q) => { S.notifications = q.docs.map((d) => ({ id: d.id, ...d.data() })); maybeBrowserNotify(); renderSoon(); }, onErr('notifications'));
  db.doc('agent/status').onSnapshot((s) => { S.agentStatus = s.exists ? s.data() : null; renderSoon(); }, onErr('agent status'));
  db.doc('agent/config').onSnapshot((s) => { S.agentConfig = s.exists ? s.data() : null; renderSoon(); }, onErr('agent settings'));
  db.collection('agentRuns').orderBy('startedAt', 'desc').limit(30).onSnapshot((q) => { S.runs = q.docs.map((d) => ({ id: d.id, ...d.data() })); renderSoon(); }, onErr('agent runs'));
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
  S.busy[appId] = 'Writing your CV and cover letter for this organization…'; render();
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
      status: 'ready', language: lang, cv: draft.cv, letter: draft.letter, emailSubject: draft.email.subject, emailBody: draft.email.body,
      review: { unsupported: review.unsupported_claims || [], orgClaims: review.organization_claims_not_in_sources || [], style: review.style_remarks || [], local, notes: draft.notes_for_candidate, regenerated, at: nowIso() },
      approvedHash: null, approvedAt: null, profileVersion: S.profileDoc?.version || 1, generationError: null,
    };
    await saveApp(appId, patch);
    const n = await saveDraftVersion({ ...app, ...patch, id: appId }, 'ai');
    const flagged = patch.review.unsupported.length + patch.review.orgClaims.length;
    await log('generate', `Wrote CV and cover letter for ${app.orgName} (version ${n}${regenerated ? ', corrected after fact-check' : ''}${flagged ? `, ${flagged} point(s) to review` : ''})`, { app: appId });
  } catch (e) {
    const msg = sampleErrorText(e);
    await saveApp(appId, { generationError: msg, status: appById(appId)?.cv ? 'ready' : 'preparing' }).catch(() => {});
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
const PENDING = ['preparing', 'ready', 'unknown'];
const KIND = { published: 'Published internship', speculative: 'Spontaneous application' };
function bestContact(opp) {
  const v = (opp?.contacts || []).filter((c) => c.status === 'verified');
  return v.find((c) => c.recommended) || v.find((c) => /^(rh|recrutement|jobs|careers|stage)/i.test(c.email)) || v[0] || null;
}
async function markNotifRead(pred) {
  for (const n of S.notifications.filter((x) => !x.read && pred(x))) {
    try { await C.db.collection('notifications').doc(n.id).update({ read: true, readAt: nowIso() }); } catch (e) { console.warn(e); }
  }
}
async function decide(oppId, decision) {
  const opp = oppById(oppId);
  if (decision === 'ignore') { await markNotifRead((n) => n.oppId === oppId); toast('Moved to earlier discoveries'); return; }
  await C.db.collection('opportunities').doc(oppId).update({ status: decision, decidedAt: nowIso() });
  await markNotifRead((n) => n.oppId === oppId);
  const label = { interested: 'Interested', not_interested: 'Not interested', saved: 'Saved for later', new: 'Moved back' }[decision];
  await log('decision', `${label}: ${opp.position ? `${opp.position} · ` : ''}${opp.name}`, { opp: oppId });
  if (decision !== 'interested') { toast(decision === 'not_interested' ? 'Noted. Your agent will not suggest it again.' : label); return; }
  let app = S.apps.find((a) => a.oppId === oppId && a.status !== 'withdrawn');
  if (!app) {
    const id = uid('app');
    const c = bestContact(opp);
    const doc = { oppId, orgName: opp.name, website: opp.website, city: opp.city || '', area: opp.area || '', kind: opp.kind, listingUrl: opp.listingUrl || '', position: opp.position || '', status: 'preparing', language: 'fr', contact: c ? { email: c.email, evidenceUrl: c.evidenceUrl, detail: c.detail, checkedAt: c.checkedAt, verified: true } : null, cv: null, letter: null, emailSubject: '', emailBody: '', review: null, events: [], failedAttempts: [], createdAt: nowIso(), updatedAt: nowIso() };
    await C.db.collection('applications').doc(id).set(doc);
    await log('decision', `Your agent started preparing an application to ${opp.name}`, { app: id });
    app = { id, ...doc };
    S.apps.push(app);
  }
  go(`app-${app.id}`);
  if (!app.cv && C.sample && !S.busy[app.id]) generate(app.id).catch((e) => toast(e.message, 'error'));
}

async function approvalHash(app) {
  return sha256Hex(stable({ cv: app.cv, letter: app.letter, subject: app.emailSubject, body: app.emailBody, language: app.language, to: app.contact?.email || null }));
}
function contactState(app) {
  if (!app.contact?.email) return 'missing';
  const opp = oppById(app.oppId);
  const c = (opp?.contacts || []).find((x) => x.email === app.contact.email);
  if (c?.status === 'verified') return 'verified';
  if (app.contact.reviewedByYou) return 'reviewed';
  return 'unverified';
}
function readiness(app) {
  const p = [];
  if (!app.cv || !app.letter) p.push('The CV and cover letter are not written yet.');
  if (!app.emailSubject?.trim() || !app.emailBody?.trim()) p.push('The email subject and message are required.');
  const cs = contactState(app);
  if (cs === 'missing') p.push('There is no recipient address yet.');
  if (cs === 'unverified') p.push(`Review the address ${app.contact.email} before sending.`);
  return p;
}
async function updateDraft(appId, patch, label) {
  const app = appById(appId);
  if (!['ready', 'preparing'].includes(app.status)) throw new Error('This application can no longer be edited.');
  const next = { ...app, ...patch };
  const review = { ...(app.review || {}), local: next.cv && next.letter ? localChecks({ cv: next.cv, letter: next.letter, email: { subject: next.emailSubject, body: next.emailBody } }, next.language) : [] };
  await saveApp(appId, { ...patch, review });
  if (patch.cv || patch.letter || 'emailSubject' in patch || 'emailBody' in patch) {
    const n = await saveDraftVersion({ ...next, id: appId }, 'edit');
    await log('edit', `${label} edited for ${app.orgName} (version ${n})`, { app: appId });
  }
  S.dirty = false;
  delete S.ui.shownHash[appId];
}

const DEFINITELY_NOT_SENT = ['tool_error', 'not_in_manifest', 'needs_reauth', 'server_not_connected', 'selection_required', 'blocked_by_policy', 'approval_required', 'not_granted', 'capability_disabled', 'capability_removed', 'bad_request', 'server_not_found', 'self_only', 'transform_error', 'consent_required'];
function mcpErrorText(e, server = 'Gmail') {
  switch (e?.code) {
    case 'server_not_connected': return `${server} is not connected to your Claude account. Add it in claude.ai Settings → Connectors.`;
    case 'needs_reauth': return `Your ${server} connection expired. Reconnect it in claude.ai Settings → Connectors.`;
    case 'not_in_manifest': case 'approval_required': case 'not_granted': case 'consent_required': return `This page was not allowed to use ${server}. Allow it when asked (or in the page's Permissions menu) and try again.`;
    case 'selection_required': return `You have more than one ${server} connector. Choose which one this page should use when asked.`;
    case 'blocked_by_policy': return `Your organization blocks this ${server} action.`;
    case 'tool_error': return `${server} refused: ${e.message}`;
    default: return e?.message || `${server} could not be reached.`;
  }
}

/** Final approval: sends exactly what was on screen when the box was ticked. */
async function approveAndSend(appId) {
  const app = appById(appId);
  if (app.status !== 'ready') throw new Error('This application is not waiting for approval.');
  const pr = readiness(app);
  if (pr.length) throw new Error(pr.join(' '));
  const shown = S.ui.shownHash[appId];
  if (!shown || shown !== (await approvalHash(app))) throw new Error('The application changed since you ticked the box. Read it again and confirm.');
  if (!C.mcp) throw new Error('Gmail cannot be used from this view. Open the page on claude.ai while signed in.');
  if (!C.assets) throw new Error('The archive is not available in this view, so nothing was sent. Open the page on claude.ai as its owner.');
  S.busy[appId] = 'Preparing the PDFs…'; render();
  try {
    const [cvBytes, letterBytes] = await Promise.all([renderCvPdf(S.profile, app.cv), renderLetterPdf(S.profile, app, app.letter, new Date())]);
    const names = fileNames(app);
    const [cvSha, letterSha] = await Promise.all([sha256Hex(cvBytes), sha256Hex(letterBytes)]);
    S.busy[appId] = 'Archiving the exact files…'; render();
    const cvAsset = await C.assets.upload(new Blob([cvBytes], { type: 'application/pdf' }), { type: 'application/pdf' });
    const letterAsset = await C.assets.upload(new Blob([letterBytes], { type: 'application/pdf' }), { type: 'application/pdf' });
    const attempt = {
      to: app.contact.email, toStatus: contactState(app), subject: app.emailSubject, body: app.emailBody, startedAt: nowIso(),
      cv: { assetId: cvAsset.id, sha256: cvSha, filename: names.cv, size: cvBytes.length },
      letter: { assetId: letterAsset.id, sha256: letterSha, filename: names.letter, size: letterBytes.length },
      profileVersion: S.profileDoc?.version || 1, approvedAt: nowIso(),
    };
    await saveApp(appId, { attempt });
    await log('approve', `You approved the application to ${app.orgName}`, { app: appId });
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
      throw new Error('Gmail did not confirm whether the email left. Use "Check my Sent folder" before trying again.');
    }
    const pl = result?.payload || {};
    const gmailId = pl.id || pl.message?.id || null;
    if (!gmailId) {
      await saveApp(appId, { status: 'unknown', attempt: { ...attempt, error: 'Gmail returned no message id' } });
      throw new Error('Gmail answered without a message ID. Use "Check my Sent folder" to confirm.');
    }
    await markSent(appId, { ...attempt, gmailId, threadId: pl.threadId || null, sentAt: nowIso() });
    toast('Sent from your Gmail and archived');
  } finally { delete S.busy[appId]; delete S.ui.shownHash[appId]; render(); }
}
async function markSent(appId, sent) {
  const app = appById(appId);
  await saveApp(appId, { status: 'sent', sent, attempt: null, events: [...(app.events || []), { type: 'status', date: nowIso().slice(0, 10), content: `Sent to ${sent.to} from Gmail (message ${sent.gmailId})` }] });
  await log('send', `Application sent to ${app.orgName} (${sent.to}) from Gmail; exact CV and letter archived`, { app: appId });
}
const gmailDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; };
async function checkSentFolder(appId) {
  const app = appById(appId); const at = app.attempt;
  if (!at) return;
  let res;
  try { res = await C.mcp.callTool('Gmail', 'search_threads', { query: `in:sent to:${at.to} after:${gmailDay(at.startedAt)}`, pageSize: 10 }, { cache: false }); } catch (e) { throw new Error(mcpErrorText(e)); }
  const threads = res?.payload?.threads || [];
  const hit = threads.find((t) => (t.messages || []).some((m) => (m.subject || '').trim() === at.subject.trim()));
  if (hit) {
    const m = hit.messages.find((x) => (x.subject || '').trim() === at.subject.trim());
    await markSent(appId, { ...at, gmailId: m.id, threadId: hit.id, sentAt: m.date || at.startedAt, confirmedVia: 'Sent folder' });
    toast('Found in your Sent folder: recorded as sent');
  } else {
    await saveApp(appId, { status: 'ready', attempt: null, failedAttempts: [...(app.failedAttempts || []), { ...at, error: 'Not found in the Sent folder', at: nowIso() }] });
    await log('error', `${app.orgName}: not found in Gmail's Sent folder, so it was not sent. It is waiting for your approval again.`, { app: appId });
    toast('Not in your Sent folder: it was not sent. You can approve it again.', 'error');
  }
}
async function checkReplies(appId) {
  const app = appById(appId); const s = app.sent;
  const domain = s.to.split('@')[1];
  let res;
  try { res = await C.mcp.callTool('Gmail', 'search_threads', { query: `from:${domain} after:${gmailDay(s.sentAt)}`, pageSize: 20 }, { cache: false }); } catch (e) { throw new Error(mcpErrorText(e)); }
  S.ui.replies[appId] = (res?.payload?.threads || []).map((t) => { const ms = t.messages || []; const m = ms.find((x) => String(x.sender || '').toLowerCase().includes(domain)) || ms[0] || {}; return { threadId: t.id, subject: m.subject || '', snippet: m.snippet || '', sender: m.sender || '', date: m.date || '', url: t.viewUrl || m.viewUrl || '' }; });
  await log('archive', `Checked Gmail for replies from ${domain}: ${S.ui.replies[appId].length} found`, { app: appId });
}
async function addEvent(appId, ev) {
  const app = appById(appId);
  const patch = { events: [...(app.events || []), ev] };
  if (ev.type === 'interview' && ['sent', 'follow_up'].includes(app.status)) patch.status = 'interview';
  await saveApp(appId, patch);
  await log('archive', `${app.orgName}: ${{ response: 'response', follow_up: 'follow-up', interview: 'interview', note: 'note' }[ev.type]} recorded`, { app: appId });
}

// ---------- the background agent (scheduled Claude Code task) ----------
const REMOTE = 'Claude Code Remote';
async function refreshTrigger() {
  const id = S.agentConfig?.triggerId;
  if (!C.mcp || !id) return;
  try { const r = await C.mcp.callTool(REMOTE, 'get_trigger', { trigger_id: id }, { cache: false }); S.trigger = r?.payload?.trigger || r?.payload || null; S.triggerError = null; } catch (e) { S.triggerError = mcpErrorText(e, 'Claude Code'); }
  renderSoon();
}
async function runAgentNow() {
  const id = S.agentConfig?.triggerId;
  if (!id) throw new Error('The agent schedule is not set up yet.');
  if (!C.mcp) throw new Error('This view cannot start the agent.');
  try { await C.mcp.callTool(REMOTE, 'fire_trigger', { trigger_id: id }); } catch (e) { throw new Error(mcpErrorText(e, 'Claude Code')); }
  await log('search', 'You asked your agent to run now');
  toast('Your agent is starting a run. It usually takes 10 to 20 minutes.');
}
async function setAgentPaused(paused) {
  const id = S.agentConfig?.triggerId;
  if (C.mcp && id) { try { await C.mcp.callTool(REMOTE, 'update_trigger', { trigger_id: id, enabled: !paused }); } catch (e) { throw new Error(mcpErrorText(e, 'Claude Code')); } }
  await C.db.doc('agent/config').update({ paused, updatedAt: nowIso() });
  await log('search', paused ? 'You paused your agent' : 'You resumed your agent');
  refreshTrigger();
}
function nextRunText() {
  const t = S.trigger;
  const next = t?.next_run_at || t?.nextRunAt || S.agentConfig?.nextRunHint;
  if (!next) return S.agentConfig?.scheduleLabel || '';
  const d = new Date(next);
  if (Number.isNaN(d.getTime())) return S.agentConfig?.scheduleLabel || '';
  const today = new Date(); const tomorrow = new Date(Date.now() + 864e5);
  const day = d.toDateString() === today.toDateString() ? 'today' : d.toDateString() === tomorrow.toDateString() ? 'tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
  return `Next search ${day} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

// ---------- browser notifications (while the page is open in a browser) ----------
function notifSupport() {
  try { return typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'; } catch { return 'unsupported'; }
}
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }
function maybeBrowserNotify() {
  const fresh = S.notifications.filter((n) => !n.read);
  const last = lsGet('stage.lastNotified') || '';
  const newer = fresh.filter((n) => String(n.ts) > last);
  if (!newer.length) return;
  lsSet('stage.lastNotified', newer[0].ts);
  if (!last || notifSupport() !== 'granted' || document.visibilityState === 'visible') return;
  const opps = newer.filter((n) => n.type === 'opportunity');
  const title = opps.length ? `Your agent found ${opps.length} new opportunit${opps.length > 1 ? 'ies' : 'y'}` : newer[0].title;
  try { new Notification(title, { body: opps.length ? opps.slice(0, 3).map((n) => n.title).join(' · ') : newer[0].body, tag: 'stage-agent' }); } catch { /* blocked by the frame */ }
}
async function askBrowserNotifications() {
  if (notifSupport() === 'unsupported') throw new Error('This browser view does not allow notifications. Your phone notifications from the Claude app still work.');
  const r = await Notification.requestPermission();
  toast(r === 'granted' ? 'Browser notifications are on' : 'Browser notifications were not allowed', r === 'granted' ? '' : 'error');
  render();
}

// ---------- navigation ----------
const main = document.getElementById('main');
const nav = document.getElementById('nav');
function route() { return (location.hash || '#home').slice(1) || 'home'; }
function go(r) { if (location.hash !== `#${r}`) location.hash = r; else render(); }
window.addEventListener('hashchange', () => { S.dirty = false; S.ui.confirm = null; render(); window.scrollTo(0, 0); });

function renderNav() {
  const r = route();
  const unread = S.notifications.filter((n) => !n.read).length;
  const pending = S.apps.filter((a) => PENDING.includes(a.status)).length;
  const items = [['home', 'Home', unread], ['applications', 'Applications', pending], ['profile', 'Profile'], ['agent', 'Agent']];
  nav.innerHTML = items.map(([k, l, n]) => html`<a href="#${k}" class="${r === k || (k === 'applications' && r.startsWith('app-')) || (k === 'home' && (r.startsWith('opp-') || r === 'activity')) ? 'active' : ''}">${l}${n ? html`<span class="count">${n}</span>` : ''}</a>`.s).join('');
}

function render() {
  renderNav();
  if (S.noRuntime) { main.innerHTML = html`<div class="notice warn">This workspace runs inside claude.ai. Open its link while signed in to your Claude account.</div>`.s; return; }
  if (!C.db && !S.capsResolved) { main.innerHTML = html`<div class="progress"><span class="spinner"></span>Opening your workspace…</div>`.s; return; }
  if (!C.db) { main.innerHTML = html`<div class="notice warn"><strong>Your workspace can't be opened in this view.</strong> Open the link on claude.ai while signed in as its owner.</div>`.s; return; }
  if (!S.ready) { main.innerHTML = html`<div class="progress"><span class="spinner"></span>${S.timedOut ? 'Your data is taking longer than usual to load. It will appear here when it arrives.' : 'Loading your workspace…'}</div>`.s; return; }
  if (!S.profile) { main.innerHTML = html`<div class="empty"><div class="serif">Your profile is not set up yet</div>Ask Claude in your chat to load your profile into this workspace.</div>`.s; return; }
  const r = route();
  let v;
  if (r.startsWith('app-')) v = viewApp(r.slice(4));
  else if (r.startsWith('opp-')) v = viewOpp(r.slice(4));
  else v = ({ home: viewHome, applications: viewApplications, activity: viewActivity, profile: viewProfile, agent: viewAgent }[r] || viewHome)();
  main.innerHTML = v.s;
}

// ---------- views ----------
function agentLine() {
  const st = S.agentStatus; const cfg = S.agentConfig;
  if (!cfg?.triggerId) return { state: 'off', text: 'Your agent is not scheduled yet.', sub: 'Ask Claude in your chat to set up the schedule.' };
  if (cfg.paused || S.trigger?.enabled === false) return { state: 'paused', text: 'Your agent is paused.', sub: 'It will not search until you resume it.' };
  if (st?.state === 'running' && Date.now() - new Date(st.startedAt) < 90 * 60e3) return { state: 'running', text: st.message || 'Your agent is searching.', sub: `Started ${fmtDate(st.startedAt, true)}` };
  if (st?.state === 'blocked') return { state: 'blocked', text: 'Your agent is blocked.', sub: st.message, extra: nextRunText() };
  return { state: 'idle', text: st?.lastRunAt ? (st.message || 'Your agent finished its last search.') : 'Your agent is scheduled and has not run yet.', sub: [st?.lastRunAt ? `Last search ${fmtDate(st.lastRunAt, true)}` : '', nextRunText()].filter(Boolean).join(' · ') };
}
function agentCard() {
  const a = agentLine();
  return html`<section class="agent agent-${a.state}" aria-live="polite">
    <div class="agent-dot" aria-hidden="true"></div>
    <div class="agent-text"><div class="eyebrow">Your agent</div><div class="agent-main">${a.text}</div><div class="small muted">${a.sub}${a.extra ? ` · ${a.extra}` : ''}</div></div>
    ${S.agentConfig?.triggerId && C.mcp && a.state !== 'running' && a.state !== 'paused' ? html`<button class="btn small" data-act="run-now">Search now</button>` : ''}
  </section>`;
}
function discoveryCard(o, n) {
  const best = bestContact(o);
  return html`<article class="disc" id="disc-${o.id}">
    <div class="disc-top"><span class="disc-label">${n && !n.read ? 'New opportunity' : 'Opportunity'}</span><span class="tag ${o.kind === 'published' ? 'solid' : ''}">${KIND[o.kind] || KIND.speculative}</span></div>
    <h3>${o.position || 'Internship'}</h3>
    <div class="where">${[o.city || AREA[o.area], o.name].filter(Boolean).join(' · ')}</div>
    ${o.summary || o.description ? html`<p class="disc-sum">${o.summary || o.description}</p>` : ''}
    ${(o.matchReasons || []).length ? html`<div class="why"><div class="why-h">Why I found this for you</div><ul>${o.matchReasons.slice(0, 4).map((x) => html`<li>${x}</li>`)}</ul></div>` : ''}
    <div class="disc-facts small muted">${best ? html`Contact verified on their website` : html`No verified contact yet`}${o.kind === 'published' && o.listingUrl ? html` · <a href="${o.listingUrl}" target="_blank" rel="noopener noreferrer">See the offer</a>` : ''} · <a href="#opp-${o.id}">Details</a></div>
    <div class="disc-actions">
      <button class="btn ghost" data-act="decide" data-id="${o.id}" data-v="not_interested">Not interested</button>
      <button class="btn ghost" data-act="decide" data-id="${o.id}" data-v="saved">Save for later</button>
      <button class="btn primary" data-act="decide" data-id="${o.id}" data-v="interested">I'm interested</button>
    </div>
    ${n && !n.read ? html`<button class="dismiss" data-act="decide" data-id="${o.id}" data-v="ignore" aria-label="Ignore for now">Ignore for now</button>` : ''}
  </article>`;
}
function viewHome() {
  const unread = S.notifications.filter((n) => !n.read);
  const newOppNotifs = unread.filter((n) => n.type === 'opportunity' && oppById(n.oppId)?.status === 'new');
  const otherNotifs = unread.filter((n) => n.type !== 'opportunity');
  const shownOpp = new Set(newOppNotifs.map((n) => n.oppId));
  const earlier = S.opps.filter((o) => (o.status === 'new' || o.status === 'saved') && !shownOpp.has(o.id)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const pending = S.apps.filter((a) => PENDING.includes(a.status)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const sent = S.apps.filter((a) => a.sent).sort((a, b) => String(b.sent.sentAt).localeCompare(String(a.sent.sentAt))).slice(0, 3);
  const n = newOppNotifs.length;
  const greet = new Date().getHours() < 18 ? 'Bonjour' : 'Bonsoir';
  return html`
  <div class="home-head"><div class="eyebrow">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
    <h1>${greet} ${S.profile.identity.first_name || ''}.</h1>
    <p class="lede">${n ? html`Your agent found <strong>${n} new opportunit${n > 1 ? 'ies' : 'y'}</strong>.` : pending.some((a) => a.status === 'ready') ? 'An application is waiting for your approval.' : 'Nothing new to decide right now. Your agent keeps searching.'}</p></div>
  ${agentCard()}
  ${otherNotifs.length ? html`<div class="section stack">${otherNotifs.map((x) => html`<div class="notif"><div><b>${x.title}</b><div class="small">${x.body}</div></div><div class="row">${x.appId ? html`<a class="btn small" href="#app-${x.appId}">Open</a>` : ''}<button class="btn small ghost" data-act="notif-read" data-v="${x.id}">Dismiss</button></div></div>`)}</div>` : ''}
  ${n ? html`<div class="section discs">${newOppNotifs.map((x) => discoveryCard(oppById(x.oppId), x))}</div>` : ''}
  ${pending.length ? html`<section class="section"><h2>Waiting for you</h2><div class="stack section">${pending.map((a) => html`<a class="pending" href="#app-${a.id}"><div><div class="title">${a.orgName}</div><div class="small muted">${a.position || KIND[a.kind]}${a.city ? ` · ${a.city}` : ''}</div></div><span class="pending-state">${S.busy[a.id] ? 'Being prepared…' : a.status === 'ready' ? 'Review and approve' : a.status === 'unknown' ? 'Check whether it was sent' : 'Being prepared'}</span></a>`)}</div></section>` : ''}
  ${earlier.length ? html`<section class="section"><div class="section-head"><h2>Earlier discoveries</h2><button class="btn small ghost" data-act="toggle-earlier">${S.ui.showEarlier ? 'Hide' : `Show ${earlier.length}`}</button></div>
    ${S.ui.showEarlier ? html`<div class="discs">${earlier.map((o) => discoveryCard(o, null))}</div>` : ''}</section>` : ''}
  ${!n && !S.opps.length ? html`<div class="section empty"><div class="serif">No opportunities yet</div>When your agent finds an internship or an organization worth contacting, it appears here and you get a notification.</div>` : ''}
  <section class="section"><div class="section-head"><h2>What your agent did</h2><a class="small" href="#activity">All activity</a></div>
    <ul class="list feed">${S.activity.slice(0, 5).map((a) => html`<li><span class="break">${a.message}</span><span class="meta">${fmtDate(a.ts, true)}</span></li>`)}</ul></section>
  ${sent.length ? html`<section class="section"><div class="section-head"><h2>Sent applications</h2><a class="small" href="#applications">History</a></div>
    <ul class="list">${sent.map((a) => html`<li><a class="row-link" href="#app-${a.id}"><div class="title">${a.orgName}</div><div class="small muted">${a.position || ''}</div></a><span class="meta">${pill(a.status)}<br>${fmtDate(a.sent.sentAt)}</span></li>`)}</ul></section>` : ''}`;
}

function viewOpp(id) {
  const o = oppById(id);
  if (!o) return html`<div class="notice warn">This opportunity was not found. <a href="#home">Back</a></div>`;
  const app = S.apps.find((a) => a.oppId === o.id && a.status !== 'withdrawn');
  const pub = o.kind === 'published';
  return html`<div class="page-head"><div><div class="eyebrow"><a href="#home">Home</a> · ${KIND[o.kind] || KIND.speculative}</div><h1>${o.position || o.name}</h1>
    <p class="lede">${[o.name, o.city || AREA[o.area], o.industry].filter(Boolean).join(' · ')}</p></div></div>
  <div class="opp-body">
    <div>
      <dl class="kv"><dt>The organization <span class="tag ai">Agent's summary of its website</span></dt><dd>${o.description || '—'}</dd></dl>
      <dl class="kv"><dt>The internship ${pub ? html`<span class="tag verified">From the published offer</span>` : html`<span class="tag ai">Agent's suggestion</span>`}</dt><dd class="position">${o.position || '—'}</dd></dl>
      ${(o.responsibilities || []).length ? html`<dl class="kv"><dt>Possible responsibilities <span class="tag ai">Agent's suggestion</span></dt><dd><ul>${o.responsibilities.map((x) => html`<li>${x}</li>`)}</ul></dd></dl>` : ''}
      ${(o.matchReasons || []).length ? html`<dl class="kv"><dt>Why I found this for you</dt><dd><ul>${o.matchReasons.map((x) => html`<li>${x}</li>`)}</ul></dd></dl>` : ''}
      ${(o.concerns || []).length ? html`<dl class="kv"><dt>Points to consider</dt><dd><ul>${o.concerns.map((x) => html`<li>${x}</li>`)}</ul></dd></dl>` : ''}
      ${o.handbookNotes ? html`<dl class="kv"><dt>University rules</dt><dd class="small">${o.handbookNotes}</dd></dl>` : ''}
    </div>
    <div>
      <dl class="kv"><dt>Website ${o.websiteCheckedAt ? html`<span class="tag verified">Opened by your agent ${fmtDate(o.websiteCheckedAt)}</span>` : ''}</dt><dd class="break"><a href="${o.website}" target="_blank" rel="noopener noreferrer">${hostOf(o.website)}</a></dd></dl>
      ${pub ? html`<dl class="kv"><dt>Published offer ${o.listingSource ? html`<span class="tag">${o.listingSource}</span>` : ''}</dt><dd class="break"><a href="${o.listingUrl}" target="_blank" rel="noopener noreferrer">${o.listingTitle || o.listingUrl}</a></dd></dl>` : ''}
      <dl class="kv"><dt>Contact</dt><dd>${(o.contacts || []).length ? html`<ul class="small">${o.contacts.map((c) => html`<li class="break">${c.email} ${c.status === 'verified' ? html`<span class="tag verified">Verified</span>` : html`<span class="tag warn">Not verified</span>`}<div class="xs muted">${c.detail || ''}</div></li>`)}</ul>` : html`<span class="muted small">No address found on their website yet.</span>`}</dd></dl>
      <dl class="kv"><dt>How your agent found it</dt><dd class="small break">${(o.sources || []).slice(0, 4).map((u) => html`<div><a href="${u}" target="_blank" rel="noopener noreferrer">${hostOf(u)}</a></div>`)}${o.locationEvidence ? html`<div class="xs muted">Location: ${o.locationEvidence}</div>` : ''}${o.createdAt ? html`<div class="xs muted">Found ${fmtDate(o.createdAt, true)}</div>` : ''}</dd></dl>
    </div>
  </div>
  <div class="disc-actions section">
    ${app ? html`<a class="btn primary" href="#app-${app.id}">Open the application</a>` : html`
      ${o.status !== 'not_interested' ? html`<button class="btn ghost" data-act="decide" data-id="${o.id}" data-v="not_interested">Not interested</button>` : html`<span class="small muted">You marked this as not interested.</span>`}
      ${o.status !== 'saved' ? html`<button class="btn ghost" data-act="decide" data-id="${o.id}" data-v="saved">Save for later</button>` : ''}
      <button class="btn primary" data-act="decide" data-id="${o.id}" data-v="interested">I'm interested</button>`}
  </div>`;
}

function viewApplications() {
  const pending = S.apps.filter((a) => PENDING.includes(a.status)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const sent = S.apps.filter((a) => a.sent).sort((a, b) => String(b.sent.sentAt).localeCompare(String(a.sent.sentAt)));
  const saved = S.opps.filter((o) => o.status === 'saved');
  return html`<div class="page-head"><div><div class="eyebrow">Applications</div><h1>Applications</h1><p class="lede">What is waiting for you, and a permanent record of everything sent.</p></div></div>
  <section><h2>Waiting for you</h2>${pending.length ? html`<div class="stack section">${pending.map((a) => html`<a class="pending" href="#app-${a.id}"><div><div class="title">${a.orgName}</div><div class="small muted">${a.position || KIND[a.kind]}</div></div><span class="pending-state">${STATUS[a.status]}</span></a>`)}</div>` : html`<p class="muted section">Nothing to approve.</p>`}</section>
  <section class="section"><h2>Sent</h2>${sent.length ? html`<div class="archive section">${sent.map((a) => html`<a class="arch-row" href="#app-${a.id}">
      <div><div class="title">${a.orgName}</div><div class="small muted">${a.position || KIND[a.kind]}</div></div>
      <div class="small"><div>${fmtDate(a.sent.sentAt)}</div><div class="muted break">${a.sent.to}</div></div>
      <div class="small">${pill(a.status)}<div class="muted">${(a.events || []).some((e) => e.type === 'response') ? 'Response received' : 'No response yet'}</div></div></a>`)}</div>` : html`<p class="muted section">No application sent yet.</p>`}</section>
  ${saved.length ? html`<section class="section"><h2>Saved for later</h2><ul class="list section">${saved.map((o) => html`<li><a class="row-link" href="#opp-${o.id}"><div class="title">${o.position || o.name}</div><div class="small muted">${o.name} · ${KIND[o.kind] || ''}</div></a></li>`)}</ul></section>` : ''}
  <section class="section"><h2>Original files</h2><div class="section">${(S.library?.items || []).map((d) => html`<div class="doc-row"><div class="break"><div>${d.label}</div><div class="xs muted">${d.filename}</div></div><a class="btn small" href="${blobUrl(d)}" target="_blank" rel="noopener">Open</a></div>`)}
    <div class="doc-row"><div><div>CV from your current profile</div><div class="xs muted">Without tailoring</div></div><button class="btn small" data-act="base-cv">Download PDF</button></div></div></section>`;
}

function reviewNotes(a) {
  const r = a.review;
  if (!r) return html`<div class="notice warn small">This version was not fact-checked automatically. Read it carefully.</div>`;
  const items = [
    ...(r.unsupported || []).map((c) => html`<li><span class="quote">${c.excerpt}</span>${c.problem}</li>`),
    ...(r.orgClaims || []).map((c) => html`<li>About the organization, not found on its pages: ${c}</li>`),
    ...(r.local || []).map((c) => html`<li>${c}</li>`),
    ...(r.style || []).map((c) => html`<li>${c}</li>`),
  ];
  return html`${items.length ? html`<div class="notice warn"><strong>Points to look at before approving</strong><ul>${items}</ul></div>` : html`<div class="notice small">Checked against your profile: every statement about you matches it.${r.regenerated ? ' A first draft was corrected automatically.' : ''}</div>`}
    ${(r.notes || []).length ? html`<div class="notice small"><strong>Questions from your agent</strong> (answer them in your profile to improve the next version)<ul>${r.notes.map((c) => html`<li>${c}</li>`)}</ul></div>` : ''}`;
}
function recipientBlock(a) {
  const cs = contactState(a); const opp = oppById(a.oppId);
  const others = (opp?.contacts || []).filter((c) => c.email !== a.contact?.email);
  if (cs === 'verified') return html`<div class="rcpt"><div><div class="eyebrow">To</div><div class="break"><b>${a.contact.email}</b> <span class="tag verified">Verified</span></div><div class="xs muted break">${a.contact.detail || ''}</div></div>${others.length ? html`<button class="btn small ghost" data-act="edit" data-v="recipient">Change</button>` : ''}</div>`;
  if (cs === 'reviewed') return html`<div class="rcpt"><div><div class="eyebrow">To</div><div class="break"><b>${a.contact.email}</b> <span class="tag warn">Confirmed by you</span></div><div class="xs muted">Your agent could not verify this address on the organization's website; you confirmed it on ${fmtDate(a.contact.reviewedAt)}.</div></div><button class="btn small ghost" data-act="edit" data-v="recipient">Change</button></div>`;
  return html`<div class="rcpt needs"><div class="stack"><div class="eyebrow">To</div>
    <div><b>${cs === 'missing' ? 'Your agent could not find a verified address for this organization.' : `Please review ${a.contact.email}: it could not be verified on their website.`}</b></div>
    <form data-form="recipient" class="stack">
      <div class="field"><label class="lbl" for="rc-email">Address to send to</label><input id="rc-email" name="email" type="email" value="${a.contact?.email || ''}" required placeholder="recrutement@organization.fr"></div>
      <div class="field"><label class="lbl" for="rc-src">Where you found it (optional)</label><input id="rc-src" name="source" type="text" placeholder="e.g. the Contact page of their website"></div>
      <label class="check"><input type="checkbox" name="confirm" required><span>I checked this address myself and want to use it.</span></label>
      <div class="row"><button class="btn small primary" type="submit">Use this address</button><button class="btn small ghost" type="button" data-act="ask-verify">Ask my agent to verify it instead</button></div>
    </form></div></div>`;
}
function cvEditor(a) {
  const p = S.profile; const cv = a.cv;
  const ord = cv.experience_order || [];
  const order = [...ord.filter((id) => p.experiences.some((e) => e.id === id)), ...p.experiences.map((e) => e.id).filter((id) => !ord.includes(id))];
  const sel = Object.fromEntries((cv.experiences || []).map((e) => [e.id, e]));
  return html`<form data-form="cv" class="stack editor">
    <p class="small muted">Facts come from your <a href="#profile">profile</a>. Here you choose what to show for this organization.</p>
    <div class="field"><label class="lbl" for="cv-head">Headline</label><input id="cv-head" name="headline" type="text" value="${cv.headline || ''}" data-dirty></div>
    <div class="field"><label class="lbl" for="cv-prof">Profile paragraph</label><textarea id="cv-prof" name="profile" class="tall serif" data-dirty>${cv.profile || ''}</textarea></div>
    <div class="field"><span class="lbl">Experiences</span><div id="exps" class="stack">${order.map((id) => {
      const e = p.experiences.find((x) => x.id === id); const s = sel[id];
      const inc = s ? s.include !== false : true; const idx = s?.bullet_indices?.length ? s.bullet_indices : e.bullets.map((_, i) => i);
      return html`<div class="exp ${inc ? '' : 'off'}" data-exp="${id}"><div class="exp-head"><label class="check"><input type="checkbox" name="inc_${id}" ${inc ? 'checked' : ''} data-dirty data-act-change="toggle-exp"><span><b>${e.title}</b><div class="xs muted">${e.organization}</div></span></label>
        <div class="order"><button type="button" data-act="up" aria-label="Move up">↑</button><button type="button" data-act="down" aria-label="Move down">↓</button></div></div>
        <div class="bullets">${e.bullets.map((b, i) => html`<label class="check small"><input type="checkbox" name="b_${id}_${i}" ${idx.includes(i) ? 'checked' : ''} data-dirty><span>${b}</span></label>`)}</div></div>`;
    })}</div></div>
    <div class="field"><span class="lbl">Courses to highlight</span><div class="stack">${p.education.flatMap((e) => e.courses || []).map((c) => html`<label class="check"><input type="checkbox" name="course" value="${c}" ${(cv.course_highlights || []).includes(c) ? 'checked' : ''} data-dirty><span>${c}</span></label>`)}</div></div>
    <div class="row"><button class="btn primary" type="submit">Save</button><button type="button" class="btn ghost" data-act="edit" data-v="">Cancel</button></div>
  </form>`;
}
function letterEditor(a) {
  const l = a.letter;
  return html`<form data-form="letter" class="stack editor">
    <div class="field"><label class="lbl" for="lt-subj">Objet</label><input id="lt-subj" name="subject_line" type="text" value="${l.subject_line}" data-dirty></div>
    <div class="field"><label class="lbl" for="lt-rec">Department line (optional)</label><input id="lt-rec" name="recipient_line" type="text" value="${l.recipient_line || ''}" data-dirty></div>
    <div class="field"><label class="lbl" for="lt-sal">Salutation</label><input id="lt-sal" name="salutation" type="text" value="${l.salutation}" data-dirty></div>
    <div class="field"><span class="lbl">Paragraphs</span><div id="paras" class="stack">${l.paragraphs.map((x, i) => html`<div class="row"><textarea id="lt-p${i}" name="paragraph" class="tall serif" data-dirty>${x}</textarea><button type="button" class="btn small ghost" data-act="rm-para">Remove</button></div>`)}</div>
      <div><button type="button" class="btn small ghost" data-act="add-para">+ Add a paragraph</button></div></div>
    <div class="field"><label class="lbl" for="lt-close">Closing</label><textarea id="lt-close" name="closing" class="serif" data-dirty>${l.closing}</textarea></div>
    <div class="row"><button class="btn primary" type="submit">Save</button><button type="button" class="btn ghost" data-act="edit" data-v="">Cancel</button></div>
  </form>`;
}
function emailEditor(a) {
  return html`<form data-form="email" class="stack editor">
    <div class="field"><label class="lbl" for="em-subj">Subject</label><input id="em-subj" name="subject" type="text" value="${a.emailSubject || ''}" data-dirty></div>
    <div class="field"><label class="lbl" for="em-body">Message</label><textarea id="em-body" name="body" class="tall serif" data-dirty>${a.emailBody || ''}</textarea></div>
    <div class="row"><button class="btn primary" type="submit">Save</button><button type="button" class="btn ghost" data-act="edit" data-v="">Cancel</button></div>
  </form>`;
}
function recipientChooser(a) {
  const opp = oppById(a.oppId);
  return html`<form data-form="pick-recipient" class="stack editor"><span class="lbl">Choose the recipient</span>
    ${(opp?.contacts || []).map((c) => html`<label class="check"><input type="radio" name="email" value="${c.email}" ${c.email === a.contact?.email ? 'checked' : ''} ${c.status === 'verified' ? '' : 'disabled'}><span class="break">${c.email} ${c.status === 'verified' ? html`<span class="tag verified">Verified</span>` : html`<span class="tag warn">Not verified</span>`}</span></label>`)}
    <div class="row"><button class="btn small primary" type="submit">Use this address</button><button type="button" class="btn small ghost" data-act="edit" data-v="">Cancel</button></div></form>`;
}
function reviewView(a) {
  const id = a.id; const ed = S.ui.editing[id] || '';
  const names = fileNames(a);
  const ready = readiness(a);
  return html`
  ${reviewNotes(a)}
  <section class="section block">${ed === 'recipient' ? recipientChooser(a) : recipientBlock(a)}</section>
  <section class="section block"><div class="block-head"><h3>Email</h3>${ed !== 'email' ? html`<button class="btn small ghost" data-act="edit" data-v="email">Edit</button>` : ''}</div>
    ${ed === 'email' ? emailEditor(a) : html`<div class="small muted">Subject</div><div class="email-subj">${a.emailSubject}</div><div class="email-body section-sm">${a.emailBody}</div><div class="xs muted section-sm break">Attached: ${names.cv} · ${names.letter}</div>`}</section>
  <section class="section block"><div class="block-head"><h3>CV</h3>${ed !== 'cv' ? html`<span class="row"><button class="btn small ghost" data-act="pdf" data-v="cv">PDF</button><button class="btn small ghost" data-act="edit" data-v="cv">Edit</button></span>` : ''}</div>
    ${ed === 'cv' ? html`<div class="split">${cvEditor(a)}${cvPaper(S.profile, a.cv)}</div>` : cvPaper(S.profile, a.cv)}</section>
  <section class="section block"><div class="block-head"><h3>Cover letter</h3>${ed !== 'letter' ? html`<span class="row"><button class="btn small ghost" data-act="pdf" data-v="letter">PDF</button><button class="btn small ghost" data-act="edit" data-v="letter">Edit</button></span>` : ''}</div>
    ${ed === 'letter' ? html`<div class="split">${letterEditor(a)}${letterPaper(S.profile, a, a.letter)}</div>` : letterPaper(S.profile, a, a.letter)}</section>
  <details class="section block"><summary>Ask your agent to rewrite it</summary>
    <form data-form="regen" class="stack section-sm">
      <div class="field"><label class="lbl" for="rg-ins">What should change?</label><textarea id="rg-ins" name="instructions" placeholder="e.g. mention their Spanish-speaking customers; make the second paragraph shorter"></textarea></div>
      <div class="field"><label class="lbl" for="rg-lang">Language of the letter and email</label><select id="rg-lang" name="language"><option value="fr" ${a.language === 'fr' ? 'selected' : ''}>French</option><option value="en" ${a.language === 'en' ? 'selected' : ''}>English</option></select></div>
      <div><button class="btn" type="submit" ${C.sample ? '' : 'disabled'}>Rewrite</button></div></form></details>
  ${(a.failedAttempts || []).length ? html`<div class="section notice warn small"><strong>Earlier attempts that were not sent:</strong><ul>${a.failedAttempts.map((f) => html`<li>${fmtDate(f.at, true)}: ${f.error}</li>`)}</ul></div>` : ''}
  <section class="section final stack">
    <h3>Approve and send</h3>
    ${ready.length ? html`<div class="notice warn small">${ready.join(' ')}</div>` : ''}
    ${!C.mcp ? html`<div class="notice warn small">Gmail can't be used from this view. Open the page on claude.ai with Gmail connected.</div>` : ''}
    <label class="check"><input type="checkbox" id="confirm-send" data-act-change="confirm" ${ready.length || ed || !C.mcp ? 'disabled' : ''}><span>I have read the email, the CV and the cover letter above. Send this application to <strong>${a.contact?.email || '…'}</strong> from my Gmail.</span></label>
    <div class="row"><button class="btn primary" id="send-btn" data-act="send" disabled>Approve and send</button><span class="xs muted">The exact PDFs are archived before sending.</span></div>
  </section>`;
}
function recordView(a) {
  const s = a.sent; const replies = S.ui.replies[a.id];
  const docRow = (d, label) => html`<div class="doc-row"><div class="break"><div>${d.filename}</div><div class="xs muted">${label} · ${(d.size / 1024).toFixed(0)} KB · <span class="mono" title="SHA-256">${d.sha256.slice(0, 16)}…</span></div></div>
    <div class="row"><a class="btn small" href="${blobUrl(d)}" target="_blank" rel="noopener">Open</a><button class="btn small ghost" data-act="dl-asset" data-v="${d.assetId}" data-name="${d.filename}">Download</button><button class="btn small ghost" data-act="verify-doc" data-v="${blobUrl(d)}" data-sha="${d.sha256}">Check it is intact</button></div></div>`;
  return html`<div class="split"><div>
    <table class="summary">
      <tr><th>Sent</th><td>${fmtDate(s.sentAt, true)} from your Gmail${s.confirmedVia ? ` (confirmed in your ${s.confirmedVia})` : ''} <span class="tag verified">Delivered to Gmail</span></td></tr>
      <tr><th>To</th><td>${s.to}${s.toStatus === 'reviewed' ? html` <span class="tag warn">confirmed by you</span>` : ''}</td></tr>
      <tr><th>Position</th><td>${a.position || '—'} <span class="small muted">(${KIND[a.kind] || ''})</span></td></tr>
      <tr><th>Organization</th><td>${a.orgName}<div class="xs"><a href="${a.website}" target="_blank" rel="noopener noreferrer">${a.website}</a></div></td></tr>
      <tr><th>Subject</th><td>${s.subject}</td></tr>
      <tr><th>Message</th><td><div class="email-body">${s.body}</div></td></tr>
    </table>
    <div class="section"><div class="eyebrow">Exact documents sent</div>${docRow(s.cv, 'CV')}${docRow(s.letter, 'Cover letter')}</div>
  </div><div>
    <div class="panel stack"><h3>Replies</h3>
      <div><button class="btn small" data-act="replies" ${C.mcp ? '' : 'disabled'}>Look in Gmail for a reply from ${s.to.split('@')[1]}</button></div>
      ${replies ? (replies.length ? html`<ul class="list small">${replies.map((t) => html`<li><div class="break"><b>${t.subject || '(no subject)'}</b><div class="muted">${t.sender}${t.date ? ` · ${fmtDate(t.date)}` : ''}</div><div>${t.snippet}</div>${t.url ? html`<a class="xs" href="${t.url}" target="_blank" rel="noopener noreferrer">Open in Gmail</a>` : ''}</div><button class="btn small" data-act="record-reply" data-v="${t.threadId}">Record as response</button></li>`)}</ul>` : html`<p class="small muted">No email from ${s.to.split('@')[1]} since you applied.</p>`) : ''}
    </div>
    <form class="section row" data-form="status"><label class="lbl" for="st-sel">Status</label><select id="st-sel" name="status">${POST_SEND.map((k) => html`<option value="${k}" ${a.status === k ? 'selected' : ''}>${STATUS[k]}</option>`)}</select><button class="btn small" type="submit">Update</button></form>
    <form class="section panel stack" data-form="event"><h3>Add to the record</h3>
      <div class="grid-2"><div class="field"><label class="lbl" for="ev-type">Type</label><select id="ev-type" name="type"><option value="response">Response received</option><option value="follow_up">Follow-up sent</option><option value="interview">Interview</option><option value="note">Note</option></select></div>
      <div class="field"><label class="lbl" for="ev-date">Date</label><input id="ev-date" type="date" name="date" value="${nowIso().slice(0, 10)}"></div></div>
      <div class="field"><label class="lbl" for="ev-content">Details</label><textarea id="ev-content" name="content" required></textarea></div>
      <div><button class="btn small primary" type="submit">Save</button></div></form>
    <ul class="timeline section">${(a.events || []).slice().reverse().map((e) => html`<li><div class="when">${fmtDate(e.date)} · ${{ response: 'Response', follow_up: 'Follow-up', interview: 'Interview', note: 'Note', status: 'Status' }[e.type] || e.type}</div><div class="break">${e.content}</div></li>`)}</ul>
  </div></div>`;
}
function viewApp(id) {
  const a = appById(id);
  if (!a) return html`<div class="notice warn">This application was not found. <a href="#applications">Back</a></div>`;
  let body;
  if (S.busy[id]) body = html`<div class="progress"><span class="spinner"></span>${S.busy[id]} This usually takes one to three minutes.</div>`;
  else if (a.status === 'preparing' || !a.cv && !a.sent) body = html`${a.generationError ? html`<div class="notice danger"><strong>Your agent could not finish.</strong> ${a.generationError}</div>` : ''}
    <div class="empty section"><div class="serif">Your agent is preparing this application</div><p>If you leave this page, it finishes on its next run and notifies you.</p>${C.sample ? html`<button class="btn primary" data-act="generate">Prepare it now</button>` : ''}</div>`;
  else if (a.status === 'unknown') body = html`<div class="notice warn"><strong>Gmail did not confirm whether this email left.</strong> Before sending again, check your Sent folder.</div><div class="section"><button class="btn primary" data-act="check-sent">Check my Sent folder</button></div>`;
  else if (a.sent) body = recordView(a);
  else body = reviewView(a);
  const vs = S.drafts.filter((d) => d.appId === id).sort((x, y) => y.n - x.n);
  const confirmDiscard = S.ui.confirm === `discard-${id}`;
  return html`<div class="page-head"><div><div class="eyebrow"><a href="#applications">Applications</a> · ${KIND[a.kind] || ''}</div><h1>${a.sent ? '' : 'Your application to '}${a.orgName}</h1>
    <p class="lede break">${[a.position, a.city].filter(Boolean).join(' · ')}${a.oppId ? html` · <a href="#opp-${a.oppId}">About this opportunity</a>` : ''}</p></div>
    <div class="row">${pill(S.busy[id] ? 'preparing' : a.status)}${PENDING.includes(a.status) && !confirmDiscard ? html`<button class="btn small ghost danger" data-act="discard">Discard</button>` : ''}</div></div>
  ${confirmDiscard ? html`<div class="inline-confirm">Discard this unsent application?<button class="btn small danger" data-act="discard-yes">Discard</button><button class="btn small ghost" data-act="cancel-confirm">Keep it</button></div>` : ''}
  ${body}
  ${vs.length ? html`<details class="section"><summary>Earlier versions (${vs.length})</summary><ul class="list section-sm">${vs.map((v) => html`<li><div>Version ${v.n} · ${v.source === 'ai' ? 'written by your agent' : 'your edit'}<div class="xs muted">${fmtDate(v.createdAt, true)}</div></div><span class="row"><button class="btn small ghost" data-act="ver-pdf" data-v="${v.id}" data-w="cv">CV</button><button class="btn small ghost" data-act="ver-pdf" data-v="${v.id}" data-w="letter">Letter</button>${a.status === 'ready' ? html`<button class="btn small" data-act="restore" data-v="${v.id}">Restore</button>` : ''}</span></li>`)}</ul></details>` : ''}`;
}

function viewActivity() {
  const f = S.ui.actFilter;
  const types = [['', 'All'], ['search', 'Searches'], ['discover', 'Discoveries'], ['decision', 'Your decisions'], ['generate', 'Writing'], ['send', 'Sent'], ['error', 'Problems']];
  const items = S.activity.filter((a) => !f || a.type === f);
  const days = new Map();
  for (const a of items) { const k = new Date(a.ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }); if (!days.has(k)) days.set(k, []); days.get(k).push(a); }
  return html`<div class="page-head"><div><div class="eyebrow"><a href="#home">Home</a></div><h1>What your agent did</h1></div></div>
  ${S.runs.length ? html`<section><h2>Search runs</h2><ul class="list section">${S.runs.slice(0, 10).map((r) => html`<li><div class="break">${r.outcome === 'blocked' ? 'Blocked: could not open websites' : `${r.kept ?? 0} kept from ${r.candidates ?? 0} candidates`}${(r.rejected || []).length ? html`<div class="xs muted">Set aside: ${r.rejected.slice(0, 6).map((x) => `${x.name} (${x.reason})`).join('; ')}</div>` : ''}</div><span class="meta">${fmtDate(r.startedAt, true)}</span></li>`)}</ul></section>` : ''}
  <div class="chips section">${types.map(([k, l]) => html`<button class="chip ${f === k ? 'active' : ''}" data-act="afilter" data-v="${k}">${l}</button>`)}</div>
  ${[...days.entries()].map(([d, l]) => html`<div class="day"><h3>${d}</h3>${l.map((a) => html`<div class="act"><span class="xs muted">${new Date(a.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span><span class="type ${a.type}">${a.type}</span><span class="msg break">${a.ref?.app ? html`<a href="#app-${a.ref.app}">${a.message}</a>` : a.ref?.opp ? html`<a href="#opp-${a.ref.opp}">${a.message}</a>` : a.message}</span></div>`)}</div>`)}`;
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
  const openQ = (p.questions || []).filter((q) => !q.answer?.trim()).length;
  const tabs = [['facts', 'About me'], ['transferable', 'Skills to confirm'], ['questions', `Questions${openQ ? ` (${openQ})` : ''}`], ['handbook', 'University rules']];
  let body;
  if (tab === 'facts') body = html`<form data-form="facts" class="stack">
    <div class="notice small">Your agent only ever writes what is here. Applications already sent keep the version they were written from.</div>
    <h2 class="section">Identity</h2><div class="grid-2">${[['full_name', 'Full name'], ['headline', 'Default headline'], ['email', 'Email'], ['phone', 'Phone'], ['city', 'City']].map(([k, l]) => html`<div class="field"><label class="lbl" for="id-${k}">${l}</label><input id="id-${k}" type="text" name="id_${k}" value="${p.identity[k] || ''}" data-dirty></div>`)}</div>
    <h2 class="section">Internship sought</h2><div class="grid-2"><div class="field"><label class="lbl" for="in-dur">Duration</label><input id="in-dur" type="text" name="duration" value="${p.internship.duration}" data-dirty></div><div class="field"><label class="lbl" for="in-per">Period</label><input id="in-per" type="text" name="period" value="${p.internship.period}" data-dirty></div></div>
    <div class="field"><label class="lbl" for="in-prof">Default CV profile paragraph</label><textarea id="in-prof" name="cv_profile_text" class="serif tall" data-dirty>${p.internship.cv_profile_text}</textarea></div>
    ${['languages', 'education', 'experiences', 'skills'].map((l) => html`<h2 class="section">${{ languages: 'Languages', education: 'Education', experiences: 'Experience', skills: 'Skills' }[l]}</h2><div class="stack" id="list-${l}">${p[l].map((o) => block(l, o))}</div><div><button type="button" class="btn small ghost" data-act="add-block" data-v="${l}">+ Add</button></div>`)}
    <h2 class="section">Interests</h2><textarea name="interests" aria-label="Interests" data-dirty>${p.interests || ''}</textarea>
    <div class="panel section stack"><div class="field"><label class="lbl" for="pf-note">What changed</label><input id="pf-note" name="note" type="text" placeholder="e.g. added TOEIC score"></div><div><button class="btn primary" type="submit">Save</button></div></div></form>`;
  else if (tab === 'transferable') body = html`<p class="lede">Skills your agent thinks your experience supports. It uses them <strong>only after you confirm them</strong>.</p>
    <form data-form="transferable" class="section stack">${p.transferable.map((t) => html`<div class="exp" data-tid="${t.id}"><div class="exp-head"><div><div class="serif">${t.text}</div><div class="xs muted">Based on: ${t.basis}</div></div>
      <select aria-label="Decision" data-dirty>${[['suggested', 'To decide'], ['confirmed', 'Yes, use it'], ['rejected', 'No, never use it']].map(([k, l]) => html`<option value="${k}" ${t.status === k ? 'selected' : ''}>${l}</option>`)}</select></div></div>`)}
      <div class="panel grid-2"><div class="field"><label class="lbl" for="tr-new">Add a skill in your own words</label><input id="tr-new" name="text" type="text" data-dirty></div><div class="field"><label class="lbl" for="tr-basis">Based on</label><input id="tr-basis" name="basis" type="text" data-dirty></div></div>
      <div><button class="btn primary" type="submit">Save</button></div></form>`;
  else if (tab === 'questions') body = html`<p class="lede">Your agent will not guess these. Leave a question empty if it does not apply.</p>
    <form data-form="questions" class="section stack">${p.questions.map((q) => html`<div class="field"><label class="lbl serif" for="q-${q.id}">${q.question}</label><textarea id="q-${q.id}" data-qid="${q.id}" data-dirty>${q.answer || ''}</textarea></div>`)}<div><button class="btn primary" type="submit">Save answers</button></div></form>`;
  else {
    const h = S.handbook;
    body = h ? html`${h.academicYear && !/2026/.test(h.academicYear) ? html`<div class="notice warn">Your handbook is the <strong>${h.academicYear}</strong> edition: its dates were written for that year. Ask the internship office (stages.llsh@univ-orleans.fr) for the 2026–2027 version.</div>` : ''}
      ${h.assetId ? html`<p class="section"><a class="btn small" href="${blobUrl(h)}" target="_blank" rel="noopener">Open the handbook</a></p>` : ''}
      <ul class="list section">${(h.requirements || []).map((r) => html`<li><div><span class="tag">${r.topic}</span> ${r.requirement}<div class="quote">“${r.quote}”${r.page ? ` (p. ${r.page})` : ''}</div></div></li>`)}</ul>`
      : html`<div class="empty">No handbook yet.</div>`;
  }
  return html`<div class="page-head"><div><div class="eyebrow">Profile · version ${S.profileDoc?.version || 1}</div><h1>What your agent knows about you</h1></div></div>
  <div class="tabs">${tabs.map(([k, l]) => html`<button data-act="ptab" data-v="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`)}</div>${body}`;
}

function viewAgent() {
  const cfg = S.agentConfig || {}; const a = agentLine();
  const np = notifSupport();
  const row = (name, ok, okText, offText) => html`<div class="doc-row"><div><div><b>${name}</b></div><div class="small muted">${ok ? okText : offText}</div></div>${ok ? html`<span class="tag verified">On</span>` : html`<span class="tag warn">Off</span>`}</div>`;
  return html`<div class="page-head"><div><div class="eyebrow">Agent &amp; settings</div><h1>Your agent</h1></div></div>
  ${agentCard()}
  <section class="section"><h2>How it works</h2>
    <p class="lede">${cfg.scheduleLabel || 'On a schedule'}, your agent starts on its own in Claude Code. It searches job boards and company career pages in Orléans and Paris, opens each organization's website to verify it and find a real contact address, compares it with your profile, and adds only relevant opportunities here. You get a notification on your phone through the Claude app. It never contacts an organization: you decide, and nothing is sent until you approve.</p>
    <div class="row section">
      ${cfg.triggerId && C.mcp ? html`${a.state === 'paused' ? html`<button class="btn primary" data-act="resume">Resume the agent</button>` : html`<button class="btn" data-act="run-now" ${a.state === 'running' ? 'disabled' : ''}>Search now</button><button class="btn ghost" data-act="pause">Pause</button>`}` : ''}
    </div>
    ${S.triggerError ? html`<p class="xs muted">Schedule details unavailable: ${S.triggerError}</p>` : ''}
  </section>
  <section class="section"><h2>Notifications</h2><div class="section">
    ${row('Phone (Claude app)', true, 'Each run that finds something ends with a push notification from the Claude app. Turn on Claude notifications on your phone to receive them.', '')}
    <div class="doc-row"><div><div><b>This browser</b></div><div class="small muted">${np === 'granted' ? 'On: when this page is open in another tab, new discoveries show as a browser notification.' : np === 'denied' ? 'Blocked in this browser. Allow notifications for claude.ai in your browser settings.' : np === 'unsupported' ? 'This view does not allow browser notifications. Phone notifications still work.' : 'Shows a notification when new discoveries arrive while this page is open in a tab.'}</div></div>
      ${np === 'default' ? html`<button class="btn small" data-act="browser-notif">Turn on</button>` : np === 'granted' ? html`<span class="tag verified">On</span>` : html`<span class="tag warn">Off</span>`}</div>
  </div></section>
  <section class="section"><h2>What it looks for</h2>
    <form data-form="focus" class="stack section">
      <div class="field"><span class="lbl">Areas</span><div class="row">${[['orleans', 'Orléans and surroundings'], ['paris', 'Paris and Île-de-France']].map(([k, l]) => html`<label class="check"><input type="checkbox" name="areas" value="${k}" ${(cfg.areas || ['orleans', 'paris']).includes(k) ? 'checked' : ''}><span>${l}</span></label>`)}</div></div>
      <div class="field"><label class="lbl" for="fc-note">Anything to favour or avoid (optional)</label><input id="fc-note" name="focus" type="text" value="${cfg.focus || ''}" placeholder="e.g. companies exporting to Spain or Latin America"></div>
      <div><button class="btn small" type="submit">Save</button></div>
    </form></section>
  <section class="section"><h2>Connections</h2><div class="section">
    ${row('Your private data', Boolean(C.db), 'Stored with this page, readable only by you.', 'Open the page on claude.ai while signed in.')}
    ${row('Writing with Claude', Boolean(C.sample), 'Applications are written on your Claude account when you say you are interested.', 'Not available in this view.')}
    ${row('Gmail', Boolean(C.mcp), 'Approved applications are sent from your Gmail; replies can be checked from each application.', 'Connect Gmail in claude.ai Settings → Connectors.')}
    ${row('Archive', Boolean(C.assets), 'The exact PDFs are stored before each email is sent.', 'Only the page owner can archive files.')}
  </div></section>`;
}

// ---------- events ----------
function closestAct(t) { return t.closest('[data-act]'); }
document.addEventListener('input', (e) => { if (e.target.matches('[data-dirty]')) S.dirty = true; });
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-dirty]')) S.dirty = true;
  if (t.dataset.actChange === 'confirm') {
    const id = curId(); const btn = document.getElementById('send-btn');
    if (t.checked) { S.ui.shownHash[id] = await approvalHash(appById(id)); btn.disabled = false; } else { delete S.ui.shownHash[id]; btn.disabled = true; }
  }
  if (t.dataset.actChange === 'toggle-exp') t.closest('.exp').classList.toggle('off', !t.checked);
});
async function guarded(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { console.error(e); toast(e.message || 'Something went wrong', 'error'); } finally { if (btn?.isConnected) btn.disabled = false; }
}
const curId = () => { const r = route(); return r.startsWith('app-') || r.startsWith('opp-') ? r.slice(4) : null; };

document.addEventListener('click', (e) => {
  const b = closestAct(e.target);
  if (!b || !main.contains(b)) return;
  const act = b.dataset.act; const v = b.dataset.v; const id = curId();
  const A = {
    decide: () => guarded(b, () => decide(b.dataset.id, v)),
    'notif-read': () => guarded(b, () => markNotifRead((n) => n.id === v)),
    'toggle-earlier': () => { S.ui.showEarlier = !S.ui.showEarlier; render(); },
    'run-now': () => guarded(b, runAgentNow),
    pause: () => guarded(b, () => setAgentPaused(true)),
    resume: () => guarded(b, () => setAgentPaused(false)),
    'browser-notif': () => guarded(b, askBrowserNotifications),
    afilter: () => { S.ui.actFilter = v; render(); },
    ptab: () => { if (S.dirty) { toast('Save your changes first, or reload to discard them.', 'error'); return; } S.ui.profileTab = v; render(); },
    edit: () => { if (S.dirty && !v) S.dirty = false; else if (S.dirty) { toast('Save or cancel the current edit first.', 'error'); return; } S.ui.editing[id] = v || null; delete S.ui.shownHash[id]; render(); },
    generate: () => guarded(b, () => generate(id)),
    up: () => { const n = b.closest('.exp'); if (n.previousElementSibling) n.parentNode.insertBefore(n, n.previousElementSibling); S.dirty = true; },
    down: () => { const n = b.closest('.exp'); if (n.nextElementSibling) n.parentNode.insertBefore(n.nextElementSibling, n); S.dirty = true; },
    'add-para': () => { document.getElementById('paras').insertAdjacentHTML('beforeend', html`<div class="row"><textarea id="lt-p${uid()}" name="paragraph" class="tall serif" data-dirty></textarea><button type="button" class="btn small ghost" data-act="rm-para">Remove</button></div>`.s); S.dirty = true; },
    'rm-para': () => { b.closest('.row').remove(); S.dirty = true; },
    send: () => guarded(b, () => approveAndSend(id)),
    'check-sent': () => guarded(b, () => checkSentFolder(id)),
    'ask-verify': () => guarded(b, async () => {
      const a = appById(id); const em = String(document.getElementById('rc-email')?.value || '').trim().toLowerCase();
      if (!em) throw new Error('Enter the address first.');
      await C.db.collection('requests').doc(uid('rq')).set({ kind: 'verify_email', oppId: a.oppId, website: a.website, email: em, evidenceUrl: a.website, status: 'pending', createdAt: nowIso() });
      await log('discover', `Asked your agent to verify ${em} for ${a.orgName}`, { app: id });
      toast('Your agent will check it on its next run.');
    }),
    discard: () => { S.ui.confirm = `discard-${id}`; render(); },
    'cancel-confirm': () => { S.ui.confirm = null; render(); },
    'discard-yes': () => guarded(b, async () => { const a = appById(id); await saveApp(id, { status: 'withdrawn' }); await log('decision', `Unsent application to ${a.orgName} discarded`, { app: id }); S.ui.confirm = null; go('applications'); }),
    restore: () => guarded(b, async () => { const d = S.drafts.find((x) => x.id === v); await updateDraft(id, { cv: d.cv, letter: d.letter, emailSubject: d.emailSubject, emailBody: d.emailBody }, `Version ${d.n} restored`); toast('Version restored'); render(); }),
    pdf: () => guarded(b, async () => { const a = appById(id); const n = fileNames(a); if (v === 'cv') await savePdf(await renderCvPdf(S.profile, a.cv), n.cv); else await savePdf(await renderLetterPdf(S.profile, a, a.letter), n.letter); }),
    'ver-pdf': () => guarded(b, async () => { const d = S.drafts.find((x) => x.id === v); const a = appById(d.appId) || { orgName: d.orgName, language: d.language, city: '' }; const n = fileNames(a); if (b.dataset.w === 'cv') await savePdf(await renderCvPdf(S.profile, d.cv), n.cv.replace('.pdf', `_v${d.n}.pdf`)); else await savePdf(await renderLetterPdf(S.profile, { ...a, language: d.language }, d.letter, d.createdAt), n.letter.replace('.pdf', `_v${d.n}.pdf`)); }),
    'base-cv': () => guarded(b, async () => savePdf(await renderCvPdf(S.profile, {}), `CV_${safeName(S.profile.identity.full_name)}.pdf`)),
    'dl-asset': () => guarded(b, async () => { const r = await fetch(`/_blob/${v}`); if (!r.ok) throw new Error('The archived file could not be read.'); await savePdf(new Uint8Array(await r.arrayBuffer()), b.dataset.name); }),
    replies: () => guarded(b, async () => { await checkReplies(id); render(); }),
    'record-reply': () => guarded(b, async () => { const t = (S.ui.replies[id] || []).find((x) => x.threadId === v); await addEvent(id, { type: 'response', date: (t.date ? new Date(t.date).toISOString() : nowIso()).slice(0, 10), content: `${t.sender}: ${t.subject} – ${t.snippet}`, gmailThread: t.threadId }); toast('Recorded'); render(); }),
    'verify-doc': () => guarded(b, async () => { const r = await fetch(v); if (!r.ok) throw new Error('The archived file could not be read.'); const h = await sha256Hex(new Uint8Array(await r.arrayBuffer())); toast(h === b.dataset.sha ? 'Intact: identical to the file sent' : 'Warning: the stored file does not match its fingerprint', h === b.dataset.sha ? '' : 'error'); }),
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
  S.dirty = false; toast('Saved');
}

document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const fd = new FormData(f); const btn = f.querySelector('[type=submit]'); const id = curId();
  const done = (msg) => { S.ui.editing[id] = null; toast(msg); render(); };
  const F = {
    cv: async () => {
      const a = appById(id);
      const exps = [...f.querySelectorAll('.exp')].map((n) => { const eid = n.dataset.exp; const pe = S.profile.experiences.find((x) => x.id === eid); return { id: eid, include: f.querySelector(`[name="inc_${eid}"]`).checked, bullet_indices: pe.bullets.map((_, i) => i).filter((i) => f.querySelector(`[name="b_${eid}_${i}"]`)?.checked) }; });
      await updateDraft(id, { cv: { ...a.cv, headline: fd.get('headline'), profile: fd.get('profile'), experience_order: exps.map((x) => x.id), experiences: exps, course_highlights: fd.getAll('course') } }, 'CV');
      done('CV saved');
    },
    letter: async () => { await updateDraft(id, { letter: { subject_line: fd.get('subject_line'), recipient_line: fd.get('recipient_line'), salutation: fd.get('salutation'), paragraphs: fd.getAll('paragraph').map((x) => String(x).trim()).filter(Boolean), closing: fd.get('closing') } }, 'Letter'); done('Letter saved'); },
    email: async () => { await updateDraft(id, { emailSubject: fd.get('subject'), emailBody: fd.get('body') }, 'Email'); done('Email saved'); },
    'pick-recipient': async () => {
      const a = appById(id); const c = (oppById(a.oppId)?.contacts || []).find((x) => x.email === fd.get('email'));
      if (!c) throw new Error('Choose an address.');
      await updateDraft(id, { contact: { email: c.email, evidenceUrl: c.evidenceUrl, detail: c.detail, checkedAt: c.checkedAt, verified: true } }, 'Recipient'); done('Recipient changed');
    },
    recipient: async () => {
      const em = String(fd.get('email') || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(em)) throw new Error('This does not look like an email address.');
      if (!fd.get('confirm')) throw new Error('Tick the box to confirm you checked the address.');
      const a = appById(id);
      await updateDraft(id, { contact: { email: em, reviewedByYou: true, reviewedAt: nowIso(), detail: String(fd.get('source') || '').trim() ? `You found it: ${String(fd.get('source')).trim()}` : 'Confirmed by you' } }, 'Recipient');
      await log('decision', `You confirmed ${em} as the recipient for ${a.orgName}`, { app: id });
      done('Address confirmed');
    },
    regen: async () => generate(id, { language: fd.get('language'), instructions: String(fd.get('instructions') || '').trim() || undefined }),
    status: async () => { const a = appById(id); await saveApp(id, { status: fd.get('status'), events: [...(a.events || []), { type: 'status', date: nowIso().slice(0, 10), content: `Status: ${STATUS[fd.get('status')]}` }] }); await log('archive', `${a.orgName}: status changed to ${STATUS[fd.get('status')]}`, { app: id }); toast('Status updated'); render(); },
    event: async () => { await addEvent(id, { type: fd.get('type'), date: fd.get('date') || nowIso().slice(0, 10), content: String(fd.get('content')).trim() }); f.reset(); toast('Saved'); render(); },
    focus: async () => { await C.db.doc('agent/config').update({ areas: fd.getAll('areas'), focus: String(fd.get('focus') || '').trim(), updatedAt: nowIso() }); await log('search', 'You updated what your agent looks for'); toast('Saved. Your agent uses this from its next run.'); },
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
      await saveProfile(p, 'Skills reviewed'); render();
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
  // Read the schedule once the config has arrived (no polling).
  const wait = setInterval(() => { if (S.agentConfig) { clearInterval(wait); refreshTrigger(); } }, 1000);
  setTimeout(() => clearInterval(wait), 30000);
}
boot();
