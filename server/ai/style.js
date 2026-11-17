// Writing rules shared by every generated text, plus a deterministic check
// for expressions that make letters sound generic or inflated.

export const HONESTY_RULES = `
Ground rules about the candidate (non-negotiable):
- The CANDIDATE FACTS block is the only source of truth about her. Use nothing else about her.
- Never invent or imply: professional experience, responsibilities, achievements, figures, software skills, technical skills, certifications, qualifications, projects, language levels or test scores.
- Do not upgrade anything: an observation internship stays an observation internship; "Excel (bases)" stays basic; a summer job stays a summer job.
- Skills listed as "confirmed_transferable_skills" may be used as written. Nothing else may be inferred and presented as a skill.
- She is a student looking for a short internship to learn. The tone must stay modest and credible.
- If something useful is missing, do not fill the gap: mention it in "notes_for_candidate".
`.trim();

export const STYLE_RULES = {
  fr: `
Style (French):
- Write like a thoughtful third-year student, not like a marketing text or an AI assistant.
- Plain, precise sentences. Vary sentence length. No rhetorical questions, no exclamation marks.
- Be specific about the organization: refer to concrete activities, markets, products or services that appear in the ORGANIZATION SOURCES. Never claim knowledge that is not in the sources.
- No flattery, no superlatives about the organization, no over-enthusiasm.
- Avoid these words/expressions entirely: passionnée, passion, dynamique, motivée et dynamique, je suis convaincue, intimement, véritable, valeur ajoutée, atout, pleinement, parfaitement, idéal, idéale, riche expérience, défi, challenge, synergie, prestigieuse, renommée, leader incontesté, n'hésitez pas, je serais ravie, c'est avec un grand intérêt, c'est avec enthousiasme, fort intérêt, en tant que, forte de, rigoureuse et dynamique, je mets à votre disposition, au sein de votre prestigieuse.
- Do not use em dashes (—). Use commas or full stops.
- Standard French letter conventions: "Madame, Monsieur," and a classic but short closing formula.
`.trim(),
  en: `
Style (English):
- Write like a thoughtful third-year student, not like a marketing text or an AI assistant.
- Plain, precise sentences. Vary sentence length. No rhetorical questions, no exclamation marks.
- Be specific about the organization, using only what appears in the ORGANIZATION SOURCES.
- No flattery, no superlatives, no over-enthusiasm.
- Avoid entirely: passionate, passion, thrilled, excited, eager, delighted, dynamic, leverage, synergy, delve, tapestry, cutting-edge, world-class, renowned, I am confident that, I am convinced, unique opportunity, perfect fit, add value, hit the ground running, I would be honoured.
- Do not use em dashes (—).
`.trim(),
};

const BANNED = {
  fr: ['passionnée', 'passionné', 'passion', 'dynamique', 'je suis convaincue', 'intimement', 'véritable', 'valeur ajoutée', 'atout', 'pleinement', 'parfaitement', 'idéal', 'riche expérience', 'défi', 'challenge', 'synergie', 'prestigieu', 'renommée', 'leader incontesté', "n'hésitez pas", 'je serais ravie', 'avec un grand intérêt', 'avec enthousiasme', 'fort intérêt', 'en tant que', 'forte de', 'je mets à votre disposition', '—', '!'],
  en: ['passionate', 'passion', 'thrilled', 'excited', 'eager', 'delighted', 'dynamic', 'leverage', 'synergy', 'delve', 'tapestry', 'cutting-edge', 'world-class', 'renowned', 'i am confident that', 'i am convinced', 'unique opportunity', 'perfect fit', 'add value', 'hit the ground running', '—', '!'],
};

export function styleCheck(texts, lang = 'fr') {
  const hits = [];
  const list = BANNED[lang] || BANNED.fr;
  for (const t of texts) {
    const low = String(t || '').toLowerCase().replace(/’/g, "'");
    for (const w of list) if (low.includes(w)) hits.push(w);
  }
  return [...new Set(hits)];
}
