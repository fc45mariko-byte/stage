// Outbox relay for the "assistant" email mode (EMAIL_RELAY=assistant).
// Applications you approved and confirmed in the app wait here, with their
// archived PDFs. An assistant with access to your Gmail sends them exactly
// as archived, then records Gmail's message id. Nothing is marked "sent"
// without that id.
//
//   node scripts/relay.mjs list
//   node scripts/relay.mjs b64 <documentId>            # base64 of an archived PDF
//   node scripts/relay.mjs complete <attemptId> <gmailMessageId> [threadId]
//   node scripts/relay.mjs fail <attemptId> "<error>"
import '../server/config.js';

import { getDocument, readDocument } from '../server/documents/storage.js';
import { outbox, completeRelay, failRelay } from '../server/applications.js';

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'list') {
  const items = outbox().map((s) => {
    const docs = [s.cv_document_id, s.letter_document_id].map((id) => getDocument(id));
    return { attemptId: s.id, organization: s.org_name, to: s.recipient, from: s.sender, subject: s.subject, body: s.body, queuedAt: s.created_at,
      attachments: docs.map((d) => ({ documentId: d.id, filename: d.filename, mimeType: d.mime, size: d.size, sha256: d.sha256 })) };
  });
  console.log(JSON.stringify(items, null, 2));
} else if (cmd === 'b64') {
  const d = getDocument(Number(a));
  const inOutbox = outbox().some((s) => s.cv_document_id === d?.id || s.letter_document_id === d?.id);
  if (!d || !inOutbox) { console.error('Document is not attached to a queued email'); process.exit(1); }
  process.stdout.write(readDocument(d).toString('base64'));
} else if (cmd === 'complete') {
  completeRelay(Number(a), { messageId: b, threadId: c || null });
  console.log('recorded as sent');
} else if (cmd === 'fail') {
  failRelay(Number(a), b || 'unknown error');
  console.log('recorded as failed');
} else {
  console.log('usage: list | b64 <docId> | complete <attemptId> <messageId> [threadId] | fail <attemptId> <error>');
}
