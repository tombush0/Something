/**
 * Google Chat spaces, as the group watcher's rooms — what slack-channels.js is
 * for Slack, with the same rules, and the few places Chat makes them differ.
 *
 *   added to a space          → a request an ADMIN approves (never automatic:
 *                               anyone can add an app to a space they manage);
 *                               added by an admin of this workspace is the
 *                               admin's yes. Not approved in 24 h → declined
 *   approved                  → registered (team.js `groups`, id `gchat-<id>`),
 *                               joining in on its own by default, and
 *                               SUBSCRIBED: a space's messages reach an app only
 *                               when @mentioned, so a Workspace Events
 *                               subscription brings the rest (renewed before
 *                               it lapses — it lives a day)
 *   someone joins or leaves   → the AUDIENCE CHECK: every member must be a
 *                               roster person of this workspace (by the email
 *                               the directory gives for their Chat id), else
 *                               the space is PAUSED — or, open to outsiders,
 *                               answered from its own memory only
 *   a message in it           → the group watcher, as a Slack channel's would be
 *
 * Where Chat differs: an app cannot leave a space by itself (Chat refuses it
 * with app authentication), so a declined space keeps the app — silent, and
 * the admins are told to remove it there. And a space with people from
 * outside the organisation is not refused outright as a Slack Connect channel
 * is: the audience check decides, as for any outsider.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as api from './gchat-api.js';
import { status as listenerStatus } from './gchat-listener.js';
import { addGroup, removeGroup, getGroup, touchGroupMeta, userByGchatId, setGchat, find as memberByEmail, list as teamList, listGroups, recordGroupMember } from '../team.js';
import { publish as publishNotification } from '../notify.js';
import { routeGroupMessage } from './group-watcher.js';

const PENDING_TTL_MS = 24 * 3600_000;
const SWEEP_MS = 10 * 60_000;
const RENEW_BEFORE_MS = 6 * 3600_000;       // renew a subscription with less than this left
const RETRY_EXISTING_MS = 25 * 3600_000;    // one we cannot see lapses within a day; make ours after that

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }
function pendingPath() { return join(projectDir(), '.team', 'gchat-pending-spaces.json'); }
function subsPath() { return join(projectDir(), '.team', 'gchat-subscriptions.json'); }
export const groupIdOf = (space) => `gchat-${String(space || '').trim().replace(/^spaces\//, '')}`;
export const spaceOf = (chatId) => `spaces/${String(chatId || '').replace(/^gchat-/, '')}`;
const shortId = (name, part) => String(name || '').split(`/${part}/`)[1] || null;

// ─── dependencies (tests swap them) ──────────────────────────────────────────
let d = {
  api, self: () => listenerStatus(), addGroup, removeGroup, getGroup, touchGroupMeta, userByGchatId, setGchat, memberByEmail, teamList, listGroups, recordGroupMember,
  notify: publishNotification, route: routeGroupMessage, now: () => Date.now(), log: (s) => process.stderr.write(`[gchat-spaces] ${s}\n`),
};
export function __setDeps(over) { d = { ...d, ...over }; }

// ─── small files ─────────────────────────────────────────────────────────────

function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function writeJson(path, value) {
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(path, JSON.stringify(value), { mode: 0o660 });
  } catch (err) { d.log(`${path.split('/').pop()} not written: ${err.message}`); }
}
export function pendingSpaces() { return readJson(pendingPath(), []); }
function writePending(list) { writeJson(pendingPath(), list); }
function dropPending(chatId) { writePending(pendingSpaces().filter(p => p.chatId !== chatId)); }
function subscriptions() { return readJson(subsPath(), {}); }
function writeSubscriptions(m) { writeJson(subsPath(), m); }

function admins() { try { return d.teamList().filter(m => m.role === 'admin' && m.slug).map(m => m.slug); } catch { return []; } }
function tellAdmins(title, body, meta = {}) {
  for (const slug of admins()) {
    try { d.notify({ kind: 'team', recipient: slug, title, body, meta: { surface: 'gchat', ...meta } }); } catch { /* best effort */ }
  }
}
const REMOVE_HINT = 'A Chat app cannot leave a space by itself: someone in the space can remove it (space menu → Apps & integrations → Remove).';

