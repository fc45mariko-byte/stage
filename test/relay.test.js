// Outbox mode: confirmed applications wait for the assistant to send them via Gmail.
// Runs the real server as a child process against local fixtures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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
    SMTP_HOST: '', EMAIL_RELAY: 'assistant', EMAIL_RELAY_SENDER: 'fc45.mariko@gmail.com',
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

test('outbox mode never marks an application sent without a Gmail message id', async () => {
  await call('/api/auth/setup', { method: 'POST', body: { email: 'fc45.mariko@gmail.com', password: 'a-long-password' } });
  assert.equal((await waitJob((await call('/api/search', { method: 'POST', body: { area: 'orleans' } })).data.jobId)).status, 'done');
  const opp = (await call('/api/opportunities?status=new')).data.items[0];
  const dec = (await call(`/api/opportunities/${opp.id}/decision`, { method: 'POST', body: { decision: 'interested' } })).data;
  await waitJob(dec.jobId);
  const id = dec.applicationId;
  const d = (await call(`/api/applications/${id}/approve`, { method: 'POST' })).data;
  assert.equal(d.email.provider, 'assistant_relay');
  const r = await call(`/api/applications/${id}/send`, { method: 'POST', body: { confirm: true, approvedHash: d.application.approved_hash } });
  assert.equal(r.status, 200);
  assert.equal(r.data.queued, true);
  let after = (await call(`/api/applications/${id}`)).data;
  assert.equal(after.application.status, 'queued');
  assert.equal((await call('/api/overview')).data.stats.sent, 0, 'not counted as sent');
  assert.equal(smtp.received.length, 0);

  const env = { ...process.env, DATA_DIR: dataDir };
  const relay = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'scripts/relay.mjs'), ...args], { env }).toString();
  const list = JSON.parse(relay('list'));
  assert.equal(list.length, 1);
  assert.equal(list[0].to, 'stages@loire-export.example');
  const b64 = relay('b64', String(list[0].attachments[0].documentId));
  assert.equal(crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'), list[0].attachments[0].sha256);
  relay('complete', String(list[0].attemptId), 'gmail-msg-123', 'thread-1');
  after = (await call(`/api/applications/${id}`)).data;
  assert.equal(after.application.status, 'sent');
  assert.equal(after.attempts[0].provider_message_id, 'gmail-msg-123');
  assert.equal(JSON.parse(relay('list')).length, 0);
  assert.equal((await call('/api/overview')).data.stats.sent, 1);
});
