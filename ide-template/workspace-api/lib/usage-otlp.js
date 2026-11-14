/**
 * usage-otlp — the usage of Claude processes workspace-api does not stream.
 *
 * The tmux brain and the background jobs (memory, titles, classification,
 * branding) run the CLI without stream-json, so usage-tap.js never sees their
 * tokens. The CLI exports them itself as OpenTelemetry events
 * (CLAUDE_CODE_ENABLE_TELEMETRY): an `api_request` per model call with its
 * tokens and API-price equivalent, a `tool_result` per tool call with its
 * sizes. Those processes post them, as OTLP/HTTP JSON, to workspace-api on
 * loopback (routes/usage.js), and this file turns them into ledger records.
 *
 * Who and where come from the resource attributes the spawner sets
 * (telemetryEnv): ws.source, ws.job, ws.channel, ws.actor. Prompt and response
 * text are never exported (OTEL_LOG_USER_PROMPTS stays unset) and tool details
 * stay off, so nothing but names, sizes and counts arrives.
 *
 * Trust: anything on loopback can post here, a turn's shell included, so a
 * record is a claim, not proof. It only feeds the admin's numbers; nothing
 * acts on it except an alert to the admin.
 */
import { recordCall, recordTool } from './usage-ledger.js';

const PORT = () => process.env.WORKSPACE_API_PORT || '3001';
export const OTLP_LOGS_PATH = '/api/internal/otlp/v1/logs';

/**
 * The environment that makes a CLI process export its usage here.
 * `attrs` names the process: { source, job, channel, actor }.
 */
export function telemetryEnv(attrs = {}) {
  const pairs = Object.entries({ 'ws.source': attrs.source, 'ws.job': attrs.job, 'ws.channel': attrs.channel, 'ws.actor': attrs.actor })
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${PORT()}${OTLP_LOGS_PATH}`,
    // Short-lived `claude -p` jobs: a short interval leaves less unsent at exit.
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
    OTEL_RESOURCE_ATTRIBUTES: pairs.join(','),
  };
}

/** `env` plus the telemetry of a background job called `job`. */
export function jobEnv(job, env = process.env) {
  return { ...env, ...telemetryEnv({ source: 'system', job, channel: 'system', actor: 'system' }) };
}

/** The CLI's telemetry variables, removed: a streamed turn is counted from its stream. */
export function withoutTelemetry(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (k === 'CLAUDE_CODE_ENABLE_TELEMETRY' || k.startsWith('OTEL_')) delete out[k];
  return out;
}

// ─── OTLP JSON → records ───────────────────────────────────────────────────

function anyValue(v) {
  if (!v || typeof v !== 'object') return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return Number(v.intValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('boolValue' in v) return !!v.boolValue;
  return undefined;
}

function attrMap(list) {
  const out = {};
  for (const a of Array.isArray(list) ? list : []) if (a && a.key) out[a.key] = anyValue(a.value);
  return out;
}

const decode = (s) => { try { return s == null ? s : decodeURIComponent(String(s)); } catch { return String(s); } };

function eventName(rec, attrs) {
  const n = attrs['event.name'] || anyValue(rec.body) || '';
  return String(n).replace(/^claude_code\./, '');
}

function timeOf(rec) {
  const ns = rec.timeUnixNano || rec.observedTimeUnixNano;
  const ms = ns ? Number(BigInt(String(ns)) / 1000000n) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
}

/** Ingest one OTLP logs request body; returns how many records were kept. */
export function ingestOtlpLogs(body) {
  let kept = 0;
  for (const rl of Array.isArray(body?.resourceLogs) ? body.resourceLogs : []) {
    const res = attrMap(rl.resource?.attributes);
    for (const sl of Array.isArray(rl.scopeLogs) ? rl.scopeLogs : []) {
      for (const rec of Array.isArray(sl.logRecords) ? sl.logRecords : []) {
        const attrs = { ...res, ...attrMap(rec.attributes) };
        const name = eventName(rec, attrs);
        const who = {
          at: timeOf(rec),
          actor: decode(attrs['ws.actor']) || (attrs['ws.source'] === 'brain' ? 'brain' : 'system'),
          channel: decode(attrs['ws.channel']) || 'system',
          kind: attrs['ws.source'] === 'brain' ? 'brain' : 'job',
          label: decode(attrs['ws.job']) || undefined,
          session: attrs['session.id'],
        };
        if (name === 'api_request') {
          recordCall({
            ...who,
            model: attrs.model,
            in: attrs.input_tokens, out: attrs.output_tokens,
            cr: attrs.cache_read_tokens, cw: attrs.cache_creation_tokens,
            cost: attrs.cost_usd ?? (attrs.cost_usd_micros ? attrs.cost_usd_micros / 1e6 : 0),
            ms: attrs.duration_ms,
          });
          kept += 1;
        } else if (name === 'tool_result') {
          recordTool({
            ...who,
            tool: attrs.tool_name,
            bytes: attrs.tool_result_size_bytes,
            inBytes: attrs.tool_input_size_bytes,
            ms: attrs.duration_ms,
            ok: String(attrs.success) === 'false' ? false : undefined,
          });
          kept += 1;
        }
      }
    }
  }
  return kept;
}
