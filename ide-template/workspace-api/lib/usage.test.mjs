/**
 * The admin's Usage page counts what it should: a turn's tokens and steps from
 * its stream, the brain's and background jobs' calls from the CLI's telemetry,
 * plan-limit events once per change, and adds them up by person, channel,
 * routine, model and tool — without message text, and without counting a
 * streamed turn twice. Run: node lib/usage.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
process.env.PROJECT_DIR = mkdtempSync(join(tmpdir(), 'usage-proj-'));
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'usage-store-'));

const L = await import('./usage-ledger.js');
const { createUsageTap, usageContext } = await import('./usage-tap.js');
const O = await import('./usage-otlp.js');
const { checkRecord, _resetAlerts } = await import('./usage-alerts.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const turns = () => L.allRecords().filter(r => r.type === 'turn');

// ─── a streamed turn ─────────────────────────────────────────────────────────
const tap = createUsageTap(usageContext({ usage: { channel: 'slack', kind: 'dm' }, actor: 'ann' }));
const usage1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
tap.observe({ type: 'system', subtype: 'init', session_id: 'sess-1' });
// The CLI sends one assistant event per content block, same message id.
tap.observe({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: usage1, content: [{ type: 'text', text: 'Checking the calendar for the secret meeting' }] } });
tap.observe({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: usage1, content: [{ type: 'tool_use', id: 't1', name: 'mcp__gcalendar__list_events', input: { q: 'secret' } }] } });
tap.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) }] } });
tap.observe({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 4, output_tokens: 50, cache_read_input_tokens: 2200 }, content: [{ type: 'tool_use', id: 't2', name: 'Read' }] } });
tap.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'nope' }] }] } });
tap.observe({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1795000000 } });
tap.observe({ type: 'result', is_error: false, duration_ms: 4200, num_turns: 2, total_cost_usd: 0.42, session_id: 'sess-1',
  usage: { input_tokens: 14, output_tokens: 55, cache_read_input_tokens: 3200, cache_creation_input_tokens: 200 },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 14, outputTokens: 55, cacheReadInputTokens: 3200, cacheCreationInputTokens: 200, costUSD: 0.42 } } });
tap.observe({ type: 'result', total_cost_usd: 9 });   // a second result is ignored

let t = turns();
ok('one turn recorded per result', t.length === 1, t.length);
t = t[0];
ok('...with who and where the caller said', t.actor === 'ann' && t.channel === 'slack' && t.kind === 'dm', t);
ok('...the turn totals from the result', t.in === 14 && t.out === 55 && t.cr === 3200 && t.cw === 200 && t.cost === 0.42 && t.calls === 2, t);
ok('...the session the CLI named', t.session === 'sess-1');
ok('...one step per model call (repeated blocks merged)', t.steps.length === 2 && t.steps[0].tools.length === 1, t.steps);
ok('...tool names and result sizes', t.steps[0].tools[0].name === 'mcp__gcalendar__list_events' && t.steps[0].tools[0].bytes === 4000);
ok('...a failed tool marked', t.steps[1].tools[0].ok === false);
ok('...per-model split', t.models['claude-opus-5-5'].cost === 0.42);
const raw = readFileSync(join(L._dir(), readdirSync(L._dir()).find(f => f.startsWith('usage-'))), 'utf8');
ok('no message text or tool input reaches the ledger', !raw.includes('secret') && !raw.includes('nope'));

// ─── context defaults ────────────────────────────────────────────────────────
ok('a room turn without a label is a group turn', usageContext({ actor: 'bob', groupContext: true, groupId: '-100' }).kind === 'group' && usageContext({ groupContext: true, groupId: '-100' }).session === 'group:-100');
ok('anything else defaults to web chat', usageContext({ actor: 'bob' }).channel === 'web' && usageContext({ actor: 'bob' }).kind === 'chat');

// ─── limits: a change, not a stream ──────────────────────────────────────────
L.recordLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1795000000 });   // same as the tap's
L.recordLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: 1795000000, utilization: 0.85 });
const limits = L.allRecords().filter(r => r.type === 'limit');
ok('a repeated limit status is written once', limits.length === 2, limits);
ok('...reset time as ISO, utilization kept', limits[1].resetsAt.startsWith('2026-') && limits[1].utilization === 0.85, limits[1]);

// ─── telemetry from the brain and background jobs ───────────────────────────
const env = O.telemetryEnv({ source: 'brain', channel: 'telegram', actor: 'tom' });
ok('telemetry posts JSON to workspace-api on loopback', env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' && env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL === 'http/json' && env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.startsWith('http://127.0.0.1:') && env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.endsWith(O.OTLP_LOGS_PATH));
ok('...never prompts or tool details', !('OTEL_LOG_USER_PROMPTS' in env) && !('OTEL_LOG_TOOL_DETAILS' in env));
ok('...names the process', env.OTEL_RESOURCE_ATTRIBUTES === 'ws.source=brain,ws.channel=telegram,ws.actor=tom', env.OTEL_RESOURCE_ATTRIBUTES);
ok('a job is labelled by name', O.jobEnv('memory', { PATH: '/bin' }).OTEL_RESOURCE_ATTRIBUTES.includes('ws.job=memory') && O.jobEnv('memory', { PATH: '/bin' }).PATH === '/bin');
const stripped = O.withoutTelemetry({ ...env, PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'x' });
ok('a streamed turn has the telemetry removed (no double count)', !Object.keys(stripped).some(k => k.startsWith('OTEL_') || k === 'CLAUDE_CODE_ENABLE_TELEMETRY') && stripped.PATH === '/bin' && stripped.CLAUDE_CODE_OAUTH_TOKEN === 'x');

const attr = (key, value) => ({ key, value: typeof value === 'number' ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }) : { stringValue: value } });
const nowNs = String(BigInt(Date.now()) * 1000000n);
const kept = O.ingestOtlpLogs({ resourceLogs: [{
  resource: { attributes: [attr('service.name', 'claude-code'), attr('ws.source', 'brain'), attr('ws.channel', 'telegram'), attr('ws.actor', 'tom')] },
  scopeLogs: [{ logRecords: [
    { timeUnixNano: nowNs, body: { stringValue: 'claude_code.api_request' }, attributes: [attr('event.name', 'api_request'), attr('model', 'claude-sonnet-5-5'), attr('input_tokens', 100), attr('output_tokens', 20), attr('cache_read_tokens', 5000), attr('cache_creation_tokens', 0), attr('cost_usd', 0.05), attr('duration_ms', 900), attr('session.id', 'brain-1')] },
    { timeUnixNano: nowNs, body: { stringValue: 'claude_code.tool_result' }, attributes: [attr('event.name', 'tool_result'), attr('tool_name', 'mcp__gdrive__export'), attr('tool_result_size_bytes', 80000), attr('success', 'true'), attr('duration_ms', 300)] },
    { timeUnixNano: nowNs, body: { stringValue: 'claude_code.user_prompt' }, attributes: [attr('event.name', 'user_prompt'), attr('prompt_length', 12)] },
  ] }],
}] });
ok('telemetry keeps model calls and tool calls, ignores the rest', kept === 2, kept);
const call = L.allRecords().find(r => r.type === 'call');
ok('...a brain call with its tokens and cost', call && call.actor === 'tom' && call.channel === 'telegram' && call.kind === 'brain' && call.in === 100 && call.cr === 5000 && call.cost === 0.05 && call.model === 'claude-sonnet-5-5', call);
ok('...its time from the record', call && Math.abs(Date.parse(call.at) - Date.now()) < 60_000);
ok('a malformed body is harmless', O.ingestOtlpLogs({ resourceLogs: 'x' }) === 0 && O.ingestOtlpLogs(null) === 0);

// ─── a routine, a job ────────────────────────────────────────────────────────
L.recordTurn({ id: 'r1', actor: 'ann', channel: 'scheduled', kind: 'routine', label: 'Morning planning', usage: { input_tokens: 50, output_tokens: 300 }, cost: 0.2 });
L.recordCall({ actor: 'system', channel: 'system', kind: 'job', label: 'memory', in: 10, out: 10, cost: 0.01 });

// ─── summary ─────────────────────────────────────────────────────────────────
const s = L.summary('7d');
ok('totals add turns and calls', Math.abs(s.total.cost - (0.42 + 0.05 + 0.2 + 0.01)) < 1e-9 && s.total.turns === 2 && s.total.calls === 2, s.total);
ok('cache hit rate', s.total.cacheHit > 0.9, s.total.cacheHit);
ok('by person, ranked by cost', s.byActor[0].key === 'ann' && s.byActor.some(r => r.key === 'tom'), s.byActor.map(r => r.key));
ok('by channel', ['slack', 'telegram', 'scheduled', 'system'].every(c => s.byChannel.some(r => r.key === c)), s.byChannel.map(r => r.key));
ok('a routine and a job by name', s.byKind.some(r => r.key === 'routine: Morning planning') && s.byKind.some(r => r.key === 'job: memory'), s.byKind.map(r => r.key));
ok('by model', s.byModel.some(r => r.key === 'claude-opus-5-5') && s.byModel.some(r => r.key === 'claude-sonnet-5-5'));
ok('tools from turn steps and telemetry, biggest first', s.tools[0].key === 'mcp__gdrive__export' && s.tools.some(x => x.key === 'mcp__gcalendar__list_events' && x.estTokens === 1000), s.tools);
ok('7 days come as 7 daily buckets', s.series.length === 7 && !s.hourly, s.series.length);
ok('...today carries the channels', Object.keys(s.series.at(-1)).includes('slack'), s.series.at(-1));
ok('today comes by the hour', L.summary('1d').hourly && L.summary('1d').series.length === 24, L.summary('1d').series.length);
ok('the most expensive turn first, without its steps', s.topTurns[0].cost === 0.42 && typeof s.topTurns[0].steps === 'number');
ok('a turn found by id for its details', L.findTurn('r1')?.label === 'Morning planning');

// ─── plan windows and projection ─────────────────────────────────────────────
let plan = L.planStatus();
ok('no projection before a limit was ever hit', plan.every(w => w.projectedAt === null && w.estimatedLimitCost === null), plan);
ok('...the latest status shown', plan.find(w => w.window === 'five_hour').status === 'allowed_warning');
L.recordLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1795003600 });
L.recordTurn({ id: 'late', actor: 'ann', channel: 'web', kind: 'chat', usage: { input_tokens: 1 }, cost: 0.1, at: new Date(Date.now() + 1000).toISOString() });
plan = L.planStatus(L.allRecords(), Date.now() + 2000);
const five = plan.find(w => w.window === 'five_hour');
ok('the limit level is learned from when it was hit', five.estimatedLimitCost > 0.6 && five.estimatedLimitCost < 0.8, five);
ok('...and spending past it is not projected', five.projectedAt === null, five);

// ─── alerts ──────────────────────────────────────────────────────────────────
_resetAlerts();
const said = [];
const say = (m) => said.push(m);
checkRecord({ type: 'turn', actor: 'ann', channel: 'web', kind: 'chat', cost: 5 }, Date.now(), say);
ok('a turn over the threshold is announced', said.length === 1 && said[0].includes('$5.00'), said);
checkRecord({ type: 'turn', actor: 'ann', channel: 'web', kind: 'chat', cost: 6 }, Date.now() + 1000, say);
ok('...once, then quiet for a while', said.length === 1, said);
for (let i = 0; i < 6; i++) L.recordTurn({ id: `mp${i}`, actor: 'ann', channel: 'scheduled', kind: 'routine', label: 'Weekly review', usage: {}, cost: 0.1 });
const jump = { type: 'turn', actor: 'ann', channel: 'scheduled', kind: 'routine', label: 'Weekly review', cost: 0.5 };
checkRecord(jump, Date.now(), say);
ok('a routine at several times its usual is announced', said.some(m => m.includes('Weekly review') && m.includes('5×')), said);
L.setAlertSettings({ enabled: false });
const before = said.length;
_resetAlerts();
checkRecord({ type: 'turn', kind: 'chat', cost: 50 }, Date.now(), say);
ok('alerts off means silence', said.length === before);
ok('alert settings are clamped', L.setAlertSettings({ enabled: true, turnCost: -3, projectionMinutes: 99999 }).turnCost === 0.05 && L.alertSettings().projectionMinutes === 1440);

// ─── pruning ─────────────────────────────────────────────────────────────────
writeFileSync(join(L._dir(), 'usage-2020-01.jsonl'), JSON.stringify({ type: 'turn', at: '2020-01-05T10:00:00Z', in: 5, out: 5, cost: 1 }) + '\n');
L.prune();
ok('a month past 90 days is folded into daily totals', !existsSync(join(L._dir(), 'usage-2020-01.jsonl')) && readFileSync(join(L._dir(), 'daily.jsonl'), 'utf8').includes('"day":"2020-01-05"'));
ok('...the current month stays', L.allRecords().some(r => r.id === 'r1'));

// ─── routes ──────────────────────────────────────────────────────────────────
const express = (await import('express')).default;
const usageRouter = (await import('../routes/usage.js')).default;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', usageRouter());
const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
let r = await fetch(`${base}/usage/summary`);
ok('the summary needs a signed-in admin', r.status === 401, r.status);
const before2 = L.allRecords().filter(x => x.type === 'call').length;
r = await fetch(`${base}/internal/otlp/v1/logs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resourceLogs: [{ resource: { attributes: [attr('ws.source', 'system'), attr('ws.job', 'chat-title')] }, scopeLogs: [{ logRecords: [{ body: { stringValue: 'claude_code.api_request' }, attributes: [attr('model', 'claude-haiku-5-5'), attr('input_tokens', 3), attr('cost_usd', 0.001)] }] }] }] }) });
ok('the OTLP endpoint answers as OTLP expects on loopback', r.status === 200 && JSON.stringify(await r.json()) === '{}');
ok('...and records the call', L.allRecords().filter(x => x.type === 'call').length === before2 + 1 && L.allRecords().at(-1).label === 'chat-title');
server.close();

console.log(`usage: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
