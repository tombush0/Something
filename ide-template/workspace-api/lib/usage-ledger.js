/**
 * usage-ledger — what the plan's tokens were spent on, for the admin's Usage page.
 *
 * Three kinds of record, one JSON line each, in a file per month under
 * WSAPI_STORE_DIR/usage/:
 *
 *   turn   one turn workspace-api ran (web, a room, a DM, a routine, a job):
 *          who, where, what kind, its tokens and API-price equivalent, and its
 *          steps (one per model call, with the tools it called and how big
 *          their results were). Taken from the CLI's own stream (usage-tap.js),
 *          so it is exact.
 *   call   one model call from a process workspace-api does not stream — the
 *          tmux brain, background jobs — reported by the CLI's OpenTelemetry
 *          export (usage-otlp.js). `tool` is a tool call from the same.
 *   limit  a plan-limit event: which window, its status, when it resets.
 *
 * Never any message text: names, sizes, counts and times only.
 *
 * Kept 90 days in full; an older month is folded into daily totals
 * (daily.jsonl) and its file removed.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_DAYS = 90;
const dir = () => join(process.env.WSAPI_STORE_DIR || '/var/wsapi-store', 'usage');
const monthFile = (d) => join(dir(), `usage-${d.toISOString().slice(0, 7)}.jsonl`);

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const clip = (s, n = 120) => (s == null ? undefined : String(s).slice(0, n));

/** Tokens in the ledger's own shape, from any of the shapes the CLI uses. */
export function normTokens(u = {}) {
  return {
    in:  num(u.input_tokens ?? u.inputTokens ?? u.in),
    out: num(u.output_tokens ?? u.outputTokens ?? u.out),
    cr:  num(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? u.cache_read_tokens ?? u.cr),
    cw:  num(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? u.cache_creation_tokens ?? u.cw),
  };
}

let listeners = [];
/** Called with every record written (alerts). */
export function onRecord(fn) { listeners.push(fn); return () => { listeners = listeners.filter(f => f !== fn); }; }

let cache = null;        // { key, records }
function write(rec) {
  try {
    mkdirSync(dir(), { recursive: true, mode: 0o770 });
    appendFileSync(monthFile(new Date(rec.at)), JSON.stringify(rec) + '\n', { mode: 0o660 });
  } catch (err) {
    process.stderr.write(`[usage] could not record: ${err.message}\n`);
    return;
  }
  if (cache) cache.records.push(rec);
  for (const fn of listeners) { try { fn(rec); } catch { /* an alert's bug is not the turn's */ } }
}

export function recordTurn(t) {
  const tok = normTokens(t.usage);
  write({
    type: 'turn',
    id: clip(t.id, 64),
    at: t.at || new Date().toISOString(),
    actor: clip(t.actor, 64) || 'unknown',
    channel: clip(t.channel, 32) || 'web',
    kind: clip(t.kind, 32) || 'chat',
    label: clip(t.label),
    session: clip(t.session, 80),
    model: clip(t.model, 80),
    ...tok,
    cost: num(t.cost),
    ms: num(t.ms),
    calls: num(t.calls),
    error: t.error ? true : undefined,
    models: t.models,       // { model: { in, out, cr, cw, cost } }
    steps: Array.isArray(t.steps) ? t.steps.slice(0, 200) : undefined,
  });
}

export function recordCall(c) {
  write({
    type: 'call',
    at: c.at || new Date().toISOString(),
    actor: clip(c.actor, 64) || 'system',
    channel: clip(c.channel, 32) || 'system',
    kind: clip(c.kind, 32) || 'job',
    label: clip(c.label),
    session: clip(c.session, 80),
    model: clip(c.model, 80),
    ...normTokens(c),
    cost: num(c.cost),
    ms: num(c.ms),
  });
}

