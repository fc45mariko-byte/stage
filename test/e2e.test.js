// End-to-end test of the main journey:
// discover → review → interested → generate → edit → approve → send → archive.
// Runs the real server as a child process against local fixtures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startSite, startMockClaude, startSmtp } from './fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let site; let claude; let smtp; let proc; let base; let cookie = ''; let dataDir;

async function call(p, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${p}`, {
    method, headers: { 'x-requested-with': 'stage-app', 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

async function waitJob(id) {
  for (let i = 0; i < 200; i++) {
    const { data } = await call(`/api/jobs/${id}`);
    if (data.status !== 'running') return data;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('job timeout');
}

before(async () => {
  site = await startSite();
  claude = await startMockClaude({ siteUrl: site.url });
  smtp = await startSmtp();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-test-'));
  const port = 3900 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/proxy/i.test(k)) delete env[k];
  Object.assign(env, {
    PORT: String(port), DATA_DIR: dataDir, BASE_URL: base,
    ANTHROPIC_API_KEY: 'test-key', AI_BASE_URL: claude.url,
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_USER: 'fc45.mariko@gmail.com', SMTP_PASS: 'x', SMTP_ALLOW_INSECURE_TLS: 'true',
    ALLOW_LOCAL_FETCH: 'true', SKIP_MX_CHECK: 'true', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  });
  proc = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/auth/state`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(() => {
  proc?.kill();
  site?.server.close(); claude?.server.close(); smtp?.server.close();
});

test('complete application journey', async () => {
  // --- auth
  assert.equal((await call('/api/overview')).status, 401, 'API requires a session');
  assert.equal((await call('/api/auth/setup', { method: 'POST', body: { email: 'fc45.mariko@gmail.com', password: 'a-long-password' } })).status, 200);
  assert.equal((await call('/api/auth/setup', { method: 'POST', body: { email: 'x@y.fr', password: 'another-password' } })).status, 409, 'only one account');
  const noHeader = await fetch(`${base}/api/search`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403, 'CSRF header required');

  // --- discovery
  const s = await call('/api/search', { method: 'POST', body: { area: 'orleans', sector: 'any', count: 3 } });
  assert.equal(s.status, 200);
  const job = await waitJob(s.data.jobId);
  assert.equal(job.status, 'done', job.error);
  const searchReq = claude.requests[0];
  assert.ok(searchReq.tools.some((t) => t.type === 'web_search_20260209'), 'uses the real web search tool');
  assert.equal(searchReq.model, 'claude-opus-5-5');
  const runs = (await call('/api/search-runs')).data;
  assert.equal(runs[0].candidates_proposed, 2);
  assert.equal(runs[0].candidates_accepted, 1, 'the invented organization is rejected');
  assert.ok(runs[0].log.some((l) => l.includes('Ghost Trading') && l.includes('not supported by any actual search result')));

  const opps = (await call('/api/opportunities?status=new')).data.items;
  assert.equal(opps.length, 1);
  const opp = opps[0];
  assert.equal(opp.name, 'Loire Export Négoce');
  assert.equal(opp.kind, 'published', 'listing page verified');
  assert.equal(opp.best_email, 'stages@loire-export.example', 'recommended verified address (de-obfuscated from the page)');
  assert.match(opp.location_evidence, /Orléans|45000/);
  assert.equal(smtp.received.length, 0, 'nobody contacted during discovery');

  // --- decision → generation
  const dec = await call(`/api/opportunities/${opp.id}/decision`, { method: 'POST', body: { decision: 'interested' } });
  assert.ok(dec.data.applicationId && dec.data.jobId);
  const appId = dec.data.applicationId;
  assert.equal((await waitJob(dec.data.jobId)).status, 'done');
  let d = (await call(`/api/applications/${appId}`)).data;
  assert.equal(d.application.status, 'draft');
  assert.equal(d.contact.email, 'stages@loire-export.example');
  assert.ok(d.application.letter.paragraphs.length >= 3);
  assert.equal(d.versions.length, 1);

  // --- cannot send a draft
  assert.equal((await call(`/api/applications/${appId}/send`, { method: 'POST', body: { confirm: true, approvedHash: 'x' } })).status, 400);

  // --- previews render as PDF
  const pv = await call(`/api/applications/${appId}/preview/cv.pdf`);
  assert.equal(pv.status, 200);
  assert.equal(pv.data.subarray(0, 5).toString(), '%PDF-');

  // --- edit the letter → new version
  const letter = { ...d.application.letter, paragraphs: [...d.application.letter.paragraphs, 'Je reste disponible pour un entretien à votre convenance.'] };
  d = (await call(`/api/applications/${appId}`, { method: 'PATCH', body: { letter } })).data;
  assert.equal(d.versions.length, 2);

  // --- an unverified address cannot be used
  const bad = await call('/api/contacts', { method: 'POST', body: { organization_id: d.organization.id, email: 'random@loire-export.example', evidence_url: `${site.url}/other` } });
  assert.equal(bad.data.status, 'unverified');
  await call(`/api/applications/${appId}`, { method: 'PATCH', body: { contact_id: bad.data.id } });
  assert.equal((await call(`/api/applications/${appId}/approve`, { method: 'POST' })).status, 400, 'approval refused for unverified recipient');
  d = (await call(`/api/applications/${appId}`, { method: 'PATCH', body: { contact_id: d.contacts.find((c) => c.email === 'stages@loire-export.example').id } })).data;

  // --- approve, then the final send rules
  d = (await call(`/api/applications/${appId}/approve`, { method: 'POST' })).data;
  assert.equal(d.application.status, 'awaiting_approval');
  assert.equal((await call(`/api/applications/${appId}/send`, { method: 'POST', body: { confirm: false, approvedHash: d.application.approved_hash } })).status, 400, 'explicit confirmation needed');
  assert.equal((await call(`/api/applications/${appId}/send`, { method: 'POST', body: { confirm: true, approvedHash: 'stale' } })).status, 409, 'stale approval rejected');
  assert.equal(smtp.received.length, 0);

  const sent = await call(`/api/applications/${appId}/send`, { method: 'POST', body: { confirm: true, approvedHash: d.application.approved_hash } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.ok(sent.data.messageId);

  // --- the email really arrived, with the exact archived PDFs
  assert.equal(smtp.received.length, 1);
  const { mail, envelope } = smtp.received[0];
  assert.deepEqual(envelope.rcptTo.map((r) => r.address), ['stages@loire-export.example']);
  assert.equal(mail.subject, d.application.email_subject);
  assert.equal(mail.attachments.length, 2);
  d = (await call(`/api/applications/${appId}`)).data;
  assert.equal(d.application.status, 'sent');
  const attempt = d.attempts[0];
  assert.equal(attempt.status, 'sent');
  for (const att of mail.attachments) {
    const hash = crypto.createHash('sha256').update(att.content).digest('hex');
    const doc = d.documents.find((x) => x.sha256 === hash);
    assert.ok(doc, `attachment ${att.filename} matches an archived document`);
    const dl = await call(`/api/documents/${doc.id}/file`);
    assert.equal(crypto.createHash('sha256').update(dl.data).digest('hex'), hash, 'archive serves identical bytes');
  }

  // --- sent documents are immutable at database level
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'stage.db'));
  assert.throws(() => db.prepare("UPDATE documents SET label = 'x' WHERE kind = 'sent_cv'").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM documents WHERE kind = 'sent_letter'").run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE send_attempts SET recipient = 'x'").run(), /cannot be modified/);
  db.close();

  // --- editing after sending is refused
  assert.equal((await call(`/api/applications/${appId}`, { method: 'PATCH', body: { email_subject: 'changed' } })).status, 400);

  // --- updating the profile does not change archived documents
  const prof = (await call('/api/profile')).data;
  prof.data.identity.headline = 'Changed headline';
  assert.equal((await call('/api/profile', { method: 'PUT', body: { data: prof.data, note: 'test' } })).status, 200);
  const cvDoc = d.documents.find((x) => x.id === attempt.cv_document_id);
  const again = await call(`/api/documents/${cvDoc.id}/file`);
  assert.equal(crypto.createHash('sha256').update(again.data).digest('hex'), cvDoc.sha256);

  // --- follow-up tracking and stats
  await call(`/api/applications/${appId}/events`, { method: 'POST', body: { type: 'response', occurred_on: '2026-11-10', content: 'Réponse positive, entretien proposé.' } });
  await call(`/api/applications/${appId}/events`, { method: 'POST', body: { type: 'interview', occurred_on: '2026-11-18', content: 'Entretien téléphonique.' } });
  const ov = (await call('/api/overview')).data;
  assert.deepEqual([ov.stats.organizations, ov.stats.sent, ov.stats.responses, ov.stats.interviews], [1, 1, 1, 1]);
  const acts = (await call('/api/activity')).data.map((a) => a.type);
  for (const t of ['search', 'discover', 'decision', 'generate', 'edit', 'approve', 'send', 'archive']) assert.ok(acts.includes(t), `activity has ${t}`);

  // --- duplicate organization is refused on manual add
  const add = await call('/api/organizations', { method: 'POST', body: { website: site.url, area: 'orleans' } });
  const addJob = await waitJob(add.data.jobId);
  assert.equal(addJob.status, 'failed');
  assert.match(addJob.error, /already/);
});