// ─── people ──────────────────────────────────────────────────────────────────

const directoryCache = new Map();   // users/<id> → { email, name } | null
/**
 * Who a Chat user is: { member, name, email }. A roster person is found by
 * their linked Chat id, else by the email (from the event, or the directory)
 * — and then linked, as a first DM links them. Nobody on the roster: member null.
 */
export async function resolvePerson(user) {
  const id = user?.name || null;
  if (!id || user.type === 'BOT') return { member: null, name: user?.displayName || id, email: null };
  const hit = d.userByGchatId(id);
  if (hit) return { member: hit, name: hit.displayName || hit.slug, email: hit.email };
  let email = user.email || null, name = user.displayName || null;
  if (!email) {
    if (!directoryCache.has(id)) {
      let u = null;
      try { u = await d.api.directoryUser(id); } catch (err) { d.log(`directory ${id}: ${err.message}`); }
      directoryCache.set(id, u);
    }
    const u = directoryCache.get(id);
    email = u?.email || null;
    name = name || u?.name || null;
  }
  const member = email ? d.memberByEmail(email) : null;
  if (member) {
    try { d.setGchat(member.email, { userId: id }, 'gchat'); } catch (err) { d.log(`could not link ${id} to ${member.slug}: ${err.message}`); }
    return { member: d.userByGchatId(id) || member, name: member.displayName || member.slug, email };
  }
  return { member: null, name: name || id, email };
}

// ─── admission ───────────────────────────────────────────────────────────────

async function spaceInfo(space) {
  try { return await d.api.getSpace(space); } catch (err) { d.log(`spaces.get ${space}: ${err.message}`); return null; }
}
const titleOf = (info, space) => info?.displayName || space;

/** The app was added to a space: an admin's yes when an admin added it, a request otherwise. */
export async function requestSpace(space, { inviter = null } = {}) {
  const chatId = groupIdOf(space);
  if (d.getGroup(chatId)) return { did: 'already-registered' };
  const info = await spaceInfo(space);
  if (info?.spaceType === 'DIRECT_MESSAGE') return { did: 'ignored', why: 'a DM' };
  const by = inviter ? (await resolvePerson(inviter)).member : null;
  if (by && by.role === 'admin') {
    const group = await approveSpace(chatId, { actor: by.email || by.slug, title: titleOf(info, space) });
    tellAdmins('Google Chat: joined a space', `${by.displayName || by.slug} added the assistant to ${group.title || titleOf(info, space)}; as an admin, that registered it — it joins in there from now on. Change its settings on the Google Chat page.`, { chatId });
    return { did: 'approved-by-admin', group };
  }
  if (pendingSpaces().some(p => p.chatId === chatId)) return { did: 'already-pending' };
  const entry = {
    chatId, space, title: titleOf(info, space), inviter: inviter?.name || null, inviterSlug: by?.slug || null,
    members: Number(info?.membershipCount?.joinedDirectHumanUserCount) || null, at: new Date(d.now()).toISOString(),
  };
  writePending([...pendingSpaces().filter(p => p.chatId !== chatId), entry]);
  tellAdmins('Google Chat: a space waits for your approval',
    `${by ? (by.displayName || by.slug) : 'Someone'} added the assistant to ${entry.title}. It stays silent there until an admin approves the space on the Google Chat page; if nobody does within a day, the request lapses.`,
    { chatId });
  return { did: 'pending', entry };
}