export function recordTool(x) {
  write({
    type: 'tool',
    at: x.at || new Date().toISOString(),
    actor: clip(x.actor, 64) || 'system',
    channel: clip(x.channel, 32) || 'system',
    kind: clip(x.kind, 32) || 'job',
    label: clip(x.label),
    session: clip(x.session, 80),
    tool: clip(x.tool, 120),
    bytes: num(x.bytes),
    inBytes: num(x.inBytes),
    ms: num(x.ms),
    ok: x.ok === false ? false : undefined,
  });
}

let lastLimit = {};      // rateLimitType → latest event
export function recordLimit(info = {}) {
  const type = clip(info.rateLimitType || info.type, 32) || 'limit';
  const rec = {
    type: 'limit',
    at: new Date().toISOString(),
    window: type,
    status: clip(info.status, 32),
    resetsAt: info.resetsAt ? (typeof info.resetsAt === 'number' ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString() : clip(info.resetsAt, 40)) : undefined,
    utilization: Number.isFinite(Number(info.utilization)) ? Number(info.utilization) : undefined,
  };
  // The CLI repeats the same status on every turn: keep a change, not a stream.
  const prev = lastLimit[type];
  lastLimit[type] = rec;
  if (prev && prev.status === rec.status && prev.resetsAt === rec.resetsAt && prev.utilization === rec.utilization) return;
  write(rec);
}

// ─── Reading ───────────────────────────────────────────────────────────────

