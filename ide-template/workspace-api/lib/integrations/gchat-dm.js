/**
 * A direct message to the coworker's Google Chat app — what Slack's DM path
 * is, for Chat. A roster person's message is a turn AS that person
 * (member-dm, surface 'gchat'), answered in the same conversation and
 * recorded in their "Google Chat" chat on the web; anyone else gets one fixed
 * line, once, and is listed for an admin.
 *
 * Identity: Chat sends the sender's email with every message to the app, so a
 * first message is matched to the roster by that email and the Chat user id
 * (users/<id>) is remembered on the entry — from then on the id is the key,
 * as Slack's member id is.
 *
 * "Working on it": an app cannot react to a message (Chat refuses reactions
 * with app authentication), so where Slack puts 👀 on the message, this posts
 * a short line at once and turns it into the answer when the turn ends — or
 * removes it when the turn stays silent, and leaves a ⚠️ when it fails.
 *
 * Files: an app cannot upload an attachment either. A file the reply hands
 * over is named with where it lives in the workspace; a file the person sends
 * is downloaded (an upload) or named with its Drive id (a Drive file).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as api from './gchat-api.js';
import { userByGchatId, setGchat, find as memberByEmail } from '../team.js';
import { startMemberDm } from './member-dm.js';
import { saveAttachments } from '../attachments.js';

const STRANGER_LINE = 'I can only talk with people on this workspace\'s team. Ask an admin to add your email to the team, then write to me again.';
export const WORKING_TEXT = '⏳';
const FAILED_TEXT = '⚠️';
const NO_UPLOAD = 'Google Chat apps cannot attach files';

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }
function pendingPath() { return join(projectDir(), '.team', 'gchat-pending.json'); }

// ─── pending people (DMs from people not on the roster) ──────────────────────

export function pendingUsers() {
  try { return JSON.parse(readFileSync(pendingPath(), 'utf8')); } catch { return []; }
}
function notePending({ id, email, name }) {
  const cur = pendingUsers().filter(p => p.id !== id);
  cur.push({ id, email: email || null, name: name || null, at: new Date().toISOString() });
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(pendingPath(), JSON.stringify(cur.slice(-50)), { mode: 0o660 });
  } catch (err) { process.stderr.write(`[gchat] pending list not written: ${err.message}\n`); }
}
export function forgetPending(id) {
  const cur = pendingUsers().filter(p => p.id !== id);
  try { writeFileSync(pendingPath(), JSON.stringify(cur), { mode: 0o660 }); } catch { /* best effort */ }
}

// ─── identity ────────────────────────────────────────────────────────────────

/**
 * The roster member behind a Chat sender, or null. A first sighting is matched
 * by the email Chat sent — only for a person (not an app) — and remembered on
 * the roster. Injectable for the tests.
 */
export function resolveMember(user, deps = {}) {
  if (!user?.name || user.type === 'BOT') return null;
  const hit = (deps.userByGchatId || userByGchatId)(user.name);
  if (hit) return hit;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return null;
  const member = (deps.memberByEmail || memberByEmail)(email);
  if (!member) {
    (deps.notePending || notePending)({ id: user.name, email, name: user.displayName });
    return null;
  }
  try { (deps.setGchat || setGchat)(member.email, { userId: user.name }, 'gchat'); }
  catch (err) { process.stderr.write(`[gchat] could not link ${user.name} to ${member.slug}: ${err.message}\n`); return null; }
  return (deps.userByGchatId || userByGchatId)(user.name) || member;
}

// ─── text ────────────────────────────────────────────────────────────────────

/**
 * Markdown as Google Chat writes it: **bold** → *bold*, a heading → a bold
 * line, [label](url) → <url|label>. Code spans and blocks are left alone.
 */
export function chatText(md) {
  return String(md || '').split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => {
    if (i % 2) return part;
    return part
      .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, '*$1*')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '*$1*')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
  }).join('');
}

// ─── the DM handler ──────────────────────────────────────────────────────────

const told = new Set();
const dmSpaces = new Map();   // users/<id> → spaces/<dm>, learned from their messages

/** The DM space with a roster member, for a post from elsewhere (a reminder, a relay). */
export async function dmSpaceOf(member, deps = {}) {
  const id = member?.gchatUserId;
  if (!id) return null;
  if (dmSpaces.has(id)) return dmSpaces.get(id);
  const space = await (deps.api || api).findDirectMessage(id);
  if (space?.name) dmSpaces.set(id, space.name);
  return space?.name || null;
}

