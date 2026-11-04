# Stage: a personal internship application agent

A private web app that finds organizations in Orléans and Paris that could host a 6-week L3 LEA internship. It shows them to you, writes a tailored CV and cover letter when you say you're interested, and emails the application only after your explicit final approval. Every document that is sent is archived permanently, byte for byte.

```
DISCOVER → REVIEW → INTERESTED → GENERATE CV + LETTER → EDIT / REVIEW → APPROVE → FINAL CONFIRM → SEND → ARCHIVE
```

## Quick start

```bash
npm install
cp .env.example .env      # then fill in ANTHROPIC_API_KEY and the Gmail settings
npm start                 # http://localhost:3000
```

Requires Node.js 22.13 or later (it uses the built-in SQLite driver). On first visit you create the single account that protects the workspace.

| Feature | Needs | Without it |
|---|---|---|
| Web search, evaluation, handbook reading, document writing | `ANTHROPIC_API_KEY`, with web search enabled for your organization in the Claude Console | You can still add organizations by URL (they are checked the same way) and write the documents yourself in the editor |
| Sending email | Gmail OAuth (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, then **Settings → Connect Gmail**) or SMTP with a Gmail app password | Applications can be prepared and approved, but they are clearly marked "ready, but cannot be sent yet" |

The Settings page lists the exact steps for each integration.

## Honesty and safety rules (enforced by the server, not just the UI)

- **No invented organizations.** The search agent uses the real web search tool. Each proposal is kept only if (a) its website or a supporting URL appeared in the actual search results, and (b) this server could fetch the website itself. Rejected proposals are logged in Activity.
- **Verified contacts only.** An address is "verified" only when the server fetched a page on the organization's own website and found that exact address on it. It is checked again just before sending. Sending to an unverified address is impossible.
- **Facts vs suggestions.** Website reachability, contact evidence, listing pages and location evidence are marked *Verified*. Descriptions, suggested positions, tasks and match reasons are marked *AI suggestion*.
- **Truthful CV.** The CV is assembled from your profile facts. The AI can only reorder, select and summarise; it cannot add experiences, skills or software. Every generated text then goes through an independent fact-check plus deterministic checks for language levels, software and certification names, and stock phrases. Serious issues trigger one automatic rewrite, and the rest are shown to you before approval.
- **Knowledge base.** Facts are split into confirmed facts, suggested transferable skills (not used until you confirm them) and open questions (never guessed).
- **Two-step approval.** "Approve documents" locks a content hash. Any edit withdraws the approval. Sending then needs a separate explicit confirmation, a matching hash, a re-verified recipient and a configured provider.
- **No fake success.** An application is marked *Sent* only when Gmail returns a message ID, or when the SMTP server accepts the recipient. Failed attempts are recorded as failed.
- **Immutable archive.** The exact PDFs are stored (sha256-addressed, read-only) before the send attempt. SQLite triggers block any update or deletion of those snapshots and of completed send attempts. Profile edits create new versions, and each application records the version it was written from.

## Architecture

```
server/
  index.js              HTTP server, security headers, static front-end
  config.js             environment configuration
  db/                   SQLite schema (built-in node:sqlite) + helpers, immutability triggers
  auth/                 single-user auth (scrypt, server-side sessions, CSRF header)
  profile/              knowledge base (seeded from the uploaded CV), versioning
  research/web.js       page fetching (SSRF-guarded), extraction of text, links, emails
  research/verify.js    contact verification (evidence page + MX)
  research/discovery.js search agent → verification → AI evaluation
  ai/                   Anthropic SDK wrapper (model, structured outputs, fallbacks), writing rules
  documents/            PDF rendering (pdfkit, embedded fonts), generation + fact-check,
                        handbook import (quotes verified against the text), file storage
  email/                provider abstraction: Gmail API (OAuth, gmail.send) or SMTP
  applications.js       lifecycle: draft, edit, approve, send, archive, follow-up
  routes/api.js         JSON API
public/                 front-end (vanilla JS modules, no build step)
test/                   end-to-end test with fixture website, mock Claude API, local SMTP server
```

The search engine, document generation, email provider and database sit in separate modules that talk to each other through small function interfaces, so each one can be replaced on its own.

## Tests

```bash
npm test
```

This runs the full journey against a real server process. A local fixture website stands in for the organization, a mock of the Claude Messages API (streaming) stands in for the AI, and a local SMTP server actually receives the email. The test checks that:

- an invented organization is rejected
- discovery contacts nobody
- an unverified address cannot be approved
- stale approvals are rejected
- the received attachments are byte-identical to the archived PDFs
- archived rows cannot be modified at database level
- profile updates leave sent documents unchanged

## Current limitations

- **University handbook:** it was not part of the initial upload. Upload it on **Profile → University handbook**. Until then, requirements are shown as unknown. Each extracted requirement is kept only if its verbatim quote is found in the document. You should still confirm with the university that the handbook applies to 2026–2027.
- **CV language:** the CV is always in French (the language of your facts). The letter and email can be in French or English.
- **Responses:** replies and follow-ups are recorded by hand on each application. The app does not read your inbox, because it only requests the Gmail `send` permission.
- **MX check:** if DNS is unreachable from the machine running the app, the mail-server lookup is recorded as "unavailable" and does not block sending. The address must still be found on the organization's website.
