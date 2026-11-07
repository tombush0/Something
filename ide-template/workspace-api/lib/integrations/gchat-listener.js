/**
 * Google Chat, as a surface: one Pub/Sub pull loop held open from inside
 * workspace-api, and what each event it brings turns into. The counterpart of
 * slack-listener.js for the coworker's own Chat app.
 *
 * Why Pub/Sub: the Chat app is configured with a Cloud Pub/Sub connection, so
 * Chat publishes every interaction event to the app's topic and this process
 * pulls them — one outbound request at a time, no public address, nothing new
 * through Caddy, like Slack's Socket Mode.
 *
 * What an event becomes (the handlers plug in from the DM and space sides):
 *   a message in a DM with the app   → onDm
 *   an @mention of the app in a space → onSpaceMessage
 *   the app added to / removed from a space → onAdded / onRemoved
 * Chat delivers only DMs and @mentions to an app; a space's other messages
 * need a Workspace Events subscription and arrive here the same way.
 *
 * Every pulled batch is acknowledged before it is handled (a turn takes
 * minutes; an unacknowledged message would come back) and every event is seen
 * once (the Pub/Sub message id, and the Chat message name — a redelivery or a
 * re-publish is dropped). Unlike Slack's socket, nothing is lost while this
 * process is down: Pub/Sub keeps what was not pulled (7 days on the app's
 * subscription), so an outage is recorded as a delay, not a gap.
 *
 * Events arrive in one of two shapes, depending on how the Chat app is
 * configured: the classic interaction event ({ type, user, space, message })
 * or the Google Workspace add-on event ({ chat: { user, messagePayload, … } }),
 * which is what a newly created Chat app sends. `normalize` turns both into
 * one record.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as api from './gchat-api.js';
import * as store from './store.js';

const ID = api.ID;
const BACKOFF_MIN_MS = 2000, BACKOFF_MAX_MS = 60_000;
const EMPTY_PULL_PAUSE_MS = 500;
const SEEN_TTL_MS = 60 * 60_000;
const OUTAGES_KEPT = 5;
// Errors no retry fixes: the key, the subscription, or the account behind them.
const FATAL_RE = /bad_key|bad_subscription|invalid_grant|invalid_client|account not found|disabled/i;

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }
function statePath() { return join(projectDir(), '.team', 'gchat-listener-state.json'); }

// ─── state ───────────────────────────────────────────────────────────────────

const st = {
  running: false, generation: 0, connected: false, since: null, lastEventAt: null, lastPullAt: null,
  downSince: null, outages: [], counts: {}, app: null, subscription: null, error: null, abort: null,
};

/** For the Integrations page: is the loop up, since when, what it saw. */
export function status() {
  return {
    running: st.running, connected: st.connected, since: st.since, lastEventAt: st.lastEventAt, lastPullAt: st.lastPullAt,
    outages: st.outages.slice(-OUTAGES_KEPT), counts: { ...st.counts },
    app: st.app, subscription: st.subscription, error: st.error,
  };
}

let stateSavedAt = 0;
function saveState(force = false) {
  const now = Date.now();
  if (!force && now - stateSavedAt < 15_000) return;
  stateSavedAt = now;
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(statePath(), JSON.stringify({ lastEventAt: st.lastEventAt, outages: st.outages.slice(-OUTAGES_KEPT) }), { mode: 0o660 });
  } catch { /* best effort */ }
}
function loadState() {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (s?.lastEventAt) st.lastEventAt = s.lastEventAt;
    if (Array.isArray(s?.outages)) st.outages = s.outages.slice(-OUTAGES_KEPT);
  } catch { /* first run */ }
}

// ─── events ──────────────────────────────────────────────────────────────────

function userOf(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    name: u.name || null,                  // "users/<id>"
    email: u.email ? String(u.email).toLowerCase() : null,
    displayName: u.displayName || null,
    type: u.type || null,                  // HUMAN | BOT
    domainId: u.domainId || null,          // the person's Workspace organisation
  };
}

function spaceOf(s) {
  if (!s || typeof s !== 'object') return null;
  const type = s.spaceType || (s.type === 'DM' ? 'DIRECT_MESSAGE' : s.type === 'ROOM' ? 'SPACE' : s.type) || null;
  return { name: s.name || null, type, displayName: s.displayName || null, singleUserBotDm: Boolean(s.singleUserBotDm) };
}

