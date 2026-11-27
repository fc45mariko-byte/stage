// University internship handbook: text extraction + AI extraction of the
// requirements. Every requirement must come with a verbatim quote, and quotes
// are checked against the handbook text; unverifiable items are discarded.
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { insert, get, run, parse, now } from '../db/index.js';
import { storeFile } from './storage.js';
import { aiAvailable, jsonCall, obj, str, arr } from '../ai/client.js';
import { logActivity } from '../lib/activity.js';

async function toText(buffer, mime, filename) {
  if (mime === 'application/pdf' || /\.pdf$/i.test(filename)) {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((t, i) => `[page ${i + 1}]\n${t}`).join('\n\n');
  }
  if (/\.docx$/i.test(filename)) return (await mammoth.extractRawText({ buffer })).value;
  if (/^text\//.test(mime) || /\.(txt|md)$/i.test(filename)) return buffer.toString('utf8');
  throw new Error('Unsupported handbook format (use PDF, DOCX or TXT)');
}

const norm = (s) => String(s).toLowerCase().normalize('NFKC').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

export async function importHandbook({ buffer, mime, filename }) {
  const text = await toText(buffer, mime, filename);
  if (text.replace(/\s/g, '').length < 200) throw new Error('Almost no text could be extracted from this file (is it a scanned document?).');
  const doc = storeFile({ buffer, kind: 'handbook', label: `Internship handbook – ${filename}`, filename, mime, immutable: true });
  const id = insert('INSERT INTO handbooks(document_id, text_content, extraction_status, created_at) VALUES (?, ?, ?, ?)', doc.id, text, aiAvailable() ? 'pending' : 'unavailable', now());
  logActivity('profile', `Internship handbook imported (${filename}, ${text.length} characters of text)`, { type: 'handbook', id });
  return id;
}

const schema = obj({
  document_title: str(),
  academic_year_stated: str('Academic year or date the handbook says it applies to, verbatim; empty string if not stated'),
  requirements: arr(obj({
    topic: { type: 'string', enum: ['duration', 'dates', 'agreement', 'missions', 'host_organization', 'abroad', 'evaluation', 'remuneration', 'procedure', 'other'] },
    requirement: str('Short neutral paraphrase'),
    quote: str('Exact verbatim excerpt from the handbook supporting it (copy characters exactly, 10–400 chars)'),
    page: str('Page marker if visible, e.g. "3", else empty'),
  })),
});

export async function extractHandbook(id) {
  const hb = get('SELECT * FROM handbooks WHERE id = ?', id);
  if (!hb) throw new Error('Handbook not found');
  const out = await jsonCall({
    system: 'You extract internship rules from a French university internship handbook. Only report rules that are explicitly written in the document. Do not add general knowledge about French internships. Quotes must be copied exactly from the text.',
    user: `Extract every rule relevant to a student of Licence 3 LEA (Commerce international) at the Université d'Orléans looking for an internship: duration, period/dates, internship agreement (convention), acceptable missions, acceptable host organizations, internships abroad, evaluation, remuneration (gratification), procedure.\n\nHANDBOOK TEXT:\n<<<\n${hb.text_content.slice(0, 400000)}\n>>>`,
    schema, effort: 'medium',
  });
  const hay = norm(hb.text_content);
  const verified = []; const dropped = [];
  for (const r of out.requirements) (hay.includes(norm(r.quote)) ? verified : dropped).push(r);
  const result = { ...out, requirements: verified, dropped_count: dropped.length, extracted_at: now() };
  run("UPDATE handbooks SET extraction_json = ?, extraction_status = 'done', extraction_error = NULL WHERE id = ?", JSON.stringify(result), id);
  logActivity('profile', `Handbook analysed: ${verified.length} requirements with verified quotes${dropped.length ? `, ${dropped.length} discarded (quote not found in the text)` : ''}`, { type: 'handbook', id });
  return result;
}

export function markHandbookFailed(id, err) {
  run("UPDATE handbooks SET extraction_status = 'failed', extraction_error = ? WHERE id = ?", String(err?.message || err), id);
}

export function currentHandbook() {
  const hb = get('SELECT h.*, d.filename, d.id AS doc_id FROM handbooks h JOIN documents d ON d.id = h.document_id ORDER BY h.id DESC LIMIT 1');
  if (!hb) return null;
  return { id: hb.id, documentId: hb.doc_id, filename: hb.filename, createdAt: hb.created_at, status: hb.extraction_status, error: hb.extraction_error, extraction: parse(hb.extraction_json), textLength: hb.text_content.length };
}

// Requirements passed to the AI when evaluating opportunities / writing letters.
export function handbookForAI() {
  const hb = currentHandbook();
  if (!hb || hb.status !== 'done') return null;
  return { academic_year_stated: hb.extraction.academic_year_stated, requirements: hb.extraction.requirements.map((r) => ({ topic: r.topic, requirement: r.requirement, quote: r.quote })) };
}
