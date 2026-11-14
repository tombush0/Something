/**
 * usage-alerts — tell the admins when the plan is being spent faster than it
 * should be, before the limit says no.
 *
 * Three alerts, each said once and then quiet for a while:
 *   - projection: at the last hour's pace a plan window runs out within
 *     `projectionMinutes` (only once the ledger has seen that window's limit
 *     hit, which is what tells it where the limit sits);
 *   - big turn: one turn cost more than `turnCost` (API-price equivalent, USD);
 *   - routine jump: a routine's run cost `routineFactor` times its usual (the
 *     median of its last runs, at least five of them).
 *
 * Delivered on Telegram where the admin has it linked, else as a web
 * notification. Settings live in the ledger (alerts.json), edited on the page.
 */
import { alertSettings, allRecords, onRecord, planStatus } from './usage-ledger.js';
import { list as teamList } from './team.js';
import { deliver } from './integrations/deliver.js';
import { publish as publishNotification } from './notify.js';

const QUIET = { projection: 2 * 3600_000, turn: 10 * 60_000, routine: 30 * 60_000 };
const lastSaid = new Map();       // key → ms

function quiet(key, ms, now) {
  const at = lastSaid.get(key);
  if (at && now - at < ms) return true;
  lastSaid.set(key, now);
  return false;
}

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const who = (r) => [r.actor && r.actor !== 'unknown' ? r.actor : null, r.channel, r.label || r.kind].filter(Boolean).join(' · ');

async function tellAdmins(text) {
  const admins = teamList().filter(m => m.role === 'admin');
  for (const m of admins) {
    let sent = false;
    try { sent = (await deliver(m, text, 'telegram')).telegram; } catch { sent = false; }
    if (!sent) {
      try { publishNotification({ kind: 'bot', title: 'Usage', body: text, recipient: m.slug }); } catch { /* nowhere left to say it */ }
    }
  }
  process.stderr.write(`[usage] alert: ${text.replace(/\n/g, ' ')}\n`);
}

let lastProjectionCheck = 0;

export function checkRecord(r, now = Date.now(), say = tellAdmins) {
  const s = alertSettings();
  if (!s.enabled || (r.type !== 'turn' && r.type !== 'call')) return;

  if (r.type === 'turn' && (r.cost || 0) >= s.turnCost && !quiet('turn', QUIET.turn, now)) {
    say(`Usage: one turn cost ${usd(r.cost)} (API-price equivalent) — ${who(r)}. Over your ${usd(s.turnCost)} threshold. Details on the Usage page.`);
  }

  if (r.type === 'turn' && r.kind === 'routine' && r.label) {
    const runs = allRecords().filter(x => x.type === 'turn' && x.kind === 'routine' && x.label === r.label && x !== r).slice(-10).map(x => x.cost || 0).sort((a, b) => a - b);
    if (runs.length >= 5) {
      const usual = runs[Math.floor(runs.length / 2)];
      if (usual > 0 && (r.cost || 0) >= usual * s.routineFactor && !quiet(`routine:${r.label}`, QUIET.routine, now)) {
        say(`Usage: the routine "${r.label}" just cost ${usd(r.cost)}, about ${Math.round((r.cost || 0) / usual)}× its usual ${usd(usual)}.`);
      }
    }
  }

  // The projection reads the whole window: at most once a minute.
  if (now - lastProjectionCheck < 60_000) return;
  lastProjectionCheck = now;
  for (const w of planStatus(allRecords(), now)) {
    if (!w.projectedAt) continue;
    const mins = (Date.parse(w.projectedAt) - now) / 60_000;
    if (mins > 0 && mins <= s.projectionMinutes && !quiet(`projection:${w.window}`, QUIET.projection, now)) {
      const at = new Date(w.projectedAt).toISOString().slice(11, 16);
      say(`Usage: at the last hour's pace the ${w.label.toLowerCase()} runs out in about ${Math.round(mins)} min (around ${at} UTC). Spent so far in it: ${usd(w.spent.cost)}.`);
    }
  }
}

export function startUsageAlerts() {
  return onRecord((r) => checkRecord(r));
}

export function _resetAlerts() { lastSaid.clear(); lastProjectionCheck = 0; }