function messageOf(m) {
  if (!m || typeof m !== 'object') return null;
  const annotations = Array.isArray(m.annotations) ? m.annotations : [];
  return {
    name: m.name || null,                  // "spaces/<s>/messages/<m>"
    text: m.text || '',
    argumentText: m.argumentText ?? null,  // the text without the app's @mention
    thread: m.thread?.name || null,
    threadReply: Boolean(m.threadReply),
    createTime: m.createTime || null,
    mentionsApp: annotations.some(a => a?.type === 'USER_MENTION' && a.userMention?.user?.type === 'BOT'),
    attachments: (Array.isArray(m.attachment) ? m.attachment : []).map(a => ({
      name: a.name || null,
      filename: a.contentName || null,
      contentType: a.contentType || null,
      source: a.source || null,            // UPLOADED_CONTENT | DRIVE_FILE
      resourceName: a.attachmentDataRef?.resourceName || null,
      driveFileId: a.driveDataRef?.driveFileId || null,
    })),
  };
}

/**
 * One event, in either shape, as { kind, eventTime, space, user, message }:
 * kind is 'message' | 'added' | 'removed' | 'other'.
 */
export function normalize(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.chat && typeof ev.chat === 'object') {
    const c = ev.chat;
    const p = c.messagePayload || c.addedToSpacePayload || c.removedFromSpacePayload || null;
    const kind = c.messagePayload ? 'message' : c.addedToSpacePayload ? 'added' : c.removedFromSpacePayload ? 'removed' : 'other';
    return { kind, eventTime: c.eventTime || null, user: userOf(c.user), space: spaceOf(p?.space), message: messageOf(p?.message), format: 'add-on' };
  }
  const kind = ev.type === 'MESSAGE' ? 'message' : ev.type === 'ADDED_TO_SPACE' ? 'added' : ev.type === 'REMOVED_FROM_SPACE' ? 'removed' : 'other';
  return { kind, eventTime: ev.eventTime || null, user: userOf(ev.user), space: spaceOf(ev.space), message: messageOf(ev.message), format: 'classic' };
}

