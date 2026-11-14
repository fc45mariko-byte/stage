// Discovery that works without direct website access, through Anthropic's
// web search (runs on Anthropic's servers; needs ANTHROPIC_API_KEY).
//
// Verification rules (checked in code, not by the model):
// - an organization is kept only if its website domain appeared in real
//   search results;
// - an email is "verified" only if it appears inside a verbatim quote
//   (citation) taken from a page on the organization's own domain;
//   an email quoted from another site is kept as "to review";
// - a listing counts as a published internship only if the listing URL was
//   a search result or a cited page, and its quoted text/title mentions an internship.
//
//   node scripts/discover-api.mjs --area orleans|paris --profile profile.json \
//        --known known.json --out out.json [--max 6] [--focus "..."]
import fs from 'node:fs';
import '../server/config.js';
import '../server/research/web.js';
import { createMessage, jsonCall, obj, str, arr } from '../server/ai/client.js';
import { baseDomain, deobfuscate } from '../server/research/web.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const area = opt('--area', 'orleans');
const max = Number(opt('--max', 6));
const focus = opt('--focus', '');
const profile = JSON.parse(fs.readFileSync(opt('--profile'), 'utf8'));
const known = fs.existsSync(opt('--known', '')) ? JSON.parse(fs.readFileSync(opt('--known'), 'utf8')) : { domains: [], listings: [] };
const outPath = opt('--out', 'discover-out.json');
const now = () => new Date().toISOString();
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const AREA = { orleans: 'Orléans and its surrounding area (Loiret, Centre-Val de Loire)', paris: 'Paris and Île-de-France' };
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
const LOC = {
  orleans: /(orl[ée]ans|\b45\d{3}\b|loiret|saint-jean-de-braye|saint-jean-de-la-ruelle|saint-jean-le-blanc|olivet|fleury-les-aubrais|saran|ingr[ée]|ormes|chécy|saint-cyr-en-val|boigny-sur-bionne|semoy|meung-sur-loire|beaugency|gien|montargis|pithiviers)/i,
  paris: /(paris|\b75\d{3}\b|\b9[1-5]\d{3}\b|\b77\d{3}\b|\b78\d{3}\b|île-de-france|ile-de-france|la d[ée]fense|roissy|rungis)/i,
};
const webSearch = (n, city) => ({ type: 'web_search_20260209', name: 'web_search', max_uses: n, user_location: { type: 'approximate', country: 'FR', city, timezone: 'Europe/Paris' } });

function harvest(content, urls, cites) {
  for (const b of content) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r.url) urls.set(r.url, r.title || '');
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c.url && c.cited_text) cites.push({ url: c.url, title: c.title || '', text: c.cited_text });
      if (b.citations.length) (cites.blocks ||= []).push({ text: b.text, citations: b.citations.filter((c) => c.url).map((c) => ({ url: c.url, text: c.cited_text || '' })) });
    }
  }
}

async function findCandidates() {
  const facts = profile.internship;
  const tool = {
    name: 'submit_candidates', strict: true,
    description: 'Submit the organizations and internship offers you found. Call once, at the end.',
    input_schema: obj({ candidates: arr(obj({
      name: str(), website: str('Official website as seen in results'), city: str(), industry: str(),
      kind: { type: 'string', enum: ['published', 'speculative'] },
      listing_url: str('URL of the internship offer if kind is published, else empty'), listing_title: str(), listing_source: str('Job board or "company website", else empty'),
      why: str('One factual sentence from the sources'),
    })) }),
  };
  const urls = new Map(); const cites = [];
  const messages = [{ role: 'user', content: `Find real internship opportunities in ${AREA[area]} for a French Licence 3 LEA (Commerce international) student: French native, English C2, Spanish B2, looking for a ${facts.duration} internship ${facts.period}, in ${facts.target_areas.join(', ')}.
${focus ? `Her preference: ${focus}.\n` : ''}
Search in French and English, about 10 searches:
a) PUBLISHED internship offers (kind "published") on job boards and company career pages (Welcome to the Jungle, HelloWork, Indeed, JobTeaser, APEC, Jobijoba, France Travail, LinkedIn job pages, "carrières/recrutement" pages) that a bachelor student could do in spring 2027 for about 6 weeks;
b) organizations with real international activity where a SPONTANEOUS application makes sense (kind "speculative"): exporters, import/export SMEs, international logistics and freight forwarders, manufacturers that export, CCI / export-support bodies, international associations.
Skip these domains (already known): ${known.domains.join(', ') || 'none'}.
Only include organizations whose official website appeared in your results. Up to ${max + 4} candidates. Then call submit_candidates.` }];
  for (let i = 0; i < 8; i++) {
    const m = await createMessage({ max_tokens: 32000, messages, tools: [webSearch(12, area === 'paris' ? 'Paris' : 'Orléans'), tool], output_config: { effort: 'high' } });
    harvest(m.content, urls, cites);
    const call = m.content.find((b) => b.type === 'tool_use' && b.name === 'submit_candidates');
    if (call) return { candidates: call.input.candidates || [], urls, cites };
    messages.push({ role: 'assistant', content: m.content });
    if (m.stop_reason === 'pause_turn') continue;
    messages.push({ role: 'user', content: 'Call submit_candidates now with what you found.' });
  }
  throw new Error('no candidates submitted');
}

