// Email provider abstraction: Gmail API (preferred) or SMTP (e.g. Gmail with
// an app password). A send is reported as successful only when the provider
// confirms it; otherwise an error is thrown and recorded.
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { config } from '../config.js';
import { gmailConfigured, gmailConnected, gmailAccount, gmailSendRaw } from './gmail.js';

export function emailStatus() {
  const smtpReady = Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
  const relay = process.env.EMAIL_RELAY === 'assistant' && process.env.EMAIL_RELAY_SENDER;
  const provider = gmailConnected() ? 'gmail' : smtpReady ? 'smtp' : relay ? 'assistant_relay' : null;
  return {
    provider,
    ready: Boolean(provider),
    sender: provider === 'gmail' ? gmailAccount() : provider === 'smtp' ? config.smtp.from : provider === 'assistant_relay' ? process.env.EMAIL_RELAY_SENDER : null,
    relay: Boolean(relay),
    gmail: { configured: gmailConfigured(), connected: gmailConnected(), account: gmailAccount() },
    smtp: { configured: smtpReady, host: config.smtp.host || null, user: config.smtp.user || null },
  };
}

function buildMessage({ from, fromName, to, subject, text, attachments }) {
  return {
    from: fromName ? { name: fromName, address: from } : from,
    to, subject, text,
    attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: 'application/pdf' })),
  };
}

/** @returns {{provider, sender, messageId, response}} */
export async function sendEmail({ fromName, to, subject, text, attachments }) {
  const st = emailStatus();
  if (!st.ready) throw new Error('No email provider is configured.');
  if (st.provider === 'gmail') {
    const msg = buildMessage({ from: st.sender, fromName, to, subject, text, attachments });
    const raw = await new MailComposer(msg).compile().build();
    const r = await gmailSendRaw(raw);
    return { provider: 'gmail', sender: st.sender, ...r };
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    ...(config.smtp.allowInsecureTls ? { tls: { rejectUnauthorized: false } } : {}),
  });
  const info = await transport.sendMail(buildMessage({ from: st.sender, fromName, to, subject, text, attachments }));
  const accepted = (info.accepted || []).map((a) => String(a.address || a).toLowerCase());
  if (!accepted.includes(String(to).toLowerCase()) || (info.rejected || []).length) {
    throw new Error(`The SMTP server did not accept the recipient (${info.response || 'no response'})`);
  }
  return { provider: 'smtp', sender: st.sender, messageId: info.messageId, response: info.response };
}
