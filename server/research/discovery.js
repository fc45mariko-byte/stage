// Opportunity discovery.
// 1. Claude searches the web (real web_search tool) and proposes organizations.
// 2. Every proposal is checked by this server: it must be backed by an actual
//    search result URL, and its website must be reachable. Proposals that fail
//    are discarded and logged; nothing is invented or kept "on trust".
// 3. Pages from the organization's own site are fetched; emails found there
//    become verified contacts.
// 4. Claude evaluates the fit using only the fetched pages (labelled as AI
//    suggestions in the interface).
import { get, all, insert, run, now, parse } from '../db/index.js';
import { createMessage, aiAvailable, AIUnavailableError, jsonCall, obj, str, arr } from '../ai/client.js';
import { crawlSite, fetchPage, extractPage, baseDomain, normalizeUrl } from './web.js';
import { checkMx } from './verify.js';
import { currentProfile, factsForAI } from '../profile/service.js';
import { handbookForAI } from '../documents/handbook.js';
import { HONESTY_RULES } from '../ai/style.js';
import { logActivity } from '../lib/activity.js';

export const SECTORS = {
  any: 'any relevant sector',
  import_export: 'import/export and trading companies',
  logistics: 'international logistics, freight forwarding, transport, supply chain',
  industry_export: 'manufacturing SMEs and industrial companies with export activity',
  cosmetics_food: 'cosmetics, perfume, food and wine companies that export (strong presence around Orléans)',
  institutions: 'chambers of commerce, export support agencies, international institutions and associations',
  services: 'international services companies (translation agencies, trade fairs, international customer service)',
};

const AREA_LABEL = { orleans: 'Orléans and its surrounding area (Loiret, Centre-Val de Loire)', paris: 'Paris and Île-de-France' };

const candidateTool = {
  name: 'submit_candidates',
  description: 'Submit the organizations you found. Call this exactly once, at the end, after searching.',
  strict: true,
  input_schema: obj({
    candidates: arr(obj({
      name: str('Official organization name'),
      website: str('Official website URL (home page) as seen in the search results'),
      city: str('City where the relevant site/office is located'),
      industry: str('Short sector label'),
      why_relevant: str('One or two factual sentences from the sources on why an LEA international-trade student could intern there'),
      source_urls: arr(str(), 'URLs of search results that support this organization (copy exactly from results)'),
      published_listing_url: str('URL of a currently published internship offer at this organization if you saw one, else empty string'),
    })),
    notes: str('Short note on the search (difficulties, sectors covered)'),
  }),
};

function collectSearchUrls(content, into) {
  for (const b of content) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url) into.add(r.url);
    }
  }
}

async function searchCandidates({ area, sector, count, exclude, log }) {
  const facts = factsForAI(currentProfile().data);
  const searchUrls = new Set();
  const system = `You are a careful research assistant helping a French university student find organizations that could host her internship. You only report organizations you actually found in web search results during this conversation. You never rely on memory for names, websites or contacts. Prefer organizations of a size and type that realistically accept short internships from bachelor students (SMEs, mid-size exporters, logistics firms, chambers of commerce, associations), not only large corporations.`;
  const user = `Find up to ${count} organizations located in ${AREA_LABEL[area]} where this student could do a ${facts.internship.duration} internship (${facts.internship.period}).

Student: Licence 3 LEA – Commerce international, Université d'Orléans. French (native), English (C2), Spanish (B2). Target areas: ${facts.internship.target_areas.join(', ')}.

Focus: ${SECTORS[sector] || SECTORS.any}.
Organizations do NOT need to have a published internship offer: a credible reason to send a spontaneous application is enough (international activity, export, foreign customers or suppliers, logistics flows, use of English/Spanish).
Exclude these domains (already known): ${exclude.length ? exclude.join(', ') : 'none'}.

Use the web_search tool (several focused searches, in French and English). Then call submit_candidates once with what you found. Only include an organization if its official website appeared in your search results or is clearly given by a source you found. If you found fewer than ${count}, submit fewer.`;

  const messages = [{ role: 'user', content: user }];
  const tools = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 15, user_location: { type: 'approximate', country: 'FR', city: area === 'paris' ? 'Paris' : 'Orléans', timezone: 'Europe/Paris' } },
    candidateTool,
  ];
  let nudged = false;
  for (let i = 0; i < 10; i++) {
    const msg = await createMessage({ max_tokens: 32000, system, messages, tools, output_config: { effort: 'high' } });
    collectSearchUrls(msg.content, searchUrls);
    const call = msg.content.find((b) => b.type === 'tool_use' && b.name === 'submit_candidates');
    if (call) return { candidates: call.input.candidates || [], notes: call.input.notes || '', searchUrls };
    messages.push({ role: 'assistant', content: msg.content });
    if (msg.stop_reason === 'pause_turn') { log('Search paused by the API, resuming'); continue; }
    if (msg.stop_reason === 'max_tokens') throw new Error('Search response was cut off.');
    if (nudged) break;
    nudged = true;
    messages.push({ role: 'user', content: 'Please call submit_candidates now with the organizations you found (or an empty list).' });
  }
  throw new Error('The search agent did not return any candidates.');
}

