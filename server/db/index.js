// SQLite persistence via Node's built-in driver (no native build step).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

// Silence the one-time "SQLite is experimental" warning; everything else passes through.
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (String(w?.message ?? w).includes('SQLite is an experimental feature')) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

const here = path.dirname(fileURLToPath(import.meta.url));

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

export const now = () => new Date().toISOString();

export function get(sql, ...params) { return db.prepare(sql).get(...params) ?? null; }
export function all(sql, ...params) { return db.prepare(sql).all(...params); }
export function run(sql, ...params) { return db.prepare(sql).run(...params); }
export function insert(sql, ...params) { return Number(db.prepare(sql).run(...params).lastInsertRowid); }

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const parse = (s, fallback = null) => { if (s == null) return fallback; try { return JSON.parse(s); } catch { return fallback; } };

export function getSetting(key) { return get('SELECT value FROM settings WHERE key = ?', key)?.value ?? null; }
export function setSetting(key, value) {
  if (value == null) run('DELETE FROM settings WHERE key = ?', key);
  else run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

// Jobs left "running" by a previous process were interrupted.
run(`UPDATE jobs SET status='failed', error='Interrupted by a server restart', updated_at=? WHERE status IN ('queued','running')`, now());
run(`UPDATE search_runs SET status='failed', error='Interrupted by a server restart', finished_at=? WHERE status IN ('queued','running')`, now());
run(`UPDATE applications SET status='draft', generation_error='Generation interrupted by a server restart' WHERE status='generating'`);
