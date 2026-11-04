// Run a discovery search from the command line (same pipeline as the Discover page).
//   node scripts/search.mjs orleans|paris [sector] [count]
import '../server/config.js';
import '../server/research/web.js';
import { ensureSeed } from '../server/profile/service.js';
import { createSearchRun, runDiscovery } from '../server/research/discovery.js';
import { get, parse } from '../server/db/index.js';
ensureSeed();
const [area = 'orleans', sector = 'any', count = '6'] = process.argv.slice(2);
const id = createSearchRun({ area, sector, count: Number(count) });
await runDiscovery(id, (l) => console.log(l));
const r = get('SELECT * FROM search_runs WHERE id = ?', id);
console.log(`\nproposed ${r.candidates_proposed}, accepted ${r.candidates_accepted}`);
console.log(parse(r.log_json, []).join('\n'));
