// JSON API consumed by the web interface. Every route requires a session.
import express from 'express';
import multer from 'multer';
import { get, all, run, insert, now, parse, getSetting, setSetting } from '../db/index.js';
import { requireAuth } from '../auth/index.js';
import { startJob, getJob } from '../lib/jobs.js';
import { logActivity } from '../lib/activity.js';
import { aiAvailable } from '../ai/client.js';
import { config } from '../config.js';
import { randomToken } from '../lib/crypto.js';
import { currentProfile, saveProfile, listProfileVersions, profileVersion } from '../profile/service.js';
import { importHandbook, extractHandbook, markHandbookFailed, currentHandbook } from '../documents/handbook.js';
import { storeFile, getDocument, readDocument } from '../documents/storage.js';
import { renderCvPdf, renderLetterPdf } from '../documents/pdf.js';
import { createSearchRun, runDiscovery, addOrganizationManually, SECTORS } from '../research/discovery.js';
import { verifyEmail } from '../research/verify.js';
import { emailStatus } from '../email/index.js';
import { gmailConfigured, gmailAuthUrl, gmailHandleCallback, gmailDisconnect } from '../email/gmail.js';
import * as A from '../applications.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const intId = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new A.UserError('Invalid id', 400); return n; };

function oppRow(o) {
  return {
    ...o,
    responsibilities: parse(o.responsibilities_json, []), match_reasons: parse(o.match_reasons_json, []), concerns: parse(o.concerns_json, []),
    listing_check: parse(o.listing_check_json), responsibilities_json: undefined, match_reasons_json: undefined, concerns_json: undefined, listing_check_json: undefined,
  };
}

function opportunityWithOrg(id) {
  const o = get('SELECT * FROM opportunities WHERE id = ?', id);
  if (!o) return null;
  const org = get('SELECT * FROM organizations WHERE id = ?', o.organization_id);
  const contacts = all("SELECT * FROM contacts WHERE organization_id = ? ORDER BY status = 'verified' DESC, id", org.id);
  const app = get("SELECT id, status FROM applications WHERE opportunity_id = ? AND status != 'withdrawn' ORDER BY id DESC LIMIT 1", id);
  return {
    ...oppRow(o),
    organization: { ...org, pages: parse(org.pages_json, []).map(({ text, ...p }) => p), search_sources: parse(org.search_source_urls_json, []), website_check: parse(org.website_check_json), pages_json: undefined, search_source_urls_json: undefined, website_check_json: undefined },
    contacts, application: app,
  };
}

