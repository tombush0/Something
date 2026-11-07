/**
 * The coworker's own Google Chat app, the API side: the service-account key signs a JWT
 * that Google can verify, an access token is minted once per scope and
 * reused until near its end, a 401 mints a fresh one, a pull decodes the
 * events Chat published and the acknowledgement names their ack ids; bad
 * settings are refused before anything is sent; resource names are checked
 * before they reach a URL; long text is cut at sensible boundaries.
 * Run: node lib/gchat-api.test.mjs
 */
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.PROJECT_DIR = mkdtempSync(join(tmpdir(), 'gchat-api-'));
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'gchat-api-store-'));
process.env.GCHAT_PROXY_URL = '';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const api = await import('./integrations/gchat-api.js');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { type: 'service_account', client_email: 'chat-app@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const SUB = 'projects/acme-chat-app/subscriptions/chat-events-sub';

// A fake Google.
const calls = [];
let tokenCount = 0, failNextWith401 = false;
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (body === null ? '' : JSON.stringify(body)) });
api.configure({
  credentials: { GCHAT_APP_KEY_JSON: JSON.stringify(key), GCHAT_APP_SUBSCRIPTION: SUB },
  fetch: async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body });
    if (url === 'https://oauth2.googleapis.com/token') { tokenCount += 1; return reply(200, { access_token: `tok-${tokenCount}`, expires_in: 3600 }); }
    if (failNextWith401) { failNextWith401 = false; return reply(401, { error: { message: 'expired' } }); }
    if (url.endsWith(':pull')) {
      const ev = { chat: { user: { name: 'users/1', email: 'Ann@Example.test' }, messagePayload: { space: { name: 'spaces/A' }, message: { name: 'spaces/A/messages/1' } } } };
      return reply(200, { receivedMessages: [
        { ackId: 'ack-1', message: { messageId: 'p1', data: Buffer.from(JSON.stringify(ev)).toString('base64') } },
        { ackId: 'ack-2', message: { messageId: 'p2', data: Buffer.from('not json').toString('base64') } },
      ] });
    }
    if (url.endsWith(':acknowledge')) return reply(200, {});
    if (url.includes('/messages') && init.method === 'POST') return reply(200, { name: 'spaces/A/messages/2', thread: JSON.parse(init.body).thread || null });
    if (url.includes('findDirectMessage')) return reply(404, { error: { message: 'not found' } });
    return reply(200, {});
  },
});

// ─── the JWT ─────────────────────────────────────────────────────────────────
const jwt = api.assertion(key, api.SCOPE_BOT, Date.UTC(2026, 10, 7, 12, 0, 0));
const [h, c, s] = jwt.split('.');
const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
ok('the assertion is signed RS256 and verifies with the public key',
  JSON.parse(Buffer.from(h, 'base64url').toString()).alg === 'RS256' && createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')));
ok('...names the account, the scope and Google\'s token endpoint, for an hour',
  claims.iss === key.client_email && claims.scope === api.SCOPE_BOT && claims.aud === 'https://oauth2.googleapis.com/token' && claims.exp - claims.iat === 3600, claims);

// ─── tokens ──────────────────────────────────────────────────────────────────
const t1 = await api.accessToken(api.SCOPE_PUBSUB);
const t2 = await api.accessToken(api.SCOPE_PUBSUB);
ok('a token is minted once per scope and reused', t1 === t2 && tokenCount === 1);
await api.accessToken(api.SCOPE_BOT);
ok('...another scope mints its own', tokenCount === 2);
const tokenBody = new URLSearchParams(calls.find(x => x.url.includes('oauth2')).body);
ok('the token request is a JWT-bearer grant and carries no raw key', tokenBody.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && !String(calls[0].body).includes('PRIVATE KEY'));
ok('a token near its end is minted again', (await api.accessToken(api.SCOPE_PUBSUB, Date.now() + 3600_000)) !== t1);

// ─── pull and acknowledge ────────────────────────────────────────────────────
const batch = await api.pull();
ok('a pull decodes what Chat published', batch.length === 2 && batch[0].event?.chat?.user?.name === 'users/1' && batch[0].ackId === 'ack-1', batch[0]);
ok('...and keeps an undecodable message as an empty event, still ackable', batch[1].event === null && batch[1].ackId === 'ack-2');
ok('...from the configured subscription', calls.some(x => x.url === `https://pubsub.googleapis.com/v1/${SUB}:pull` && x.method === 'POST'));
await api.acknowledge(batch.map(m => m.ackId));
const ack = calls.filter(x => x.url.endsWith(':acknowledge')).pop();
ok('the acknowledgement names every ack id', JSON.stringify(JSON.parse(ack.body)) === JSON.stringify({ ackIds: ['ack-1', 'ack-2'] }));

// ─── a 401 mints a fresh token ───────────────────────────────────────────────
const before = tokenCount;
failNextWith401 = true;
await api.createMessage({ space: 'spaces/A', text: 'hi' });
ok('a 401 drops the token and retries once with a fresh one', tokenCount === before + 1);

// ─── Chat calls ──────────────────────────────────────────────────────────────
const posted = await api.createMessage({ space: 'spaces/A', text: 'in the thread', thread: 'spaces/A/threads/T1' });
const post = calls.filter(x => x.url.includes('/messages') && x.method === 'POST').pop();
ok('a threaded reply asks Chat to fall back to a new thread', post.url.includes('messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD') && JSON.parse(post.body).thread.name === 'spaces/A/threads/T1' && posted.name === 'spaces/A/messages/2');
await api.updateMessage('spaces/A/messages/2', 'the answer');
ok('an edit patches only the text', calls.some(x => x.method === 'PATCH' && x.url.endsWith('/v1/spaces/A/messages/2?updateMask=text')));
ok('no DM with someone is null, not an error', (await api.findDirectMessage('users/ann@example.test')) === null);
let threw = null;
try { await api.createMessage({ space: '../../oauth2', text: 'x' }); } catch (err) { threw = err; }
ok('a resource name that is not a space never reaches a URL', threw?.status === 'bad_name');

// ─── settings ────────────────────────────────────────────────────────────────
const check = (creds) => { api.configure({ credentials: creds }); try { api.settings(); return null; } catch (err) { return err.status; } };
ok('a key that is not JSON is refused', check({ GCHAT_APP_KEY_JSON: 'nope', GCHAT_APP_SUBSCRIPTION: SUB }) === 'bad_key');
ok('a JSON that is not a service-account key is refused', check({ GCHAT_APP_KEY_JSON: '{"web":{}}', GCHAT_APP_SUBSCRIPTION: SUB }) === 'bad_key');
ok('a subscription that is not a full name is refused', check({ GCHAT_APP_KEY_JSON: JSON.stringify(key), GCHAT_APP_SUBSCRIPTION: 'chat-events-sub' }) === 'bad_subscription');
ok('good settings pass', check({ GCHAT_APP_KEY_JSON: JSON.stringify(key), GCHAT_APP_SUBSCRIPTION: SUB }) === null);

// ─── splitting ───────────────────────────────────────────────────────────────
const long = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
const parts = api.splitText(long);
ok('a long text is cut at the paragraph', parts.length === 2 && parts[0] === 'a'.repeat(3000) && parts[1] === 'b'.repeat(3000));
ok('a short text is one piece', api.splitText('hello').length === 1);

console.log(`\ngchat-api: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
