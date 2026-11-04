// Single-user authentication: password (scrypt) + server-side sessions in an
// HttpOnly, SameSite=Strict cookie. Mutating API calls also require a custom
// header, which cross-site forms cannot send (CSRF protection).
import { get, insert, run, now } from '../db/index.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../lib/crypto.js';
import { logActivity } from '../lib/activity.js';

const COOKIE = 'sid';
const TTL_DAYS = 30;
const attempts = new Map();

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function setCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.secureCookies ? '; Secure' : ''}`);
}

export const hasUser = () => Boolean(get('SELECT id FROM users LIMIT 1'));

function createSession(res, userId) {
  const token = randomToken(32);
  insert('INSERT INTO sessions(user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)', userId, sha256(token), now(), new Date(Date.now() + TTL_DAYS * 864e5).toISOString());
  setCookie(res, token, TTL_DAYS * 86400);
}

export function sessionUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = get('SELECT s.*, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', sha256(token));
  if (!s || s.expires_at < now()) return null;
  return { id: s.user_id, email: s.email, sessionId: s.id };
}

export function requireAuth(req, res, next) {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'stage-app') {
    return res.status(403).json({ error: 'Missing request header' });
  }
  req.user = u;
  next();
}

function throttle(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return false;
  return true;
}
function fail(ip) {
  const a = attempts.get(ip) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 5) { a.until = Date.now() + 60_000 * Math.min(15, a.n - 4); }
  attempts.set(ip, a);
}

export function authRoutes(app) {
  app.get('/api/auth/state', (req, res) => {
    const u = sessionUser(req);
    res.json({ setupRequired: !hasUser(), user: u ? { email: u.email } : null });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (hasUser()) return res.status(409).json({ error: 'Account already exists' });
    if (req.get('x-requested-with') !== 'stage-app') return res.status(403).json({ error: 'Missing request header' });
    const { email, password } = req.body || {};
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    if (!password || password.length < 10) return res.status(400).json({ error: 'Use a password of at least 10 characters' });
    const id = insert('INSERT INTO users(email, password_hash, created_at) VALUES (?, ?, ?)', email.toLowerCase(), hashPassword(password), now());
    createSession(res, id);
    logActivity('system', 'Account created');
    res.json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    if (req.get('x-requested-with') !== 'stage-app') return res.status(403).json({ error: 'Missing request header' });
    const ip = req.ip;
    if (!throttle(ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
    const { email, password } = req.body || {};
    const u = get('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase());
    if (!u || !verifyPassword(String(password || ''), u.password_hash)) { fail(ip); return res.status(401).json({ error: 'Incorrect email or password' }); }
    attempts.delete(ip);
    createSession(res, u.id);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const u = sessionUser(req);
    if (u) run('DELETE FROM sessions WHERE id = ?', u.sessionId);
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  app.post('/api/auth/password', requireAuth, (req, res) => {
    const { current, next: pw } = req.body || {};
    const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(String(current || ''), u.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
    if (!pw || pw.length < 10) return res.status(400).json({ error: 'Use a password of at least 10 characters' });
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(pw), u.id);
    run('DELETE FROM sessions WHERE user_id = ? AND id != ?', u.id, req.user.sessionId);
    res.json({ ok: true });
  });
}
