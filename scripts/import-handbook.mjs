// Import the university internship handbook from the command line.
//   node scripts/import-handbook.mjs path/to/handbook.pdf
import fs from 'node:fs';
import path from 'node:path';
import '../server/config.js';
import '../server/research/web.js';
import { ensureSeed } from '../server/profile/service.js';
import { importHandbook, extractHandbook, markHandbookFailed } from '../server/documents/handbook.js';
import { aiAvailable } from '../server/ai/client.js';
ensureSeed();
const file = process.argv[2];
const id = await importHandbook({ buffer: fs.readFileSync(file), mime: 'application/pdf', filename: path.basename(file) });
console.log('imported handbook', id);
if (aiAvailable()) {
  try { const r = await extractHandbook(id); console.log(JSON.stringify(r, null, 1)); } catch (e) { markHandbookFailed(id, e); throw e; }
}
