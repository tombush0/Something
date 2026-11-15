/**
 * The provider's own developer app (`mcp.oauthClient: "app"`), against a
 * stand-in authorization server shaped like Canva's Connect one: no dynamic
 * registration, a client secret at the token endpoint, scopes from the
 * resource metadata. Sign-in refuses plainly until an admin stores the app;
 * the secret is stored encrypted and never returned; the workspace's and each
 * person's connection all go through the one app, with HTTP Basic at the token
 * endpoint for the code exchange and the refresh; disconnecting the last
 * connection keeps the app.
 * Run: node lib/oauth-app-client.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'oauth-app-'));
const STORE = mkdtempSync(join(tmpdir(), 'oauth-app-store-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, 'ab'.repeat(32));
process.env.INTEGRATIONS_CATALOG_LOCAL = join(STORE, 'catalog.local.json');
process.env.MCP_OAUTH_PROXY_URL = '';   // the stand-in is on loopback; no egress proxy here
mkdirSync(join(ROOT, '.team'), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };

const CLIENT_ID = 'OC-standin-client';
const SECRET = 'standin-secret-0123456789';
const SCOPES = ['design:meta:read', 'design:content:read', 'folder:read'];

// ─── the stand-in authorization server ──────────────────────────────────────
const seen = { registrations: 0, tokens: [] };
const body = (req) => new Promise((done) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => done(s)); });
const srv = createServer(async (req, res) => {
  const base = `http://127.0.0.1:${srv.address().port}`;
  const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const url = new URL(req.url, base);
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return send(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: SCOPES });
  if (url.pathname === '/.well-known/oauth-authorization-server') return send(200, {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  });
  if (url.pathname === '/register') { seen.registrations++; return send(404, { error: 'not_found' }); }
  if (url.pathname === '/token' && req.method === 'POST') {
    const form = Object.fromEntries(new URLSearchParams(await body(req)));
    const basic = /^Basic (.+)$/.exec(req.headers.authorization || '')?.[1];
    const [id, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [];
    seen.tokens.push({ form, id, secret });
    if (id !== CLIENT_ID || secret !== SECRET) return send(401, { error: 'invalid_client' });
    const n = seen.tokens.length;
    // Short-lived, so the refresh path runs; rotated refresh tokens.
    return send(200, { access_token: `access-${n}`, refresh_token: `refresh-${n}`, token_type: 'Bearer', expires_in: 60 });
  }
  res.writeHead(404); res.end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const MCP_URL = `http://127.0.0.1:${srv.address().port}/mcp`;

const entry = (id, extra = {}) => ({
  id, label: id, description: 'stand-in', category: 'other',
  fields: [{ name: 'OAUTH_TOKENS', label: 'connection', type: 'remote-mcp-oauth' }],
  mcp: { type: 'http', url: MCP_URL, name: id, allowedHosts: ['127.0.0.1'], ...extra },
});
writeFileSync(process.env.INTEGRATIONS_CATALOG_LOCAL, JSON.stringify({ integrations: [
  entry('stub-app', { oauthClient: 'app' }),
  entry('stub-dcr'),
] }));

const crypto = await import('./integrations/crypto.js');
if (!crypto.isReady()) { console.log('oauth-app-client: the crypto key is not readable in this environment — skipped'); srv.close(); process.exit(0); }
const oauth = await import('./integrations/oauth.js');
const store = await import('./integrations/store.js');
const catalog = await import('./integrations/catalog.js');

const BASE = 'https://workspace.example.test';
const REDIRECT = `${BASE}/api/integrations/oauth/callback`;
const params = (u) => new URL(u).searchParams;
const clientsFile = () => readFileSync(join(STORE, 'mcp-oauth-clients.json'), 'utf8');

// ─── before the app is set up ────────────────────────────────────────────────
{
  ok('the flag is read from the catalog', oauth.usesAppClient(catalog.get('stub-app')) && !oauth.usesAppClient(catalog.get('stub-dcr')));
  ok('status: not set up', oauth.appClientStatus('stub-app').configured === false);
  let err = null;
  try { await oauth.startAuth('stub-app', BASE); } catch (e) { err = e; }
  ok('sign-in refuses with a plain reason', err?.code === 'app_client_missing' && /admin adds its client ID and secret/.test(err.message), err?.message);
  ok('...and never tries to register', seen.registrations === 0);
}

// ─── storing the app ────────────────────────────────────────────────────────
{
  const bad = (f) => { try { f(); return false; } catch { return true; } };
  ok('a client ID with spaces is refused', bad(() => oauth.setAppClient('stub-app', { clientId: 'has space', clientSecret: SECRET })));
  ok('a first save without a secret is refused', bad(() => oauth.setAppClient('stub-app', { clientId: CLIENT_ID })));
  ok('an integration without the flag refuses an app', bad(() => oauth.setAppClient('stub-dcr', { clientId: CLIENT_ID, clientSecret: SECRET })));

  const st = oauth.setAppClient('stub-app', { clientId: CLIENT_ID, clientSecret: SECRET });
  ok('save: set up, the admin sees the client ID', st.configured === true && st.clientId === CLIENT_ID, st);
  ok('save: the secret is never returned', !JSON.stringify(st).includes(SECRET) && !JSON.stringify(oauth.appClientStatus('stub-app', { admin: true })).includes(SECRET));
  ok('save: a member\'s status has no client ID', oauth.appClientStatus('stub-app').clientId === undefined);
  ok('save: the secret is not on disk in clear', !clientsFile().includes(SECRET) && clientsFile().includes(CLIENT_ID));
}

// ─── the workspace's connection signs in through the app ────────────────────
{
  const at = await oauth.startAuth('stub-app', BASE);
  ok('authorize: the app\'s client ID', params(at).get('client_id') === CLIENT_ID, at);
  ok('authorize: this deployment\'s redirect', params(at).get('redirect_uri') === REDIRECT, at);
  ok('authorize: the scopes from the resource metadata', params(at).get('scope') === SCOPES.join(' '), at);
  ok('authorize: PKCE S256', params(at).get('code_challenge_method') === 'S256' && !!params(at).get('code_challenge'));
  ok('authorize: still no registration attempt', seen.registrations === 0);

  const key = await oauth.handleCallback(params(at).get('state'), 'code-ws');
  const t = seen.tokens.at(-1);
  ok('exchange: HTTP Basic with the app\'s ID and secret', t.id === CLIENT_ID && t.secret === SECRET, t);
  ok('exchange: the code and the same redirect', t.form.code === 'code-ws' && t.form.redirect_uri === REDIRECT && !!t.form.code_verifier, t.form);
  ok('exchange: the secret never goes in the form body', !JSON.stringify(t.form).includes(SECRET));
  ok('exchange: tokens in the workspace\'s store entry', key === 'stub-app' && JSON.parse(store.decryptFor(key).OAUTH_TOKENS).access_token === `access-${seen.tokens.length}`);
}

// ─── a person's own connection: same app, their own tokens ──────────────────
{
  const at = await oauth.startAuth('stub-app', BASE, { owner: 'ola', reach: 'personal', access: 'read' });
  ok('personal: the same app', params(at).get('client_id') === CLIENT_ID);
  const key = await oauth.handleCallback(params(at).get('state'), 'code-ola');
  ok('personal: stored under the person\'s key', key === store.personalKey('stub-app', 'ola') && store.isActive(key), key);
  const mine = JSON.parse(store.decryptFor(key).OAUTH_TOKENS).access_token;
  const team = JSON.parse(store.decryptFor('stub-app').OAUTH_TOKENS).access_token;
  ok('personal: separate tokens from the workspace\'s', mine !== team, { mine, team });
  ok('personal: a person\'s own connection is theirs (write), as for every integration', store.accessOf(key) === 'write');

  // The token is within the refresh window (60 s < 2 min): it refreshes through the app.
  const before = seen.tokens.length;
  const fresh = await oauth.getFreshToken(key);
  const r = seen.tokens.at(-1);
  ok('refresh: one call, HTTP Basic with the app', seen.tokens.length === before + 1 && r.id === CLIENT_ID && r.secret === SECRET, r);
  ok('refresh: grant_type refresh_token with the person\'s token', r.form.grant_type === 'refresh_token' && r.form.refresh_token === `refresh-${before}`, r.form);
  ok('refresh: the new token is stored and returned', fresh === `access-${seen.tokens.length}` && JSON.parse(store.decryptFor(key).OAUTH_TOKENS).access_token === fresh);
}

// ─── changing and keeping the app ───────────────────────────────────────────
{
  oauth.setAppClient('stub-app', { clientId: 'OC-renamed', clientSecret: '' });
  ok('a blank secret keeps the stored one', oauth.appClientStatus('stub-app', { admin: true }).clientId === 'OC-renamed' && oauth.appClientStatus('stub-app').configured);
  oauth.setAppClient('stub-app', { clientId: CLIENT_ID, clientSecret: '' });

  oauth.forgetClient('stub-app');   // what DELETE does when the last connection goes
  ok('disconnecting keeps the app', oauth.appClientStatus('stub-app').configured === true);
  ok('forgetAppClient removes it', oauth.forgetAppClient('stub-app') === true && oauth.appClientStatus('stub-app').configured === false);
  let err = null;
  try { await oauth.startAuth('stub-app', BASE); } catch (e) { err = e; }
  ok('...and sign-in refuses again', err?.code === 'app_client_missing');
}

srv.close();
console.log(`oauth-app-client: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
