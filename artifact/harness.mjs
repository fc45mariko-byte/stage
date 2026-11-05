// Local browser test of the artifact page with a stand-in claude.ai runtime
// (in-memory db, scripted Claude answers, fake Gmail that records calls).
//   node artifact/harness.mjs <pdfkit.standalone.js> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { seedProfile } from '../server/profile/seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const { chromium } = require('playwright');
const [pdfkitPath, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const pageBody = fs.readFileSync(path.join(here, 'dist', 'stage.html'), 'utf8');
const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0}</style></head><body>${pageBody}</body></html>`;

const opp = (over) => ({
  name: 'Loire Export Négoce', website: 'https://loire-export.example/', domain: 'loire-export.example', area: 'orleans', city: 'Orléans', industry: 'Négoce de vins (export)',
  kind: 'published', listingUrl: 'https://loire-export.example/recrutement', listingTitle: 'Stage assistant(e) export', listingSource: 'Company website',
  summary: 'The company is looking for an intern to support its export sales administration.',
  description: 'Négociant exportateur de vins du Val de Loire.', position: 'Assistant(e) export', responsibilities: ['Préparer des documents export'], matchReasons: ['Your LEA background is relevant.', 'Your English and Spanish could be useful: they sell to the UK and Spain.'], concerns: ['Small company'], fit: 'strong',
  contacts: [{ email: 'stages@loire-export.example', evidenceUrl: 'https://loire-export.example/contact', status: 'verified', detail: 'Found on https://loire-export.example/contact (checked 2026-11-05)', checkedAt: '2026-11-05', recommended: true }],
  sources: ['https://loire-export.example/'], sourcesText: 'Exportateur de vins du Val de Loire vers le Royaume-Uni et l’Espagne. 45000 Orléans.', status: 'new', createdAt: '2026-11-05T07:50:00Z', websiteCheckedAt: '2026-11-05', ...over,
});
const seed = {
  'profile/current': { data: seedProfile, version: 1, updatedAt: '2026-11-04T10:00:00Z' },
  'handbook/current': { title: 'Livret de stage LEA', filename: 'livret.pdf', academicYear: 'Année universitaire 2021-2022', requirements: [{ topic: 'duration', requirement: '210 hours', quote: 'Le stage de troisième année de Licence est d’une durée de 210 heures', page: '3' }] },
  'agent/config': { triggerId: 'trig_test', scheduleLabel: 'Every morning', areas: ['orleans', 'paris'], notifyEmail: false, paused: false },
  'agent/status': { state: 'idle', lastRunAt: '2026-11-05T07:55:00Z', message: 'Found 2 new opportunities in the Orléans area.', lastFound: 2 },
  'agentRuns/run-1': { startedAt: '2026-11-05T07:40:00Z', finishedAt: '2026-11-05T07:55:00Z', outcome: 'done', candidates: 7, kept: 2, rejected: [{ name: 'Example SA', reason: 'website unreachable' }] },
  'opportunities/opp1': opp({}),
  'opportunities/opp2': opp({ name: 'Atelier Logistique Saran', website: 'https://als.example/', domain: 'als.example', kind: 'speculative', listingUrl: '', position: 'Assistant(e) logistique internationale', summary: 'A freight forwarder near Orléans handling shipments to Spain and Latin America.', contacts: [], createdAt: '2026-11-05T07:52:00Z' }),
  'notifications/n1': { ts: '2026-11-05T07:55:01Z', type: 'opportunity', oppId: 'opp1', title: 'Assistant(e) export', body: 'x', read: false },
  'notifications/n2': { ts: '2026-11-05T07:55:02Z', type: 'opportunity', oppId: 'opp2', title: 'Assistant(e) logistique internationale', body: 'x', read: false },
  'activity/a1': { ts: '2026-11-05T07:55:00Z', type: 'search', message: 'Search run finished: 2 new opportunities from 7 candidates' },
};

const generated = {
  cv: { headline: 'Étudiante en Licence 3 LEA – Commerce international', profile: "Étudiante en troisième année de LEA à l'Université d'Orléans. Je recherche un stage de 6 semaines à débuter entre mi-avril et juin 2027.", experience_order: ['deret', 'croix-rouge'], experiences: [{ id: 'bathart', include: false, bullet_indices: [] }], course_highlights: ['commerce et économie internationale'], skills_order: ['lang'] },
  letter: { subject_line: 'Candidature spontanée – stage de 6 semaines (avril–juin 2027)', recipient_line: 'Service export', salutation: 'Madame, Monsieur,', paragraphs: ["Étudiante en troisième année de LEA à l'Université d'Orléans, je vous adresse ma candidature pour un stage de six semaines entre mi-avril et juin 2027. ".repeat(2), 'Votre activité d’export de vins vers le Royaume-Uni et l’Espagne correspond aux langues que j’étudie. '.repeat(3), 'J’ai travaillé en entrepôt chez Deret, ce qui m’a donné une première idée des flux logistiques. '.repeat(3)], closing: "Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées." },
  email: { subject: 'Candidature spontanée – stage export (avril–juin 2027)', body: 'Madame, Monsieur,\n\nVeuillez trouver ci-joint mon CV et ma lettre de motivation.\n\nCordialement,\nFatima-Christine Mariko' },
  notes_for_candidate: ['Avez-vous une préférence de date de début ?'],
};

const init = ({ seed, generated }) => {
  const store = new Map(Object.entries(seed));
  const listeners = new Set();
  const notify = () => setTimeout(() => listeners.forEach((l) => l()), 0);
  const snapDoc = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
  const collQuery = (cpath, ord, lim) => {
    const run = () => {
      let docs = [...store.keys()].filter((k) => k.startsWith(`${cpath}/`) && k.split('/').length === cpath.split('/').length + 1).map(snapDoc);
      if (ord) docs.sort((a, b) => String(a.data()[ord[0]]).localeCompare(String(b.data()[ord[0]])) * (ord[1] === 'desc' ? -1 : 1));
      if (lim) docs = docs.slice(0, lim);
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
    };
    return {
      orderBy: (f, d) => collQuery(cpath, [f, d], lim), limit: (n) => collQuery(cpath, ord, n), where: () => collQuery(cpath, ord, lim),
      get: async () => run(),
      onSnapshot: (next) => { const l = () => next(run()); listeners.add(l); setTimeout(l, 5); return () => listeners.delete(l); },
      doc: (id) => docRef(`${cpath}/${id || Math.random().toString(36).slice(2)}`),
      add: async (data) => { const r = docRef(`${cpath}/${Math.random().toString(36).slice(2)}`); await r.set(data); return r; },
    };
  };
  const docRef = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => snapDoc(p),
    set: async (d) => { store.set(p, JSON.parse(JSON.stringify(d))); notify(); },
    update: async (d) => { if (!store.has(p)) throw { code: 'invalid_argument' }; store.set(p, { ...store.get(p), ...JSON.parse(JSON.stringify(d)) }); notify(); },
    delete: async () => { store.delete(p); notify(); },
    onSnapshot: (next) => { const l = () => next(snapDoc(p)); listeners.add(l); setTimeout(l, 5); return () => listeners.delete(l); },
    collection: (c) => collQuery(`${p}/${c}`),
  });
  const db = { doc: docRef, collection: (c) => collQuery(c) };
  window.__store = store;
  window.__gmail = [];
  window.__saved = [];
  const sample = async () => ({ text: '' });
  sample.json = async (input) => {
    await new Promise((r) => setTimeout(r, 50));
    if (String(input).startsWith('You are a strict fact-checker')) return { unsupported_claims: [], organization_claims_not_in_sources: [], style_remarks: [] };
    return JSON.parse(JSON.stringify(generated));
  };
  const mcp = {
    callTool: async (server, tool, input) => {
      window.__gmail.push({ server, tool, input });
      if (tool === 'send_message') return { content: [], payload: { id: 'msg-123', threadId: 'thr-1', labelIds: ['SENT'] } };
      if (tool === 'get_trigger') return { content: [], payload: { trigger: { id: 'trig_test', enabled: true, next_run_at: new Date(Date.now() + 20 * 3600e3).toISOString() } } };
      if (tool === 'fire_trigger') return { content: [], payload: { ok: true } };
      if (tool === 'search_threads') return { content: [], payload: { threads: [{ id: 'thr-9', viewUrl: 'https://mail.google.com/x', messages: [{ id: 'm9', subject: 'Re: Candidature', snippet: 'Merci pour votre candidature, pouvons-nous convenir d’un entretien ?', sender: 'rh@loire-export.example', date: '2026-11-10T09:00:00Z' }] }] } };
      throw { code: 'tool_error', message: 'unknown' };
    },
  };
  const blobs = new Map();
  const assets = { upload: async (blob) => { const id = `a${blobs.size + 1}`; blobs.set(id, blob); return { id, url: `/_blob/${id}`, sizeBytes: blob.size, contentType: blob.type }; }, list: async () => ({ assets: [] }) };
  window.__blobs = blobs;
  const downloads = { save: async ({ filename, data }) => { window.__saved.push({ filename, size: data.byteLength || data.length }); return 'saved'; } };
  const caps = { db, user: { isOwner: () => true }, sample, mcp, assets, downloads };
  window.claude = { use: async (n) => caps[n] ?? null };
};

const browser = await chromium.launch();
const errors = [];
async function setup(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.route('https://cdn.jsdelivr.net/**', (r) => r.fulfill({ path: pdfkitPath, contentType: 'text/javascript' }));
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await ctx.route('https://stage.test/_blob/**', async (r) => r.fulfill({ status: 404 }));
  await ctx.route('https://stage.test/', (r) => r.fulfill({ body: doc, contentType: 'text/html' }));
  await ctx.addInitScript(init, { seed, generated });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${viewport.width}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_|404/.test(m.text())) errors.push(`${viewport.width}: ${m.text()}`); });
  return { ctx, page };
}

const shot = (page, name, full = true) => page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: full });
const result = {};
const sha = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
{
  const { page } = await setup({ width: 1280, height: 860 });
  await page.goto('https://stage.test/#home');
  await page.waitForSelector('.disc');
  result.banner = await page.$eval('.home-head .lede', (e) => e.textContent.trim());
  result.cards = await page.$$eval('.disc h3', (e) => e.map((x) => x.textContent));
  await shot(page, 'd1-home');
  // 1. interested in the published offer (verified contact)
  await page.click('#disc-opp1 [data-v=interested]');
  await page.waitForSelector('#confirm-send', { timeout: 15000 });
  await shot(page, 'd2-review');
  await page.click('[data-act=edit][data-v=letter]'); await page.waitForSelector('form[data-form=letter]');
  await page.fill('#lt-close', "Je vous prie d'agréer, Madame, Monsieur, mes salutations distinguées.");
  await page.click('form[data-form=letter] button[type=submit]'); await page.waitForSelector('#confirm-send:not([disabled])');
  result.sendDisabledBeforeConfirm = await page.$eval('#send-btn', (b) => b.disabled);
  await page.check('#confirm-send'); await page.waitForFunction(() => !document.getElementById('send-btn').disabled);
  await page.click('#send-btn');
  await page.waitForSelector('[data-act=replies]', { timeout: 15000 });
  await page.click('[data-act=replies]'); await page.waitForSelector('[data-act=record-reply]');
  await page.click('[data-act=record-reply]'); await page.waitForTimeout(300);
  await shot(page, 'd3-record');
  // 2. interested in the spontaneous one (no verified address)
  await page.goto('https://stage.test/#home'); await page.waitForSelector('#disc-opp2');
  await page.click('#disc-opp2 [data-v=interested]');
  await page.waitForSelector('form[data-form=recipient]', { timeout: 15000 });
  result.unverifiedBlocked = await page.$eval('#confirm-send', (b) => b.disabled);
  await shot(page, 'd4-needs-address');
  await page.fill('#rc-email', 'contact@als.example'); await page.fill('#rc-src', 'Contact page of their website');
  await page.check('form[data-form=recipient] [name=confirm]'); await page.click('form[data-form=recipient] button[type=submit]');
  await page.waitForSelector('#confirm-send:not([disabled])');
  result.reviewedAllowed = true;
  // agent page
  await page.goto('https://stage.test/#agent'); await page.waitForSelector('[data-act=run-now]');
  await page.click('[data-act=run-now]'); await page.waitForTimeout(300);
  await shot(page, 'd5-agent');
  const g = await page.evaluate(() => window.__gmail);
  const send = g.find((x) => x.tool === 'send_message');
  const store = await page.evaluate(() => Object.fromEntries(window.__store));
  const app = Object.entries(store).map(([, v]) => v).find((v) => v.sent);
  result.calls = g.map((x) => x.tool);
  result.to = send.input.to;
  result.attachmentsArePdf = send.input.attachments.map((a) => Buffer.from(a.content, 'base64').subarray(0, 5).toString());
  result.shaMatchesArchive = sha(send.input.attachments[0].content) === app.sent.cv.sha256 && sha(send.input.attachments[1].content) === app.sent.letter.sha256;
  const blobsSha = await page.evaluate(async () => { const out = {}; for (const [id, b] of window.__blobs) { const h = await crypto.subtle.digest('SHA-256', await b.arrayBuffer()); out[id] = [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join(''); } return out; });
  result.archivedBlobsMatch = blobsSha[app.sent.cv.assetId] === app.sent.cv.sha256 && blobsSha[app.sent.letter.assetId] === app.sent.letter.sha256;
  result.sentStatus = app.status; result.events = app.events.map((e) => e.type);
  result.notificationsRead = Object.entries(store).filter(([k]) => k.startsWith('notifications/')).map(([, v]) => v.read);
  result.oppStatuses = Object.entries(store).filter(([k]) => k.startsWith('opportunities/')).map(([, v]) => v.status);
  result.activity = Object.entries(store).filter(([k]) => k.startsWith('activity/')).map(([, v]) => v.type);
  for (const [r, n] of [['applications', 'd6-applications'], ['activity', 'd7-activity'], ['profile', 'd8-profile']]) { await page.goto(`https://stage.test/#${r}`); await page.waitForTimeout(250); await shot(page, n); }
}
{
  const { page } = await setup({ width: 390, height: 844 });
  await page.goto('https://stage.test/#home'); await page.waitForSelector('.disc'); await page.waitForTimeout(200); await shot(page, 'm1-home');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) errors.push('mobile overflow on home');
  await page.click('#disc-opp1 [data-v=interested]');
  await page.waitForSelector('#confirm-send', { timeout: 15000 }); await shot(page, 'm2-review');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) errors.push('mobile overflow on review');
  await page.goto('https://stage.test/#agent'); await page.waitForTimeout(300); await shot(page, 'm3-agent');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) errors.push('mobile overflow on agent');
}
console.log(JSON.stringify({ result, errors }, null, 1));
await browser.close();
