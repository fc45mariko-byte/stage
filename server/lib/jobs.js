// Tiny in-process background job runner. Jobs are persisted so the UI can
// poll their state; on restart, running jobs are marked as interrupted.
import { insert, run, now, get } from '../db/index.js';
import { logActivity } from './activity.js';

export function startJob(type, refId, fn) {
  const id = insert('INSERT INTO jobs(type, ref_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', type, refId ?? null, 'running', now(), now());
  const progress = (text) => run('UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?', text, now(), id);
  setImmediate(async () => {
    try {
      await fn(progress);
      run("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?", now(), id);
    } catch (err) {
      console.error(`[job ${type}#${id}] ${err?.message || err}`);
      run("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", String(err?.message || err), now(), id);
      logActivity('error', `${type} failed: ${err?.message || err}`, { type: 'job', id });
    }
  });
  return id;
}

export const getJob = (id) => get('SELECT * FROM jobs WHERE id = ?', id);
