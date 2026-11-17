import { api, html, bind, toast } from '../core.js';

export async function mount(el, { query }) {
  const s = await api('settings');
  const g = query.gmail;
  if (g) toast(g === 'connected' ? 'Gmail connected' : g === 'not_configured' ? 'Gmail is not configured on the server yet' : `Gmail: ${g}`, g === 'connected' ? '' : 'error');
  el.innerHTML = html`
  <div class="page-head"><div><div class="eyebrow">Settings</div><h1>Integrations</h1>
  <p class="lede">What is active, and exactly what is needed to activate the rest.</p></div></div>

  <div class="card"><div class="section-head"><h2>AI research and writing</h2>${s.ai.available ? html`<span class="tag verified">Active · ${s.ai.model}</span>` : html`<span class="tag warn">Not configured</span>`}</div>
    <p class="small">Used for: web search of organizations, evaluating fit, reading the handbook, writing and fact-checking documents.</p>
    ${s.ai.available ? html`<p class="small muted">Refusal fallbacks are ${s.ai.fallbacks ? 'on' : 'off'}. Web search must be enabled for your API organization (Claude Console → Settings → Privacy / web search).</p>` : html`
    <div class="notice warn small"><strong>To activate:</strong> create an API key at console.anthropic.com, add <span class="mono">ANTHROPIC_API_KEY=sk-ant-…</span> to the <span class="mono">.env</span> file next to the app, make sure web search is enabled for your organization in the Console, then restart the server. Without it you can still add organizations by hand and write documents yourself.</div>`}
  </div>

  <div class="card"><div class="section-head"><h2>Email sending</h2>${s.email.ready ? html`<span class="tag verified">Active · ${s.email.provider === 'gmail' ? 'Gmail' : 'SMTP'} · ${s.email.sender}</span>` : html`<span class="tag warn">Not connected</span>`}</div>
    <p class="small">Emails are only ever sent after your final approval of a specific application, to an address verified on the organization's website.</p>
    <h3 class="section">Gmail</h3>
    ${s.email.gmail.connected ? html`<p>Connected as <strong>${s.email.gmail.account}</strong> (permission: send only).</p><button class="btn" data-action="disconnect">Disconnect Gmail</button>`
      : s.gmail.configured ? html`<p class="small">The server is ready. Connecting opens Google's consent screen; the app asks only for permission to send emails, not to read your mailbox.</p><a class="btn primary" href="/api/integrations/gmail/connect">Connect Gmail</a>`
      : html`<div class="notice warn small"><strong>To activate Gmail:</strong>
        <ol>
          <li>In Google Cloud Console, create a project and enable the <em>Gmail API</em>.</li>
          <li>Configure the OAuth consent screen (External, add yourself as a test user).</li>
          <li>Create an OAuth client ID of type <em>Web application</em> with this authorised redirect URI: <span class="mono break">${s.gmail.redirectUri}</span></li>
          <li>Add <span class="mono">GOOGLE_CLIENT_ID</span> and <span class="mono">GOOGLE_CLIENT_SECRET</span> to <span class="mono">.env</span> and restart, then come back here and click Connect.</li>
        </ol></div>`}
    <h3 class="section">Alternative: SMTP</h3>
    ${s.email.smtp.configured ? html`<p class="small">SMTP configured: ${s.email.smtp.user} on ${s.email.smtp.host}${s.email.provider === 'gmail' ? ' (Gmail is used first)' : ''}.</p>`
      : html`<p class="small muted">Instead of OAuth, you can use a Gmail <em>app password</em> (Google account → Security → 2-Step Verification → App passwords) with <span class="mono">SMTP_HOST=smtp.gmail.com</span>, <span class="mono">SMTP_PORT=465</span>, <span class="mono">SMTP_USER</span>, <span class="mono">SMTP_PASS</span> in <span class="mono">.env</span>.</p>`}
  </div>

  <div class="card"><h2>Account</h2><p class="small muted">Signed in as ${s.user}.</p>
    <form data-form="password" class="grid-2 section">
      <div class="field"><label>Current password</label><input type="password" name="current" autocomplete="current-password" required></div>
      <div class="field"><label>New password</label><input type="password" name="next" autocomplete="new-password" minlength="10" required></div>
      <div><button class="btn" type="submit">Change password</button></div>
    </form>
  </div>`.s;
  bind(el, {
    click: { disconnect: async () => { if (!confirm('Disconnect Gmail?')) return; await api('integrations/gmail/disconnect', { method: 'POST' }); toast('Gmail disconnected'); mount(el, { query: {} }); } },
    submit: { password: async (d, f) => { await api('/api/auth/password', { method: 'POST', body: d }); f.reset(); toast('Password changed'); } },
  });
}
