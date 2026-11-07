/**
 * Google Chat, as the coworker's own app: the little of Pub/Sub and the Chat API the
 * surface needs — no SDK. The counterpart of slack-api.js.
 *
 * Identity is the app's service account: a JSON key stored encrypted in the
 * integrations store (`google-chat-app`), decrypted only to sign a token
 * request — never kept on the object, in env or on disk. Access tokens are
 * cached in memory per scope until a minute before they expire.
 *
 * Two scopes: `pubsub` to pull the events Chat publishes to the app's topic
 * (the Chat app is configured with a Cloud Pub/Sub connection, so nothing
 * listens for Google), and `chat.bot` to act in Chat as the app. Outbound
 * traffic goes through the egress proxy by name, falling back to the
 * transparent path, as Slack's does.
 *
 * What app authentication cannot do (checked against a real workspace,
 * 2026-11-07): add reactions, upload attachments, or see member emails —
 * callers get those from the event (sender email) or not at all.
 */
import { createSign } from 'node:crypto';
import { ProxyAgent } from 'undici';
import * as store from './store.js';

export const ID = 'google-chat-app';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PUBSUB = 'https://pubsub.googleapis.com/v1';
const CHAT = 'https://chat.googleapis.com/v1';
export const SCOPE_PUBSUB = 'https://www.googleapis.com/auth/pubsub';
export const SCOPE_BOT = 'https://www.googleapis.com/auth/chat.bot';
export const TEXT_MAX = 4000;   // Chat accepts more; one screen of text reads better

const PROXY_URL = process.env.GCHAT_PROXY_URL ?? process.env.MCP_OAUTH_PROXY_URL ?? 'http://egress-proxy:3130';
let dispatcher = null;
function proxyDispatcher() {
  if (!PROXY_URL) return undefined;
  if (!dispatcher) { try { dispatcher = new ProxyAgent(PROXY_URL); } catch { return undefined; } }
  return dispatcher;
}

let fetchImpl = (url, init) => fetch(url, init);
let credentialsOverride = null;
/** Tests (and a local check) swap the transport and the stored key. */
export function configure({ fetch: f, credentials } = {}) {
  if (f) fetchImpl = f;
  if (credentials !== undefined) credentialsOverride = credentials;
  tokens.clear();
}

export class GchatError extends Error {
  constructor(what, status, message, extra = {}) {
    super(`google chat ${what}: ${status}${message ? ` ${message}` : ''}`);
    this.status = status;
    this.what = what;
    Object.assign(this, extra);
  }
}

/**
 * The app's settings from the store: { key: {client_email, private_key, …},
 * subscription }. Throws when the app is not connected or the key is not a
 * service-account key.
 */
export function settings() {
  const plain = credentialsOverride || store.decryptFor(ID);
  let key = plain?.GCHAT_APP_KEY_JSON;
  if (typeof key === 'string') {
    try { key = JSON.parse(key); } catch { throw new GchatError('settings', 'bad_key', 'the service account key is not JSON'); }
  }
  if (!key?.client_email || !key?.private_key) throw new GchatError('settings', 'bad_key', 'not a service account key (client_email, private_key)');
  const subscription = String(plain?.GCHAT_APP_SUBSCRIPTION || '').trim();
  if (!/^projects\/[a-z][a-z0-9-]{4,29}\/subscriptions\/[A-Za-z][\w.~+%-]{2,254}$/.test(subscription)) {
    throw new GchatError('settings', 'bad_subscription', 'expected projects/<project>/subscriptions/<name>');
  }
  return { key, subscription };
}

async function send(url, init, { allowFallback = true } = {}) {
  const d = proxyDispatcher();
  try {
    return await fetchImpl(url, d ? { ...init, dispatcher: d } : init);
  } catch (err) {
    // The explicit proxy is not reachable (dev, a test rig): the transparent
    // path is the same gate, just by IP.
    if (!d || !allowFallback) throw err;
    return fetchImpl(url, init);
  }
}

// ─── sign-in ─────────────────────────────────────────────────────────────────

const tokens = new Map();   // scope → { value, exp }

/** A signed JWT assertion for one scope (exported for the tests). */
export function assertion(key, scope, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  return `${unsigned}.${sig}`;
}

