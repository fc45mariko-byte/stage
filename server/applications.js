// Application lifecycle: draft → (generation) → edits → approval → send → archive.
// All approval and sending rules are enforced here, server-side.
import { get, all, insert, run, now, parse, tx } from './db/index.js';
import { currentProfile, profileVersion } from './profile/service.js';
import { generateApplication, reviewApplication, localChecks } from './documents/generate.js';
import { renderCvPdf, renderLetterPdf } from './documents/pdf.js';
import { storeFile } from './documents/storage.js';
import { verifyEmail } from './research/verify.js';
import { sendEmail, emailStatus } from './email/index.js';
import { aiAvailable, AIUnavailableError } from './ai/client.js';
import { sha256, stableStringify } from './lib/crypto.js';
import { logActivity } from './lib/activity.js';

export const EDITABLE = ['draft', 'awaiting_approval'];
export const POST_SEND = ['sent', 'follow_up', 'interview', 'rejected', 'accepted', 'withdrawn'];

class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
export { UserError };

export function loadContext(appId) {
  const app = get('SELECT * FROM applications WHERE id = ?', appId);
  if (!app) throw new UserError('Application not found', 404);
  const opp = get('SELECT * FROM opportunities WHERE id = ?', app.opportunity_id);
  const org = get('SELECT * FROM organizations WHERE id = ?', opp.organization_id);
  const contact = app.contact_id ? get('SELECT * FROM contacts WHERE id = ?', app.contact_id) : null;
  return { app, opp, org, contact };
}

function defaultContact(orgId) {
  return get(`SELECT * FROM contacts WHERE organization_id = ? AND status = 'verified'
    ORDER BY (label = 'Recommended by agent') DESC,
      (email LIKE 'rh@%' OR email LIKE 'recrutement@%' OR email LIKE 'jobs@%' OR email LIKE 'careers@%' OR email LIKE 'stage%@%') DESC,
      (email LIKE 'contact@%' OR email LIKE 'info@%') DESC, id LIMIT 1`, orgId);
}

export function createApplication(oppId) {
  const opp = get('SELECT * FROM opportunities WHERE id = ?', oppId);
  if (!opp) throw new UserError('Opportunity not found', 404);
  const existing = get("SELECT id FROM applications WHERE opportunity_id = ? AND status != 'withdrawn' ORDER BY id DESC LIMIT 1", oppId);
  if (existing) return existing.id;
  const contact = defaultContact(opp.organization_id);
  const id = insert(
    'INSERT INTO applications(opportunity_id, status, language, profile_version_id, contact_id, position_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    oppId, 'draft', 'fr', currentProfile().versionId, contact?.id ?? null, opp.position_title, now(), now(),
  );
  const org = get('SELECT name FROM organizations WHERE id = ?', opp.organization_id);
  logActivity('decision', `Application draft opened for ${org.name}`, { type: 'application', id });
  return id;
}

