// Gmail API integration (OAuth 2.0, scope gmail.send only).
import { config } from '../config.js';
import { getSetting, setSetting } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'];

export const gmailConfigured = () => Boolean(config.gmail.clientId && config.gmail.clientSecret);
export const gmailConnected = () => Boolean(getSetting('gmail_refresh_token'));
export const gmailAccount = () => getSetting('gmail_email');

export function gmailAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: config.gmail.clientId, redirect_uri: config.gmail.redirectUri, response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.gmail.clientId, client_secret: config.gmail.clientSecret, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token error: ${json.error_description || json.error || res.status}`);
  return json;
}

export async function gmailHandleCallback(code) {
  const tok = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: config.gmail.redirectUri });
  if (!tok.refresh_token) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.');
  if (!String(tok.scope || '').includes('gmail.send')) throw new Error('The Gmail "send" permission was not granted.');
  const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
  setSetting('gmail_refresh_token', encrypt(tok.refresh_token));
  setSetting('gmail_email', info.email || '');
  return info.email;
}

export async function gmailDisconnect() {
  const enc = getSetting('gmail_refresh_token');
  if (enc) {
    try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decrypt(enc))}`, { method: 'POST' }); } catch { /* best effort */ }
  }
  setSetting('gmail_refresh_token', null);
  setSetting('gmail_email', null);
}

/** Sends a raw RFC 822 message. Returns the Gmail message id; throws otherwise. */
export async function gmailSendRaw(rawBuffer) {
  const enc = getSetting('gmail_refresh_token');
  if (!enc) throw new Error('Gmail is not connected');
  const { access_token: accessToken } = await tokenRequest({ refresh_token: decrypt(enc), grant_type: 'refresh_token' });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: rawBuffer.toString('base64url') }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) throw new Error(`Gmail refused the message: ${json.error?.message || res.status}`);
  return { messageId: json.id, response: JSON.stringify({ id: json.id, threadId: json.threadId, labelIds: json.labelIds }) };
}