/** Post a reply, in pieces Chat reads well; the first piece may replace the working line. */
export async function postReply({ space, text, thread = null, replace = null }, a = api) {
  const pieces = api.splitText(chatText(text));
  if (!pieces.length) return { ok: false };
  let first = null;
  if (replace) {
    try { first = await a.updateMessage(replace, pieces[0]); } catch { first = null; }
  }
  if (!first) first = await a.createMessage({ space, text: pieces[0], thread });
  for (const p of pieces.slice(1)) await a.createMessage({ space, text: p, thread: first?.thread?.name || thread });
  return { ok: !!first?.name, messageId: first?.name || null };
}

/**
 * Build the DM handler with its dependencies (the real ones by default; tests
 * pass fakes). It takes one normalized event (gchat-listener) and returns what
 * it did, as `{ did, ... }`.
 */
export function createDmHandler(deps = {}) {
  const d = {
    api, resolveMember: (u) => resolveMember(u, deps), memberDm: startMemberDm, saveAttachments,
    log: (s) => process.stderr.write(`[gchat] ${s}\n`), ...deps,
  };

  async function attachmentsBlock(ev, member) {
    const files = ev.message?.attachments || [];
    if (!files.length) return '';
    const got = [], drive = [];
    for (const f of files.slice(0, 10)) {
      if (f.source === 'DRIVE_FILE' || f.driveFileId) { drive.push(`- ${f.filename || 'a file'} (Drive file id ${f.driveFileId})`); continue; }
      if (!f.resourceName) continue;
      try {
        const buffer = await d.api.downloadAttachment(f.resourceName);
        got.push({ originalname: f.filename || 'file', buffer, size: buffer.length });
      } catch (err) { d.log(`file ${f.filename || ''} from ${member.slug} not fetched: ${err.message}`); }
    }
    let out = drive.length ? `\n\n[Drive files they shared — open them with the Drive tools]\n${drive.join('\n')}` : '';
    if (got.length) {
      try {
        const saved = d.saveAttachments(`gchat-${member.slug}`, got);
        out += `\n\n[Attachments — read these files to answer]\n${saved.map(a => `- ${a.path}`).join('\n')}`;
      } catch (err) { d.log(`attachments not saved: ${err.message}`); }
    }
    return out;
  }

  return async function onDm(ev) {
    const space = ev.space.name;
    const member = d.resolveMember(ev.user);
    if (!member) {
      if (told.has(ev.user.name)) return { did: 'ignored', why: 'stranger (told)' };
      told.add(ev.user.name);
      try { await d.api.createMessage({ space, text: STRANGER_LINE }); } catch (err) { d.log(`stranger line not sent: ${err.message}`); }
      return { did: 'stranger-told', user: ev.user.name };
    }
    if (member.gchatUserId) dmSpaces.set(member.gchatUserId, space);
    const text = String(ev.message.argumentText ?? ev.message.text ?? '').trim();
    const body = `${text}${await attachmentsBlock(ev, member)}`.trim();
    if (!body) return { did: 'ignored', why: 'empty' };
    // A message inside a thread is answered in that thread; a new message
    // gets its answer next to it, as in a person's chat.
    const thread = ev.message.threadReply ? ev.message.thread : null;
    let working = null;
    try { working = (await d.api.createMessage({ space, text: WORKING_TEXT, thread }))?.name || null; }
    catch (err) { d.log(`working line not posted: ${err.message}`); }
    const send = async (target, reply) => {
      const replace = working;
      working = null;
      return postReply({ space: target, text: reply, thread, replace }, d.api);
    };
    const sendFile = async () => ({ ok: false, error: NO_UPLOAD });
    const done = d.memberDm(member, body, { surface: 'gchat', target: space, send, sendFile });
    done.then(async (r) => {
      if (!working) return;   // the answer took its place
      const w = working;
      working = null;
      try {
        if (r && r.reason === 'error') await d.api.updateMessage(w, FAILED_TEXT);
        else await d.api.deleteMessage(w);
      } catch (err) { d.log(`working line not cleared: ${err.message}`); }
    }).catch(() => {});
    return { did: 'member-dm', slug: member.slug, body, done };
  };
}

/** Tests: forget who was told and which DMs were seen. */
export function __reset() { told.clear(); dmSpaces.clear(); }
