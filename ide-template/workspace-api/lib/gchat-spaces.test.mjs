/**
 * Google Chat spaces as rooms, the counterpart of slack-channels.test.mjs.
 * Being added is a request for an admin (an admin adding it is the yes);
 * approval registers the space open by default and subscribes to it; the
 * audience check knows every member by the email the directory gives, links
 * a roster person it finds, counts another app as someone else, pauses a
 * space only when it is closed to outsiders, and resumes it when they leave;
 * a request nobody answered in a day is declined (the app cannot leave, the
 * admins are told); subscriptions are renewed before they lapse, made anew
 * when gone, and one the app cannot see is left to lapse; a space message
 * reaches the watcher in a Slack message's shape, with its thread only when
 * it is a reply, its files, and whether the app was addressed; an @mention in
 * a space nobody decided on makes the request. Also: Workspace Events
 * deliveries are read by the listener, and the watcher's thread handling
 * works for Chat's thread ids. Chat, the directory, the watcher and the
 * clock are injected.
 * Run: node lib/gchat-spaces.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'gchat-spaces-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'gchat-spaces-store-'));
process.env.GCHAT_PROXY_URL = '';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', gchatUserId: 'users/1000000001', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: {} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const S = await import('./integrations/gchat-spaces.js');
const L = await import('./integrations/gchat-listener.js');
const team = await import('./team.js');
const { groupIdKind } = await import('./group-id.js');
const W = await import('./integrations/group-watcher.js');

// A fake Chat, directory and Workspace Events.
const people = {
  'users/1000000001': { name: 'users/1000000001', type: 'HUMAN', displayName: 'Stan' },
  'users/2000000002': { name: 'users/2000000002', type: 'HUMAN', displayName: 'Ann' },
  'users/3000000003': { name: 'users/3000000003', type: 'HUMAN', displayName: 'Guest' },
  'users/app-other': { name: 'users/app-other', type: 'BOT', displayName: 'Polls' },
};
const directory = { 'users/2000000002': { email: 'ann@example.test', name: 'Ann Lee' }, 'users/3000000003': { email: 'guest@partner.test', name: 'Guest Person' } };
const spaces = {
  'spaces/TEAM01': { spaceType: 'SPACE', displayName: 'Team', members: ['users/1000000001', 'users/2000000002'] },
  'spaces/OPEN02': { spaceType: 'SPACE', displayName: 'Partners', members: ['users/1000000001'] },
  'spaces/BYADM3': { spaceType: 'SPACE', displayName: 'Launch', members: ['users/1000000001'] },
};
const notices = [], routed = [], subsCalls = [];
let clock = Date.parse('2026-11-08T10:00:00Z');
let renewFails = null, createExists = false;
const fakeApi = {
  getSpace: async (s) => ({ name: s, ...spaces[s] }),
  listMembers: async (s) => spaces[s].members.map(n => ({ name: `${s}/members/${n.split('/')[1]}`, state: 'JOINED', member: people[n] })),
  directoryUser: async (id) => directory[id] || null,
  createSpaceSubscription: async (s) => { subsCalls.push(['create', s]); return createExists ? { exists: true } : { name: `subscriptions/sub-${s.split('/')[1]}`, expireTime: new Date(clock + 24 * 3600_000).toISOString() }; },
  renewSubscription: async (n) => { subsCalls.push(['renew', n]); if (renewFails) { const e = new Error(renewFails); e.status = 404; throw e; } return { name: n, expireTime: new Date(clock + 24 * 3600_000).toISOString() }; },
};
S.__setDeps({
  api: fakeApi, self: () => ({ appUser: 'users/app-self' }), now: () => clock, log: () => {},
  notify: (n) => notices.push(n), route: (p) => { routed.push(p); return { ok: true }; },
});
const subsFile = () => JSON.parse(readFileSync(join(ROOT, '.team', 'gchat-subscriptions.json'), 'utf8'));
const stan = { name: 'users/1000000001', email: 'stan@example.test', type: 'HUMAN', displayName: 'Stan' };
const ann = { name: 'users/2000000002', type: 'HUMAN', displayName: 'Ann' };

ok('a Chat space id is a room id of its own kind', groupIdKind('gchat-TEAM01') === 'gchat' && S.groupIdOf('spaces/TEAM01') === 'gchat-TEAM01' && S.spaceOf('gchat-TEAM01') === 'spaces/TEAM01');

// ─── admission ───────────────────────────────────────────────────────────────
let r = await S.onAdded({ space: { name: 'spaces/TEAM01', type: 'SPACE' }, user: ann });
ok('added by a member: a request, not a yes', r.did === 'pending' && !team.getGroup('gchat-TEAM01') && S.pendingSpaces().some(p => p.chatId === 'gchat-TEAM01' && p.title === 'Team'));
ok('...the admins are told', notices.some(n => n.recipient === 'stan' && /waits for your approval/.test(n.title)));
ok('a DM is not a room', (await S.onAdded({ space: { name: 'spaces/DM9', type: 'DIRECT_MESSAGE' }, user: ann })).did === 'ignored');

r = await S.onAdded({ space: { name: 'spaces/BYADM3', type: 'SPACE' }, user: stan });
ok('added by an admin: registered at once', r.did === 'approved-by-admin' && !!team.getGroup('gchat-BYADM3'));
ok('...and subscribed', subsCalls.some(c => c[0] === 'create' && c[1] === 'spaces/BYADM3') && subsFile()['gchat-BYADM3']?.name === 'subscriptions/sub-BYADM3');

const g = await S.approveSpace('gchat-TEAM01', { actor: 'stan@example.test' });
ok('an approved space is registered, open to the room by default, no longer pending', g.chatId === 'gchat-TEAM01' && g.openAudience === true && !S.pendingSpaces().some(p => p.chatId === 'gchat-TEAM01'));
ok('...a member the directory names is linked to the roster', team.find('ann@example.test').gchatUserId === 'users/2000000002');
ok('...the audience is the team', team.getGroup('gchat-TEAM01').audience?.ok === true && !team.getGroup('gchat-TEAM01').paused);

// ─── the audience ────────────────────────────────────────────────────────────
spaces['spaces/TEAM01'].members.push('users/3000000003');
r = await S.onMembership({ kind: 'membership', change: 'joined', space: { name: 'spaces/TEAM01' }, user: people['users/3000000003'] });
ok('someone not on the team joins: named as an outsider', r.audience?.ok === false && r.audience.outsiders.some(o => o.id === 'users/3000000003' && o.name === 'Guest'));
ok('...an open space stays answering (its own memory only, by the room rules)', !team.getGroup('gchat-TEAM01').paused);
team.touchGroupMeta('gchat-TEAM01', { openAudience: false });
await S.checkAudience('gchat-TEAM01');
ok('...a space closed to outsiders is paused, and the admins hear', team.getGroup('gchat-TEAM01').paused === true && notices.some(n => /is paused/.test(n.title)));
spaces['spaces/TEAM01'].members.pop();
await S.onMembership({ kind: 'membership', change: 'left', space: { name: 'spaces/TEAM01' }, user: people['users/3000000003'] });
ok('...and resumed when they leave', !team.getGroup('gchat-TEAM01').paused && notices.some(n => /resumed/.test(n.title)));
spaces['spaces/TEAM01'].members.push('users/app-other');
const a = await S.checkAudience('gchat-TEAM01');
ok('another app counts as someone else', a.ok === false && a.outsiders.some(o => o.id === 'users/app-other'));
spaces['spaces/TEAM01'].members.pop();
await S.checkAudience('gchat-TEAM01');

// ─── a request nobody answered ───────────────────────────────────────────────
await S.onAdded({ space: { name: 'spaces/OPEN02', type: 'SPACE' }, user: ann });
clock += 25 * 3600_000;
ok('a request older than a day is declined', (await S.sweepPending()) === 1 && !S.pendingSpaces().length && !team.getGroup('gchat-OPEN02'));
ok('...and the admins are told how to remove the app (it cannot leave)', notices.some(n => /declined/.test(n.title) && /cannot leave a space by itself/.test(n.body)));

// ─── subscriptions ───────────────────────────────────────────────────────────
let s = await S.ensureSubscription('gchat-TEAM01');
ok('a day later, the approval\'s subscription is renewed', s.did === 'renewed');
subsCalls.length = 0;
s = await S.ensureSubscription('gchat-TEAM01');
ok('a fresh subscription is left alone', s.did === 'fresh' && !subsCalls.length);
clock += 20 * 3600_000;
s = await S.ensureSubscription('gchat-TEAM01');
ok('one near its end is renewed', s.did === 'renewed' && subsCalls[0]?.[0] === 'renew');
clock += 23 * 3600_000;
renewFails = 'Subscription not found';
s = await S.ensureSubscription('gchat-TEAM01');
renewFails = null;
ok('one that is gone is made anew', s.did === 'created' && subsCalls.some(c => c[0] === 'create' && c[1] === 'spaces/TEAM01'));
r = await S.onSubscription({ kind: 'subscription', what: 'expired', subscription: subsFile()['gchat-TEAM01'].name, space: { name: 'spaces/TEAM01' } });
ok('an expired notice makes a new one', r.did === 'created');
team.addGroup({ chatId: 'gchat-NEWSP4', title: 'New', actor: 'stan@example.test' });
createExists = true;
s = await S.ensureSubscription('gchat-NEWSP4');
ok('one that exists but cannot be seen is left to lapse', s.did === 'existing' && subsFile()['gchat-NEWSP4']?.exists === true);
ok('...and not asked for again within the day', (await S.ensureSubscription('gchat-NEWSP4')).did === 'existing');
createExists = false;
team.removeGroup('gchat-NEWSP4', 'stan@example.test');
await S.sweepSubscriptions();
ok('a space no longer registered is no longer renewed', !subsFile()['gchat-NEWSP4']);

// ─── space messages ──────────────────────────────────────────────────────────
const msg = (over = {}) => ({
  kind: 'message', format: 'event', space: { name: 'spaces/TEAM01', type: 'SPACE', displayName: 'Team' }, user: ann,
  message: { name: 'spaces/TEAM01/messages/thr1.msgA', text: 'hello all', argumentText: 'hello all', thread: 'spaces/TEAM01/threads/thr1', threadReply: false, mentionsApp: false, attachments: [], ...over },
});
r = await S.onSpaceMessage(msg());
ok('a space message reaches the watcher', r.did === 'routed' && routed[0]?.chat_id === 'gchat-TEAM01' && routed[0].message_id === 'thr1.msgA');
ok('...as the roster names the sender', routed[0].from_id === 'users/2000000002' && routed[0].from_name === 'Ann');
ok('...a top-level message has no thread, and is not a mention', routed[0].thread_id === null && routed[0].is_mention === false);
await S.onSpaceMessage(msg({ name: 'spaces/TEAM01/messages/thr1.msgB', threadReply: true, mentionsApp: true }));
ok('a reply carries its thread, and a mention of the app is one', routed[1].thread_id === 'thr1' && routed[1].is_mention === true);
await S.onSpaceMessage({ ...msg({ name: 'spaces/TEAM01/messages/thr2.msgC' }), format: 'add-on' });
ok('an interaction event (Chat sends those only for a mention) is a mention', routed[2].is_mention === true);
await S.onSpaceMessage(msg({ name: 'spaces/TEAM01/messages/thr3.msgD', attachments: [
  { filename: 'pic.png', contentType: 'image/png', resourceName: 'res-pic' },
  { filename: 'plan.pdf', contentType: 'application/pdf', resourceName: 'res-plan' },
  { filename: 'Budget', source: 'DRIVE_FILE', driveFileId: 'drv1' },
] }));
ok('files: an image, a document, and a Drive file named by its id', routed[3].photo_file_id?.file_id === 'res-pic' && routed[3].attachment?.file_id === 'res-plan' && /Drive file id drv1/.test(routed[3].text));
team.touchGroupMeta('gchat-TEAM01', { paused: true });
ok('a paused space routes nothing', (await S.onSpaceMessage(msg({ name: 'spaces/TEAM01/messages/thr4.msgE' }))).why === 'paused');
team.touchGroupMeta('gchat-TEAM01', { paused: false });
const before = routed.length;
r = await S.onSpaceMessage({ ...msg({ name: 'spaces/LATE05/messages/t.m', mentionsApp: true }), space: { name: 'spaces/LATE05', type: 'SPACE' } });
spaces['spaces/LATE05'] = { spaceType: 'SPACE', displayName: 'Late', members: [] };
ok('an @mention in a space nobody decided on makes the request, and routes nothing', r.why === 'not registered' && routed.length === before && S.pendingSpaces().some(p => p.chatId === 'gchat-LATE05'));

// ─── the listener reads Workspace Events ─────────────────────────────────────
const ce = (type, data, subject = '//chat.googleapis.com/spaces/TEAM01') => ({ event: data, attributes: { 'ce-type': type, 'ce-subject': subject, 'ce-time': '2026-11-08T12:00:00Z', 'ce-source': '//workspaceevents.googleapis.com/subscriptions/sub-TEAM01' } });
let ev = L.normalize(ce('google.workspace.chat.message.v1.created', { message: { name: 'spaces/TEAM01/messages/t9.m9', sender: { name: 'users/2000000002', type: 'HUMAN' }, text: 'hi', thread: { name: 'spaces/TEAM01/threads/t9' } } }).event, ce('x', {}).attributes && { 'ce-type': 'google.workspace.chat.message.v1.created', 'ce-subject': '//chat.googleapis.com/spaces/TEAM01' });
ok('a subscribed message is a message in its space, from its sender', ev.kind === 'message' && ev.format === 'event' && ev.space.name === 'spaces/TEAM01' && ev.user.name === 'users/2000000002' && ev.message.thread === 'spaces/TEAM01/threads/t9');
ev = L.normalize({ membership: { name: 'spaces/TEAM01/members/3000000003', member: { name: 'users/3000000003', type: 'HUMAN' } } }, { 'ce-type': 'google.workspace.chat.membership.v1.deleted' });
ok('a membership change is read as joined or left', ev.kind === 'membership' && ev.change === 'left' && ev.space.name === 'spaces/TEAM01');
ev = L.normalize({ subscription: { name: 'subscriptions/sub-TEAM01', targetResource: '//chat.googleapis.com/spaces/TEAM01' } }, { 'ce-type': 'google.workspace.events.subscription.v1.expirationReminder' });
ok('a subscription notice names the subscription and its space', ev.kind === 'subscription' && ev.what === 'expirationReminder' && ev.subscription === 'subscriptions/sub-TEAM01' && ev.space.name === 'spaces/TEAM01');
const batch = L.normalizeAll({ messages: [{ message: { name: 'spaces/TEAM01/messages/a.1', sender: { name: 'users/1', type: 'HUMAN' } } }, { message: { name: 'spaces/TEAM01/messages/a.2', sender: { name: 'users/2', type: 'HUMAN' } } }] }, { 'ce-type': 'google.workspace.chat.message.v1.batchCreated' });
ok('a batch is read as each of its messages', batch.length === 2 && batch[1].message.name === 'spaces/TEAM01/messages/a.2');
const got = [];
const h = L.createHandler({ onSpaceMessage: async (e) => { got.push(e.format); return { did: 'space' }; } });
await L.dispatch({ messageId: 'p1', event: { chat: { user: ann, messagePayload: { space: { name: 'spaces/TEAM01', spaceType: 'SPACE' }, message: { name: 'spaces/TEAM01/messages/x.1', text: '@App hi' } } } } }, { handle: h });
await L.dispatch({ messageId: 'p2', event: { message: { name: 'spaces/TEAM01/messages/x.1', sender: ann } }, attributes: { 'ce-type': 'google.workspace.chat.message.v1.created', 'ce-subject': '//chat.googleapis.com/spaces/TEAM01' } }, { handle: h });
ok('the same message as an @mention and as a subscribed message is handled once', got.length === 1 && got[0] === 'add-on');

// ─── the watcher's threads, for Chat ─────────────────────────────────────────
const target = { message_id: 'thr7.msgZ', thread_id: null, from_id: 'users/2000000002' };
ok('a top-level message in a quiet space is answered in the space', JSON.stringify(W.placeReply('gchat-TEAM01', target, { text: 'short', hist: [] })) === '{}');
ok('a long answer goes into the message\'s own thread', W.placeReply('gchat-TEAM01', target, { text: 'x'.repeat(900), hist: [] }).thread_ts === 'thr7');
ok('a reply in a thread is answered in that thread', W.placeReply('gchat-TEAM01', { ...target, thread_id: 'thr8' }, { text: 'short' }).thread_ts === 'thr8');
ok('a thread keeps its own session', W.__test.sessionKeyFor('gchat-TEAM01', { thread_id: 'thr9' }) === 'gchat-TEAM01|thr9');
ok('Slack threads still work as before', W.__test.sessionKeyFor('slack-C0GENERAL', { thread_id: '1700000000.000100' }) === 'slack-C0GENERAL|1700000000.000100' && W.__test.sessionKeyFor('slack-C0GENERAL', { thread_id: 'thr9' }) === 'slack-C0GENERAL');

S.stopSweep();
console.log(`\ngchat-spaces: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
