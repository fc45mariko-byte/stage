import { insert, now } from '../db/index.js';

// Chronological, append-only log of everything the agent does.
export function logActivity(type, message, ref = {}, meta = null) {
  return insert(
    'INSERT INTO activity(ts, type, message, ref_type, ref_id, meta_json) VALUES (?, ?, ?, ?, ?, ?)',
    now(), type, message, ref.type ?? null, ref.id ?? null, meta ? JSON.stringify(meta) : null,
  );
}
