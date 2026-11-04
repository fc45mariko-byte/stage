// Central configuration. Everything comes from environment variables so that
// credentials never live in the code or the database in plain text.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Minimal .env loader (no dependency). Existing env vars take precedence.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// APP_SECRET signs sessions and encrypts stored OAuth tokens. If it is not
// provided, one is generated once and kept in the data directory.
function loadSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 32) return process.env.APP_SECRET;
  const f = path.join(DATA_DIR, '.app_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'stage.db'),
  storageDir: path.join(DATA_DIR, 'storage'),
  secret: loadSecret(),
  secureCookies: process.env.SECURE_COOKIES === 'true' || (process.env.BASE_URL || '').startsWith('https://'),

  ai: {
    // The SDK also accepts ANTHROPIC_AUTH_TOKEN / profiles; we only check the key
    // to decide whether to show AI features as available.
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    // Server-side refusal fallbacks (Claude API only). Set AI_FALLBACKS=off to disable.
    fallbacks: process.env.AI_FALLBACKS !== 'off',
  },

  gmail: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || `${(process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '')}/api/integrations/gmail/callback`,
  },

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT || 465) === 465,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    // Only for automated tests against a local SMTP sink.
    allowInsecureTls: process.env.SMTP_ALLOW_INSECURE_TLS === 'true',
  },

  research: {
    userAgent: process.env.RESEARCH_USER_AGENT || 'PersonalInternshipAssistant/1.0 (single-user research tool)',
    // Test-only switch: allows fetching http://127.0.0.1 fixture sites.
    allowLocalFetch: process.env.ALLOW_LOCAL_FETCH === 'true',
  },
};
