/**
 * A direct message to the coworker's Google Chat app. A roster person is
 * matched by the email Chat sends and their Chat id is remembered; their
 * message is a turn as them, with a working line posted at once that turns
 * into the answer (removed when the turn is silent, a warning when it fails);
 * a stranger gets one fixed line, once, and lands on the pending list; a file
 * they upload is fetched for the turn and a Drive file is named by its id;
 * a file the reply hands over is named, not attached (apps cannot upload);
 * Markdown is written the way Chat formats; Google Chat is a surface people
 * are reached on, by default once linked; a teammate can be linked by id
 * once only. The API, the turn and the roster are real or injected.
 * Run: node lib/gchat-dm.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'gchat-dm-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'gchat-dm-store-'));
process.env.GCHAT_PROXY_URL = '';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', gchatUserId: 'users/2000000001', addedAt: '2026-09-01T00:00:00Z' },
]));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const G = await import('./integrations/gchat-dm.js');
const team = await import('./team.js');
const { prefers, describeSurfaces, parseSurfaces } = await import('./surfaces.js');

// A fake Chat and a fake turn.
let seq = 0;
const created = [], updated = [], deleted = [], downloads = [];
const fakeApi = {
  createMessage: async ({ space, text, thread }) => { const m = { name: `${space}/messages/b${++seq}`, thread: { name: thread || `${space}/threads/t${seq}` } }; created.push({ space, text, thread, name: m.name }); return m; },
  updateMessage: async (name, text) => { updated.push({ name, text }); return { name }; },
  deleteMessage: async (name) => { deleted.push(name); return null; },
  downloadAttachment: async (ref) => { downloads.push(ref); return Buffer.from('pdf bytes'); },
  findDirectMessage: async () => ({ name: 'spaces/FOUND' }),
};
const turns = [];
let nextReply = { text: 'Here you go, **all done**.' };
const fakeMemberDm = (member, body, deps) => {
  turns.push({ slug: member.slug, body, surface: deps.surface, target: deps.target });
  return (async () => {
    const r = nextReply;
    if (r.reason) return { delivered: false, reason: r.reason };
    if (r.file) { const f = await deps.sendFile(deps.target, { abs: '/x', name: 'plan.pdf' }); return { delivered: false, file: f }; }
    const sent = await deps.send(deps.target, r.text);
    return { delivered: sent.ok, reason: 'gchat' };
  })();
};
const saved = [];
const handle = G.createDmHandler({
  api: fakeApi, memberDm: fakeMemberDm,
  saveAttachments: (thread, files) => { saved.push({ thread, files: files.map(f => f.originalname) }); return files.map(f => ({ path: `.attachments/${thread}/${f.originalname}` })); },
  log: () => {},
});
const dmEvent = (user, text, extra = {}) => ({
  kind: 'message', space: { name: 'spaces/DM1', type: 'DIRECT_MESSAGE' }, user,
  message: { name: `spaces/DM1/messages/m${++seq}`, text, argumentText: text, thread: 'spaces/DM1/threads/T1', threadReply: false, attachments: [], ...extra },
});
const stan = { name: 'users/1000000001', email: 'stan@example.test', displayName: 'Stan', type: 'HUMAN' };
const ann = { name: 'users/2000000001', email: 'ann@example.test', displayName: 'Ann', type: 'HUMAN' };
const guest = { name: 'users/3000000001', email: 'guest@elsewhere.test', displayName: 'Guest', type: 'HUMAN' };

// ─── identity ────────────────────────────────────────────────────────────────
ok('a linked teammate is found by their Chat id', G.resolveMember(ann)?.slug === 'ann');
ok('a first message links a teammate by the email Chat sends', G.resolveMember(stan)?.slug === 'stan' && team.find('stan@example.test').gchatUserId === 'users/1000000001');
ok('...and from then on the id is the key', team.userByGchatId('users/1000000001')?.slug === 'stan');
ok('an app is never a teammate', G.resolveMember({ ...ann, type: 'BOT' }) === null);
ok('someone not on the team is not matched', G.resolveMember(guest) === null && G.pendingUsers().some(p => p.id === guest.name && p.email === 'guest@elsewhere.test'));
let dup = null;
try { team.setGchat('ann@example.test', { userId: 'users/1000000001' }, 'stan@example.test'); } catch (err) { dup = err.message; }
ok('one Chat account belongs to one teammate', /already linked/.test(dup || ''));
let bad = null;
try { team.setGchat('ann@example.test', { userId: 'U0SLACK01' }, 'stan@example.test'); } catch (err) { bad = err.message; }
ok('a value that is not a Chat user id is refused', /not a Google Chat user id/.test(bad || ''));

// ─── a teammate's DM ─────────────────────────────────────────────────────────
let r = await handle(dmEvent(ann, 'what is on my plate?'));
await r.done;
ok('a teammate\'s DM is a turn as them, on the gchat surface, in that DM', r.did === 'member-dm' && turns[0]?.slug === 'ann' && turns[0].surface === 'gchat' && turns[0].target === 'spaces/DM1');
ok('a working line is posted at once', created[0]?.text === G.WORKING_TEXT && created[0].space === 'spaces/DM1');
ok('...and turns into the answer, in Chat\'s formatting', updated[0]?.name === created[0].name && updated[0].text === 'Here you go, *all done*.', updated);
ok('...with nothing else posted', created.length === 1 && deleted.length === 0);

nextReply = { reason: 'silent' };
r = await handle(dmEvent(ann, 'thanks'));
await r.done; await new Promise(res => setTimeout(res, 5));
ok('a silent turn removes its working line', deleted.length === 1 && deleted[0] === created[created.length - 1].name);

nextReply = { reason: 'error' };
r = await handle(dmEvent(ann, 'and this?'));
await r.done; await new Promise(res => setTimeout(res, 5));
ok('a failed turn leaves a warning in place of the working line', updated[updated.length - 1]?.text === '⚠️' && updated[updated.length - 1].name === created[created.length - 1].name);

nextReply = { text: 'in the thread' };
const before = created.length;
r = await handle(dmEvent(ann, 'follow-up', { threadReply: true, thread: 'spaces/DM1/threads/T9' }));
await r.done;
ok('a message inside a thread is answered in that thread', created[before]?.thread === 'spaces/DM1/threads/T9');

nextReply = { file: true };
r = await handle(dmEvent(ann, 'send me the plan'));
const out = await r.done;
ok('a file the reply hands over is not attached (apps cannot upload)', out.file?.ok === false && /cannot attach/.test(out.file.error));

// ─── files they send ─────────────────────────────────────────────────────────
nextReply = { text: 'read it' };
r = await handle(dmEvent(ann, 'look at these', { attachments: [
  { filename: 'q3.pdf', source: 'UPLOADED_CONTENT', resourceName: 'res-q3' },
  { filename: 'Budget', source: 'DRIVE_FILE', driveFileId: 'drive123' },
] }));
await r.done;
ok('an uploaded file is fetched and saved for the turn', downloads.includes('res-q3') && saved.some(s => s.thread === 'gchat-ann' && s.files.includes('q3.pdf')));
ok('...and named to the turn by its path', /\[Attachments — read these files to answer\]\n- \.attachments\/gchat-ann\/q3\.pdf/.test(r.body));
ok('a Drive file is named by its id, for the Drive tools', /Budget \(Drive file id drive123\)/.test(r.body) && downloads.length === 1);

// ─── a stranger ──────────────────────────────────────────────────────────────
const n = created.length;
r = await handle(dmEvent(guest, 'hello?'));
ok('a stranger gets one fixed line', r.did === 'stranger-told' && /only talk with people on this workspace/.test(created[n]?.text || ''));
r = await handle(dmEvent(guest, 'hello??'));
ok('...once', r.did === 'ignored' && created.length === n + 1);
ok('...and no turn runs for them', !turns.some(t => t.body.includes('hello')));

// ─── the DM space for a post from elsewhere ──────────────────────────────────
ok('a teammate\'s DM is known from their message', (await G.dmSpaceOf(team.find('ann@example.test'), { api: fakeApi })) === 'spaces/DM1');
G.__reset();
ok('...or found from Chat when not seen yet', (await G.dmSpaceOf(team.find('ann@example.test'), { api: fakeApi })) === 'spaces/FOUND');
ok('someone without a Chat link has none', (await G.dmSpaceOf({ slug: 'x' }, { api: fakeApi })) === null);

// ─── text ────────────────────────────────────────────────────────────────────
ok('headings become bold lines and links Chat links', G.chatText('## Plan\nSee [the doc](https://x.test/d).') === '*Plan*\nSee <https://x.test/d|the doc>.');
ok('code is left alone', G.chatText('`**x**` and ```\n**y**\n```') === '`**x**` and ```\n**y**\n```');

// ─── surfaces ────────────────────────────────────────────────────────────────
ok('Google Chat is a surface a person can choose', JSON.stringify(parseSurfaces(['web', 'gchat'])) === '["web","gchat"]' && describeSurfaces(['gchat']) === 'Google Chat');
ok('with no preference, a linked person is reached on Google Chat (as on Slack)', prefers({}, 'gchat') && prefers({}, 'slack') && !prefers({}, 'telegram'));
ok('a stated preference without it is respected', !prefers({ surfaces: ['web'] }, 'gchat'));
ok('the link is kept on the roster entry', JSON.parse(readFileSync(join(ROOT, '.allowed-emails.json'), 'utf8')).find(e => e.email === 'stan@example.test')?.gchatUserId === 'users/1000000001');
team.setGchat('stan@example.test', { userId: '' }, 'stan@example.test');
ok('...and an admin can clear it', team.find('stan@example.test').gchatUserId === null && team.userByGchatId('users/1000000001') === null);

console.log(`\ngchat-dm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
