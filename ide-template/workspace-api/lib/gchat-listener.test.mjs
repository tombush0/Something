/**
 * What a Google Chat event becomes. Both shapes Chat sends (the classic
 * interaction event and the Workspace add-on event a new Chat app sends) are
 * read into one record; a DM goes to the DM side and an @mention in a space to
 * the space side; being added to or removed from a space reaches its handlers;
 * another app's message, an event without a sender and one seen before
 * (redelivered, or the same Chat message again) are ignored; a pulled batch
 * is acknowledged before its events are handled; with no handler yet an event
 * is logged, not lost silently. The API and the handlers are injected.
 * Run: node lib/gchat-listener.test.mjs
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'gchat-listener-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'gchat-listener-store-'));
process.env.GCHAT_PROXY_URL = '';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const L = await import('./integrations/gchat-listener.js');

// The shapes, as captured from a real Chat app on 2026-11-07 (trimmed).
const ann = { name: 'users/111', displayName: 'Ann', email: 'Ann@Example.test', type: 'HUMAN', domainId: 'dom1' };
const addOnDm = { commonEventObject: {}, chat: { user: ann, eventTime: '2026-11-07T12:00:00Z', messagePayload: {
  space: { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
  message: { name: 'spaces/DM1/messages/M1', text: 'hello', argumentText: 'hello', thread: { name: 'spaces/DM1/threads/T1' } },
} } };
const addOnMention = { chat: { user: ann, eventTime: '2026-11-07T12:01:00Z', messagePayload: {
  space: { name: 'spaces/S1', spaceType: 'SPACE', displayName: 'Team' },
  message: { name: 'spaces/S1/messages/M2', text: '@Ada what is up?', argumentText: ' what is up?', thread: { name: 'spaces/S1/threads/T2' }, threadReply: true,
    annotations: [{ type: 'USER_MENTION', userMention: { user: { name: 'users/app', type: 'BOT' } } }],
    attachment: [{ name: 'spaces/S1/messages/M2/attachments/A1', contentName: 'plan.pdf', contentType: 'application/pdf', source: 'UPLOADED_CONTENT', attachmentDataRef: { resourceName: 'res-1' } }] },
} } };
const addOnAdded = { chat: { user: ann, eventTime: '2026-11-07T12:02:00Z', addedToSpacePayload: { space: { name: 'spaces/S1', spaceType: 'SPACE' } } } };
const addOnRemoved = { chat: { user: ann, eventTime: '2026-11-07T12:03:00Z', removedFromSpacePayload: { space: { name: 'spaces/S1', spaceType: 'SPACE' } } } };
const classicDm = { type: 'MESSAGE', eventTime: '2026-11-07T12:04:00Z', user: ann, space: { name: 'spaces/DM1', type: 'DM' }, message: { name: 'spaces/DM1/messages/M9', text: 'classic' } };

// ─── normalize ───────────────────────────────────────────────────────────────
const dm = L.normalize(addOnDm);
ok('an add-on DM is a message in a DIRECT_MESSAGE space', dm.kind === 'message' && dm.space.type === 'DIRECT_MESSAGE' && dm.format === 'add-on');
ok('...with the sender\'s email, lower-cased, and their organisation', dm.user.email === 'ann@example.test' && dm.user.domainId === 'dom1' && dm.user.type === 'HUMAN');
ok('...and its thread', dm.message.thread === 'spaces/DM1/threads/T1' && dm.message.text === 'hello');
const men = L.normalize(addOnMention);
ok('an @mention keeps the text without the mention and says the app was mentioned', men.message.argumentText === ' what is up?' && men.message.mentionsApp && men.message.threadReply);
ok('...and an uploaded attachment with its download reference', men.message.attachments[0]?.resourceName === 'res-1' && men.message.attachments[0]?.filename === 'plan.pdf');
ok('added and removed are their own kinds', L.normalize(addOnAdded).kind === 'added' && L.normalize(addOnRemoved).kind === 'removed');
const cl = L.normalize(classicDm);
ok('a classic event reads the same (DM → DIRECT_MESSAGE)', cl.kind === 'message' && cl.space.type === 'DIRECT_MESSAGE' && cl.format === 'classic' && cl.user.email === 'ann@example.test');
ok('something that is not an event is null', L.normalize(null) === null && L.normalize('x') === null);

// ─── routing ─────────────────────────────────────────────────────────────────
const got = { dm: [], space: [], added: [], removed: [] };
const handle = L.createHandler({
  onDm: async (ev) => { got.dm.push(ev); return { did: 'dm-turn' }; },
  onSpaceMessage: async (ev) => { got.space.push(ev); return { did: 'routed' }; },
  onAdded: async (ev) => { got.added.push(ev); },
  onRemoved: async (ev) => { got.removed.push(ev); },
});
ok('a DM goes to the DM side', (await handle(dm)).did === 'dm-turn' && got.dm.length === 1);
ok('an @mention in a space goes to the space side', (await handle(men)).did === 'routed' && got.space.length === 1);
ok('added reaches its handler', (await handle(L.normalize(addOnAdded))).did === 'added' && got.added.length === 1);
ok('removed reaches its handler', (await handle(L.normalize(addOnRemoved))).did === 'removed' && got.removed.length === 1);
const bot = L.normalize({ chat: { user: { name: 'users/other-app', type: 'BOT' }, messagePayload: addOnDm.chat.messagePayload } });
ok('another app\'s message is ignored (loop prevention)', (await handle(bot)).why === 'bot' && got.dm.length === 1);
const anon = L.normalize({ chat: { messagePayload: addOnDm.chat.messagePayload } });
ok('a message without a sender is ignored', (await handle(anon)).why === 'no sender');
ok('with no handler yet, an event is reported as unhandled', (await L.createHandler({})(dm)).did === 'unhandled');

// ─── dispatch: dedupe, acknowledgement order ─────────────────────────────────
let handled = 0;
const h = async () => { handled += 1; return { did: 'ok' }; };
ok('a pulled event is handled', (await L.dispatch({ messageId: 'p1', event: addOnDm }, { handle: h })).did === 'ok' && handled === 1);
ok('...a redelivery of the same Pub/Sub message is dropped', (await L.dispatch({ messageId: 'p1', event: addOnDm }, { handle: h })).did === 'duplicate' && handled === 1);
ok('...and so is the same Chat message published again', (await L.dispatch({ messageId: 'p2', event: addOnDm }, { handle: h })).did === 'duplicate' && handled === 1);
ok('an undecodable message is ignored', (await L.dispatch({ messageId: 'p3', event: null }, { handle: h })).why === 'not an event');
const failing = await L.dispatch({ messageId: 'p4', event: classicDm }, { handle: async () => { throw new Error('boom'); } });
ok('a handler that throws is reported, not thrown', failing.did === 'failed' && failing.error === 'boom');
ok('the status counts what arrived', L.status().counts.message >= 2 && L.status().lastEventAt);

const order = [];
const fakeApi = {
  pull: async () => [{ ackId: 'a1', messageId: 'q1', event: addOnMention }, { ackId: 'a2', messageId: 'q2', event: addOnAdded }],
  acknowledge: async (ids) => { order.push(`ack:${ids.join(',')}`); },
};
L.__reset();
const n = await L.pullOnce({ api: fakeApi, handle: async (ev) => { order.push(`handle:${ev.kind}`); return { did: 'ok' }; } });
await new Promise(r => setTimeout(r, 20));
ok('a batch is acknowledged before its events are handled', n === 2 && order[0] === 'ack:a1,a2' && order.slice(1).sort().join() === 'handle:added,handle:message', order);
ok('a successful pull marks the loop connected', L.status().connected && L.status().since);
ok('the listener keeps its state in the project, without secrets',
  !existsSync(join(ROOT, '.team', 'gchat-listener-state.json')) || !/private_key|BEGIN/.test(readFileSync(join(ROOT, '.team', 'gchat-listener-state.json'), 'utf8')));

L.__reset();
console.log(`\ngchat-listener: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
