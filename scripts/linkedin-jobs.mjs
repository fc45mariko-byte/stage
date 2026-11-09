// Reads public LinkedIn internship offers (guest pages, no login) for the agent.
// Every offer in the output was fetched from LinkedIn by this script.
//
//   node scripts/linkedin-jobs.mjs --out offers.json [--known known.json] [--max-details 60]
//
// Output: [{id, url, title, company, companyUrl, location, area, listed, description,
//           duration, durationWeeks, startHint, levelHint, languages, fitsSixWeeks}]
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import '../server/config.js';
import { fetchPage } from '../server/research/web.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = opt('--out', 'linkedin-offers.json');
const maxDetails = Number(opt('--max-details', 60));
const known = fs.existsSync(opt('--known', '')) ? JSON.parse(fs.readFileSync(opt('--known'), 'utf8')) : { listings: [] };
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const LOCATIONS = { orleans: 'Orléans, Centre-Val de Loire, France', paris: 'Paris, Île-de-France, France' };
// Broad on purpose: any role where an LEA student's languages and business courses are useful.
const KEYWORDS = [
  'stage', 'stage anglais', 'stage espagnol', 'stage international', 'stage export', 'stage import export',
  'stage commercial', 'stage assistant commercial', 'stage achats', 'stage supply chain', 'stage logistique',
  'stage administration des ventes', 'stage service client', 'stage relation client', 'stage marketing',
  'stage communication', 'stage événementiel', 'stage tourisme', 'stage traduction', 'stage assistant',
  'stage ressources humaines', 'stage office manager', 'internship English Spanish',
];
const EXCLUDE = /(ing[ée]nieur|engineer|d[ée]velopp|developer|data scien|data eng|devops|r&d|m[ée]canique|[ée]lectronique|informatique|cyber|logiciel|software|fullstack|full-stack|back-?end|front-?end|chimi|biolog|pharmac|juriste|avocat|comptab|audit|finance de march|btp|g[ée]nie civil|architecte|infirmi|m[ée]dical)/i;

async function search(keywords, location, start = 0) {
  const u = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}&f_JT=I&start=${start}`;
  const r = await fetchPage(u, { timeoutMs: 20000 });
  if (!r.ok) throw new Error(`LinkedIn search HTTP ${r.status}`);
  const $ = cheerio.load(r.html);
  return $('li').map((_, li) => {
    const el = $(li);
    const link = el.find('a.base-card__full-link, a[href*="/jobs/view/"]').first().attr('href') || '';
    const id = (link.match(/-(\d{8,})(?:\?|$)/) || link.match(/view\/(\d{8,})/) || [])[1];
    if (!id) return null;
    return {
      id, url: `https://www.linkedin.com/jobs/view/${id}`,
      title: el.find('.base-search-card__title').text().trim(),
      company: el.find('.base-search-card__subtitle').text().trim(),
      companyUrl: (el.find('.base-search-card__subtitle a').attr('href') || '').split('?')[0],
      location: el.find('.job-search-card__location').text().trim(),
      listed: el.find('time').attr('datetime') || '',
    };
  }).get().filter(Boolean);
}

function analyse(text) {
  const t = text.replace(/\s+/g, ' ');
  const dur = t.match(/(\d{1,2})\s*(?:à|-|–)?\s*(\d{1,2})?\s*(mois|semaines?|months?|weeks?)/i);
  let durationWeeks = null; let duration = '';
  if (dur) {
    duration = dur[0];
    const n = Number(dur[2] || dur[1]);
    durationWeeks = /mois|month/i.test(dur[3]) ? n * 4.3 : n;
    const nMin = Number(dur[1]);
    if (/mois|month/i.test(dur[3])) durationWeeks = nMin * 4.3;
  }
  const start = t.match(/(?:d[ée]but|start|démarrage|à partir de|d[èe]s)[^.]{0,40}?(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|january|february|march|april|may|june|july|august|september)\s*(20\d\d)?/i);
  const level = t.match(/(bac\s*\+\s*\d|master|licence|bachelor|L3|M1|M2|école de commerce)/i);
  const languages = [...new Set((t.match(/\b(anglais|espagnol|english|spanish|allemand|italien|bilingue)\b/gi) || []).map((x) => x.toLowerCase()))];
  return { duration, durationWeeks, startHint: start ? start[0] : '', levelHint: level ? level[0] : '', languages };
}

const seen = new Map();
for (const [area, location] of Object.entries(LOCATIONS)) {
  for (const kw of KEYWORDS) {
    try {
      const cards = await search(kw, location);
      for (const c of cards) if (!seen.has(c.id)) seen.set(c.id, { ...c, area, matchedKeyword: kw });
      log(area, kw, cards.length);
    } catch (e) { log(area, kw, 'error', e.message); }
  }
}
const NOT_INTERNSHIP = /(altern|apprenti|apprentissage|b[ée]n[ée]volat|\bCDI\b|\bCDD\b|formation |contrat pro)/i;
const RELEVANT = /(international|export|import|achat|acheteu|commercial|ADV|administration des ventes|supply|logisti|transport|douane|client|customer|marketing|communication|[ée]v[ée]nement|tourisme|traduct|langue|anglais|espagnol|assistant|office|achats|sourcing|trade|business developer|d[ée]veloppement commercial)/i;
let offers = [...seen.values()].filter((o) => !EXCLUDE.test(o.title) && !NOT_INTERNSHIP.test(o.title) && !known.listings.includes(o.url));
log('unique', seen.size, 'after filters', offers.length);
offers.sort((a, b) => Number(RELEVANT.test(b.title)) - Number(RELEVANT.test(a.title)));
const per = Math.ceil(maxDetails / 2);
offers = [...offers.filter((o) => o.area === 'orleans').slice(0, per), ...offers.filter((o) => o.area === 'paris').slice(0, per)];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
for (const o of offers) {
  await pause(1500 + Math.random() * 1500);
  try {
    const r = await fetchPage(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${o.id}`, { timeoutMs: 20000 });
    if (!r.ok) { o.detailError = `HTTP ${r.status}`; continue; }
    const $ = cheerio.load(r.html);
    o.description = $('.show-more-less-html__markup, .description__text').first().text().replace(/\s+/g, ' ').trim().slice(0, 5000);
    o.companyUrl ||= ($('a.topcard__org-name-link').attr('href') || '').split('?')[0];
    Object.assign(o, analyse(o.description));
    o.fitsSixWeeks = o.durationWeeks ? o.durationWeeks <= 10 : null;
  } catch (e) { o.detailError = e.message; }
}
fs.writeFileSync(out, JSON.stringify(offers, null, 1));
log('wrote', offers.length, 'offers to', out);
