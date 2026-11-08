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
 * come from a Workspace Events subscription on the space (gchat-spaces.js),
 * published to the same topic as CloudEvents:
 *   a message in a subscribed space   → onSpaceMessage (the @mention of the
 *                                       same message, sent both ways, is seen once)
 *   someone joined or left it          → onMembership (the audience check)
 *   a subscription expiring or gone    → onSubscription (renew or make anew)
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
import { __setGchatStatus } from './channel-adapter.js';

const ID = api.ID;
const BACKOFF_MIN_MS = 2000, BACKOFF_MAX_MS = 60_000;
const EMPTY_PULL_PAUSE_MS = 500;
// A held pull is cut after this and counts as empty: a connection the proxy
// or network dropped silently must not stall the loop for good.
const PULL_TIMEOUT_MS = 90_000;
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
  appUser: null,   // the app's own users/<id>, learned from the first @mention of it
};

/** For the Integrations page: is the loop up, since when, what it saw. */
export function status() {
  return {
    running: st.running, connected: st.connected, since: st.since, lastEventAt: st.lastEventAt, lastPullAt: st.lastPullAt,
    outages: st.outages.slice(-OUTAGES_KEPT), counts: { ...st.counts },
    app: st.app, subscription: st.subscription, error: st.error, appUser: st.appUser,
  };
}
__setGchatStatus(status);   // the channel adapter learns the app's own id and whether it is connected

