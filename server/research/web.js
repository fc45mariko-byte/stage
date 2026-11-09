// Web page fetching and extraction used to verify organizations.
// The server itself fetches pages, so "verified" means: our server saw it.
import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import { fetch as ufetch, EnvHttpProxyAgent, Agent, setGlobalDispatcher } from 'undici';
import { config } from '../config.js';

const usingProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);
export const dispatcher = usingProxy ? new EnvHttpProxyAgent() : new Agent();
// Also route the Anthropic SDK / Gmail calls through the proxy if one is configured.
if (usingProxy) setGlobalDispatcher(dispatcher);

const MAX_BYTES = 2_500_000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
  }
  return false;
}

// Refuse URLs that point at the local machine or private networks.
async function assertPublicUrl(u) {
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Unsupported protocol ${u.protocol}`);
  if (config.research.allowLocalFetch) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Refusing to fetch a local address');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('Refusing to fetch a private address'); return; }
  if (usingProxy) return; // the egress proxy resolves names; local DNS may be unavailable
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Refusing to fetch a private address');
  } catch (e) {
    if (String(e.message).startsWith('Refusing')) throw e;
    throw new Error(`DNS lookup failed for ${host}`);
  }
}

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Empty URL');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  u.hash = '';
  return u;
}

// Registrable-ish domain: strips "www." and keeps the last two labels
// (good enough for .fr/.com/.org/.eu; handles a few common two-level suffixes).
export function baseDomain(hostOrUrl) {
  let host = String(hostOrUrl);
  try { host = new URL(host.includes('://') ? host : `https://${host}`).hostname; } catch { /* keep */ }
  host = host.toLowerCase().replace(/^www\./, '');
  const parts = host.split('.');
  const twoLevel = ['co.uk', 'com.au', 'co.jp', 'com.br', 'gouv.fr', 'asso.fr', 'cci.fr'];
  const last2 = parts.slice(-2).join('.');
  if (twoLevel.includes(last2) && parts.length > 2) return parts.slice(-3).join('.');
  return last2;
}

export async function fetchPage(input, { timeoutMs = 15000 } = {}) {
  let url = input instanceof URL ? input : normalizeUrl(input);
  const started = Date.now();
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(url);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await ufetch(url, {
        dispatcher,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': config.research.userAgent, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5', 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8' },
      });
    } catch (e) {
      clearTimeout(t);
      throw new Error(e.name === 'AbortError' ? `Timed out fetching ${url.href}` : `Could not reach ${url.href}: ${e.cause?.code || e.message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(t);
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    const type = res.headers.get('content-type') || '';
    let body = '';
    if (/text|html|xml|json/i.test(type) || !type) {
      const reader = res.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length; chunks.push(value);
          if (size > MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } break; }
        }
      }
      body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    } else {
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    clearTimeout(t);
    return { ok: res.ok, status: res.status, finalUrl: url.href, contentType: type, html: body, fetchedAt: new Date().toISOString(), ms: Date.now() - started };
  }
  throw new Error('Too many redirects');
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
const IGNORED_EMAIL = /(example\.(com|org|fr)|sentry|wixpress|\.png$|\.jpe?g$|\.gif$|\.webp$|\.svg$|domain\.(com|fr)|email\.com$|votre|yourname|nom\.prenom|prenom\.nom|monadresse|mondomaine|votreadresse|votre-email|adresse@|email@|u003e)/i;

export function deobfuscate(text) {
  return String(text)
    .replace(/\s*[[(]\s*(at|arobase|chez)\s*[\])]\s*/gi, '@')
    .replace(/\s*[[(]\s*(dot|point)\s*[\])]\s*/gi, '.');
}

export function extractEmails(htmlOrText) {
  const found = new Set();
  const src = deobfuscate(String(htmlOrText).replace(/&#64;|&commat;/g, '@').replace(/&#46;/g, '.'));
  for (const m of src.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/^mailto:/, '').replace(/\.$/, '');
    if (!IGNORED_EMAIL.test(e) && e.length < 120) found.add(e);
  }
  return [...found];
}

export function extractPage(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const mailtos = [];
  $('a[href^="mailto:"]').each((_, a) => {
    const raw = decodeURIComponent(($(a).attr('href') || '').slice(7).split('?')[0]).trim().toLowerCase();
    if (raw) mailtos.push(raw);
  });
  const links = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    try {
      const u = new URL(href, pageUrl);
      if (['http:', 'https:'].includes(u.protocol)) links.push({ url: u.href.split('#')[0], text: $(a).text().replace(/\s+/g, ' ').trim().slice(0, 80) });
    } catch { /* ignore */ }
  });
  const title = $('title').first().text().replace(/\s+/g, ' ').trim();
  const description = ($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '').trim();
  $('script, style, noscript, svg, iframe').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim() || $.root().text().replace(/\s+/g, ' ').trim();
  const emails = [...new Set([...mailtos, ...extractEmails(html)])];
  return { title, description, text, links, emails };
}

const CONTACT_HINT = /(contact|nous-contacter|contactez|mentions|legal|a-propos|about|qui-sommes|societe|entreprise|recrutement|carriere|careers|emploi|jobs|rejoindre|join|stage|alternance)/i;

// Fetch the home page plus a few contact/legal/careers pages on the same site.
export async function crawlSite(website, { maxPages = 6 } = {}) {
  const home = await fetchPage(website);
  const pages = [];
  const domain = baseDomain(home.finalUrl);
  const homeEx = extractPage(home.html, home.finalUrl);
  pages.push({ url: home.finalUrl, status: home.status, fetchedAt: home.fetchedAt, ...homeEx });
  if (!home.ok) return { home, domain, pages };
  const candidates = [];
  const seen = new Set([home.finalUrl]);
  for (const l of homeEx.links) {
    if (seen.has(l.url) || baseDomain(l.url) !== domain) continue;
    if (CONTACT_HINT.test(l.url) || CONTACT_HINT.test(l.text)) { candidates.push(l.url); seen.add(l.url); }
  }
  for (const url of candidates.slice(0, maxPages - 1)) {
    try {
      const p = await fetchPage(url, { timeoutMs: 12000 });
      if (p.ok && p.html) pages.push({ url: p.finalUrl, status: p.status, fetchedAt: p.fetchedAt, ...extractPage(p.html, p.finalUrl) });
    } catch { /* a missing sub-page is not fatal */ }
  }
  return { home, domain, pages };
}
