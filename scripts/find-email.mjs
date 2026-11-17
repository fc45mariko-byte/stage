// Deep search for contact addresses on an organization's own website.
// Goes further than verify-org.mjs: sitemap, common paths, two link levels,
// Cloudflare-protected addresses, and a real browser for pages built by scripts.
// Every address in the output was read on a page this script fetched.
//
//   node scripts/find-email.mjs <website> [--max 45] [--browser] [--extra url1,url2]
//
// Output: {website, domain, pagesFetched, contacts:[{email, evidenceUrl, status, detail, context, kind}], relatedDomains}
import '../server/config.js';
import * as cheerio from 'cheerio';
import { fetchPage, extractPage, baseDomain } from '../server/research/web.js';
import { checkMx } from '../server/research/verify.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const website = args[0];
const MAX = Number(opt('--max', 45));
const useBrowser = args.includes('--browser');
const extra = (opt('--extra', '') || '').split(',').filter(Boolean);
const log = (...a) => console.error(...a);

const HINT = /(contact|nous-contacter|contactez|mentions|legal|l[ée]gales|imprint|impressum|a-propos|about|qui-sommes|societe|entreprise|company|recrut|carri[eè]re|career|emploi|job|rejoin|join|stage|intern|alternance|talent|rh\b|ressources-humaines|presse|press|media|privacy|confidentialit|donnees|rgpd|gdpr|cgv|cgu|conditions|terms|equipe|team|implantation|agence|site|adresse|coordonn|faq|aide|help|service-client|candidat|spontan)/i;
const STRONG = /(contact|recrut|carri|career|emploi|job|rejoin|join|stage|candidat|spontan|mentions|legal)/i;
const COMMON = ['/contact', '/contact/', '/contactez-nous', '/nous-contacter', '/contact-us', '/fr/contact', '/en/contact', '/mentions-legales', '/mentions-legales/', '/fr/mentions-legales', '/legal', '/legal-notice', '/recrutement', '/carrieres', '/careers', '/nous-rejoindre', '/rejoignez-nous', '/jobs', '/emploi', '/politique-de-confidentialite', '/privacy', '/privacy-policy', '/presse', '/press', '/a-propos', '/about', '/about-us', '/qui-sommes-nous', '/cgv', '/donnees-personnelles'];

function cfDecode(hex) {
  const k = parseInt(hex.slice(0, 2), 16); let s = '';
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
  return s;
}
function extract(html, url) {
  const ex = extractPage(html, url);
  const emails = new Set(ex.emails);
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) emails.add(cfDecode(m[1]).toLowerCase());
  for (const m of html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) emails.add(cfDecode(m[1]).toLowerCase());
  // "name [at] domain . fr", "name(at)domain.fr", "name @ domain.fr"
  const t = ex.text.replace(/\s*(?:\[|\(|\{)\s*(?:at|arobase|a)\s*(?:\]|\)|\})\s*/gi, '@').replace(/\s+@\s+/g, '@').replace(/\s*(?:\[|\()\s*(?:dot|point)\s*(?:\]|\))\s*/gi, '.');
  for (const m of t.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi)) emails.add(m[0].toLowerCase().replace(/\.$/, ''));
  const bad = /(example\.|sentry|wixpress|\.(png|jpe?g|gif|webp|svg|css|js)$|domain\.|email\.com$|votre|yourname|nom\.prenom|prenom\.nom|monadresse|mondomaine|adresse@|email@|^nom@|^name@|^xxx|u003e|@2x|@sentry|^[0-9a-f]{20,}@)/i;
  ex.emails = [...emails].filter((e) => !bad.test(e) && e.length < 90 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e));
  return ex;
}
const context = (text, email) => { const i = text.toLowerCase().indexOf(email.split('@')[0]); return i < 0 ? '' : text.slice(Math.max(0, i - 140), i + email.length + 60).replace(/\s+/g, ' ').trim(); };
const kindOf = (email, ctx, url) => {
  const s = `${email} ${url}`.toLowerCase(); const c = `${s} ${ctx}`.toLowerCase();
  if (/(recrut|recruit|career|carriere|job|emploi|rh@|\brh\b|hr@|drh|talent|stage|candidat|people@)/.test(s)) return 'recruitment';
  if (/(dpo|privacy|rgpd|gdpr|donnees|data\.?protection|vieprivee|cnil|legal|juridique|abuse|webmaster|compliance|ethic|alert)/.test(s)) return 'privacy/legal';
  if (/(presse|press|media|communication)/.test(s)) return 'press';
  if (/(sav|service\.?client|customer|commande|order|support|reclam)/.test(s)) return 'customer service';
  if (/(recrut|candidat|cv |stage|emploi)/.test(c)) return 'recruitment';
  if (/(contact|info|accueil|bonjour|hello|welcome)/.test(s)) return 'general';
  return 'other';
};

let browser;
async function render(url) {
  const { chromium } = await import('playwright');
  browser ||= await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'fr-FR', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    return { html: await page.content(), finalUrl: page.url(), ok: true };
  } finally { await ctx.close(); }
}

