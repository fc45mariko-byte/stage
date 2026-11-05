// Tailored CV + cover letter + email generation, followed by a fact-check
// pass. The CV is assembled from profile facts; the AI only chooses what to
// emphasise and writes the short profile paragraph, which is then checked.
import { jsonCall, obj, str, arr } from '../ai/client.js';
import { HONESTY_RULES, STYLE_RULES, styleCheck } from '../ai/style.js';
import { factsForAI } from '../profile/service.js';
import { handbookForAI } from './handbook.js';
import { parse } from '../db/index.js';

const generationSchema = obj({
  cv: obj({
    headline: str('One line under the name. Must stay factual, e.g. "Étudiante en Licence 3 LEA – Commerce international · recherche un stage de 6 semaines (avril–juin 2027)"'),
    profile: str('3–4 sentence profile paragraph for the CV, tailored to this organization, using only candidate facts'),
    experience_order: arr(str(), 'All experience ids, most relevant first'),
    experiences: arr(obj({ id: str(), include: { type: 'boolean' }, bullet_indices: arr({ type: 'integer' }, 'Indices of existing bullets to keep, in display order') })),
    course_highlights: arr(str(), 'Course names copied exactly from the candidate facts, most relevant first'),
    skills_order: arr(str(), 'Skill ids, most relevant first'),
  }),
  letter: obj({
    subject_line: str('e.g. "Candidature spontanée – stage de 6 semaines (avril–juin 2027)"'),
    recipient_line: str('Optional second line under the organization name (e.g. "Service Export" or "Service des ressources humaines") only if supported by the sources, else empty'),
    salutation: str(),
    paragraphs: arr(str(), '3 or 4 paragraphs'),
    closing: str('Closing formula paragraph'),
  }),
  email: obj({ subject: str(), body: str('Short email body (60–120 words) presenting the application, mentioning the two attachments, signed with her name and phone') }),
  notes_for_candidate: arr(str(), 'Questions or missing information she should provide to improve this application (never filled in by you)'),
});

export function buildContext({ profile, org, opp, pages, language }) {
  const facts = factsForAI(profile);
  const handbook = handbookForAI();
  const sources = (pages || []).map((p) => `URL: ${p.url}\nTITLE: ${p.title}\nTEXT: ${String(p.text || '').slice(0, 5000)}`).join('\n\n---\n\n');
  return `CANDIDATE FACTS (only source of truth about her):
${JSON.stringify(facts, null, 1)}

${handbook ? `UNIVERSITY HANDBOOK REQUIREMENTS (verbatim quotes):\n${JSON.stringify(handbook, null, 1)}\n` : ''}
TARGET ORGANIZATION: ${org.name}
Website: ${org.website}
Area: ${org.area}${org.city ? `, ${org.city}` : ''}
Industry: ${org.industry || 'unknown'}
Application type: ${opp.kind === 'published' ? `reply to a published internship offer (${opp.listing_url})` : 'spontaneous application (no published offer)'}
Internship idea (AI suggestion, may be adjusted): ${opp.position_title || 'not defined'}
Possible tasks (AI suggestion): ${(parse(opp.responsibilities_json, []) || []).join(' | ')}
Why it may fit (AI suggestion): ${(parse(opp.match_reasons_json, []) || []).join(' | ')}

ORGANIZATION SOURCES (pages fetched from its website):
${sources || '(no page text available – stay general about the organization and say so in notes_for_candidate)'}

LANGUAGE OF THE LETTER AND EMAIL: ${language === 'en' ? 'English' : 'French'}. The CV stays in French.`;
}