export function apiRouter() {
  const r = express.Router();

  // Gmail OAuth callback is a top-level browser navigation (cookie is sent
  // because the redirect returns to our own origin, SameSite=Strict allows
  // it only for same-site navigations — so we validate a one-time state).
  r.get('/integrations/gmail/callback', wrap(async (req, res) => {
    const st = getSetting('gmail_oauth_state');
    setSetting('gmail_oauth_state', null);
    const [token, exp] = String(st || '').split('|');
    if (!token || token !== req.query.state || Number(exp) < Date.now()) return res.redirect('/#/settings?gmail=state_error');
    if (req.query.error) return res.redirect(`/#/settings?gmail=${encodeURIComponent(String(req.query.error))}`);
    try {
      const email = await gmailHandleCallback(String(req.query.code || ''));
      logActivity('system', `Gmail connected (${email}); the app can now send emails on your behalf, only after your approval`);
      res.redirect('/#/settings?gmail=connected');
    } catch (e) {
      logActivity('error', `Gmail connection failed: ${e.message}`);
      res.redirect(`/#/settings?gmail=${encodeURIComponent(e.message)}`);
    }
  }));

  r.use(requireAuth);

  // ---------- overview ----------
  r.get('/overview', (req, res) => {
    const stats = {
      organizations: get('SELECT COUNT(*) n FROM organizations').n,
      newOpportunities: get("SELECT COUNT(*) n FROM opportunities WHERE status = 'new'").n,
      saved: get("SELECT COUNT(*) n FROM opportunities WHERE status = 'saved'").n,
      sent: get("SELECT COUNT(DISTINCT application_id) n FROM send_attempts WHERE status = 'sent'").n,
      responses: get("SELECT COUNT(DISTINCT application_id) n FROM application_events WHERE type = 'response'").n,
      interviews: get("SELECT COUNT(*) n FROM applications WHERE status IN ('interview','accepted') OR id IN (SELECT application_id FROM application_events WHERE type = 'interview')").n,
      drafts: get("SELECT COUNT(*) n FROM applications WHERE status IN ('draft','generating','awaiting_approval')").n,
    };
    const prof = currentProfile().data;
    res.json({
      stats,
      recentActivity: all('SELECT * FROM activity ORDER BY id DESC LIMIT 8'),
      activeJobs: all("SELECT * FROM jobs WHERE status = 'running' ORDER BY id DESC"),
      followUps: all(`SELECT a.id, o.name, s.finished_at FROM applications a JOIN send_attempts s ON s.id = a.sent_attempt_id
        JOIN opportunities op ON op.id = a.opportunity_id JOIN organizations o ON o.id = op.organization_id
        WHERE a.status = 'sent' AND s.finished_at < ? AND a.id NOT IN (SELECT application_id FROM application_events WHERE type IN ('response','follow_up'))`, new Date(Date.now() - 14 * 864e5).toISOString()),
      awaiting: all(`SELECT a.id, a.status, o.name FROM applications a JOIN opportunities op ON op.id = a.opportunity_id JOIN organizations o ON o.id = op.organization_id WHERE a.status IN ('draft','awaiting_approval','generating','queued') ORDER BY a.updated_at DESC LIMIT 6`),
      openQuestions: prof.questions.filter((q) => q.status === 'open').length,
      suggestedSkills: prof.transferable.filter((t) => t.status === 'suggested').length,
      handbook: Boolean(currentHandbook()),
      integrations: { ai: aiAvailable(), email: emailStatus().ready },
    });
  });

  // ---------- discovery ----------
  r.get('/opportunities', (req, res) => {
    const status = String(req.query.status || 'new');
    const area = String(req.query.area || '');
    const where = []; const params = [];
    if (status !== 'all') { where.push('op.status = ?'); params.push(status); }
    if (area) { where.push('o.area = ?'); params.push(area); }
    const rows = all(`SELECT op.*, o.name, o.website, o.domain, o.area, o.city, o.industry, o.description, o.origin, o.location_evidence, o.search_source_urls_json, o.created_at AS org_created_at,
        (SELECT COUNT(*) FROM contacts c WHERE c.organization_id = o.id AND c.status = 'verified') AS verified_contacts,
        (SELECT email FROM contacts c WHERE c.organization_id = o.id AND c.status = 'verified' ORDER BY (label = 'Recommended by agent') DESC, id LIMIT 1) AS best_email,
        (SELECT evidence_url FROM contacts c WHERE c.organization_id = o.id AND c.status = 'verified' ORDER BY (label = 'Recommended by agent') DESC, id LIMIT 1) AS best_email_source,
        (SELECT a.id FROM applications a WHERE a.opportunity_id = op.id AND a.status != 'withdrawn' ORDER BY a.id DESC LIMIT 1) AS application_id
      FROM opportunities op JOIN organizations o ON o.id = op.organization_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE op.fit WHEN 'strong' THEN 0 WHEN 'possible' THEN 1 WHEN 'weak' THEN 2 ELSE 3 END, op.id DESC`, ...params);
    const counts = Object.fromEntries(all('SELECT status, COUNT(*) n FROM opportunities GROUP BY status').map((x) => [x.status, x.n]));
    res.json({ items: rows.map((o) => ({ ...oppRow(o), search_sources: parse(o.search_source_urls_json, []), search_source_urls_json: undefined })), counts });
  });

  r.get('/opportunities/:id', (req, res) => {
    const o = opportunityWithOrg(intId(req.params.id));
    if (!o) return res.status(404).json({ error: 'Not found' });
    res.json(o);
  });

  r.post('/opportunities/:id/decision', wrap(async (req, res) => {
    const id = intId(req.params.id);
    const { decision } = req.body || {};
    if (!['interested', 'not_interested', 'saved', 'new'].includes(decision)) throw new A.UserError('Invalid decision');
    const o = opportunityWithOrg(id);
    if (!o) throw new A.UserError('Not found', 404);
    run('UPDATE opportunities SET status = ?, decided_at = ? WHERE id = ?', decision, now(), id);
    const label = { interested: 'Interested', not_interested: 'Not interested', saved: 'Saved for later', new: 'Moved back to new' }[decision];
    logActivity('decision', `${label}: ${o.organization.name}`, { type: 'opportunity', id });
    let applicationId = null; let jobId = null;
    if (decision === 'interested') {
      applicationId = A.createApplication(id);
      const app = get('SELECT * FROM applications WHERE id = ?', applicationId);
      if (aiAvailable() && !app.cv_json && app.status === 'draft') {
        jobId = startJob('generate', applicationId, (p) => A.generateForApplication(applicationId, {}, p));
      }
    }
    res.json({ ok: true, applicationId, jobId });
  }));

  r.get('/search/options', (req, res) => res.json({ sectors: SECTORS, ai: aiAvailable() }));
  r.post('/search', (req, res) => {
    if (!aiAvailable()) throw new A.UserError('Web research needs the AI to be configured (ANTHROPIC_API_KEY). You can still add organizations manually.', 503);
    const area = ['orleans', 'paris'].includes(req.body?.area) ? req.body.area : 'orleans';
    const sector = SECTORS[req.body?.sector] ? req.body.sector : 'any';
    const count = Math.min(10, Math.max(1, Number(req.body?.count) || 6));
    const runId = createSearchRun({ area, sector, count });
    const jobId = startJob('search', runId, (p) => runDiscovery(runId, p));
    res.json({ runId, jobId });
  });
  r.get('/search-runs', (req, res) => res.json(all('SELECT id, params_json, status, stage, candidates_proposed, candidates_accepted, error, started_at, finished_at, log_json FROM search_runs ORDER BY id DESC LIMIT 20').map((x) => ({ ...x, params: parse(x.params_json), log: parse(x.log_json, []) }))));

  r.post('/organizations', (req, res) => {
    const { website, name, area, listingUrl } = req.body || {};
    if (!website) throw new A.UserError('Website is required');
    const jobId = startJob('add_organization', null, async (p) => {
      const id = await addOrganizationManually({ website, name, area: ['orleans', 'paris'].includes(area) ? area : 'other', listingUrl }, p);
      p(`opportunity:${id}`);
    });
    res.json({ jobId });
  });

  // ---------- contacts ----------
  r.post('/contacts', wrap(async (req, res) => {
    const { organization_id: orgId, email, evidence_url: evidenceUrl } = req.body || {};
    const org = get('SELECT * FROM organizations WHERE id = ?', Number(orgId));
    if (!org) throw new A.UserError('Organization not found', 404);
    const v = await verifyEmail({ email, evidenceUrl, orgWebsite: org.website });
    const addr = String(email).trim().toLowerCase();
    const existing = get('SELECT id FROM contacts WHERE organization_id = ? AND email = ?', org.id, addr);
    let id;
    if (existing) { run('UPDATE contacts SET evidence_url = ?, status = ?, status_detail = ?, mx_status = ?, checked_at = ? WHERE id = ?', v.evidenceUrl || evidenceUrl, v.status, v.detail, v.mx, v.checkedAt, existing.id); id = existing.id; }
    else id = insert('INSERT INTO contacts(organization_id, email, label, evidence_url, status, status_detail, mx_status, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', org.id, addr, 'Added by you', v.evidenceUrl || evidenceUrl || null, v.status, v.detail, v.mx, v.checkedAt, now());
    logActivity('discover', `Contact ${addr} for ${org.name}: ${v.status} (${v.detail})`, { type: 'organization', id: org.id });
    res.json(get('SELECT * FROM contacts WHERE id = ?', id));
  }));

  r.post('/contacts/:id/verify', wrap(async (req, res) => {
    const c = get('SELECT * FROM contacts WHERE id = ?', intId(req.params.id));
    if (!c) throw new A.UserError('Not found', 404);
    const org = get('SELECT * FROM organizations WHERE id = ?', c.organization_id);
    const v = await verifyEmail({ email: c.email, evidenceUrl: c.evidence_url, orgWebsite: org.website });
    run('UPDATE contacts SET status = ?, status_detail = ?, mx_status = ?, checked_at = ? WHERE id = ?', v.status, v.detail, v.mx, v.checkedAt, c.id);
    res.json(get('SELECT * FROM contacts WHERE id = ?', c.id));
  }));

  // ---------- applications ----------
  r.get('/applications', (req, res) => {
    res.json(all(`SELECT a.id, a.status, a.language, a.position_title, a.created_at, a.updated_at, a.generation_error, op.kind, op.position_title AS opp_position,
        o.name, o.website, o.area, o.city, c.email AS recipient, s.finished_at AS sent_at, s.provider,
        (SELECT COUNT(*) FROM application_events e WHERE e.application_id = a.id AND e.type = 'response') AS responses,
        (SELECT MAX(occurred_on) FROM application_events e WHERE e.application_id = a.id AND e.type != 'status') AS last_event
      FROM applications a JOIN opportunities op ON op.id = a.opportunity_id JOIN organizations o ON o.id = op.organization_id
      LEFT JOIN contacts c ON c.id = a.contact_id LEFT JOIN send_attempts s ON s.id = a.sent_attempt_id
      WHERE a.status != 'withdrawn' ORDER BY a.updated_at DESC`));
  });

  r.get('/applications/:id', (req, res) => res.json(A.applicationDetail(intId(req.params.id))));

  r.post('/applications/:id/generate', (req, res) => {
    const id = intId(req.params.id);
    const { app } = A.loadContext(id);
    if (!aiAvailable()) throw new A.UserError('AI generation is not configured (ANTHROPIC_API_KEY). You can write the documents yourself in the editor.', 503);
    if (!A.EDITABLE.includes(app.status)) throw new A.UserError(`Cannot regenerate when the application is "${app.status}".`);
    const language = ['fr', 'en'].includes(req.body?.language) ? req.body.language : app.language;
    const instructions = String(req.body?.instructions || '').slice(0, 2000) || undefined;
    run("UPDATE applications SET status = 'generating', updated_at = ? WHERE id = ?", now(), id);
    const jobId = startJob('generate', id, (p) => A.generateForApplication(id, { language, instructions }, p));
    res.json({ jobId });
  });

  r.post('/applications/:id/start-manual', (req, res) => {
    // Lets the user write documents without AI: starts from the base CV and an empty letter.
    const id = intId(req.params.id);
    const { app } = A.loadContext(id);
    if (app.cv_json) throw new A.UserError('Documents already exist');
    const prof = currentProfile().data;
    A.updateDraft(id, {
      cv: { headline: prof.identity.headline, profile: prof.internship.cv_profile_text, experience_order: prof.experiences.map((e) => e.id), experiences: prof.experiences.map((e) => ({ id: e.id, include: true, bullet_indices: e.bullets.map((_, i) => i) })), course_highlights: [], skills_order: prof.skills.map((s) => s.id) },
      letter: { subject_line: 'Candidature spontanée – stage de 6 semaines (avril–juin 2027)', recipient_line: '', salutation: 'Madame, Monsieur,', paragraphs: [''], closing: "Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées." },
      email_subject: '', email_body: '',
    });
    res.json({ ok: true });
  });

  r.patch('/applications/:id', (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const k of ['cv', 'letter', 'email_subject', 'email_body', 'contact_id', 'language']) if (k in b) patch[k] = b[k];
    if (patch.language && !['fr', 'en'].includes(patch.language)) throw new A.UserError('Invalid language');
    A.updateDraft(intId(req.params.id), patch);
    res.json(A.applicationDetail(intId(req.params.id)));
  });

  r.post('/applications/:id/approve', (req, res) => { A.approveDocuments(intId(req.params.id)); res.json(A.applicationDetail(intId(req.params.id))); });
  r.post('/applications/:id/revoke', (req, res) => { A.revokeApproval(intId(req.params.id)); res.json(A.applicationDetail(intId(req.params.id))); });
  r.post('/applications/:id/discard', (req, res) => { A.withdrawDraft(intId(req.params.id)); res.json({ ok: true }); });
  r.post('/applications/:id/send', wrap(async (req, res) => {
    const result = await A.sendApplication(intId(req.params.id), { confirm: req.body?.confirm, approvedHash: req.body?.approvedHash });
    res.json({ ok: true, ...result, detail: A.applicationDetail(intId(req.params.id)) });
  }));
  r.post('/applications/:id/status', (req, res) => { A.setStatus(intId(req.params.id), req.body?.status, req.body?.note); res.json(A.applicationDetail(intId(req.params.id))); });
  r.post('/applications/:id/events', (req, res) => { A.addEvent(intId(req.params.id), req.body || {}); res.json(A.applicationDetail(intId(req.params.id))); });

  const sendPdf = (res, buf, filename, download) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  };

  r.get('/applications/:id/preview/:which.pdf', wrap(async (req, res) => {
    const { app, org } = A.loadContext(intId(req.params.id));
    if (!app.cv_json || !app.letter_json) throw new A.UserError('No documents yet', 404);
    const { cv, letter } = await A.renderDrafts(app, org);
    sendPdf(res, req.params.which === 'cv' ? cv : letter, `${req.params.which === 'cv' ? 'CV' : 'Lettre'}_apercu.pdf`, req.query.download === '1');
  }));

  r.get('/versions/:vid/:which.pdf', wrap(async (req, res) => {
    const v = get('SELECT * FROM draft_versions WHERE id = ?', intId(req.params.vid));
    if (!v) throw new A.UserError('Not found', 404);
    const { app, org } = A.loadContext(v.application_id);
    const prof = profileVersion(app.profile_version_id) || currentProfile();
    const buf = req.params.which === 'cv'
      ? await renderCvPdf(prof.data, parse(v.cv_json))
      : await renderLetterPdf(prof.data, parse(v.letter_json), { orgName: org.name, orgCity: org.city, lang: app.language, date: v.created_at });
    sendPdf(res, buf, `${req.params.which}_v${v.version_no}.pdf`, req.query.download === '1');
  }));

  r.post('/versions/:vid/restore', (req, res) => {
    const v = get('SELECT * FROM draft_versions WHERE id = ?', intId(req.params.vid));
    if (!v) throw new A.UserError('Not found', 404);
    A.updateDraft(v.application_id, { cv: parse(v.cv_json), letter: parse(v.letter_json), email_subject: v.email_subject, email_body: v.email_body });
    res.json(A.applicationDetail(v.application_id));
  });

  // ---------- documents ----------
  r.get('/documents', (req, res) => {
    const docs = all(`SELECT d.id, d.kind, d.label, d.filename, d.mime, d.sha256, d.size, d.immutable, d.created_at, d.application_id, o.name AS org_name,
        s.status AS send_status, s.recipient
      FROM documents d LEFT JOIN applications a ON a.id = d.application_id LEFT JOIN opportunities op ON op.id = a.opportunity_id LEFT JOIN organizations o ON o.id = op.organization_id
      LEFT JOIN send_attempts s ON (s.cv_document_id = d.id OR s.letter_document_id = d.id)
      ORDER BY d.id DESC`);
    const versions = all(`SELECT v.id, v.application_id, v.version_no, v.source, v.created_at, o.name AS org_name, a.status AS app_status
      FROM draft_versions v JOIN applications a ON a.id = v.application_id JOIN opportunities op ON op.id = a.opportunity_id JOIN organizations o ON o.id = op.organization_id
      ORDER BY v.id DESC LIMIT 200`);
    res.json({ documents: docs, versions, profileVersions: listProfileVersions() });
  });

  r.get('/documents/:id/file', (req, res) => {
    const d = getDocument(intId(req.params.id));
    if (!d) return res.status(404).json({ error: 'Not found' });
    const buf = readDocument(d);
    res.setHeader('Content-Type', d.mime);
    res.setHeader('Content-Disposition', `${req.query.download === '1' || d.mime !== 'application/pdf' ? 'attachment' : 'inline'}; filename="${d.filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-SHA256', d.sha256);
    res.send(buf);
  });

  r.get('/base-cv.pdf', wrap(async (req, res) => {
    const prof = currentProfile().data;
    const buf = await renderCvPdf(prof, { headline: prof.identity.headline, profile: prof.internship.cv_profile_text });
    sendPdf(res, buf, 'CV_base.pdf', req.query.download === '1');
  }));

  // ---------- activity ----------
  r.get('/activity', (req, res) => {
    const type = String(req.query.type || '');
    const before = Number(req.query.before) || null;
    const where = []; const params = [];
    if (type) { where.push('type = ?'); params.push(type); }
    if (before) { where.push('id < ?'); params.push(before); }
    res.json(all(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 100`, ...params));
  });

  // ---------- profile ----------
  r.get('/profile', (req, res) => {
    res.json({ ...currentProfile(), versions: listProfileVersions(), handbook: currentHandbook(), originals: all("SELECT id, label, filename, created_at FROM documents WHERE kind = 'original_cv' ORDER BY id DESC") });
  });
  r.get('/profile/versions/:id', (req, res) => {
    const p = profileVersion(intId(req.params.id));
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  });
  r.put('/profile', (req, res) => {
    const { data, note } = req.body || {};
    for (const q of data?.questions || []) q.status = q.answer?.trim() ? 'answered' : 'open';
    res.json(saveProfile(data, String(note || 'Profile updated').slice(0, 200)));
  });
  r.post('/profile/handbook', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new A.UserError('No file');
    const id = await importHandbook({ buffer: req.file.buffer, mime: req.file.mimetype, filename: req.file.originalname });
    let jobId = null;
    if (aiAvailable()) jobId = startJob('handbook', id, async () => { try { await extractHandbook(id); } catch (e) { markHandbookFailed(id, e); throw e; } });
    res.json({ id, jobId });
  }));
  r.post('/profile/handbook/:id/extract', (req, res) => {
    const id = intId(req.params.id);
    if (!aiAvailable()) throw new A.UserError('AI is not configured', 503);
    const jobId = startJob('handbook', id, async () => { try { await extractHandbook(id); } catch (e) { markHandbookFailed(id, e); throw e; } });
    res.json({ jobId });
  });
  r.post('/profile/original-cv', upload.single('file'), (req, res) => {
    if (!req.file) throw new A.UserError('No file');
    const d = storeFile({ buffer: req.file.buffer, kind: 'original_cv', label: `Original CV – uploaded ${now().slice(0, 10)}`, filename: req.file.originalname, mime: req.file.mimetype || 'application/octet-stream', immutable: true });
    logActivity('profile', `New original CV uploaded (${req.file.originalname}). Update the facts on the Profile page so documents use it.`, { type: 'document', id: d.id });
    res.json(d);
  });

  // ---------- jobs ----------
  r.get('/jobs/:id', (req, res) => { const j = getJob(intId(req.params.id)); if (!j) return res.status(404).json({ error: 'Not found' }); res.json(j); });

  // ---------- settings / integrations ----------
  r.get('/settings', (req, res) => {
    res.json({
      ai: { available: aiAvailable(), model: config.ai.model, fallbacks: config.ai.fallbacks },
      email: emailStatus(),
      gmail: { configured: gmailConfigured(), redirectUri: config.gmail.redirectUri },
      baseUrl: config.baseUrl, user: req.user.email,
    });
  });
  r.get('/integrations/gmail/connect', (req, res) => {
    if (!gmailConfigured()) return res.redirect('/#/settings?gmail=not_configured');
    const state = randomToken(24);
    setSetting('gmail_oauth_state', `${state}|${Date.now() + 10 * 60_000}`);
    res.redirect(gmailAuthUrl(state));
  });
  r.post('/integrations/gmail/disconnect', wrap(async (req, res) => {
    await gmailDisconnect();
    logActivity('system', 'Gmail disconnected');
    res.json({ ok: true });
  }));

  // ---------- errors ----------
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    const status = err.status || (err.code === 'AI_UNAVAILABLE' ? 503 : 500);
    if (status >= 500 && status !== 503 && status !== 502) console.error(err);
    res.status(status).json({ error: err.message || 'Server error' });
  });
  return r;
}
