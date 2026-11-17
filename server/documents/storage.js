// Document storage. Files are content-addressed (sha256) under data/storage,
// written read-only, and only ever served to the authenticated user.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { insert, get } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';

fs.mkdirSync(config.storageDir, { recursive: true });

export function storeFile({ buffer, kind, label, filename, mime, applicationId = null, immutable = false }) {
  const hash = sha256(buffer);
  const rel = path.join(hash.slice(0, 2), `${hash}${path.extname(filename) || ''}`);
  const abs = path.join(config.storageDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buffer, { mode: 0o444 });
  const id = insert(
    'INSERT INTO documents(kind, application_id, label, filename, mime, sha256, size, storage_path, immutable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    kind, applicationId, label, filename, mime, hash, buffer.length, rel, immutable ? 1 : 0, new Date().toISOString(),
  );
  return getDocument(id);
}

export const getDocument = (id) => get('SELECT * FROM documents WHERE id = ?', id);

// Reads a stored file and checks that it still matches its recorded hash.
export function readDocument(doc) {
  const abs = path.join(config.storageDir, doc.storage_path);
  const buf = fs.readFileSync(abs);
  if (sha256(buf) !== doc.sha256) throw new Error(`Integrity check failed for document ${doc.id}`);
  return buf;
}