function files() {
  try { return readdirSync(dir()).filter(f => /^usage-\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
}

/** Every record of the last KEEP_DAYS, cached until a file changes. */
export function allRecords() {
  const fs = files();
  const key = fs.map(f => { try { const s = statSync(join(dir(), f)); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return f; } }).join('|');
  if (cache && cache.key === key) return cache.records;
  const records = [];
  for (const f of fs) {
    let text = '';
    try { text = readFileSync(join(dir(), f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { /* a torn last line */ }
    }
  }
  for (const r of records) if (r.type === 'limit') lastLimit[r.window] = r;
  cache = { key, records };
  return records;
}

export function findTurn(id) {
  return allRecords().find(r => r.type === 'turn' && r.id === id) || null;
}

/** Fold months older than KEEP_DAYS into daily totals and remove them. */
export function prune(now = new Date()) {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400_000).toISOString().slice(0, 7);
  for (const f of files()) {
    const month = f.slice(6, 13);
    if (month >= cutoff) continue;
    const days = {};
    try {
      for (const line of readFileSync(join(dir(), f), 'utf8').split('\n')) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (r.type !== 'turn' && r.type !== 'call') continue;
        const d = days[r.at.slice(0, 10)] ||= { day: r.at.slice(0, 10), in: 0, out: 0, cr: 0, cw: 0, cost: 0, turns: 0 };
        d.in += r.in || 0; d.out += r.out || 0; d.cr += r.cr || 0; d.cw += r.cw || 0; d.cost += r.cost || 0;
        if (r.type === 'turn') d.turns += 1;
      }
      appendFileSync(join(dir(), 'daily.jsonl'), Object.values(days).map(d => JSON.stringify(d)).join('\n') + (Object.keys(days).length ? '\n' : ''), { mode: 0o660 });
      unlinkSync(join(dir(), f));
    } catch (err) {
      process.stderr.write(`[usage] could not fold ${f}: ${err.message}\n`);
    }
  }
  cache = null;
}

// ─── Summary ───────────────────────────────────────────────────────────────

const RANGES = { '1d': 1, '7d': 7, '30d': 30, '90d': 90 };
const H = 3600_000;

function add(acc, r) {
  acc.in += r.in || 0; acc.out += r.out || 0; acc.cr += r.cr || 0; acc.cw += r.cw || 0;
  acc.cost += r.cost || 0;
  if (r.type === 'turn') acc.turns += 1;
  if (r.type === 'call') acc.calls += 1;
  return acc;
}
const zero = () => ({ in: 0, out: 0, cr: 0, cw: 0, cost: 0, turns: 0, calls: 0 });
const tokens = (a) => a.in + a.out + a.cr + a.cw;

function group(records, keyOf) {
  const m = new Map();
  for (const r of records) {
    const k = keyOf(r);
    if (k == null) continue;
    add(m.get(k) || m.set(k, zero()).get(k), r);
  }
  return [...m.entries()].map(([key, v]) => ({ key, ...v, tokens: tokens(v) })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
}

/** The tools whose results filled the most input: turn steps and OTel tool events together. */
function toolTable(records) {
  const m = new Map();
  const put = (tool, bytes, ms, ok) => {
    if (!tool) return;
    const e = m.get(tool) || m.set(tool, { key: tool, count: 0, bytes: 0, ms: 0, errors: 0 }).get(tool);
    e.count += 1; e.bytes += bytes || 0; e.ms += ms || 0; if (ok === false) e.errors += 1;
  };
  for (const r of records) {
    if (r.type === 'tool') put(r.tool, r.bytes, r.ms, r.ok);
    if (r.type === 'turn') for (const s of r.steps || []) for (const t of s.tools || []) put(t.name, t.bytes, 0, t.ok);
  }
  // A result's size in tokens, roughly: ~4 bytes a token.
  return [...m.values()].map(e => ({ ...e, estTokens: Math.round(e.bytes / 4) })).sort((a, b) => b.bytes - a.bytes);
}

/** Model-call spend inside the trailing window ending at `now`. */
function windowSum(records, ms, now) {
  const from = new Date(now - ms).toISOString();
  const acc = zero();
  for (const r of records) if ((r.type === 'turn' || r.type === 'call') && r.at >= from) add(acc, r);
  return { ...acc, tokens: tokens(acc) };
}

/**
 * When the plan last said no, how much had the window spent by then? Its
 * median is the best guess at where the limit sits, since Anthropic does not
 * publish it in tokens. Null until a limit has been hit at least once.
 */
function limitLevel(records, windowType, ms) {
  const hits = records.filter(r => r.type === 'limit' && r.window === windowType && r.status === 'rejected');
  if (!hits.length) return null;
  const spends = hits.map(h => windowSum(records, ms, Date.parse(h.at)).cost).filter(c => c > 0).sort((a, b) => a - b);
  return spends.length ? spends[Math.floor(spends.length / 2)] : null;
}

const WINDOWS = [
  { type: 'five_hour', label: '5-hour window', ms: 5 * H },
  { type: 'seven_day', label: 'Weekly window', ms: 7 * 24 * H },
];

export function planStatus(records = allRecords(), now = Date.now()) {
  const lastHour = windowSum(records, H, now);
  return WINDOWS.map(w => {
    const spent = windowSum(records, w.ms, now);
    const level = limitLevel(records, w.type, w.ms);
    const last = records.filter(r => r.type === 'limit' && r.window === w.type).at(-1) || null;
    let projectedAt = null;
    if (level && lastHour.cost > 0 && spent.cost < level) {
      projectedAt = new Date(now + ((level - spent.cost) / lastHour.cost) * H).toISOString();
    }
    return {
      window: w.type, label: w.label, spent,
      status: last?.status || null, resetsAt: last?.resetsAt || null, utilization: last?.utilization ?? null,
      estimatedLimitCost: level, projectedAt,
    };
  });
}

export function summary(range = '7d', now = Date.now()) {
  const days = RANGES[range] || 7;
  // Buckets: the last 24 whole hours for a day, else the last N calendar days
  // (UTC) with today as the last — so "7 days" is seven bars, not a partial
  // eighth at the start. The range starts where the first bucket does.
  const hourly = days === 1;
  const step = hourly ? H : 86400_000;
  const count = hourly ? 24 : days;
  const last = hourly ? Math.floor(now / H) * H : Math.floor(now / 86400_000) * 86400_000;
  const start = last - (count - 1) * step;
  const from = new Date(start).toISOString();
  const all = allRecords();
  const inRange = all.filter(r => r.at >= from);
  const spend = inRange.filter(r => r.type === 'turn' || r.type === 'call');

  const bucketOf = (at) => hourly ? `${at.slice(0, 13)}:00` : at.slice(0, 10);
  const series = new Map();
  for (let i = 0; i < count; i++) { const b = bucketOf(new Date(start + i * step).toISOString()); series.set(b, { bucket: b }); }
  for (const r of spend) {
    const b = series.get(bucketOf(r.at));
    if (!b) continue;   // stamped in the future (a skewed clock): not on the chart
    const ch = r.channel || 'other';
    b[ch] = (b[ch] || 0) + tokens(r);
    b.cost = (b.cost || 0) + (r.cost || 0);
    b.tokens = (b.tokens || 0) + tokens(r);
  }

  const total = spend.reduce((a, r) => add(a, r), zero());
  const topTurns = inRange.filter(r => r.type === 'turn')
    .sort((a, b) => (b.cost || 0) - (a.cost || 0) || tokens(b) - tokens(a))
    .slice(0, 20)
    .map(({ steps, models, ...t }) => ({ ...t, tokens: tokens(t), steps: (steps || []).length }));

  return {
    range, from, now: new Date(now).toISOString(), hourly,
    total: { ...total, tokens: tokens(total), cacheHit: total.in + total.cr ? total.cr / (total.in + total.cr) : 0 },
    plan: planStatus(all, now),
    series: [...series.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    channels: [...new Set(spend.map(r => r.channel || 'other'))],
    byActor: group(spend, r => r.actor || 'unknown'),
    byChannel: group(spend, r => r.channel || 'other'),
    byKind: group(spend, r => (r.label ? `${r.kind}: ${r.label}` : r.kind) || 'other'),
    byModel: modelTable(spend),
    tools: toolTable(inRange).slice(0, 30),
    topTurns,
    limits: inRange.filter(r => r.type === 'limit').slice(-50),
    // How far back the ledger goes, so the page can say "since …" honestly.
    firstAt: all[0]?.at || null,
  };
}

/** A turn that ran several models (a subagent on Haiku) splits by model. */
function modelTable(records) {
  const m = new Map();
  for (const r of records) {
    const parts = r.models && Object.keys(r.models).length ? Object.entries(r.models) : [[r.model || 'unknown', r]];
    for (const [model, v] of parts) {
      const e = m.get(model) || m.set(model, zero()).get(model);
      e.in += v.in || 0; e.out += v.out || 0; e.cr += v.cr || 0; e.cw += v.cw || 0; e.cost += v.cost || 0;
      if (r.type === 'turn') e.turns += 1;
      if (r.type === 'call') e.calls += 1;
    }
  }
  return [...m.entries()].map(([key, v]) => ({ key, ...v, tokens: tokens(v) })).sort((a, b) => b.cost - a.cost);
}

// ─── Alert settings ────────────────────────────────────────────────────────

const ALERT_DEFAULTS = { enabled: true, projectionMinutes: 60, turnCost: 2, routineFactor: 3 };
const alertsFile = () => join(dir(), 'alerts.json');

export function alertSettings() {
  try { return { ...ALERT_DEFAULTS, ...JSON.parse(readFileSync(alertsFile(), 'utf8')) }; } catch { return { ...ALERT_DEFAULTS }; }
}

export function setAlertSettings(patch = {}) {
  const cur = alertSettings();
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
    projectionMinutes: clampNum(patch.projectionMinutes, cur.projectionMinutes, 5, 24 * 60),
    turnCost: clampNum(patch.turnCost, cur.turnCost, 0.05, 1000),
    routineFactor: clampNum(patch.routineFactor, cur.routineFactor, 1.5, 50),
  };
  mkdirSync(dir(), { recursive: true, mode: 0o770 });
  writeFileSync(alertsFile(), JSON.stringify(next, null, 2), { mode: 0o660 });
  return next;
}

function clampNum(v, dflt, min, max) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
}

/** Test hook: forget the in-memory cache and limit state. */
export function _reset() { cache = null; lastLimit = {}; listeners = []; }
export const _dir = dir;