export async function generateApplication({ profile, org, opp, pages, language = 'fr', feedback = null, previous = null }) {
  const system = `You write internship applications for one specific student. Each application must be written for this organization only: refer to what it actually does according to the sources, and explain plainly why this internship makes sense for her studies. Never reuse a generic template.

${HONESTY_RULES}

${STYLE_RULES[language] || STYLE_RULES.fr}

CV rules: you do not write the CV content. You only (1) write a short factual headline and profile paragraph, (2) order her real experiences and choose which existing bullets to show (use ids and indices from the facts; keep the Service Civique and the logistics experiences unless clearly irrelevant), (3) choose which real courses to highlight, (4) order skill groups. The profile paragraph must mention the internship duration and period exactly as in the facts.

Cover letter: about 250–330 words in total for the paragraphs. Paragraph 1: who she is and what she is asking for (dates). Paragraph 2: what she understood of the organization's activity and why it relates to her LEA international-trade studies (be concrete, cite activities from the sources). Paragraph 3: what she can realistically contribute as an intern, based only on her facts (languages, rigour in writing, first logistics experience, etc.) and what she wants to learn. Optional short paragraph 4: availability / meeting. Do not repeat the CV line by line.`;

  let user = buildContext({ profile, org, opp, pages, language });
  if (feedback && previous) {
    user += `\n\nA PREVIOUS DRAFT had these problems, fix them all:\n${feedback.map((f) => `- ${f}`).join('\n')}\n\nPrevious draft:\n${JSON.stringify(previous)}`;
  } else if (feedback) {
    user += `\n\nINSTRUCTIONS FROM THE CANDIDATE FOR THIS VERSION:\n${feedback.join('\n')}`;
  }
  const out = await jsonCall({ system, user, schema: generationSchema, effort: 'high' });
  // Safety net: drop course names / ids that do not exist in the facts.
  const courses = profile.education.flatMap((e) => e.courses);
  out.cv.course_highlights = out.cv.course_highlights.filter((c) => courses.includes(c));
  const expIds = profile.experiences.map((e) => e.id);
  out.cv.experience_order = out.cv.experience_order.filter((id) => expIds.includes(id));
  out.cv.experiences = out.cv.experiences.filter((e) => expIds.includes(e.id));
  return out;
}

const reviewSchema = obj({
  unsupported_claims: arr(obj({
    excerpt: str('The exact problematic excerpt'),
    problem: str('Why it is not supported by the facts or is exaggerated'),
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
  })),
  organization_claims_not_in_sources: arr(str(), 'Statements about the organization that the sources do not support'),
  style_remarks: arr(str(), 'Generic, inflated or AI-sounding passages, if any'),
});

/** Independent fact-check of every free-text element against the facts. */
export async function reviewApplication({ profile, org, opp, pages, language, draft }) {
  const review = await jsonCall({
    system: `You are a strict fact-checker. Compare an internship application with the candidate's facts and the organization's web pages. Flag every claim about the candidate that is not directly supported by her facts (invented experience, tasks, skills, software, achievements, certifications, upgraded language levels or exaggerations), and every claim about the organization not supported by the sources. Reasonable, modest statements of motivation or learning goals are fine. Do not flag style choices as facts.`,
    user: `${buildContext({ profile, org, opp, pages, language })}\n\nAPPLICATION TO CHECK:\nCV headline: ${draft.cv.headline}\nCV profile: ${draft.cv.profile}\n\nLetter:\n${draft.letter.subject_line}\n${draft.letter.salutation}\n${draft.letter.paragraphs.join('\n\n')}\n${draft.letter.closing}\n\nEmail subject: ${draft.email.subject}\nEmail body:\n${draft.email.body}`,
    schema: reviewSchema, effort: 'medium', maxTokens: 12000,
  });
  return review;
}

export function localChecks(draft, language, profile) {
  const texts = [draft.cv.headline, draft.cv.profile, draft.letter.subject_line, ...draft.letter.paragraphs, draft.letter.closing, draft.email.subject, draft.email.body];
  const banned = styleCheck(texts, language);
  const warnings = [];
  if (banned.length) warnings.push(`Expressions to avoid found: ${banned.join(', ')}`);
  const words = draft.letter.paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
  if (words > 380) warnings.push(`The letter is long (${words} words).`);
  if (words < 150) warnings.push(`The letter is short (${words} words).`);
  // Language levels must not differ from the profile.
  const all = texts.join(' ');
  for (const lvl of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) {
    const re = new RegExp(`\\b${lvl}\\b`, 'g');
    if (re.test(all) && !profile.languages.some((l) => l.level.includes(lvl))) warnings.push(`Mentions level ${lvl}, which is not in the profile.`);
  }
  const tools = /\b(SAP|Salesforce|CRM|ERP|Excel avancé|advanced Excel|VBA|Power ?BI|Tableau|SQL|Python|Photoshop|Canva|HubSpot|TOEIC|TOEFL|IELTS|Cambridge|DELE)\b/gi;
  const known = JSON.stringify(profile).toLowerCase();
  for (const m of all.matchAll(tools)) if (!known.includes(m[0].toLowerCase())) warnings.push(`Mentions "${m[0]}", which is not in the profile.`);
  return [...new Set(warnings)];
}
