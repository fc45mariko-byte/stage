import { api, html, bind } from '../core.js';

export function mount(el, { setup, onDone }) {
  el.innerHTML = html`
  <div class="auth"><div class="card">
    <div class="eyebrow">Internship workspace</div>
    <h1>${setup ? 'Create your access' : 'Welcome back'}</h1>
    <p class="muted small">${setup ? 'This workspace is private. Choose the email and password that will protect it. Only one account can be created.' : 'Sign in to your private internship workspace.'}</p>
    <form data-form="auth" class="stack">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" minlength="${setup ? 10 : 1}" required>
      ${setup ? html`<div class="hint">At least 10 characters.</div>` : ''}</div>
      <button class="btn primary" type="submit" data-busy="…">${setup ? 'Create and continue' : 'Sign in'}</button>
    </form>
  </div></div>`.s;
  bind(el, {
    submit: {
      auth: async (d) => {
        await api(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { email: d.email, password: d.password } });
        onDone();
      },
    },
  });
}