const LOCATION_PATTERNS = {
  orleans: /(orl[ée]ans|\b45\d{3}\b|loiret|saint-jean-de-braye|saint-jean-de-la-ruelle|saint-jean-le-blanc|olivet|fleury-les-aubrais|sarana?|ingr[ée]|ormes|saran|la chapelle-saint-mesmin|chécy|checy|gien|montargis|pithiviers|meung-sur-loire|beaugency)/i,
  paris: /(paris|\b75\d{3}\b|\b9[1-5]\d{3}\b|\b77\d{3}\b|\b78\d{3}\b|île-de-france|ile-de-france|la d[ée]fense|roissy|rungis)/i,
};

function findLocation(pages, area) {
  const re = LOCATION_PATTERNS[area];
  if (!re) return null;
  for (const p of pages) {
    const m = `${p.title} ${p.text}`.match(re);
    if (m) return `"${m[0]}" found on ${p.url}`;
  }
  return null;
}

const evaluationSchema = obj({
  suitable: { type: 'boolean', description: 'false if this organization is clearly not a realistic host for this student (wrong place, closed, unrelated activity)' },
  unsuitable_reason: str(),
  description: str('2–3 sentence neutral description of the organization, based ONLY on the provided pages'),
  industry: str(),
  potential_position: str('A realistic internship title for a 6-week bachelor internship, in French'),
  responsibilities: arr(str(), '3–5 realistic, modest tasks a 6-week LEA intern could do there, in French'),
  match_reasons: arr(str(), '2–4 concrete reasons linking her real profile to this organization'),
  concerns: arr(str(), 'Honest caveats (size, language needs, distance, no evidence of international activity, etc.)'),
  fit: { type: 'string', enum: ['strong', 'possible', 'weak'] },
  handbook_notes: str('Any point to check against the handbook requirements given, or empty if none were provided'),
  recommended_email: str('Best address for an internship/spontaneous application among AVAILABLE EMAILS only, or empty string'),
});

export async function evaluateOrganization({ org, pages, listing }) {
  const facts = factsForAI(currentProfile().data);
  const handbook = handbookForAI();
  const emails = [...new Set(pages.flatMap((p) => p.emails))];
  const sources = pages.map((p) => `URL: ${p.url}\nTITLE: ${p.title}\n${p.description ? `META: ${p.description}\n` : ''}TEXT: ${p.text.slice(0, 6000)}`).join('\n\n---\n\n');
  const out = await jsonCall({
    system: `You assess whether an organization could realistically host a specific student for a short internship. You use only the provided web pages as information about the organization. Anything you propose (position, tasks) is a suggestion and must be realistic for a 6-week internship of a bachelor student with no professional experience in the field.\n\n${HONESTY_RULES}`,
    user: `CANDIDATE FACTS:\n${JSON.stringify(facts, null, 1)}\n\n${handbook ? `UNIVERSITY HANDBOOK REQUIREMENTS (verbatim quotes):\n${JSON.stringify(handbook, null, 1)}\n\n` : 'No university handbook has been provided; leave handbook_notes empty.\n\n'}ORGANIZATION: ${org.name} (${org.website}), expected area: ${org.area}\n${listing ? `PUBLISHED INTERNSHIP OFFER (verified page):\n${listing.text.slice(0, 5000)}\n\n` : ''}AVAILABLE EMAILS (found on its website): ${emails.length ? emails.join(', ') : 'none'}\n\nORGANIZATION SOURCES (fetched by our server):\n${sources}`,
    schema: evaluationSchema, effort: 'medium', maxTokens: 16000,
  });
  if (out.recommended_email && !emails.includes(out.recommended_email.toLowerCase())) out.recommended_email = '';
  return out;
}