async function investigate(c) {
  const urls = new Map(); const cites = [];
  const m = await createMessage({ max_tokens: 16000, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'FR', city: area === 'paris' ? 'Paris' : 'Orléans', timezone: 'Europe/Paris' } }], output_config: { effort: 'medium' }, messages: [{ role: 'user', content:
    `Research ${c.name} (official website ${c.website}).${c.listing_url ? ` Also look at this internship offer: ${c.listing_url}.` : ''}
Using web search, write short factual sentences in French, each one supported by a citation from the page it comes from:
1. what the organization does, and its international activity (countries, export, import, foreign customers or suppliers);
2. where it is located (city, postcode);
3. the email address it publishes for contact, recruitment or internships, quoted exactly as written on the page (prefer a page of its own website);
${c.listing_url ? '4. the offer: title, dates or duration, level required, tasks.\n' : ''}State only what the pages say. If you cannot find an email address, say so.` }] });
  harvest(m.content, urls, cites);
  return { urls, cites };
}

function verify(c, found, searchUrls) {
  const domain = baseDomain(c.website);
  const allUrls = new Map([...searchUrls, ...found.urls]);
  const siteSeen = [...allUrls.keys()].some((u) => baseDomain(u) === domain) || found.cites.some((x) => baseDomain(x.url) === domain);
  if (!siteSeen) return { ok: false, reason: 'its website did not appear in the search results' };
  const contacts = [];
  const add = (email, status, url, detail, quote) => { if (!contacts.some((k) => k.email === email)) contacts.push({ email, evidenceUrl: url, status, detail, checkedAt: now().slice(0, 10), quote: (quote || '').slice(0, 200) }); };
  // 1. Full address inside a verbatim quote.
  for (const x of found.cites) for (const mm of deobfuscate(x.text).matchAll(EMAIL_RE)) {
    const email = mm[0].toLowerCase().replace(/\.$/, '');
    if (baseDomain(x.url) === domain) add(email, 'verified', x.url, `Quoted from ${x.url} by web search on ${now().slice(0, 10)}`, x.text);
    else add(email, 'to_review', x.url, `Quoted from ${new URL(x.url).hostname}, not the organization's own website: please confirm`, x.text);
  }
  // 2. Address stated next to a quote from the organization's own site, but the quote was cut off.
  for (const blk of (found.cites.blocks || [])) for (const mm of deobfuscate(blk.text).matchAll(EMAIL_RE)) {
    const email = mm[0].toLowerCase().replace(/\.$/, '');
    const own = blk.citations.find((c) => baseDomain(c.url) === domain);
    if (own && baseDomain(email.split('@')[1]) === domain) add(email, 'to_review', own.url, `Found by web search on ${own.url}; the quote was cut off, so please confirm the address`, own.text);
  }
  let listing = null;
  if (c.kind === 'published' && c.listing_url) {
    const lu = c.listing_url.replace(/[#?].*$/, '');
    const seen = [...allUrls.keys()].find((u) => u.replace(/[#?].*$/, '') === lu);
    const quoted = found.cites.filter((x) => x.url.replace(/[#?].*$/, '') === lu);
    const text = `${seen ? allUrls.get(seen) : ''} ${quoted.map((q) => `${q.title} ${q.text}`).join(' ')}`;
    if ((seen || quoted.length) && /(stage|stagiaire|internship|intern\b|alternance)/i.test(text)) listing = { url: c.listing_url, title: c.listing_title, source: c.listing_source, quoted: quoted.map((q) => q.text) };
  }
  const re = LOC[area]; let locationEvidence = null;
  for (const x of found.cites) { const mm = x.text.match(re); if (mm) { locationEvidence = `"${mm[0]}" quoted from ${x.url}`; break; } }
  const byUrl = new Map();
  for (const x of found.cites) byUrl.set(x.url, `${byUrl.get(x.url) || `[${x.url}] ${x.title}\n`}${x.text}\n`);
  return { ok: true, domain, contacts, listing, locationEvidence, sourcesText: [...byUrl.values()].join('\n').slice(0, 6000), sources: [...new Set(found.cites.map((x) => x.url))].slice(0, 8) };
}

const evalSchema = obj({
  suitable: { type: 'boolean' }, reason_if_unsuitable: str(),
  summary: str('One sentence for a notification card, in English, e.g. "The company is looking for an intern to support its export sales administration."'),
  description: str('2–3 neutral sentences in English, only from the sources'), industry: str(), city: str(),
  position: str('Realistic internship title in French; for a published offer, its title'),
  responsibilities: arr(str(), '3–5 modest tasks for a 6-week L3 intern, in French'),
  matchReasons: arr(str(), '2–4 short concrete reasons in English linking HER real profile to THIS organization ("Why I found this for you")'),
  concerns: arr(str()), fit: { type: 'string', enum: ['strong', 'possible', 'weak'] }, handbookNotes: str(),
});
async function evaluate(c, v) {
  const facts = { ...profile, transferable: (profile.transferable || []).filter((t) => t.status === 'confirmed'), questions: (profile.questions || []).filter((q) => q.answer) };
  return jsonCall({ effort: 'medium', maxTokens: 8000, schema: evalSchema,
    system: 'You assess whether an organization could realistically host a specific student for a 6-week internship (L3 LEA, Commerce international), 15 May–30 June 2027. Use only the quoted sources for facts about the organization and only the profile for facts about her. Never invent experience or skills. Suggestions must be modest and realistic.',
    user: `PROFILE:\n${JSON.stringify(facts)}\n\nORGANIZATION: ${c.name} (${c.website}), ${c.kind === 'published' && v.listing ? `published offer: ${v.listing.title} (${v.listing.url})` : 'spontaneous application'}\n\nQUOTED SOURCES:\n${v.sourcesText || '(none)'}\n\nThe handbook on file is the 2021–2022 edition (210 hours = 6 weeks of 35 h; mission related to LEA teaching; department must validate). Mention a point to check in handbookNotes only if relevant.` });
}

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const result = { area, startedAt: now(), mode: 'search', queries: 'web_search (Anthropic)', candidates: 0, kept: [], rejected: [] };
try {
  log('searching', area);
  const { candidates, urls } = await findCandidates();
  result.candidates = candidates.length;
  log(candidates.length, 'candidates');
  for (const c of candidates) {
    if (result.kept.length >= max) break;
    let domain; try { domain = baseDomain(c.website); } catch { result.rejected.push({ name: c.name, reason: 'invalid website' }); continue; }
    if (known.domains.includes(domain) || (c.listing_url && known.listings.includes(c.listing_url))) { result.rejected.push({ name: c.name, reason: 'already known' }); continue; }
    log('investigating', c.name);
    let found; try { found = await investigate(c); } catch (e) { result.rejected.push({ name: c.name, reason: e.message }); continue; }
    const v = verify(c, found, urls);
    if (!v.ok) { result.rejected.push({ name: c.name, reason: v.reason }); continue; }
    if (c.kind === 'published' && !v.listing) c.kind = 'speculative';
    let ev; try { ev = await evaluate(c, v); } catch (e) { result.rejected.push({ name: c.name, reason: `evaluation failed: ${e.message}` }); continue; }
    if (!ev.suitable || ev.fit === 'weak') { result.rejected.push({ name: c.name, reason: ev.reason_if_unsuitable || 'weak match' }); continue; }
    const id = `opp-${slug(v.domain)}${v.listing ? `-${slug(v.listing.title || 'offre').slice(0, 20)}` : ''}`;
    const best = v.contacts.find((x) => x.status === 'verified' && /(rh|recrut|stage|job|career|emploi)/i.test(x.email)) || v.contacts.find((x) => x.status === 'verified');
    if (best) best.recommended = true;
    if (!v.locationEvidence) ev.concerns = [...(ev.concerns || []), 'Location not confirmed in the quoted pages.'];
    if (!v.contacts.some((x) => x.status === 'verified')) ev.concerns = [...(ev.concerns || []), 'No email address could be verified on its own website yet.'];
    result.kept.push({
      id, doc: {
        name: c.name, website: c.website, domain: v.domain, area, city: ev.city || c.city, industry: ev.industry || c.industry,
        kind: v.listing ? 'published' : 'speculative', listingUrl: v.listing?.url || '', listingTitle: v.listing?.title || '', listingSource: v.listing?.source || '',
        summary: ev.summary, description: ev.description, position: ev.position, responsibilities: ev.responsibilities, matchReasons: ev.matchReasons, concerns: ev.concerns, fit: ev.fit, handbookNotes: ev.handbookNotes,
        contacts: v.contacts, sources: v.sources, sourcesText: v.sourcesText, locationEvidence: v.locationEvidence || '',
        verification: 'Anthropic web search: website seen in results; emails verified only when quoted from the organization’s own pages',
        websiteCheckedAt: now().slice(0, 10), status: 'new', createdAt: now(),
      },
    });
    log('kept', c.name, ev.fit);
  }
} catch (e) { result.error = e.message; log('error', e.message); }
result.finishedAt = now();
fs.writeFileSync(outPath, JSON.stringify(result, null, 1));
log('done', result.kept.length, 'kept,', result.rejected.length, 'set aside');