function saveVersion(appId, source, { cv, letter, subject, body }) {
  const n = (get('SELECT MAX(version_no) AS n FROM draft_versions WHERE application_id = ?', appId)?.n || 0) + 1;
  insert('INSERT INTO draft_versions(application_id, version_no, source, cv_json, letter_json, email_subject, email_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    appId, n, source, JSON.stringify(cv), JSON.stringify(letter), subject, body, now());
  return n;
}

/** Runs in a background job. */
export async function generateForApplication(appId, { language, instructions } = {}, progress) {
  if (!aiAvailable()) throw new AIUnavailableError();
  const { app, opp, org } = loadContext(appId);
  const lang = language || app.language || 'fr';
  const prof = currentProfile();
  run("UPDATE applications SET status = 'generating', generation_error = NULL, language = ?, profile_version_id = ?, updated_at = ? WHERE id = ?", lang, prof.versionId, now(), appId);
  try {
    const pages = parse(org.pages_json, []);
    progress?.('Writing the CV and cover letter');
    let draft = await generateApplication({ profile: prof.data, org, opp, pages, language: lang, feedback: instructions ? [instructions] : null });
    progress?.('Fact-checking against your profile');
    let review = await reviewApplication({ profile: prof.data, org, opp, pages, language: lang, draft });
    let local = localChecks(draft, lang, prof.data);
    let regenerated = false;
    const serious = review.unsupported_claims.filter((c) => c.severity !== 'low');
    if (serious.length || review.organization_claims_not_in_sources.length || local.some((w) => w.startsWith('Expressions'))) {
      progress?.('Correcting the issues found by the fact-check');
      const feedback = [
        ...serious.map((c) => `Unsupported claim: "${c.excerpt}" – ${c.problem}`),
        ...review.organization_claims_not_in_sources.map((c) => `Claim about the organization not in the sources: ${c}`),
        ...local,
        ...(instructions ? [`Candidate instructions: ${instructions}`] : []),
      ];
      draft = await generateApplication({ profile: prof.data, org, opp, pages, language: lang, feedback, previous: draft });
      review = await reviewApplication({ profile: prof.data, org, opp, pages, language: lang, draft });
      local = localChecks(draft, lang, prof.data);
      regenerated = true;
    }
    const reviewJson = { ...review, local_warnings: local, notes_for_candidate: draft.notes_for_candidate, regenerated, reviewed_at: now() };
    run(`UPDATE applications SET status = 'draft', cv_json = ?, letter_json = ?, email_subject = ?, email_body = ?, review_json = ?, approved_hash = NULL, approved_at = NULL, updated_at = ? WHERE id = ?`,
      JSON.stringify(draft.cv), JSON.stringify(draft.letter), draft.email.subject, draft.email.body, JSON.stringify(reviewJson), now(), appId);
    const v = saveVersion(appId, 'ai', { cv: draft.cv, letter: draft.letter, subject: draft.email.subject, body: draft.email.body });
    const flagged = review.unsupported_claims.length + review.organization_claims_not_in_sources.length;
    logActivity('generate', `Generated CV and cover letter for ${org.name} (version ${v}${regenerated ? ', corrected after fact-check' : ''}${flagged ? `, ${flagged} point(s) to review` : ''})`, { type: 'application', id: appId });
  } catch (e) {
    run("UPDATE applications SET status = 'draft', generation_error = ?, updated_at = ? WHERE id = ?", e.message, now(), appId);
    throw e;
  }
}

/** Manual edits by the user. Any edit withdraws a previous approval. */
export function updateDraft(appId, patch) {
  const { app, org } = loadContext(appId);
  if (!EDITABLE.includes(app.status)) throw new UserError(`Documents cannot be edited when the application is "${app.status}".`);
  const cv = patch.cv ?? parse(app.cv_json);
  const letter = patch.letter ?? parse(app.letter_json);
  const subject = patch.email_subject ?? app.email_subject;
  const body = patch.email_body ?? app.email_body;
  const language = patch.language ?? app.language;
  let contactId = app.contact_id;
  if (patch.contact_id !== undefined) {
    const c = patch.contact_id ? get('SELECT * FROM contacts WHERE id = ?', patch.contact_id) : null;
    if (patch.contact_id && (!c || c.organization_id !== org.id)) throw new UserError('Unknown contact for this organization');
    contactId = c?.id ?? null;
  }
  if (letter && (!Array.isArray(letter.paragraphs) || typeof letter.salutation !== 'string')) throw new UserError('Invalid letter');
  const prof = profileVersion(app.profile_version_id) || currentProfile();
  const review = parse(app.review_json, {}) || {};
  if (cv && letter) review.local_warnings = localChecks({ cv, letter, email: { subject: subject || '', body: body || '' } }, language, prof.data);
  const docsChanged = patch.cv || patch.letter || patch.email_subject !== undefined || patch.email_body !== undefined;
  run(`UPDATE applications SET cv_json = ?, letter_json = ?, email_subject = ?, email_body = ?, language = ?, contact_id = ?, review_json = ?, status = 'draft', approved_hash = NULL, approved_at = NULL, updated_at = ? WHERE id = ?`,
    cv ? JSON.stringify(cv) : null, letter ? JSON.stringify(letter) : null, subject, body, language, contactId, JSON.stringify(review), now(), appId);
  if (docsChanged && cv && letter) {
    const v = saveVersion(appId, 'edit', { cv, letter, subject, body });
    logActivity('edit', `Edited application documents for ${org.name} (version ${v})`, { type: 'application', id: appId });
  }
  if (app.status === 'awaiting_approval') logActivity('approve', `Approval withdrawn for ${org.name} because the application was edited`, { type: 'application', id: appId });
}

export function computeHash(app, contact) {
  return sha256(stableStringify({ cv: parse(app.cv_json), letter: parse(app.letter_json), subject: app.email_subject, body: app.email_body, language: app.language, to: contact?.email ?? null, contactId: app.contact_id }));
}

function readiness(app, contact) {
  const problems = [];
  if (!app.cv_json || !app.letter_json) problems.push('The CV and cover letter have not been written yet.');
  if (!app.email_subject?.trim() || !app.email_body?.trim()) problems.push('The email subject and body are required.');
  if (!contact) problems.push('No recipient is selected.');
  else if (contact.status !== 'verified') problems.push(`The recipient ${contact.email} is not verified.`);
  return problems;
}

export function approveDocuments(appId) {
  const { app, org, contact } = loadContext(appId);
  if (app.status !== 'draft') throw new UserError(`Only a draft can be approved (current status: ${app.status}).`);
  const problems = readiness(app, contact);
  if (problems.length) throw new UserError(problems.join(' '));
  const hash = computeHash(app, contact);
  run("UPDATE applications SET status = 'awaiting_approval', approved_hash = ?, approved_at = ?, updated_at = ? WHERE id = ?", hash, now(), now(), appId);
  logActivity('approve', `Documents approved for ${org.name}; the application now awaits your final send approval`, { type: 'application', id: appId });
  return hash;
}

export function revokeApproval(appId) {
  const { app, org } = loadContext(appId);
  if (app.status !== 'awaiting_approval') throw new UserError('Nothing to withdraw.');
  run("UPDATE applications SET status = 'draft', approved_hash = NULL, approved_at = NULL, updated_at = ? WHERE id = ?", now(), appId);
  logActivity('approve', `Approval withdrawn for ${org.name}`, { type: 'application', id: appId });
}

const safeName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

export async function renderDrafts(app, org) {
  const prof = profileVersion(app.profile_version_id) || currentProfile();
  const cv = await renderCvPdf(prof.data, parse(app.cv_json), 'fr');
  const letter = await renderLetterPdf(prof.data, parse(app.letter_json), { orgName: org.name, orgCity: org.city, lang: app.language });
  return { cv, letter, profile: prof.data };
}

/**
 * Final, explicit send. Requires: status awaiting_approval, the approval hash
 * the user saw, a freshly re-verified recipient and a configured provider.
 * The exact PDFs are stored as immutable snapshots before the send attempt.
 */
export async function sendApplication(appId, { confirm, approvedHash }) {
  const { app, org, contact } = loadContext(appId);
  if (confirm !== true) throw new UserError('Explicit confirmation is required to send.');
  if (app.status !== 'awaiting_approval') throw new UserError('This application has not been approved for sending.');
  const problems = readiness(app, contact);
  if (problems.length) throw new UserError(problems.join(' '));
  const hash = computeHash(app, contact);
  if (hash !== app.approved_hash || approvedHash !== app.approved_hash) throw new UserError('The application changed after approval. Please review and approve it again.', 409);
  const st = emailStatus();
  if (!st.ready) throw new UserError('The application is ready, but it cannot be sent: no email account is connected (see Settings).', 503);

  const recheck = await verifyEmail({ email: contact.email, evidenceUrl: contact.evidence_url, orgWebsite: org.website });
  run('UPDATE contacts SET status = ?, status_detail = ?, mx_status = ?, checked_at = ? WHERE id = ?', recheck.status, recheck.detail, recheck.mx, recheck.checkedAt, contact.id);
  if (recheck.status !== 'verified') {
    run("UPDATE applications SET status = 'draft', approved_hash = NULL, approved_at = NULL, updated_at = ? WHERE id = ?", now(), appId);
    logActivity('error', `Send blocked for ${org.name}: the recipient ${contact.email} could not be re-verified (${recheck.detail})`, { type: 'application', id: appId });
    throw new UserError(`Not sent: the recipient address could no longer be verified (${recheck.detail}).`, 409);
  }

  const { cv, letter, profile } = await renderDrafts(app, org);
  const who = safeName(profile.identity.full_name);
  const cvName = `CV_${who}.pdf`;
  const letterName = `${app.language === 'en' ? 'Cover_letter' : 'Lettre_de_motivation'}_${who}_${safeName(org.name)}.pdf`;
  const stamp = now();
  const { cvDoc, letterDoc, attemptId } = tx(() => {
    const cvDoc = storeFile({ buffer: cv, kind: 'sent_cv', label: `CV – ${org.name} – ${stamp.slice(0, 10)}`, filename: cvName, mime: 'application/pdf', applicationId: appId, immutable: true });
    const letterDoc = storeFile({ buffer: letter, kind: 'sent_letter', label: `Cover letter – ${org.name} – ${stamp.slice(0, 10)}`, filename: letterName, mime: 'application/pdf', applicationId: appId, immutable: true });
    const attemptId = insert('INSERT INTO send_attempts(application_id, status, recipient, subject, body, cv_document_id, letter_document_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      appId, 'sending', contact.email, app.email_subject, app.email_body, cvDoc.id, letterDoc.id, stamp);
    return { cvDoc, letterDoc, attemptId };
  });

  try {
    const r = await sendEmail({
      fromName: profile.identity.full_name, to: contact.email, subject: app.email_subject, text: app.email_body,
      attachments: [{ filename: cvName, content: cv }, { filename: letterName, content: letter }],
    });
    tx(() => {
      run("UPDATE send_attempts SET status = 'sent', provider = ?, sender = ?, provider_message_id = ?, provider_response = ?, finished_at = ? WHERE id = ?", r.provider, r.sender, r.messageId, String(r.response || ''), now(), attemptId);
      run("UPDATE applications SET status = 'sent', sent_attempt_id = ?, updated_at = ? WHERE id = ?", attemptId, now(), appId);
      insert('INSERT INTO application_events(application_id, type, occurred_on, content, created_at) VALUES (?, ?, ?, ?, ?)', appId, 'status', now().slice(0, 10), `Sent to ${contact.email} via ${r.provider}`, now());
    });
    logActivity('send', `Application sent to ${org.name} (${contact.email}) via ${r.provider === 'gmail' ? 'Gmail' : 'SMTP'}; documents archived (CV ${cvDoc.sha256.slice(0, 10)}, letter ${letterDoc.sha256.slice(0, 10)})`, { type: 'application', id: appId });
    return { attemptId, provider: r.provider, messageId: r.messageId };
  } catch (e) {
    run("UPDATE send_attempts SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", e.message, now(), attemptId);
    logActivity('error', `Sending to ${org.name} failed: ${e.message}. Nothing was sent; the application is still awaiting approval.`, { type: 'application', id: appId });
    throw new UserError(`Not sent: ${e.message}`, 502);
  }
}

export function setStatus(appId, status, note) {
  const { app, org } = loadContext(appId);
  if (!POST_SEND.includes(status)) throw new UserError('Invalid status');
  if (!POST_SEND.includes(app.status)) throw new UserError('Status can only be changed after the application has been sent.');
  if (status === 'sent' && !app.sent_attempt_id) throw new UserError('Invalid status');
  run('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?', status, now(), appId);
  insert('INSERT INTO application_events(application_id, type, occurred_on, content, created_at) VALUES (?, ?, ?, ?, ?)', appId, 'status', now().slice(0, 10), `Status: ${status}${note ? ` – ${note}` : ''}`, now());
  logActivity('archive', `${org.name}: status changed to ${status}`, { type: 'application', id: appId });
}

export function addEvent(appId, { type, occurred_on, content }) {
  const { app, org } = loadContext(appId);
  if (!['response', 'follow_up', 'interview', 'note'].includes(type)) throw new UserError('Invalid event type');
  if (!content?.trim()) throw new UserError('Content is required');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(occurred_on || '') ? occurred_on : now().slice(0, 10);
  insert('INSERT INTO application_events(application_id, type, occurred_on, content, created_at) VALUES (?, ?, ?, ?, ?)', appId, type, date, content.trim(), now());
  if (type === 'interview' && ['sent', 'follow_up'].includes(app.status)) run("UPDATE applications SET status = 'interview', updated_at = ? WHERE id = ?", now(), appId);
  logActivity('archive', `${org.name}: ${type.replace('_', '-')} recorded`, { type: 'application', id: appId });
}

export function withdrawDraft(appId) {
  const { app, org } = loadContext(appId);
  if (!EDITABLE.includes(app.status)) throw new UserError('Only an unsent application can be discarded.');
  run("UPDATE applications SET status = 'withdrawn', approved_hash = NULL, updated_at = ? WHERE id = ?", now(), appId);
  logActivity('decision', `Unsent application for ${org.name} discarded`, { type: 'application', id: appId });
}

export function applicationDetail(appId) {
  const { app, opp, org, contact } = loadContext(appId);
  const contacts = all('SELECT * FROM contacts WHERE organization_id = ? ORDER BY status = \'verified\' DESC, id', org.id);
  const attempts = all('SELECT * FROM send_attempts WHERE application_id = ? ORDER BY id DESC', appId);
  const docs = all('SELECT id, kind, label, filename, sha256, size, created_at FROM documents WHERE application_id = ? ORDER BY id DESC', appId);
  const events = all('SELECT * FROM application_events WHERE application_id = ? ORDER BY occurred_on DESC, id DESC', appId);
  const versions = all('SELECT id, version_no, source, created_at FROM draft_versions WHERE application_id = ? ORDER BY version_no DESC', appId);
  const prof = profileVersion(app.profile_version_id);
  return {
    application: { ...app, cv: parse(app.cv_json), letter: parse(app.letter_json), review: parse(app.review_json), cv_json: undefined, letter_json: undefined, review_json: undefined, currentHash: app.cv_json ? computeHash(app, contact) : null },
    opportunity: { ...opp, responsibilities: parse(opp.responsibilities_json, []), match_reasons: parse(opp.match_reasons_json, []), concerns: parse(opp.concerns_json, []) },
    organization: { ...org, pages: parse(org.pages_json, []).map(({ text, ...p }) => p), pages_json: undefined, search_sources: parse(org.search_source_urls_json, []) },
    contact, contacts, attempts, documents: docs, events, versions,
    profileExperiences: prof?.data.experiences ?? currentProfile().data.experiences,
    profileCourses: (prof?.data ?? currentProfile().data).education.flatMap((e) => e.courses),
    profileSkills: (prof?.data ?? currentProfile().data).skills,
    email: emailStatus(),
  };
}