/** An admin said yes: register the space, subscribe to it, and check who is in it. */
export async function approveSpace(chatId, { actor = null, title = null, requireMention = null, language = null, beat = null, openAudience = null } = {}) {
  const space = spaceOf(chatId);
  const info = title ? null : await spaceInfo(space);
  const group = d.addGroup({ chatId, title: title ?? titleOf(info, space), requireMention, language, beat, openAudience, actor });
  dropPending(chatId);
  await ensureSubscription(chatId).catch((err) => d.log(`subscription for ${chatId}: ${err.message}`));
  await checkAudience(chatId, { quiet: true });
  return d.getGroup(chatId) || group;
}

/** An admin said no (or the request lapsed): forget the space. The app stays in it, silent. */
export async function rejectSpace(chatId, why = 'declined') {
  const wasPending = pendingSpaces().some(p => p.chatId === chatId);
  dropPending(chatId);
  const registered = !!d.getGroup(chatId);
  if (registered) d.removeGroup(chatId, 'gchat');
  forgetSubscription(chatId);
  if (wasPending || registered) {
    tellAdmins('Google Chat: a space was declined', `The assistant will stay silent in ${chatId} (${why}). ${REMOVE_HINT}`, { chatId });
  }
  return { ok: true };
}

// ─── the audience ────────────────────────────────────────────────────────────

/**
 * Is everyone in the space ours? Every person must be on this workspace's
 * roster (another app counts as someone else, as a bot does on Slack).
 * Otherwise the space is paused — unless it is open to outsiders — and the
 * admins hear who is in the way; when it is ours again it resumes.
 */
export async function checkAudience(chatId, { quiet = false } = {}) {
  const group = d.getGroup(chatId);
  if (!group || group.kind !== 'gchat') return null;
  const space = spaceOf(chatId);
  const self = d.self()?.appUser || null;
  let memberships = [];
  try { memberships = await d.api.listMembers(space); } catch (err) { d.log(`members ${space}: ${err.message}`); return null; }
  const outsiders = [];
  let count = 0;
  for (const mb of memberships) {
    if (mb.state && mb.state !== 'JOINED') continue;
    const u = mb.member || {};
    if (!u.name || u.name === self) continue;
    count += 1;
    if (u.type === 'BOT') { outsiders.push({ id: u.name, name: u.displayName || 'another app' }); continue; }
    const p = await resolvePerson(u);
    if (p.member) { try { d.recordGroupMember(chatId, u.name, p.name); } catch { /* best effort */ } continue; }
    outsiders.push({ id: u.name, name: p.name || u.name });
  }
  const audience = { ok: outsiders.length === 0, outsiders: outsiders.slice(0, 20), members: count, checkedAt: new Date(d.now()).toISOString() };
  const paused = !audience.ok && !group.openAudience;
  const wasPaused = !!group.paused;
  d.touchGroupMeta(chatId, { audience, paused });
  if (paused && !wasPaused && !quiet) {
    tellAdmins('Google Chat: a space is paused', `${group.title || chatId} has ${outsiders.length} ${outsiders.length === 1 ? 'member' : 'members'} not on the team. The assistant stays silent there until the space is the team's again.`, { chatId });
  }
  if (!paused && wasPaused && !quiet) {
    tellAdmins('Google Chat: a space resumed', `${group.title || chatId} is the team's again; the assistant answers there once more.`, { chatId });
  }
  return audience;
}

// ─── subscriptions ───────────────────────────────────────────────────────────

function forgetSubscription(chatId) {
  const m = subscriptions();
  if (m[chatId]) { delete m[chatId]; writeSubscriptions(m); }
}

/**
 * Make sure an approved space is subscribed: renew one that will lapse soon,
 * make a new one when it is gone. One we cannot see (made before, by another
 * run) is left to lapse and made again after a day.
 */
