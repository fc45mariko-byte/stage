// Thin wrapper around the Anthropic SDK. All AI features go through here so
// the model / provider can change without touching the rest of the app.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client = null;

export function aiAvailable() { return Boolean(config.ai.apiKey); }

export class AIUnavailableError extends Error {
  constructor() { super('AI is not configured: set ANTHROPIC_API_KEY in .env and restart the server.'); this.code = 'AI_UNAVAILABLE'; }
}

function getClient() {
  if (!aiAvailable()) throw new AIUnavailableError();
  client ??= new Anthropic({
    apiKey: config.ai.apiKey,
    // Explicit base URL so an unrelated ANTHROPIC_BASE_URL in the shell is not picked up.
    baseURL: process.env.AI_BASE_URL || 'https://api.anthropic.com',
    maxRetries: 3,
    timeout: 15 * 60 * 1000,
  });
  return client;
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('The Anthropic API key was rejected (401). Check ANTHROPIC_API_KEY.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('The Anthropic API refused access (403). Check that your key can use this model and web search.');
  if (err instanceof Anthropic.RateLimitError) return new Error('The Anthropic API rate limit was reached. Try again in a minute.');
  if (err instanceof Anthropic.BadRequestError) return new Error(`The AI request was rejected: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Anthropic API (network error).');
  if (err instanceof Anthropic.APIError) return new Error(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
  return err;
}

/** One Messages API call (streamed, so long outputs never hit HTTP timeouts). */
export async function createMessage(params) {
  const c = getClient();
  const body = { model: config.ai.model, max_tokens: 32000, ...params };
  try {
    const stream = config.ai.fallbacks
      ? c.beta.messages.stream({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : c.beta.messages.stream(body);
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') {
      throw new Error(`The model declined this request${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ''}.`);
    }
    return msg;
  } catch (err) {
    throw friendly(err);
  }
}

export const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

/** Structured JSON output constrained by a JSON schema. */
export async function jsonCall({ system, user, schema, effort = 'high', maxTokens = 32000 }) {
  const msg = await createMessage({
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  });
  if (msg.stop_reason === 'max_tokens') throw new Error('The AI response was cut off (max tokens).');
  const text = textOf(msg);
  try { return JSON.parse(text); } catch { throw new Error('The AI returned malformed JSON.'); }
}

// Helper for strict JSON schemas: every property required, no extras.
export function obj(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
export const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
export const arr = (items, description) => (description ? { type: 'array', items, description } : { type: 'array', items });
