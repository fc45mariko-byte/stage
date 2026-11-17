// PDF rendering for the tailored CV and the cover letter (A4, embedded fonts).
import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const INK = '#2a2926';
const MUTED = '#6b6a64';
const ACCENT = '#5c6338';
const RULE = '#d9d5c8';

function newDoc(title, author) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 44, bottom: 36, left: 56, right: 56 }, info: { Title: title, Author: author, Creator: 'Personal internship assistant' } });
  doc.registerFont('serif', path.join(FONTS, 'newsreader-latin-400-normal.woff'));
  doc.registerFont('serif-semibold', path.join(FONTS, 'newsreader-latin-600-normal.woff'));
  doc.registerFont('serif-italic', path.join(FONTS, 'newsreader-latin-400-italic.woff'));
  doc.registerFont('sans', path.join(FONTS, 'inter-latin-400-normal.woff'));
  doc.registerFont('sans-semibold', path.join(FONTS, 'inter-latin-600-normal.woff'));
  return doc;
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

const LABELS = {
  fr: { profile: 'Profil', languages: 'Langues', education: 'Formation', experience: 'Expériences', skills: 'Compétences', interests: "Centres d'intérêt", courses: 'Enseignements' },
  en: { profile: 'Profile', languages: 'Languages', education: 'Education', experience: 'Experience', skills: 'Skills', interests: 'Interests', courses: 'Courses' },
};

/**
 * Build the effective CV content from the profile facts and the tailoring
 * choices. Tailoring can only select, order and summarise; facts come from
 * the profile.
 */
export function resolveCv(profile, cv) {
  const exps = profile.experiences;
  const order = [...(cv.experience_order || []).filter((id) => exps.some((e) => e.id === id)), ...exps.map((e) => e.id).filter((id) => !(cv.experience_order || []).includes(id))];
  const sel = Object.fromEntries((cv.experiences || []).map((e) => [e.id, e]));
  const experiences = order.map((id) => {
    const e = exps.find((x) => x.id === id);
    const s = sel[id];
    const include = s ? s.include !== false : true;
    const idx = s?.bullet_indices?.length ? s.bullet_indices.filter((i) => Number.isInteger(i) && i >= 0 && i < e.bullets.length) : e.bullets.map((_, i) => i);
    return { ...e, include, bullets: idx.map((i) => e.bullets[i]) };
  }).filter((e) => e.include);
  const allCourses = profile.education.flatMap((ed) => ed.courses);
  const courseHighlights = (cv.course_highlights || []).filter((c) => allCourses.includes(c));
  const education = profile.education.map((ed) => ({ ...ed, courses: ed.courses.length ? [...courseHighlights.filter((c) => ed.courses.includes(c)), ...ed.courses.filter((c) => !courseHighlights.includes(c))] : [] }));
  const skillOrder = [...(cv.skills_order || []).filter((id) => profile.skills.some((s) => s.id === id)), ...profile.skills.map((s) => s.id).filter((id) => !(cv.skills_order || []).includes(id))];
  return {
    identity: profile.identity,
    headline: cv.headline || profile.identity.headline,
    profileText: cv.profile || profile.internship.cv_profile_text,
    languages: profile.languages,
    education,
    experiences,
    skills: skillOrder.map((id) => profile.skills.find((s) => s.id === id)),
    interests: profile.interests,
    extraLines: cv.extra_lines || [],
  };
}