/** Persist an organization + contacts + opportunity after verification. */
async function saveVerified({ cand, area, origin, runId, searchSourceUrls, site, listing, log }) {
  const pages = site.pages;
  const home = pages[0];
  const domain = site.domain;
  const loc = findLocation(pages, area);
  const orgId = insert(
    `INSERT INTO organizations(name, website, domain, area, city, industry, description, origin, search_run_id, search_source_urls_json, website_check_json, pages_json, location_evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cand.name || home.title || domain, site.home.finalUrl, domain, area, cand.city || null, cand.industry || null, null, origin, runId ?? null,
    JSON.stringify(searchSourceUrls || []), JSON.stringify({ status: site.home.status, finalUrl: site.home.finalUrl, fetchedAt: site.home.fetchedAt }),
    JSON.stringify(pages.map((p) => ({ url: p.url, title: p.title, description: p.description, fetchedAt: p.fetchedAt, emails: p.emails, text: p.text.slice(0, 8000) }))), loc, now(),
  );
  const org = get('SELECT * FROM organizations WHERE id = ?', orgId);

  // Contacts: addresses found on the organization's own pages.
  const contactIds = {};
  for (const p of pages) {
    for (const e of p.emails) {
      if (contactIds[e]) continue;
      const mx = await checkMx(e);
      const status = mx === 'none' ? 'failed' : 'verified';
      const detail = mx === 'none' ? `Found on ${p.url}, but the domain has no mail server` : `Found on ${p.url} (fetched ${p.fetchedAt.slice(0, 10)})${mx === 'unavailable' ? '; mail-server lookup unavailable from this machine' : ''}`;
      contactIds[e] = insert('INSERT OR IGNORE INTO contacts(organization_id, email, evidence_url, status, status_detail, mx_status, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', orgId, e, p.url, status, detail, mx, now(), now());
    }
  }

  let ev = null; let evalStatus = 'done'; let evalError = null;
  if (aiAvailable()) {
    try { ev = await evaluateOrganization({ org, pages, listing }); } catch (e) { evalStatus = 'failed'; evalError = e.message; log(`Evaluation failed for ${org.name}: ${e.message}`); }
  } else evalStatus = 'unavailable';

  if (ev && !ev.suitable) {
    log(`Discarded ${org.name}: ${ev.unsuitable_reason}`);
    logActivity('discover', `Discarded ${org.name} after review of its website: ${ev.unsuitable_reason}`, { type: 'organization', id: orgId });
    run('UPDATE organizations SET description = ? WHERE id = ?', ev.description, orgId);
    insert(`INSERT INTO opportunities(organization_id, kind, position_title, status, evaluation_status, concerns_json, created_at) VALUES (?, 'speculative', NULL, 'not_interested', 'done', ?, ?)`, orgId, JSON.stringify([`Agent: ${ev.unsuitable_reason}`]), now());
    return null;
  }
  if (ev) run('UPDATE organizations SET description = ?, industry = COALESCE(?, industry) WHERE id = ?', ev.description, ev.industry || null, orgId);
  else if (home.description) run('UPDATE organizations SET description = ? WHERE id = ?', `[Website meta description] ${home.description}`, orgId);

  const oppId = insert(
    `INSERT INTO opportunities(organization_id, kind, listing_url, listing_check_json, position_title, responsibilities_json, match_reasons_json, concerns_json, handbook_notes, fit, status, evaluation_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    orgId, listing ? 'published' : 'speculative', listing?.url ?? null, listing ? JSON.stringify({ status: listing.status, fetchedAt: listing.fetchedAt, keywordFound: true }) : null,
    listing?.title && !ev ? listing.title : (ev?.potential_position ?? null),
    JSON.stringify(ev?.responsibilities ?? []), JSON.stringify(ev?.match_reasons ?? []),
    JSON.stringify([...(ev?.concerns ?? []), ...(loc ? [] : ['Location not confirmed on the organization’s website.']), ...(evalError ? [`AI evaluation failed: ${evalError}`] : [])]),
    ev?.handbook_notes || null, ev?.fit ?? null, evalStatus, now(),
  );
  if (ev?.recommended_email && contactIds[ev.recommended_email]) run("UPDATE contacts SET label = 'Recommended by agent' WHERE id = ?", contactIds[ev.recommended_email]);
  logActivity('discover', `Discovered ${org.name} (${domain})${listing ? ' – published internship offer' : ' – spontaneous application'}; ${Object.keys(contactIds).length} email(s) found on its site`, { type: 'opportunity', id: oppId });
  return oppId;
}

async function verifyListing(url, domain) {
  if (!url) return null;
  try {
    const p = await fetchPage(url);
    if (!p.ok) return null;
    const ex = extractPage(p.html, p.finalUrl);
    if (!/(stage|stagiaire|internship|intern\b)/i.test(`${ex.title} ${ex.text}`)) return null;
    return { url: p.finalUrl, status: p.status, fetchedAt: p.fetchedAt, title: ex.title, text: ex.text, onOwnSite: baseDomain(p.finalUrl) === domain };
  } catch { return null; }
}

export function createSearchRun(params) {
  return insert('INSERT INTO search_runs(params_json, status, stage, started_at) VALUES (?, ?, ?, ?)', JSON.stringify(params), 'running', 'Searching the web', now());
}

export async function runDiscovery(runId, progress) {
  if (!aiAvailable()) throw new AIUnavailableError();
  const params = parse(get('SELECT params_json FROM search_runs WHERE id = ?', runId).params_json);
  const logLines = [];
  const log = (line) => { logLines.push(`${new Date().toISOString().slice(11, 19)} ${line}`); run('UPDATE search_runs SET log_json = ?, stage = ? WHERE id = ?', JSON.stringify(logLines), line, runId); progress?.(line); };
  try {
    logActivity('search', `Search started: ${AREA_LABEL[params.area]}, focus "${SECTORS[params.sector] || SECTORS.any}", up to ${params.count} organizations`, { type: 'search_run', id: runId });
    const exclude = all('SELECT domain FROM organizations').map((r) => r.domain);
    log('Searching the web');
    const { candidates, notes, searchUrls } = await searchCandidates({ ...params, exclude, log });
    run('UPDATE search_runs SET candidates_proposed = ?, search_urls_json = ? WHERE id = ?', candidates.length, JSON.stringify([...searchUrls]), runId);
    log(`${candidates.length} candidates proposed from ${searchUrls.size} search results${notes ? ` (${notes})` : ''}`);
    const searchDomains = new Set([...searchUrls].map(baseDomain));
    let accepted = 0;
    for (const cand of candidates) {
      let domain;
      try { domain = baseDomain(normalizeUrl(cand.website).href); } catch { log(`Rejected ${cand.name}: invalid website`); continue; }
      if (get('SELECT id FROM organizations WHERE domain = ?', domain)) { log(`Skipped ${cand.name}: already known`); continue; }
      const backing = (cand.source_urls || []).filter((u) => searchUrls.has(u));
      if (!searchDomains.has(domain) && backing.length === 0) {
        log(`Rejected ${cand.name}: not supported by any actual search result`);
        logActivity('discover', `Rejected "${cand.name}": the proposal was not backed by a real search result`, { type: 'search_run', id: runId });
        continue;
      }
      log(`Checking ${cand.name} (${domain})`);
      let site;
      try { site = await crawlSite(cand.website); } catch (e) { log(`Rejected ${cand.name}: website unreachable (${e.message})`); continue; }
      if (!site.home.ok) { log(`Rejected ${cand.name}: website returned HTTP ${site.home.status}`); continue; }
      if (get('SELECT id FROM organizations WHERE domain = ?', site.domain)) { log(`Skipped ${cand.name}: already known`); continue; }
      const listing = await verifyListing(cand.published_listing_url, site.domain);
      const allBacking = [...new Set([...backing, ...[...searchUrls].filter((u) => baseDomain(u) === site.domain).slice(0, 3)])];
      const oppId = await saveVerified({ cand, area: params.area, origin: 'search', runId, searchSourceUrls: allBacking, site, listing, log });
      if (oppId) accepted++;
    }
    run("UPDATE search_runs SET status = 'done', stage = 'Finished', candidates_accepted = ?, finished_at = ? WHERE id = ?", accepted, now(), runId);
    logActivity('search', `Search finished: ${accepted} new opportunities from ${candidates.length} candidates`, { type: 'search_run', id: runId });
  } catch (e) {
    run("UPDATE search_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", e.message, now(), runId);
    logActivity('error', `Search failed: ${e.message}`, { type: 'search_run', id: runId });
    throw e;
  }
}

/** Manually add an organization by URL: same verification, no web search. */
export async function addOrganizationManually({ website, name, area, listingUrl }, progress) {
  const site = await crawlSite(website);
  if (!site.home.ok) throw new Error(`The website returned HTTP ${site.home.status}`);
  if (get('SELECT id FROM organizations WHERE domain = ?', site.domain)) throw new Error('This organization is already in your list');
  progress?.('Website fetched, evaluating');
  const listing = await verifyListing(listingUrl, site.domain);
  const oppId = await saveVerified({ cand: { name: name || site.pages[0].title, city: null, industry: null }, area: area || 'other', origin: 'manual', runId: null, searchSourceUrls: [], site, listing, log: (l) => progress?.(l) });
  if (!oppId) throw new Error('The agent judged this organization unsuitable; see Activity for the reason.');
  return oppId;
}