/** An access token for `scope`, minted with the stored key when the cached one is near its end. */
export async function accessToken(scope, now = Date.now()) {
  const t = tokens.get(scope);
  if (t && t.exp - 60_000 > now) return t.value;
  const { key } = settings();
  const resp = await send(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(key, scope, now) }).toString(),
  });
  let data = null;
  try { data = await resp.json(); } catch { /* below */ }
  if (!resp.ok || !data?.access_token) {
    throw new GchatError('token', resp.status, data?.error_description || data?.error || '', { code: data?.error || `http_${resp.status}` });
  }
  tokens.set(scope, { value: data.access_token, exp: now + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
}

/**
 * One JSON call. Returns the parsed body (null for an empty one); throws
 * GchatError with Google's message. A 401 drops the cached token and retries
 * once; a 429 waits a little and retries once.
 */
export async function call(scope, method, url, body, { retried = false, signal = undefined } = {}) {
  const tok = await accessToken(scope);
  const resp = await send(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  if ((resp.status === 401 || resp.status === 429) && !retried) {
    if (resp.status === 401) tokens.delete(scope);
    else await new Promise(r => setTimeout(r, Math.min(Number(resp.headers?.get?.('retry-after')) || 2, 30) * 1000));
    return call(scope, method, url, body, { retried: true, signal });
  }
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!resp.ok) throw new GchatError(`${method} ${new URL(url).pathname}`, resp.status, data?.error?.message || text.slice(0, 200), { reason: data?.error?.status || null });
  return data;
}

// ─── Pub/Sub: the event stream ───────────────────────────────────────────────

/**
 * One long pull: up to `max` messages, or [] when none arrived before Google
 * returned. Each is { ackId, messageId, publishTime, attributes, event } with
 * `event` the decoded JSON (null when the data is not JSON).
 */
export async function pull({ max = 10, signal } = {}) {
  const { subscription } = settings();
  const r = await call(SCOPE_PUBSUB, 'POST', `${PUBSUB}/${subscription}:pull`, { maxMessages: max }, { signal });
  return (r?.receivedMessages || []).map((m) => {
    let event = null;
    try { event = JSON.parse(Buffer.from(m.message?.data || '', 'base64').toString('utf8')); } catch { event = null; }
    return { ackId: m.ackId, messageId: m.message?.messageId || null, publishTime: m.message?.publishTime || null, attributes: m.message?.attributes || {}, event };
  });
}

export async function acknowledge(ackIds) {
  if (!ackIds?.length) return;
  const { subscription } = settings();
  await call(SCOPE_PUBSUB, 'POST', `${PUBSUB}/${subscription}:acknowledge`, { ackIds });
}

// ─── Chat, as the app ────────────────────────────────────────────────────────

const rx = {
  space: /^spaces\/[A-Za-z0-9_-]+$/,
  message: /^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+$/,
  thread: /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/,
  user: /^users\/[A-Za-z0-9_.@-]+$/,
};
function check(kind, name) {
  const s = String(name || '');
  if (!rx[kind].test(s)) throw new GchatError(kind, 'bad_name', JSON.stringify(s.slice(0, 80)));
  return s;
}
// Resource names keep their "/" in the path.
const path = (name) => name.split('/').map(encodeURIComponent).join('/');

export async function getSpace(space) {
  return call(SCOPE_BOT, 'GET', `${CHAT}/${path(check('space', space))}`);
}

/** Every membership of a space (paged): { name, member: { name, type, displayName, domainId }, role, state }. */
export async function listMembers(space) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) });
    const r = await call(SCOPE_BOT, 'GET', `${CHAT}/${path(check('space', space))}/members?${q}`);
    out.push(...(r?.memberships || []));
    pageToken = r?.nextPageToken || '';
  } while (pageToken && out.length < 2000);
  return out;
}

/** The DM space between the app and one person (`users/<id>` or `users/<email>`), or null. */
export async function findDirectMessage(user) {
  try {
    return await call(SCOPE_BOT, 'GET', `${CHAT}/spaces:findDirectMessage?${new URLSearchParams({ name: check('user', user) })}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Post text, into `thread` when given (falling back to a new thread). Returns the message. */
export async function createMessage({ space, text, thread = null }) {
  const q = new URLSearchParams(thread ? { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' } : {});
  const body = { text: String(text || ''), ...(thread ? { thread: { name: check('thread', thread) } } : {}) };
  return call(SCOPE_BOT, 'POST', `${CHAT}/${path(check('space', space))}/messages${thread ? `?${q}` : ''}`, body);
}

/** Replace the text of one of the app's own messages (the "working…" line turning into the answer). */
export async function updateMessage(message, text) {
  return call(SCOPE_BOT, 'PATCH', `${CHAT}/${path(check('message', message))}?updateMask=text`, { text: String(text || '') });
}

export async function deleteMessage(message) {
  return call(SCOPE_BOT, 'DELETE', `${CHAT}/${path(check('message', message))}`);
}

/**
 * Bytes of an attachment someone uploaded to Chat (its
 * attachmentDataRef.resourceName), bounded. Drive attachments are not here.
 */
export async function downloadAttachment(resourceName, { maxBytes = 25 * 1024 * 1024 } = {}) {
  const name = String(resourceName || '');
  if (!name || name.length > 2000) throw new GchatError('media', 'bad_name', '');
  const tok = await accessToken(SCOPE_BOT);
  const resp = await send(`${CHAT}/media/${path(name)}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!resp.ok) throw new GchatError('media', resp.status, '');
  const len = Number(resp.headers?.get?.('content-length') || 0);
  if (len > maxBytes) throw new GchatError('media', 'too_large', '');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) throw new GchatError('media', 'too_large', '');
  return buf;
}

/** Cut a long text at paragraph, line, then word boundaries (exported for the tests). */
export function splitText(text, max = TEXT_MAX) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}