export async function ensureSubscription(chatId) {
  if (!d.getGroup(chatId)) return { did: 'not-registered' };
  const now = d.now();
  const m = subscriptions();
  const rec = m[chatId];
  if (rec?.name) {
    const left = (Date.parse(rec.expireTime || '') || 0) - now;
    if (left > RENEW_BEFORE_MS) return { did: 'fresh', ...rec };
    try {
      const r = await d.api.renewSubscription(rec.name);
      m[chatId] = { name: r.name, expireTime: r.expireTime, at: new Date(now).toISOString() };
      writeSubscriptions(m);
      return { did: 'renewed', ...m[chatId] };
    } catch (err) {
      if (err.status !== 404 && !/not.?found|expired|deleted/i.test(err.message)) throw err;
      d.log(`subscription for ${chatId} is gone (${err.message}); making a new one`);
    }
  } else if (rec?.exists && now - (Date.parse(rec.at || '') || 0) < RETRY_EXISTING_MS) {
    return { did: 'existing' };
  }
  const r = await d.api.createSpaceSubscription(spaceOf(chatId));
  m[chatId] = r.exists ? { exists: true, at: new Date(now).toISOString() } : { name: r.name, expireTime: r.expireTime, at: new Date(now).toISOString() };
  writeSubscriptions(m);
  return { did: r.exists ? 'existing' : 'created', ...m[chatId] };
}

/** A subscription's own news: expiring soon → renew; gone → make anew; suspended → the admins hear. */
export async function onSubscription(ev) {
  const m = subscriptions();
  const chatId = Object.keys(m).find(k => m[k]?.name && m[k].name === ev.subscription) || (ev.space?.name ? groupIdOf(ev.space.name) : null);
  if (!chatId || !d.getGroup(chatId)) return { did: 'ignored', why: 'not a registered space' };
  if (ev.what === 'expired') { forgetSubscription(chatId); return ensureSubscription(chatId); }
  if (ev.what === 'expirationReminder') {
    if (m[chatId]) { m[chatId].expireTime = new Date(d.now()).toISOString(); writeSubscriptions(m); }   // renew now
    return ensureSubscription(chatId);
  }
  if (ev.what === 'suspended') {
    tellAdmins('Google Chat: a space stopped reporting', `Google suspended the subscription that brings ${chatId}'s messages (usually a permission was withdrawn). The assistant hears only @mentions there until it is set up again.`, { chatId });
    forgetSubscription(chatId);
    return { did: 'suspended' };
  }
  return { did: 'ignored', why: ev.what };
}

// ─── sweeps ──────────────────────────────────────────────────────────────────

/** Requests nobody answered within a day: declined (the app stays, silent). */
export async function sweepPending() {
  const now = d.now();
  let n = 0;
  for (const p of pendingSpaces()) {
    if (now - Date.parse(p.at) < PENDING_TTL_MS) continue;
    await rejectSpace(p.chatId, 'not approved within a day');
    n += 1;
  }
  return n;
}

const AUDIENCE_SWEEP_MS = 60 * 60_000;
let lastAudienceSweep = 0;
export async function sweepAudience({ force = false } = {}) {
  const now = d.now();
  if (!force && now - lastAudienceSweep < AUDIENCE_SWEEP_MS) return 0;
  lastAudienceSweep = now;
  let n = 0;
  for (const g of d.listGroups()) {
    if (g.kind !== 'gchat') continue;
    try { await checkAudience(g.chatId); n += 1; } catch (err) { d.log(`audience sweep ${g.chatId}: ${err.message}`); }
  }
  return n;
}

/** Every approved space subscribed and fresh; a removed space no longer renewed. */
export async function sweepSubscriptions() {
  const registered = new Set(d.listGroups().filter(g => g.kind === 'gchat').map(g => g.chatId));
  const m = subscriptions();
  let dropped = false;
  for (const k of Object.keys(m)) if (!registered.has(k)) { delete m[k]; dropped = true; }
  if (dropped) writeSubscriptions(m);
  let n = 0;
  for (const chatId of registered) {
    try { const r = await ensureSubscription(chatId); if (r.did === 'renewed' || r.did === 'created') n += 1; }
    catch (err) { d.log(`subscription sweep ${chatId}: ${err.message}`); }
  }
  return n;
}