const home = await fetchPage(website).catch((e) => ({ ok: false, status: 0, html: '', finalUrl: website, error: e.message }));
let start = home;
if ((!home.ok || home.html.length < 1500) && useBrowser) { try { start = await render(website); } catch (e) { log('render home failed', e.message); } }
const domain = baseDomain(start.finalUrl || website);
const origin = new URL(start.finalUrl || website).origin;
const queue = []; const seen = new Set();
const push = (u, pr) => { try { const x = new URL(u, origin); x.hash = ''; if (baseDomain(x.href) !== domain) return; if (/\.(pdf|jpe?g|png|gif|zip|mp4|webp|svg|css|js|ico|xml)(\?|$)/i.test(x.pathname)) return; const k = x.href.replace(/\/$/, ''); if (seen.has(k)) return; seen.add(k); queue.push({ url: x.href, pr }); } catch { /* ignore */ } };
const pages = [];
const add = (res) => { const ex = extract(res.html, res.finalUrl); pages.push({ url: res.finalUrl, ...ex }); return ex; };
seen.add((start.finalUrl || website).replace(/\/$/, ''));
if (start.html) { const ex = add(start); for (const l of ex.links) if (HINT.test(l.url) || HINT.test(l.text)) push(l.url, STRONG.test(l.url + l.text) ? 0 : 1); }
for (const u of extra) push(u, 0);
for (const p of COMMON) push(origin + p, 2);
try {
  const sm = await fetchPage(`${origin}/sitemap.xml`, { timeoutMs: 10000 });
  if (sm.ok) {
    let locs = [...sm.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    for (const sub of locs.filter((l) => /\.xml/i.test(l)).slice(0, 6)) { try { const s2 = await fetchPage(sub, { timeoutMs: 10000 }); if (s2.ok) locs.push(...[...s2.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'))); } catch { /* ignore */ } }
    for (const l of locs) if (!/\.xml/i.test(l) && STRONG.test(new URL(l, origin).pathname)) push(l, 1);
  }
} catch { /* no sitemap */ }
let fetched = 0;
while (queue.length && fetched < MAX) {
  queue.sort((a, b) => a.pr - b.pr);
  const { url, pr } = queue.shift(); fetched++;
  try {
    let r = await fetchPage(url, { timeoutMs: 12000 });
    if ((!r.ok || r.html.length < 1500) && useBrowser && pr === 0) r = await render(url);
    if (!r.ok || !r.html) continue;
    if (baseDomain(r.finalUrl) !== domain) continue;
    let ex = add(r);
    if (!ex.emails.length && useBrowser && pr === 0 && STRONG.test(url)) { try { const rr = await render(url); ex = add(rr); } catch { /* ignore */ } }
    if (pr <= 1) for (const l of ex.links) if (STRONG.test(l.url) || STRONG.test(l.text)) push(l.url, pr + 1);
  } catch { /* a missing page is not fatal */ }
}
if (browser) await browser.close();

const checkedAt = new Date().toISOString().slice(0, 10);
const contacts = []; const related = {};
for (const p of pages) for (const e of p.emails) {
  const ex = contacts.find((c) => c.email === e);
  if (ex) { ex.pages++; continue; }
  const d = baseDomain(e.split('@')[1]);
  const mx = await checkMx(e);
  let same = d === domain; let relNote = '';
  if (!same) {
    // Is the other domain the organization's own? It is if it redirects to this website.
    if (!(d in related)) { try { const r = await fetchPage(`https://${d}`, { timeoutMs: 10000 }); related[d] = baseDomain(r.finalUrl) === domain ? `redirects to ${domain}` : `separate site (${r.finalUrl}, HTTP ${r.status})`; } catch (er) { related[d] = `no website (${er.message.slice(0, 60)})`; } }
    if (/^redirects/.test(related[d])) { same = true; relNote = `; ${d} ${related[d]}, so it is the organization's own domain`; }
  }
  const ctx = context(p.text, e);
  contacts.push({ email: e, evidenceUrl: p.url, status: mx === 'none' ? 'failed' : same ? 'verified' : 'to_review', mx,
    detail: mx === 'none' ? `Found on ${p.url}, but its domain has no mail server` : same ? `Found on ${p.url} (checked ${checkedAt})${relNote}` : `Found on ${p.url}, but it belongs to another domain (${d}): please confirm`,
    kind: kindOf(e, ctx, p.url), context: ctx, checkedAt, pages: 1 });
}
const order = ['recruitment', 'general', 'other', 'customer service', 'press', 'privacy/legal'];
contacts.sort((a, b) => (a.status === 'verified' ? 0 : 1) - (b.status === 'verified' ? 0 : 1) || order.indexOf(a.kind) - order.indexOf(b.kind));
process.stdout.write(`${JSON.stringify({ website, finalUrl: start.finalUrl, homeStatus: home.status, domain, pagesFetched: pages.length, pageUrls: pages.map((p) => p.url), contacts, relatedDomains: related }, null, 1)}\n`);
