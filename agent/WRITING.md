# Writing rules for applications

The page (`artifact/src/app.js`, `HONESTY` / `STYLE` / `generationPrompt`) uses these same rules. Keep both in sync.

## Truthfulness
- Her profile (`profile/current.data`) is the only source of truth about her: confirmed facts, `transferable`
  items with `status: "confirmed"`, and answered `questions`. Nothing else.
- Never invent or imply experience, responsibilities, achievements, figures, software or technical skills,
  certifications, qualifications, projects, language levels or test scores. Never upgrade anything
  ("Excel (bases)" stays basic; an observation internship stays an observation internship).
- The tone is modest: a student asking for a short internship to learn.
- Missing information goes into `review.notes` as a question, never filled in.

## The CV (JSON in `applications/<id>.cv`)
You do not write CV content. Only choose:
`{headline, profile (3–4 factual sentences mentioning the duration and period exactly as in the profile),
experience_order: [experience ids], experiences: [{id, include, bullet_indices}], course_highlights: [exact course names], skills_order: [skill ids]}`.

## The cover letter (`applications/<id>.letter`)
`{subject_line, recipient_line, salutation, paragraphs: [3 or 4], closing}`, 250–330 words in the paragraphs, in French
unless `language` is `en`.
1. Who she is and what she asks for (dates).
2. What she understood of the organization's activity, citing concrete activities from its own pages, and why it
   relates to her LEA international-trade studies.
3. What she can realistically bring as an intern, from her facts only, and what she wants to learn.
4. (Optional, short) availability for a meeting.

Style: plain, precise sentences of varied length; no flattery, superlatives, exclamation marks, rhetorical questions
or em dashes. Never use: passionnée, passion, dynamique, je suis convaincue, intimement, véritable, valeur ajoutée,
atout, pleinement, parfaitement, idéal, riche expérience, défi, challenge, synergie, prestigieuse, renommée,
leader incontesté, n'hésitez pas, je serais ravie, c'est avec un grand intérêt, c'est avec enthousiasme,
fort intérêt, en tant que, forte de, je mets à votre disposition.

## The email
`emailSubject`, `emailBody`: 60–120 words presenting the application, mentioning the CV and the cover letter
attached, signed with her name and phone number.

## Review
After writing, fact-check every sentence against her profile and the organization's pages, and record
`review: {unsupported: [{excerpt, problem, severity}], orgClaims: [...], style: [...], local: [], notes: [...], at}`.
Fix anything serious before saving.
