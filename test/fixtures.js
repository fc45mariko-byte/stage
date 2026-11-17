// Test fixtures: a small organization website, a mock of the Claude Messages
// API (streaming SSE), and a local SMTP server that records received mail.
// These exist only for automated tests; the app itself never uses them.
import http from 'node:http';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

export async function startSite() {
  const server = http.createServer((req, res) => {
    const page = (title, body) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="Négoce international de vins et spiritueux"></head><body>${body}</body></html>`;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/') return res.end(page('Loire Export Négoce', '<h1>Loire Export Négoce</h1><p>Exportateur de vins du Val de Loire vers le Royaume-Uni, l’Espagne et l’Amérique latine. Siège : 12 rue de Bourgogne, 45000 Orléans.</p><a href="/contact">Contact</a> <a href="/recrutement">Recrutement</a>'));
    if (req.url === '/contact') return res.end(page('Contact', '<p>Service export : <a href="mailto:export@loire-export.example">export@loire-export.example</a></p><p>Stages : stages [at] loire-export.example</p>'));
    if (req.url === '/recrutement') return res.end(page('Recrutement – stage assistant export', '<h2>Stage assistant(e) export – printemps 2027</h2><p>Nous accueillons un stagiaire pour 6 à 8 semaines.</p>'));
    if (req.url === '/other') return res.end(page('Other', '<p>No address here.</p>'));
    res.statusCode = 404; res.end('not found');
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

// ---------- mock Claude API ----------
function sse(res, blocks, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      send('content_block_start', { index, content_block: { ...b, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    } else {
      send('content_block_start', { index, content_block: b });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 50 } });
  send('message_stop', {});
  res.end();
}

export async function startMockClaude({ siteUrl }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = JSON.parse(body);
      requests.push(r);
      const sys = String(r.system || '');
      const json = (obj) => sse(res, [{ type: 'text', text: JSON.stringify(obj) }], 'end_turn');
      if (r.tools?.some((t) => t.name === 'submit_candidates')) {
        return sse(res, [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'exportateur Orléans stage' } },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: `${siteUrl}/`, title: 'Loire Export Négoce', encrypted_content: 'x', page_age: null }] },
          { type: 'tool_use', id: 'toolu_1', name: 'submit_candidates', input: { notes: 'test', candidates: [
            { name: 'Loire Export Négoce', website: `${siteUrl}/`, city: 'Orléans', industry: 'Négoce de vins', why_relevant: 'Exports to the UK and Spain.', source_urls: [`${siteUrl}/`], published_listing_url: `${siteUrl}/recrutement` },
            { name: 'Ghost Trading', website: 'https://ghost-trading-invented.example/', city: 'Orléans', industry: 'Import', why_relevant: 'Invented', source_urls: ['https://ghost-trading-invented.example/'], published_listing_url: '' },
          ] } },
        ], 'tool_use');
      }
      if (sys.includes('assess whether an organization')) {
        return json({ suitable: true, unsuitable_reason: '', description: 'Négociant exportateur de vins du Val de Loire, basé à Orléans, qui vend au Royaume-Uni, en Espagne et en Amérique latine.', industry: 'Négoce de vins (export)', potential_position: 'Stage assistant(e) export', responsibilities: ['Préparer des documents export simples', 'Mettre à jour des fiches clients en anglais et en espagnol', 'Assister le suivi des expéditions'], match_reasons: ['Anglais C2 et espagnol B2, marchés UK et Espagne', 'Première expérience en logistique (préparation de commandes)'], concerns: ['Petite structure'], fit: 'strong', handbook_notes: '', recommended_email: 'stages@loire-export.example' });
      }
      if (sys.includes('You write internship applications')) {
        return json({
          cv: { headline: 'Étudiante en Licence 3 LEA – Commerce international', profile: "Étudiante en troisième année de LEA (anglais, espagnol), parcours Commerce international, à l'Université d'Orléans. Je recherche un stage de 6 semaines à débuter entre mi-avril et juin 2027 dans le négoce et l'export.", experience_order: ['deret', 'croix-rouge', 'couronnerie', 'garde', 'bathart'], experiences: [{ id: 'bathart', include: false, bullet_indices: [] }], course_highlights: ['commerce et économie internationale', 'anglais économique et commercial'], skills_order: ['lang', 'notions', 'tools', 'soft'] },
          letter: { subject_line: 'Candidature spontanée – stage de 6 semaines (avril–juin 2027)', recipient_line: 'Service export', salutation: 'Madame, Monsieur,', paragraphs: ["Étudiante en troisième année de LEA à l'Université d'Orléans, je vous adresse ma candidature pour un stage de six semaines entre mi-avril et juin 2027.", 'Votre activité d’export de vins du Val de Loire vers le Royaume-Uni et l’Espagne correspond aux langues que j’étudie.', 'J’ai déjà travaillé en entrepôt chez Deret, ce qui m’a donné une première idée des flux logistiques.'], closing: "Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées." },
          email: { subject: 'Candidature spontanée – stage export (avril–juin 2027)', body: 'Madame, Monsieur,\n\nVeuillez trouver ci-joint mon CV et ma lettre de motivation pour un stage de six semaines.\n\nCordialement,\nFatima-Christine Mariko\n06 30 73 26 40' },
          notes_for_candidate: ['Avez-vous une préférence de date de début ?'],
        });
      }
      if (sys.includes('strict fact-checker')) return json({ unsupported_claims: [], organization_claims_not_in_sources: [], style_remarks: [] });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'unexpected request in mock' } }));
    });
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

export async function startSmtp() {
  const received = [];
  const server = new SMTPServer({
    authOptional: false, disabledCommands: ['STARTTLS'],
    onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
    onData(stream, session, cb) {
      simpleParser(stream).then((mail) => { received.push({ mail, envelope: session.envelope }); cb(); }).catch(cb);
    },
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.server.address().port)));
  return { server, port, received };
}
