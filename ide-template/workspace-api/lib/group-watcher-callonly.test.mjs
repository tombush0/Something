/**
 * "Only when called" rooms (the room's "joins in on its own" switch off,
 * stored as requireMention): every message is kept as context, but a plain
 * one starts nothing — no gate, no turn, so Google Chat shows no working line.
 * An @mention is answered; a message in a thread the assistant is in goes to
 * the gate and is silent when the gate cannot say yes; naming the assistant
 * without the @ and the engaged window do not count. A room that joins in on
 * its own is unchanged. Google Chat spaces start as "only when called".
 * No model, no network: the adapter is a fake and the model binary is absent.
 * Run: node lib/group-watcher-callonly.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'gw-called-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'gw-called-store-'));
process.env.SLACK_PROXY_URL = '';
process.env.CLAUDE_BIN = '/nonexistent/claude';
process.env.GROUP_WATCHER_QUIET_MS = '20';
process.env.GROUP_WATCHER_MAX_WINDOW_MS = '40';
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', slackUserId: 'U0ANN0001', addedAt: '2026-09-01T00:00:00Z' },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true, groups: {
  'slack-C0CALLED1': { title: '#called', requireMention: true, addedAt: '2026-10-01T00:00:00Z', members: {} },
  'slack-C0AMBIENT': { title: '#ambient', requireMention: false, addedAt: '2026-10-01T00:00:00Z', members: {} },
} }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const A = await import('./integrations/channel-adapter.js');
const working = [];
A.__setAdapter('slack', {
  kind: 'slack', label: 'Slack', roomNoun: 'Slack CHANNEL', replyMax: 12000, threads: true,
  prompt: { otherBots: '- OTHER BOTS: none.', reactions: 'a common emoji.' },
  send: async () => ({ ok: true, messageId: '1.0' }), sendFile: async () => ({ ok: true }), typing: async () => {},
  react: async () => ({ ok: true }), download: async () => ({ ok: false, error: 'no' }),
  working: async (c, m, on) => { working.push({ c, m, on }); },
  memberOf: (id) => (id === 'U0ANN0001' ? { slug: 'ann', displayName: 'Ann', role: 'member' } : null),
  selfId: () => 'U0SELF', isSelf: (id) => id === 'U0SELF', ensureSelf: () => {}, sendingReady: () => true,
  replyRef: (t) => (t && t.thread_id ? { thread_ts: String(t.thread_id) } : {}),
  creatorOf: async () => null, afterRegister: async () => {},
});
const gw = await import('./integrations/group-watcher.js');
const team = await import('./team.js');

const settle = () => new Promise(r => setTimeout(r, 250));
const log = (chat) => {
  const f = join(ROOT, '.group-watcher', `${chat}.jsonl`);
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};
const verdict = (chat, mid) => log(chat).filter(l => l.msg_id === mid).pop() || null;
const send = (chat, mid, text, extra = {}) => gw.routeGroupMessage({ chat_id: chat, message_id: mid, text, from_id: 'U0ANN0001', from_name: 'Ann', ...extra });
const C = 'slack-C0CALLED1';

// A plain message: context only.
send(C, '100.0', 'anyone know when the next team meeting is?');
await settle();
let v = verdict(C, '100.0');
ok('a plain message starts nothing', v && v.decision === 'ignore' && v.reason_enum === 'call-only', v);
ok('...shows no working line', !working.some(w => w.m === '100.0'));
ok('...and is kept as context', readFileSync(join(ROOT, '.group-watcher', `${C}-history.jsonl`), 'utf8').includes('next team meeting'));

// Named without the @: still context only.
send(C, '101.0', 'I think Aria already sent that report yesterday');
await settle();
v = verdict(C, '101.0');
ok('naming the assistant without the @ starts nothing', v && v.reason_enum === 'call-only', v);

// The engaged window does not count.
gw.__test.engage(C, 'U0ANN0001');
send(C, '102.0', 'ok thanks, and what about the budget numbers');
await settle();
v = verdict(C, '102.0');
ok('a follow-up inside the engaged window starts nothing', v && v.reason_enum === 'call-only', v);
gw.__test.disengage(C, 'U0ANN0001');

// An @mention is answered (the turn fails here: no model, but it was started).
send(C, '103.0', 'can you summarise this week?', { is_mention: true });
await settle();
v = verdict(C, '103.0');
ok('an @mention starts a turn without the gate', v && v.decision !== 'ignore' && v.reason_enum !== 'call-only' && v.beat === 'addressed', v);

// In a thread the assistant is in: the gate rules; no verdict means silence.
gw.__test.noteSpoke(C, '200.0');
send(C, '200.5', 'could you also add the March numbers?', { thread_id: '200.0' });
await settle();
v = verdict(C, '200.5');
ok('a thread message where the gate cannot rule stays silent', v && v.decision === 'ignore' && v.reason_enum !== 'call-only' && v.reason_enum !== 'gate-down-pass', v);
ok('...and shows no working line', !working.some(w => w.m === '200.5'));

// In a thread the assistant is not in: context only.
send(C, '300.5', 'sure, I will handle it', { thread_id: '300.0' });
await settle();
v = verdict(C, '300.5');
ok('a message in someone else\'s thread starts nothing', v && v.reason_enum === 'call-only', v);

// A room that joins in on its own keeps the old path: a gate failure goes to the brain.
send('slack-C0AMBIENT', '400.0', 'anyone know when the next team meeting is?');
await settle();
v = verdict('slack-C0AMBIENT', '400.0');
ok('a room that joins in on its own still judges plain messages', v && v.reason_enum !== 'call-only', v);

// Defaults: a new Google Chat space is "only when called", a Slack channel joins in.
const g = team.addGroup({ chatId: 'gchat-AAAAtest01' });
ok('a new Google Chat space starts as "only when called"', g?.requireMention === true || team.getGroup('gchat-AAAAtest01')?.requireMention === true);
team.addGroup({ chatId: 'slack-C0NEWCHAN' });
ok('...a new Slack channel still joins in on its own', team.getGroup('slack-C0NEWCHAN')?.requireMention === false);
team.touchGroupMeta('gchat-AAAAtest01', { requireMention: false });
ok('...and the switch can turn it back', team.getGroup('gchat-AAAAtest01')?.requireMention === false);

console.log(`group-watcher-callonly: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