export async function renderCvPdf(profile, cv, lang = 'fr') {
  const L = LABELS[lang] || LABELS.fr;
  const r = resolveCv(profile, cv);
  const doc = newDoc(`CV – ${r.identity.full_name}`, r.identity.full_name);
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x0 = doc.page.margins.left;

  doc.font('serif').fontSize(24).fillColor(INK).text(r.identity.full_name, { characterSpacing: 0.3 });
  doc.moveDown(0.15);
  doc.font('sans').fontSize(10.5).fillColor(ACCENT).text(r.headline);
  doc.moveDown(0.3);
  const contact = [r.identity.phone, r.identity.email, r.identity.city, ...(r.extraLines || [])].filter(Boolean).join('  ·  ');
  doc.font('sans').fontSize(9).fillColor(MUTED).text(contact);
  doc.moveDown(0.8);

  const section = (title) => {
    if (doc.y > doc.page.height - 85) doc.addPage();
    doc.moveDown(0.4);
    doc.font('sans-semibold').fontSize(8.5).fillColor(ACCENT).text(title.toUpperCase(), { characterSpacing: 1.4 });
    const y = doc.y + 3;
    doc.moveTo(x0, y).lineTo(x0 + W, y).lineWidth(0.6).strokeColor(RULE).stroke();
    doc.y = y + 7;
  };
  const body = (t, opts = {}) => doc.font('serif').fontSize(10.2).fillColor(INK).text(t, { lineGap: 1.5, ...opts });

  section(L.profile);
  body(r.profileText, { align: 'justify' });

  section(L.languages);
  {
    const colW = W / r.languages.length;
    const y = doc.y;
    r.languages.forEach((l, i) => {
      doc.font('serif-semibold').fontSize(10.5).fillColor(INK).text(l.name, x0 + i * colW, y, { width: colW - 8 });
      doc.font('sans').fontSize(9).fillColor(MUTED).text(l.level, x0 + i * colW, doc.y + 1, { width: colW - 8 });
    });
    doc.x = x0;
    doc.y = y + 30;
  }

  const entry = (title, right, sub) => {
    const y = doc.y;
    doc.font('serif-semibold').fontSize(10.8).fillColor(INK).text(title, x0, y, { width: W - 110 });
    const yAfter = doc.y;
    if (right) doc.font('sans').fontSize(9).fillColor(MUTED).text(right, x0 + W - 105, y + 1, { width: 105, align: 'right' });
    doc.x = x0; doc.y = yAfter;
    if (sub) doc.font('serif-italic').fontSize(10.2).fillColor(MUTED).text(sub, x0, doc.y, { width: W });
  };

  section(L.education);
  for (const ed of r.education) {
    entry(ed.title, ed.dates, ed.institution);
    if (ed.courses.length) {
      doc.moveDown(0.15);
      doc.font('sans-semibold').fontSize(9).fillColor(INK).text(`${L.courses} : `, x0, doc.y, { continued: true });
      doc.font('sans').fontSize(9).fillColor(INK).text(ed.courses.join(' · '));
    }
    doc.moveDown(0.5);
  }

  section(L.experience);
  for (const e of r.experiences) {
    if (doc.y > doc.page.height - 75) doc.addPage();
    entry(e.title, e.dates, e.organization);
    if (e.summary) { doc.moveDown(0.1); body(e.summary, { width: W }); }
    for (const b of e.bullets) {
      doc.moveDown(0.02);
      const y = doc.y;
      doc.font('serif').fontSize(10.5).fillColor(ACCENT).text('–', x0 + 2, y, { width: 10 });
      doc.font('serif').fontSize(10.2).fillColor(INK).text(b, x0 + 14, y, { width: W - 14, lineGap: 0.8 });
    }
    doc.x = x0;
    doc.moveDown(0.4);
  }

  section(L.skills);
  for (const s of r.skills) {
    doc.font('sans-semibold').fontSize(9.5).fillColor(INK).text(`${s.label} : `, x0, doc.y, { continued: true, lineGap: 2 });
    doc.font('sans').fontSize(9.5).fillColor(INK).text(s.value, { lineGap: 2 });
  }

  if (r.interests) {
    section(L.interests);
    doc.font('sans').fontSize(9.5).fillColor(INK).text(r.interests);
  }
  return toBuffer(doc);
}

const MONTHS = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

export function formatLetterDate(date, lang, city) {
  const d = new Date(date);
  if (lang === 'en') return `${city}, ${d.getDate()} ${MONTHS.en[d.getMonth()]} ${d.getFullYear()}`;
  return `${city}, le ${d.getDate() === 1 ? '1er' : d.getDate()} ${MONTHS.fr[d.getMonth()]} ${d.getFullYear()}`;
}

export async function renderLetterPdf(profile, letter, { orgName, orgCity, date = new Date(), lang = 'fr' } = {}) {
  const id = profile.identity;
  const doc = newDoc(`${lang === 'en' ? 'Cover letter' : 'Lettre de motivation'} – ${id.full_name}`, id.full_name);
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x0 = doc.page.margins.left;

  doc.font('serif').fontSize(17).fillColor(INK).text(id.full_name);
  doc.font('sans').fontSize(9).fillColor(MUTED).text([id.city, id.phone, id.email].filter(Boolean).join('  ·  '));
  doc.moveDown(2);

  const rx = x0 + W * 0.55;
  const yR = doc.y;
  doc.font('serif-semibold').fontSize(11).fillColor(INK).text(orgName, rx, yR, { width: W * 0.45 });
  if (letter.recipient_line) doc.font('serif').fontSize(10.5).text(letter.recipient_line, rx, doc.y, { width: W * 0.45 });
  if (orgCity) doc.font('serif').fontSize(10.5).fillColor(INK).text(orgCity, rx, doc.y, { width: W * 0.45 });
  doc.moveDown(1.2);
  doc.font('serif').fontSize(10.5).fillColor(INK).text(formatLetterDate(date, lang, id.city), rx, doc.y, { width: W * 0.45 });
  doc.x = x0;
  doc.moveDown(2);

  doc.font('serif-semibold').fontSize(10.8).fillColor(INK).text(`${lang === 'en' ? 'Subject' : 'Objet'} : ${letter.subject_line}`, x0, doc.y, { width: W });
  doc.moveDown(1.4);
  doc.font('serif').fontSize(11).fillColor(INK).text(letter.salutation, { width: W });
  doc.moveDown(0.8);
  for (const p of letter.paragraphs) {
    doc.font('serif').fontSize(11).fillColor(INK).text(p, { width: W, align: 'justify', lineGap: 2.2, indent: lang === 'fr' ? 18 : 0 });
    doc.moveDown(0.75);
  }
  doc.font('serif').fontSize(11).text(letter.closing, { width: W, align: 'justify', lineGap: 2.2, indent: lang === 'fr' ? 18 : 0 });
  doc.moveDown(2);
  doc.font('serif').fontSize(11).text(id.full_name, x0 + W * 0.55, doc.y, { width: W * 0.45 });
  return toBuffer(doc);
}
