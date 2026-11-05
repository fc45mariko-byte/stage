-- Personal internship application agent: data model.
-- All timestamps are ISO-8601 UTC strings.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- The knowledge base. Every edit creates a new version; applications point to
-- the version they were generated from, so history is never rewritten.
CREATE TABLE IF NOT EXISTS profile_versions (
  id INTEGER PRIMARY KEY,
  data_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

-- Files on disk (content-addressed). Rows flagged immutable cannot be updated
-- or deleted (enforced by triggers below).
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,              -- original_cv | handbook | sent_cv | sent_letter
  application_id INTEGER REFERENCES applications(id),
  label TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS documents_no_update
BEFORE UPDATE ON documents WHEN OLD.immutable = 1
BEGIN SELECT RAISE(ABORT, 'immutable document snapshot cannot be modified'); END;

CREATE TRIGGER IF NOT EXISTS documents_no_delete
BEFORE DELETE ON documents WHEN OLD.immutable = 1
BEGIN SELECT RAISE(ABORT, 'immutable document snapshot cannot be deleted'); END;

CREATE TABLE IF NOT EXISTS handbooks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  text_content TEXT NOT NULL,
  extraction_json TEXT,           -- AI extraction with quotes (only verified quotes kept)
  extraction_status TEXT NOT NULL DEFAULT 'pending', -- pending | done | failed | unavailable
  extraction_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_runs (
  id INTEGER PRIMARY KEY,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL,           -- queued | running | done | failed
  stage TEXT,
  candidates_proposed INTEGER DEFAULT 0,
  candidates_accepted INTEGER DEFAULT 0,
  search_urls_json TEXT,          -- every URL returned by the web search tool
  log_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  area TEXT,                      -- orleans | paris | other
  city TEXT,
  industry TEXT,
  description TEXT,               -- AI summary of the fetched pages (labelled as such)
  origin TEXT NOT NULL,           -- search | manual
  search_run_id INTEGER REFERENCES search_runs(id),
  search_source_urls_json TEXT,   -- URLs from real web search results that mention it
  website_check_json TEXT,        -- server-side fetch result (status, final URL, time)
  pages_json TEXT,                -- pages fetched as evidence (url, title, fetched_at)
  location_evidence TEXT,         -- e.g. "Orléans" found on https://...
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  label TEXT,
  evidence_url TEXT,
  status TEXT NOT NULL,           -- verified | unverified | failed
  status_detail TEXT,
  mx_status TEXT,                 -- ok | none | unavailable
  checked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, email)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,             -- published | speculative
  listing_url TEXT,
  listing_check_json TEXT,
  position_title TEXT,            -- AI suggestion unless a listing is verified
  responsibilities_json TEXT,     -- AI suggestion
  match_reasons_json TEXT,        -- AI suggestion
  concerns_json TEXT,             -- AI suggestion
  handbook_notes TEXT,
  fit TEXT,                       -- strong | possible | weak (AI suggestion)
  status TEXT NOT NULL DEFAULT 'new', -- new | interested | not_interested | saved
  decided_at TEXT,
  evaluation_status TEXT NOT NULL DEFAULT 'done', -- done | unavailable | failed
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id),
  status TEXT NOT NULL,           -- draft | generating | awaiting_approval | sent | follow_up | interview | rejected | accepted | withdrawn
  language TEXT NOT NULL DEFAULT 'fr',
  profile_version_id INTEGER REFERENCES profile_versions(id),
  contact_id INTEGER REFERENCES contacts(id),
  position_title TEXT,
  cv_json TEXT,
  letter_json TEXT,
  email_subject TEXT,
  email_body TEXT,
  review_json TEXT,               -- fact-check and style warnings
  approved_hash TEXT,
  approved_at TEXT,
  generation_error TEXT,
  sent_attempt_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every generated or edited version of the documents (document library).
CREATE TABLE IF NOT EXISTS draft_versions (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  version_no INTEGER NOT NULL,
  source TEXT NOT NULL,           -- ai | edit
  cv_json TEXT NOT NULL,
  letter_json TEXT NOT NULL,
  email_subject TEXT,
  email_body TEXT,
  created_at TEXT NOT NULL
);

-- One row per sending attempt. The exact PDFs are stored before sending and
-- linked here; a finished attempt can never be modified.
CREATE TABLE IF NOT EXISTS send_attempts (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  status TEXT NOT NULL,           -- sending | sent | failed
  provider TEXT,
  sender TEXT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  cv_document_id INTEGER REFERENCES documents(id),
  letter_document_id INTEGER REFERENCES documents(id),
  provider_message_id TEXT,
  provider_response TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TRIGGER IF NOT EXISTS send_attempts_final
BEFORE UPDATE ON send_attempts WHEN OLD.status IN ('sent', 'failed')
BEGIN SELECT RAISE(ABORT, 'finished send attempt cannot be modified'); END;

CREATE TRIGGER IF NOT EXISTS send_attempts_no_delete
BEFORE DELETE ON send_attempts
BEGIN SELECT RAISE(ABORT, 'send attempts are permanent'); END;

-- Responses, follow-ups, interviews and notes after sending.
CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  type TEXT NOT NULL,             -- response | follow_up | interview | note | status
  occurred_on TEXT NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,             -- search | discover | evaluate | decision | generate | edit | approve | send | archive | profile | system | error
  message TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  ref_id INTEGER,
  status TEXT NOT NULL,           -- queued | running | done | failed
  progress TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);
