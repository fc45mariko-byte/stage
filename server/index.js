// Entry point: HTTP server, static front-end, API.
import express from 'express';
import path from 'node:path';
import { config, ROOT } from './config.js';
import './db/index.js';
import './research/web.js'; // installs the proxy dispatcher when HTTPS_PROXY is set
import { ensureSeed } from './profile/service.js';
import { authRoutes } from './auth/index.js';
import { apiRouter } from './routes/api.js';
import { aiAvailable } from './ai/client.js';
import { emailStatus } from './email/index.js';

ensureSeed();

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
  next();
});

authRoutes(app);
app.use('/api', apiRouter());
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: 0 }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'server', 'index.js')) {
  app.listen(config.port, () => {
    const e = emailStatus();
    console.log(`Internship assistant running on ${config.baseUrl}`);
    console.log(`  AI (search + writing): ${aiAvailable() ? `on (${config.ai.model})` : 'OFF – set ANTHROPIC_API_KEY'}`);
    console.log(`  Email sending: ${e.ready ? `on (${e.provider}${e.sender ? `, ${e.sender}` : ''})` : 'OFF – connect Gmail in Settings or set SMTP_*'}`);
  });
}
