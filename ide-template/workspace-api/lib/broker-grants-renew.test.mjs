/**
 * Broker grants reach every process with life left:
 *   - the config sync keeps a grant with at least half its 24h left and
 *     mints a new one past that, while the old one stays valid for the
 *     processes already holding it;
 *   - an expired grant is never handed out;
 *   - a chat turn renews the grants BEFORE it writes its own MCP config from
 *     the bot's — renewing after it (as it once did) gave the first turn after
 *     expiry dead grants, and every brokered MCP failed "grant invalid".
 * Run: node lib/broker-grants-renew.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'grants-renew-'));
const STORE = mkdtempSync(join(tmpdir(), 'grants-renew-store-'));
const CFG = join(ROOT, 'claude.json');
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = STORE;
process.env.CLAUDE_CONFIG_PATH = CFG;
process.env.INTEGRATIONS_KEY_PATH = join(STORE, 'key');
writeFileSync(process.env.INTEGRATIONS_KEY_PATH, 'ab'.repeat(32));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400)}` : ''}`); }
};
const read = () => JSON.parse(readFileSync(CFG, 'utf8'));
const nonceOf = () => read().mcpServers.grok.env.BROKER_NONCE;

const store = await import('./integrations/store.js');
const runtime = await import('./integrations/runtime.js');
const broker = await import('./integrations/broker.js');

const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
const at = (hours) => { const t = realNow() + hours * HOUR; Date.now = () => t; };

writeFileSync(CFG, JSON.stringify({ mcpServers: {} }, null, 2));
store.activate('grok', { fields: { XAI_API_KEY: 'test-key' } });

at(0);
runtime.syncMcpServers();
const first = nonceOf();
ok('a new connection gets a live grant', broker.grantIntegration(first) === 'grok' && broker.grantToKeep(first) === 'grok');

at(11);
let r = runtime.syncMcpServers();
ok('with more than half its life left, the grant is kept (no rewrite)', nonceOf() === first && r.changed === false);

at(13);
r = runtime.syncMcpServers();
const second = nonceOf();
ok('past half its life, a new grant is minted into the config', second !== first && r.changed === true && broker.grantToKeep(second) === 'grok');
ok('...and the old one still works for the processes holding it', broker.grantIntegration(first) === 'grok');
ok('...but is not handed to a new process', broker.grantToKeep(first) === null);

at(25);
ok('after 24h the old grant is dead', broker.grantIntegration(first) === null);
ok('...while the renewed one still has hours left', broker.grantIntegration(second) === 'grok');
runtime.syncMcpServers();
ok('a sync never leaves an expired grant in the config', broker.grantIntegration(nonceOf()) === 'grok');

at(60);
runtime.syncMcpServers();
ok('even after days with no sync, the next one hands out a live grant', broker.grantToKeep(nonceOf()) === 'grok');
Date.now = realNow;

// A person's own connections (their turns' config) follow the same rule.
store.activate('trello@ann', { fields: { TRELLO_API_KEY: 'k', TRELLO_TOKEN: 't' } }, { owner: 'ann', reach: 'personal' });
at(0);
const annFirst = runtime.personalServers('ann')['trello-mine'].env.BROKER_NONCE;
at(11);
ok('a person\'s own grant is reused while fresh', runtime.personalServers('ann')['trello-mine'].env.BROKER_NONCE === annFirst);
at(13);
const annSecond = runtime.personalServers('ann')['trello-mine'].env.BROKER_NONCE;
ok('...and renewed past half its life', annSecond !== annFirst && broker.grantToKeep(annSecond) === 'trello@ann');
Date.now = realNow;

// The turn renews before it writes its MCP config from the bot's (source order
// inside runClaudeTurn: the sync, then every read of the bot's servers).
const src = readFileSync(new URL('./claude.js', import.meta.url), 'utf8');
const turn = src.slice(src.indexOf('export function runClaudeTurn('));
const sync = turn.indexOf('syncMcpServers();');
const reads = [...turn.matchAll(/turnMcpServers\(\{ actor, groupContext \}\)/g)].map(m => m.index);
const write = turn.indexOf('writeTurnMcpFile(slot');
ok('runClaudeTurn renews the grants', sync > 0);
ok('...before it reads the bot\'s servers for the turn', reads.length > 0 && reads.every(i => i > sync), { sync, reads });
ok('...and before it writes the turn\'s MCP config', write > sync, { sync, write });
ok('...once (no second pass after the config is written)', turn.indexOf('syncMcpServers();', sync + 1) === -1 || turn.indexOf('syncMcpServers();', sync + 1) > turn.indexOf('\nexport function', 1));

console.log(`broker-grants-renew: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