const seen = new Map();
function dedupe(key, now = Date.now()) {
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  if (!key) return true;
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

/**
 * Build the handler with its dependencies (the handlers set by the DM and
 * space sides by default; tests pass fakes). It takes one normalized event and
 * returns what it did, as `{ did, ... }`, for the log and the tests.
 */
export function createHandler(deps = {}) {
  const d = { onDm: null, onSpaceMessage: null, onAdded: null, onRemoved: null, log: (s) => process.stderr.write(`[gchat] ${s}\n`), ...deps };
  return async function handle(ev) {
    if (!ev || !ev.space?.name) return { did: 'ignored', why: 'no space' };
    if (ev.kind === 'added') return d.onAdded ? (await d.onAdded(ev)) || { did: 'added' } : { did: 'unhandled', kind: ev.kind };
    if (ev.kind === 'removed') return d.onRemoved ? (await d.onRemoved(ev)) || { did: 'removed' } : { did: 'unhandled', kind: ev.kind };
    if (ev.kind !== 'message') return { did: 'ignored', why: `kind ${ev.kind}` };
    if (!ev.user?.name) return { did: 'ignored', why: 'no sender' };
    if (ev.user.type === 'BOT') return { did: 'ignored', why: 'bot' };   // loop prevention, as on Slack
    if (!ev.message?.name) return { did: 'ignored', why: 'no message' };
    const dm = ev.space.type === 'DIRECT_MESSAGE';
    const fn = dm ? d.onDm : d.onSpaceMessage;
    if (!fn) return { did: 'unhandled', kind: dm ? 'dm' : 'space' };
    return (await fn(ev)) || { did: dm ? 'dm' : 'space' };
  };
}

let handler = null;
let handlerDeps = {};
/** The DM and space sides plug in here; until they do, events are logged and dropped. */
export function setHandlers(h = {}) {
  handlerDeps = { ...handlerDeps, ...h };
  handler = createHandler(handlerDeps);
}

/**
 * One pulled message → dedupe → handler. Exported so the tests can drive it
 * without a network. Never throws.
 */
export async function dispatch(pulled, { handle = null, now = Date.now() } = {}) {
  const ev = normalize(pulled?.event);
  if (!ev) return { did: 'ignored', why: 'not an event' };
  const key = ev.kind === 'message' && ev.message?.name ? `m:${ev.message.name}` : `${ev.kind}:${ev.space?.name}:${ev.eventTime}`;
  if (!dedupe(pulled?.messageId ? `p:${pulled.messageId}` : null, now) || !dedupe(key, now)) return { did: 'duplicate' };
  st.counts[ev.kind] = (st.counts[ev.kind] || 0) + 1;
  st.lastEventAt = new Date(now).toISOString();
  saveState();
  try {
    const r = await (handle || handler || (handler = createHandler(handlerDeps)))(ev);
    if (r?.did === 'unhandled') process.stderr.write(`[gchat] ${r.kind} event from ${ev.user?.email || ev.user?.name || '?'} in ${ev.space?.name}: no handler yet\n`);
    return r;
  } catch (err) {
    process.stderr.write(`[gchat] event failed: ${err.message}\n`);
    return { did: 'failed', error: err.message };
  }
}

// ─── the pull loop ───────────────────────────────────────────────────────────

function markDown(why) {
  if (st.connected) { st.downSince = new Date().toISOString(); st.outages.push({ from: st.downSince, why: String(why).slice(0, 200) }); saveState(true); }
  st.connected = false;
}
function markUp() {
  if (!st.connected) {
    st.connected = true;
    st.since = new Date().toISOString();
    const last = st.outages[st.outages.length - 1];
    if (last && !last.to) { last.to = st.since; saveState(true); }
  }
  st.error = null;
}

/** One pull, its acknowledgement, then the events (not awaited: a turn must not stall the stream). */
export async function pullOnce(deps = {}, generation = st.generation) {
  const a = deps.api || api;
  st.abort = new AbortController();
  const batch = await a.pull({ max: 10, signal: st.abort.signal });
  st.lastPullAt = new Date().toISOString();
  if (generation !== st.generation) return 0;
  markUp();
  if (!batch.length) return 0;
  await a.acknowledge(batch.map(m => m.ackId));
  for (const m of batch) dispatch(m, deps).catch(() => {});
  return batch.length;
}

async function runLoop(generation) {
  let backoff = BACKOFF_MIN_MS;
  while (st.running && generation === st.generation) {
    try {
      const n = await pullOnce({}, generation);
      backoff = BACKOFF_MIN_MS;
      if (!n) await new Promise(r => setTimeout(r, EMPTY_PULL_PAUSE_MS));
    } catch (err) {
      if (!st.running || generation !== st.generation) break;
      st.error = String(err?.message || err).replace(/[A-Za-z0-9_-]{40,}/g, '…');
      markDown(st.error);
      process.stderr.write(`[gchat] pull failed: ${st.error}\n`);
      if (FATAL_RE.test(`${err?.status || ''} ${err?.code || ''} ${st.error}`)) { st.running = false; break; }
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }
}

export function start() {
  if (st.running) return false;
  loadState();
  try {
    const s = api.settings();
    st.app = s.key.client_email; st.subscription = s.subscription;
  } catch (err) {
    st.error = String(err.message || err);
    return false;
  }
  st.running = true; st.error = null;
  const generation = ++st.generation;
  runLoop(generation).catch((err) => { st.error = String(err?.message || err); st.running = false; });
  return true;
}

export function stop(why = 'stopped') {
  st.running = false;
  st.generation++;
  try { st.abort?.abort(); } catch { /* already */ }
  if (st.connected) markDown(why);
}

/** Match the loop to the store: up when the app is connected and not paused, down otherwise. */
export function reconcile() {
  let usable = false;
  try { usable = store.isUsable(ID); } catch { usable = false; }
  if (usable && !st.running) start();
  else if (!usable && st.running) stop('disconnected');
  return st.running;
}

/** Tests: forget everything this process saw. */
export function __reset() {
  stop('reset');
  seen.clear();
  Object.assign(st, { connected: false, since: null, lastEventAt: null, lastPullAt: null, downSince: null, outages: [], counts: {}, app: null, subscription: null, error: null });
  handler = null; handlerDeps = {};
}
