// Contact email verification. An address is "verified" only when our server
// fetched a page on the organization's own website and found that exact
// address on it. Nothing is ever sent to an unverified address.
import dns from 'node:dns/promises';
import { fetchPage, extractPage, baseDomain } from './web.js';

export async function checkMx(email) {
  if (process.env.SKIP_MX_CHECK === 'true') return 'unavailable'; // automated tests only
  const domain = email.split('@')[1];
  try {
    const mx = await dns.resolveMx(domain);
    return mx.length ? 'ok' : 'none';
  } catch (e) {
    if (e.code === 'ENODATA') {
      // RFC 5321: fall back to an A record
      try { await dns.resolve4(domain); return 'ok'; } catch { return 'none'; }
    }
    if (e.code === 'ENOTFOUND' && !process.env.HTTPS_PROXY && !process.env.https_proxy) return 'none';
    return 'unavailable'; // DNS not reachable from this machine; recorded, not blocking
  }
}

const EMAIL_SHAPE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/i;

/**
 * Verify that `email` appears on `evidenceUrl`, and that the page belongs to
 * the organization's website domain.
 */
export async function verifyEmail({ email, evidenceUrl, orgWebsite }) {
  const addr = String(email || '').trim().toLowerCase();
  const checkedAt = new Date().toISOString();
  if (!EMAIL_SHAPE.test(addr)) return { status: 'failed', detail: 'Not a valid email address', checkedAt, mx: null };
  if (!evidenceUrl) return { status: 'unverified', detail: 'No page showing this address was provided', checkedAt, mx: null };

  const orgDomain = baseDomain(orgWebsite);
  let page;
  try { page = await fetchPage(evidenceUrl); } catch (e) {
    return { status: 'unverified', detail: `Could not fetch the evidence page: ${e.message}`, checkedAt, mx: null };
  }
  if (!page.ok) return { status: 'unverified', detail: `Evidence page returned HTTP ${page.status}`, checkedAt, mx: null };
  if (baseDomain(page.finalUrl) !== orgDomain) {
    return { status: 'unverified', detail: `The evidence page (${baseDomain(page.finalUrl)}) is not on the organization's website (${orgDomain})`, checkedAt, mx: null };
  }
  const ex = extractPage(page.html, page.finalUrl);
  if (!ex.emails.includes(addr)) {
    return { status: 'unverified', detail: `The address was not found on ${page.finalUrl}`, checkedAt, mx: null };
  }
  const mx = await checkMx(addr);
  if (mx === 'none') return { status: 'failed', detail: `The domain ${addr.split('@')[1]} has no mail server`, checkedAt, mx };
  return {
    status: 'verified',
    detail: `Found on ${page.finalUrl} (fetched ${checkedAt.slice(0, 10)})${mx === 'unavailable' ? '; mail-server lookup unavailable from this machine' : ''}`,
    checkedAt, mx, evidenceUrl: page.finalUrl,
  };
}
