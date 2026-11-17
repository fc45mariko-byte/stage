// Knowledge base access. The profile is versioned: each save creates a new row.
import fs from 'node:fs';
import path from 'node:path';
import { get, insert, all, parse, now } from '../db/index.js';
import { seedProfile } from './seed.js';
import { storeFile } from '../documents/storage.js';
import { logActivity } from '../lib/activity.js';
import { ROOT } from '../config.js';

export function currentProfile() {
  const row = get('SELECT * FROM profile_versions ORDER BY id DESC LIMIT 1');
  return row ? { versionId: row.id, createdAt: row.created_at, data: parse(row.data_json) } : null;
}

export function profileVersion(id) {
  const row = get('SELECT * FROM profile_versions WHERE id = ?', id);
  return row ? { versionId: row.id, createdAt: row.created_at, data: parse(row.data_json) } : null;
}

export function listProfileVersions() {
  return all('SELECT id, note, created_at FROM profile_versions ORDER BY id DESC');
}

export function saveProfile(data, note = 'Profile updated') {
  validateProfile(data);
  const id = insert('INSERT INTO profile_versions(data_json, note, created_at) VALUES (?, ?, ?)', JSON.stringify(data), note, now());
  logActivity('profile', `${note} (version ${id})`, { type: 'profile', id });
  return currentProfile();
}

function validateProfile(d) {
  if (!d || typeof d !== 'object') throw new Error('Invalid profile');
  for (const k of ['identity', 'internship', 'languages', 'education', 'experiences', 'skills', 'transferable', 'questions']) {
    if (!(k in d)) throw new Error(`Profile is missing "${k}"`);
  }
  if (!d.identity.full_name || !d.identity.email) throw new Error('Name and email are required');
}

// Facts the AI is allowed to use: confirmed data, confirmed transferable
// skills and answered questions. Suggested/rejected items are excluded.
export function factsForAI(data) {
  return {
    identity: data.identity,
    internship: data.internship,
    languages: data.languages,
    education: data.education,
    experiences: data.experiences,
    skills: data.skills,
    interests: data.interests,
    confirmed_transferable_skills: data.transferable.filter((t) => t.status === 'confirmed').map((t) => ({ text: t.text, basis: t.basis })),
    answers_from_candidate: data.questions.filter((q) => q.status === 'answered' && q.answer?.trim()).map((q) => ({ question: q.question, answer: q.answer })),
  };
}

export function ensureSeed() {
  if (currentProfile()) return;
  insert('INSERT INTO profile_versions(data_json, note, created_at) VALUES (?, ?, ?)', JSON.stringify(seedProfile), 'Initial knowledge base from uploaded CV', now());
  logActivity('profile', 'Knowledge base created from the uploaded CV (confirmed facts, suggested transferable skills, open questions)');
  const cvPath = path.join(ROOT, 'assets', 'CV_Fatima-Christine_Mariko.docx');
  if (fs.existsSync(cvPath)) {
    storeFile({
      buffer: fs.readFileSync(cvPath), kind: 'original_cv', label: 'Original CV (uploaded)',
      filename: 'CV_Fatima-Christine_Mariko.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', immutable: true,
    });
  }
}
