// Deterministic verification used by the background agent.
// The agent proposes; this script checks. Output is JSON on stdout.
//
//   node scripts/verify-org.mjs --check
//       → {online: true|false, detail}: can this machine open ordinary websites?
//   node scripts/verify-org.mjs <website> [--listing <url>] [--area orleans|paris] [--email <addr> --evidence <url>]
//       → website status, pages fetched (text excerpts), emails found on the
//         organization's own pages, location evidence, listing check.
import '../server/config.js';
import { crawlSite, fetchPage, extractPage, baseDomain } from '../server/research/web.js';
import { checkMx, verifyEmail } from '../server/research/verify.js';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const out = (o) => { process.stdout.write(`${JSON.stringify(o, null, 1)}\n`); };

const LOCATION = {
  orleans: /(orl[ée]ans|\b45\d{3}\b|loiret|saint-jean-de-braye|saint-jean-de-la-ruelle|saint-jean-le-blanc|olivet|fleury-les-aubrais|saran|ingr[ée]|ormes|chécy|checy|saint-cyr-en-val|la chapelle-saint-mesmin|meung-sur-loire|beaugency|gien|montargis|pithiviers)/i,
  paris: /(paris|\b75\d{3}\b|\b9[1-5]\d{3}\b|\b77\d{3}\b|\b78\d{3}\b|île-de-france|ile-de-france|la d[ée]fense|roissy|rungis)/i,
};

async function main() {
  if (args[0] === '--check') {
    for (const u of ['https://www.service-public.fr/', 'https://www.univ-orleans.fr/']) {
      try { const r = await fetchPage(u, { timeoutMs: 12000 }); if (r.status > 0) return out({ online: true, detail: `${u} answered HTTP ${r.status}` }); } catch (e) { out({ online: false, detail: `${u}: ${e.message}` }); return; }
    }
    return out({ online: false, detail: 'no answer' });
  }
  const website = args[0];
  if (!website) return out({ error: 'usage: verify-org.mjs <website> [--listing url] [--area orleans|paris]' });
  const area = opt('--area');
  const result = { website, checkedAt: new Date().toISOString() };
  let site;
  try { site = await crawlSite(website, { maxPages: 7 }); } catch (e) { return out({ ...result, ok: false, reason: `website unreachable: ${e.message}` }); }
  if (!site.home.ok) return out({ ...result, ok: false, reason: `website answered HTTP ${site.home.status}` });
  result.ok = true;
  result.finalUrl = site.home.finalUrl;
  result.domain = site.domain;
  result.pages = site.pages.map((p) => ({ url: p.url, title: p.title, description: p.description, emails: p.emails, text: p.text.slice(0, 6000) }));
  // Emails count only when found on the organization's own pages.
  const contacts = [];
  for (const p of site.pages) for (const e of p.emails) {
    if (contacts.some((c) => c.email === e)) continue;
    const mx = await checkMx(e);
    contacts.push({ email: e, evidenceUrl: p.url, status: mx === 'none' ? 'failed' : 'verified', mx, detail: mx === 'none' ? `Found on ${p.url}, but its domain has no mail server` : `Found on ${p.url} (checked ${result.checkedAt.slice(0, 10)})`, checkedAt: result.checkedAt.slice(0, 10) });
  }
  result.contacts = contacts;
  const re = LOCATION[area];
  if (re) for (const p of site.pages) { const m = `${p.title} ${p.text}`.match(re); if (m) { result.locationEvidence = `"${m[0]}" found on ${p.url}`; break; } }
  const listing = opt('--listing');
  if (listing) {
    try {
      const l = await fetchPage(listing);
      const ex = extractPage(l.html, l.finalUrl);
      const isInternship = /(stage|stagiaire|internship|intern\b)/i.test(`${ex.title} ${ex.text}`);
      result.listing = { url: l.finalUrl, status: l.status, ok: l.ok && isInternship, title: ex.title, onOrgSite: baseDomain(l.finalUrl) === site.domain, text: ex.text.slice(0, 6000), emails: ex.emails, reason: !l.ok ? `HTTP ${l.status}` : isInternship ? undefined : 'page does not mention an internship' };
    } catch (e) { result.listing = { url: listing, ok: false, reason: e.message }; }
  }
  const email = opt('--email');
  if (email) result.emailCheck = await verifyEmail({ email, evidenceUrl: opt('--evidence'), orgWebsite: site.home.finalUrl });
  out(result);
}
main().catch((e) => { out({ ok: false, reason: e.message }); process.exitCode = 1; });