let stateSavedAt = 0;
function saveState(force = false) {
  const now = Date.now();
  if (!force && now - stateSavedAt < 15_000) return;
  stateSavedAt = now;
  try {
    mkdirSync(join(projectDir(), '.team'), { recursive: true, mode: 0o770 });
    writeFileSync(statePath(), JSON.stringify({ lastEventAt: st.lastEventAt, outages: st.outages.slice(-OUTAGES_KEPT), appUser: st.appUser }), { mode: 0o660 });
  } catch { /* best effort */ }
}
function loadState() {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (s?.lastEventAt) st.lastEventAt = s.lastEventAt;
    if (Array.isArray(s?.outages)) st.outages = s.outages.slice(-OUTAGES_KEPT);
    if (typeof s?.appUser === 'string' && /^users\/[\w-]+$/.test(s.appUser)) st.appUser = s.appUser;
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

const botMention = (a) => a?.type === 'USER_MENTION' && a.userMention?.user?.type === 'BOT';

function messageOf(m, appUser = st.appUser) {
  if (!m || typeof m !== 'object') return null;
  const annotations = Array.isArray(m.annotations) ? m.annotations : [];
  return {
    name: m.name || null,                  // "spaces/<s>/messages/<m>"
    text: m.text || '',
    argumentText: m.argumentText ?? null,  // the text without the app's @mention
    thread: m.thread?.name || null,
    threadReply: Boolean(m.threadReply),
    createTime: m.createTime || null,
    // Mentions THIS app: by its id once known; until then any app mention counts.
    mentionsApp: annotations.some(a => botMention(a) && (!appUser || a.userMention.user.name === appUser)),
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

const subjectSpace = (s) => (/^\/\/chat\.googleapis\.com\/(spaces\/[A-Za-z0-9_-]+)/.exec(String(s || '')) || [])[1] || null;

/**
 * A Workspace Events CloudEvent (a space subscription's delivery) as one or
 * more records: a message (in a batch, several), a membership change, or a
 * subscription's own lifecycle. `attrs` are the Pub/Sub attributes (ce-*).
 */
function normalizeCloudEvent(data, attrs) {
  const type = String(attrs['ce-type'] || '');
  const time = attrs['ce-time'] || null;
  const fromSubject = subjectSpace(attrs['ce-subject']);
  if (/^google\.workspace\.chat\.message\.v1\.(batchC|c)reated$/.test(type)) {
    const list = Array.isArray(data?.messages) ? data.messages.map(x => x?.message || x) : [data?.message];
    return list.filter(Boolean).map((m) => ({
      kind: 'message', eventTime: m.createTime || time, format: 'event',
      user: userOf(m.sender),
      space: spaceOf({ ...(m.space || {}), name: m.space?.name || fromSubject || String(m.name || '').split('/messages/')[0] || null }),
      message: messageOf(m),
    }));
  }
  if (/^google\.workspace\.chat\.membership\.v1\.(batch)?(created|deleted)$/i.test(type)) {
    const created = /created$/i.test(type);
    const list = Array.isArray(data?.memberships) ? data.memberships.map(x => x?.membership || x) : [data?.membership];
    return list.filter(Boolean).map((mb) => ({
      kind: 'membership', eventTime: time, format: 'event', change: created ? 'joined' : 'left',
      user: userOf(mb.member), space: spaceOf({ name: String(mb.name || '').split('/members/')[0] || fromSubject }), message: null,
    }));
  }
  if (/^google\.workspace\.events\.subscription\.v1\./.test(type)) {
    const sub = data?.subscription || {};
    const name = sub.name || (/subscriptions\/[\w-]+$/.exec(String(attrs['ce-source'] || '')) || [])[0] || null;
    return [{
      kind: 'subscription', eventTime: time, format: 'event', what: type.split('.').pop(),   // expirationReminder | expired | suspended
      subscription: name, user: null, message: null,
      space: spaceOf({ name: subjectSpace(sub.targetResource) || fromSubject }),
    }];
  }
  return [{ kind: 'other', eventTime: time, format: 'event', user: null, space: spaceOf({ name: fromSubject }), message: null, ceType: type }];
}

/**
 * One event, in any shape Chat sends, as { kind, eventTime, space, user, message }:
 * kind is 'message' | 'added' | 'removed' | 'membership' | 'subscription' | 'other'.
 * A Workspace Events delivery (its `ce-type` attribute) may hold several; the
 * first is returned here and `normalizeAll` gives them all.
 */
export function normalize(ev, attrs = {}) {
  return normalizeAll(ev, attrs)[0] || null;
}

export function normalizeAll(ev, attrs = {}) {
  if (!ev || typeof ev !== 'object') return [];
  if (attrs && attrs['ce-type']) return normalizeCloudEvent(ev, attrs);
  return [normalizeInteraction(ev)].filter(Boolean);
}

function normalizeInteraction(ev) {
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
  const d = { onDm: null, onSpaceMessage: null, onAdded: null, onRemoved: null, onMembership: null, onSubscription: null, log: (s) => process.stderr.write(`[gchat] ${s}\n`), ...deps };
  return async function handle(ev) {
    if (ev?.kind === 'subscription') return d.onSubscription ? (await d.onSubscription(ev)) || { did: 'subscription' } : { did: 'unhandled', kind: ev.kind };
    if (!ev || !ev.space?.name) return { did: 'ignored', why: 'no space' };
    if (ev.kind === 'membership') return d.onMembership ? (await d.onMembership(ev)) || { did: 'membership' } : { did: 'unhandled', kind: ev.kind };
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
  const all = normalizeAll(pulled?.event, pulled?.attributes || {});
  if (!all.length) return { did: 'ignored', why: 'not an event' };
  if (!dedupe(pulled?.messageId ? `p:${pulled.messageId}` : null, now)) return { did: 'duplicate' };
  if (all.length === 1) { learnAppUser(all[0], pulled?.event); return dispatchOne(all[0], { handle, now }); }
  const results = [];
  for (const ev of all) results.push(await dispatchOne(ev, { handle, now }));
  return { did: 'batch', results };
}

/** Learn the app's own Chat user from an @mention Chat delivered to it (the only mention that is surely of this app). */
function learnAppUser(ev, raw) {
  if (st.appUser || (ev.format !== 'add-on' && ev.format !== 'classic') || !raw) return;
  const ann = (raw.chat?.messagePayload?.message || raw.message || {}).annotations || [];
  const mentions = ann.filter(botMention).map(a => a.userMention.user.name).filter(Boolean);
  if (ev.space?.type !== 'DIRECT_MESSAGE' && new Set(mentions).size === 1) { st.appUser = mentions[0]; saveState(true); }
}

async function dispatchOne(ev, { handle = null, now = Date.now(), raw = null } = {}) {
  const key = ev.kind === 'message' && ev.message?.name ? `m:${ev.message.name}`
    : ev.kind === 'subscription' ? `s:${ev.subscription}:${ev.what}:${ev.eventTime}`
    : `${ev.kind}:${ev.space?.name}:${ev.user?.name || ''}:${ev.eventTime}`;
  if (!dedupe(key, now)) return { did: 'duplicate' };
  st.counts[ev.kind] = (st.counts[ev.kind] || 0) + 1;
  st.lastEventAt = new Date(now).toISOString();
  saveState();
  try {
    const r = await (handle || handler || (handler = createHandler(handlerDeps)))(ev);
    if (r?.did === 'unhandled') process.stderr.write(`[gchat] ${r.kind} event${ev.user ? ` from ${ev.user.email || ev.user.name}` : ''} in ${ev.space?.name || '?'}: no handler\n`);
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
export async function pullOnce(deps = {}, generation = st.generation, { immediate = false, timeoutMs = PULL_TIMEOUT_MS } = {}) {
  const a = deps.api || api;
  const abort = st.abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
  let batch;
  try { batch = await a.pull({ max: 10, signal: abort.signal, immediate }); }
  catch (err) { if (!timedOut) throw err; batch = []; }
  finally { clearTimeout(timer); }
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
  let first = true;
  while (st.running && generation === st.generation) {
    try {
      const n = await pullOnce({}, generation, { immediate: first });
      first = false;
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
  Object.assign(st, { connected: false, since: null, lastEventAt: null, lastPullAt: null, downSince: null, outages: [], counts: {}, app: null, subscription: null, error: null, appUser: null });
  handler = null; handlerDeps = {};
}