let sweeper = null;
export function startSweep() {
  if (sweeper) return;
  const run = () => { sweepPending().catch(() => {}); sweepAudience().catch(() => {}); sweepSubscriptions().catch(() => {}); };
  sweeper = setInterval(run, SWEEP_MS);
  sweeper.unref?.();
  setTimeout(run, 30_000).unref?.();   // once soon after boot: a subscription may have lapsed while down
}
export function stopSweep() { if (sweeper) clearInterval(sweeper); sweeper = null; }

// ─── events from the listener ────────────────────────────────────────────────

export async function onAdded(ev) {
  if (ev.space?.type === 'DIRECT_MESSAGE') return { did: 'ignored', why: 'a DM' };
  return requestSpace(ev.space.name, { inviter: ev.user || null });
}

export async function onRemoved(ev) {
  const chatId = groupIdOf(ev.space.name);
  dropPending(chatId);
  forgetSubscription(chatId);
  if (d.getGroup(chatId)) { d.removeGroup(chatId, 'gchat'); return { did: 'removed' }; }
  return { did: 'ignored', why: 'not registered' };
}

export async function onMembership(ev) {
  const chatId = groupIdOf(ev.space.name);
  if (!d.getGroup(chatId)) return { did: 'ignored', why: 'not registered' };
  return { did: 'audience', audience: await checkAudience(chatId) };
}

const IMAGE_RE = /^image\//;

/** A message in a space → the group watcher, in the shape a Slack channel message takes. */
export async function onSpaceMessage(ev) {
  const chatId = groupIdOf(ev.space.name);
  const group = d.getGroup(chatId);
  if (!group) {
    // In a space nobody approved or declined (it was added while this was
    // off): the first @mention there makes the request.
    if (ev.message?.mentionsApp && !pendingSpaces().some(p => p.chatId === chatId)) await requestSpace(ev.space.name, { inviter: null });
    return { did: 'ignored', why: 'not registered' };
  }
  if (group.paused) return { did: 'ignored', why: 'paused' };
  const p = await resolvePerson(ev.user);
  const m = ev.message;
  const messageId = shortId(m.name, 'messages');
  const thread = m.threadReply ? shortId(m.thread, 'threads') : null;
  const text = String(m.argumentText ?? m.text ?? '').trim();
  // Chat delivers an interaction event only for an @mention (or a DM); a
  // subscription's copy says so by its annotations.
  const mentioned = ev.format !== 'event' || !!m.mentionsApp;
  const files = m.attachments || [];
  const image = files.find(f => IMAGE_RE.test(String(f.contentType || '')) && f.resourceName);
  const doc = files.find(f => !IMAGE_RE.test(String(f.contentType || '')) && f.resourceName);
  const drive = files.filter(f => f.driveFileId).map(f => `${f.filename || 'a file'} (Drive file id ${f.driveFileId})`);
  const payload = {
    chat_id: chatId,
    chat_title: ev.space.displayName || group.title || null,
    message_id: messageId,
    thread_id: thread,
    text: drive.length ? `${text}\n[shared from Drive: ${drive.join('; ')}]`.trim() : text,
    from_id: String(ev.user.name),
    from_name: p.name || ev.user.name,
    from_username: '',
    is_mention: mentioned,
    is_reply_to_bot: false,   // a thread the app spoke in is known to the watcher by its thread id
    ...(image ? { photo_file_id: { file_id: image.resourceName, name: image.filename || '', mime: image.contentType || '' } } : {}),
    ...(doc ? { attachment: { kind: 'document', file_id: doc.resourceName, name: doc.filename || '', mime: doc.contentType || '', size: null } } : {}),
  };
  const r = d.route(payload);
  return { did: 'routed', payload, result: r };
}

/** Tests: forget the directory answers. */
export function __reset() { directoryCache.clear(); lastAudienceSweep = 0; }
