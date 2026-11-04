// Assembles the single-file artifact page: styles + app script + embedded fonts.
//   node artifact/build.mjs  ->  artifact/dist/stage.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.join(here, '..', 'server', 'documents', 'fonts');
const fonts = {
  serif: 'newsreader-latin-400-normal.woff', 'serif-semibold': 'newsreader-latin-600-normal.woff', 'serif-italic': 'newsreader-latin-400-italic.woff',
  sans: 'inter-latin-400-normal.woff', 'sans-semibold': 'inter-latin-600-normal.woff',
};
const fontData = Object.fromEntries(Object.entries(fonts).map(([k, f]) => [k, fs.readFileSync(path.join(fontsDir, f)).toString('base64')]));
const css = fs.readFileSync(path.join(here, 'src', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(here, 'src', 'app.js'), 'utf8');
export const PDFKIT_URL = 'https://cdn.jsdelivr.net/npm/pdfkit@0.17.2/js/pdfkit.standalone.js';
const page = `<title>Stage Internship Desk</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&display=swap">
<style>
${css}
</style>
<header class="top"><div class="wrap"><div class="brand">Stage<small>Internship desk</small></div><nav class="main" id="nav" aria-label="Sections"></nav></div></header>
<main class="wrap" id="main"></main>
<script src="${PDFKIT_URL}"></script>
<script>window.__STAGE_FONTS__ = ${JSON.stringify(fontData)};</script>
<script>
${js}
</script>
`;
fs.mkdirSync(path.join(here, 'dist'), { recursive: true });
fs.writeFileSync(path.join(here, 'dist', 'stage.html'), page);
console.log('built', (page.length / 1024).toFixed(0), 'KB');
