// A turn outlives its browser stream: the history says it is still running
// while the reply is unsaved, and holds the reply once it ends, whether or not
// anyone stayed on the stream. A reopened chat waits on this (ChatPanel).
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
const ROOT = mkdtempSync(join(tmpdir(), 'chat-running-'));
const RELEASE = join(ROOT, 'release');
const FAKE = join(ROOT, 'fake-claude');
writeFileSync(FAKE, `#!/bin/sh
while [ ! -f '${RELEASE}' ]; do sleep 0.05; done
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"the reply"}}}'
echo '{"type":"result","is_error":false,"session_id":"s1"}'
`);
chmodSync(FAKE, 0o755);
process.env.PROJECT_DIR = ROOT;
process.env.CLAUDE_BIN = FAKE;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('FAIL', name, extra ?? ''); } };
const { default: chatRouter } = await import('../routes/chat.js');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.actor = 'solo@example.test'; next(); });
app.use('/api', chatRouter());
const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/chat`;
const sid = (await (await fetch(`${base}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).id;
const history = async () => (await fetch(`${base}/history?sessionId=${sid}`)).json();
const until = async (check) => { for (let i = 0; i < 200; i++) { const h = await history(); if (check(h)) return h; await new Promise(r => setTimeout(r, 25)); } return history(); };

ok('no turn: not running', (await history()).running === false);
const leave = new AbortController();
await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, message: 'hello' }), signal: leave.signal });
let h = await until(x => x.running);
ok('mid-turn: running, reply not saved yet', h.running === true && !h.messages.some(m => m.role === 'assistant'), h);
leave.abort();              // the person switches chats
h = await history();
ok('the stream closed: still running', h.running === true, h);
writeFileSync(RELEASE, '');
h = await until(x => !x.running);
ok('ended: no longer running', h.running === false, h);
ok('...and the reply is in the history', h.messages.some(m => m.role === 'assistant' && m.text.includes('the reply')), h.messages);
ok('(setup) the fake turn was released', existsSync(RELEASE));

server.close();
console.log(`chat-running: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
