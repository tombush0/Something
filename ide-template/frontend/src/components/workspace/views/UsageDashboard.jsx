import { useState } from 'react';
import { Gauge, X, Loader2, CheckCircle2, AlertTriangle, OctagonX } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import EditorHeader from '../EditorHeader.jsx';
import { useApi } from '@/lib/useApi';
import useMe from '../useMe.js';
import { cn } from '@/lib/utils';

/**
 * Usage — what the plan's tokens went on (workspace-api lib/usage-ledger.js).
 * Admins only. Plan windows first (is it about to run out?), then the burn
 * over the range, the breakdowns (who, where, which routine or job, which
 * model, which tools), the most expensive turns with their steps, and the
 * alert thresholds. "API-price equivalent" is what the same tokens would cost
 * on the API: not billed on a subscription, but one unit across models and
 * cache, so it is what the page ranks by.
 */

const RANGES = [['1d', 'Today'], ['7d', '7 days'], ['30d', '30 days']];

// Channels in a fixed order: a channel keeps its colour whatever the range
// shows (the data-viz palette's categorical slots, light and dark).
const CHANNELS = [
  ['web', 'Web'], ['telegram', 'Telegram'], ['slack', 'Slack'], ['gchat', 'Google Chat'],
  ['scheduled', 'Routines'], ['group', 'Rooms'], ['system', 'Background'], ['lookup', 'Lookups'],
];
const CHANNEL_LABEL = Object.fromEntries(CHANNELS);
const channelLabel = (c) => CHANNEL_LABEL[c] || (c === 'brain' ? 'Brain' : c || 'Other');
const seriesVar = (c) => { const i = CHANNELS.findIndex(([k]) => k === c); return i >= 0 ? `var(--series-${i + 1})` : 'var(--series-other)'; };

const KIND_LABEL = { chat: 'Chat', page: 'Page actions', group: 'Room', dm: 'DM', routine: 'Routine', invoke: 'Scheduled run', lookup: 'Private lookup', delegate: 'Room → private task', job: 'Background job', brain: 'Brain' };
const kindLabel = (k) => {
  const [kind, ...rest] = String(k || '').split(': ');
  const base = KIND_LABEL[kind] || kind || 'Other';
  return rest.length ? `${base}: ${rest.join(': ')}` : base;
};

const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
};
const fmtUsd = (n) => { const v = Number(n) || 0; return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`; };
const fmtBytes = (n) => { const v = Number(n) || 0; return v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : v >= 1e3 ? `${Math.round(v / 1e3)} kB` : `${v} B`; };
const fmtTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const toolName = (t) => String(t || '').replace(/^mcp__/, '').replace(/__/, ' · ');

export default function UsageDashboard({ sidebarOpen }) {
  const { me } = useMe();
  const [range, setRange] = useState('7d');
  const [turnId, setTurnId] = useState(null);
  const isAdmin = !!(me?.isAdmin || me?.role === 'admin');
  const { data, loading, error, reload } = useApi(isAdmin ? `/api/usage/summary?range=${range}` : null);

  return (
    <div className="usage-viz flex h-full min-h-0 flex-col">
      <style>{VIZ_VARS}</style>
      <EditorHeader icon={Gauge} title="Usage" subtitle="What your Claude plan is spent on" sidebarOpen={sidebarOpen} />
      <div className="flex-1 overflow-auto">
        <div className="flex max-w-5xl flex-col gap-6 px-6 pb-16 pt-2">
          {!isAdmin ? (
            <p className="text-[13px] text-muted-foreground">Only admins can see usage.</p>
          ) : (
            <>
              <div className="flex items-center gap-4 border-b border-border/60">
                {RANGES.map(([id, label]) => (
                  <button key={id} type="button" onClick={() => setRange(id)}
                    className={cn('-mb-px border-b-2 px-0.5 pb-2 text-[13px] font-medium outline-none transition-colors', range === id ? 'border-foreground text-foreground' : 'border-transparent text-foreground/55 hover:text-foreground/85')}>
                    {label}
                  </button>
                ))}
                <button type="button" onClick={() => reload()} className="ml-auto pb-2 text-[12px] text-foreground/55 hover:text-foreground/85">Refresh</button>
              </div>

              {loading && !data && <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>}
              {error && !data && <p className="text-[13px] text-red-600">Could not load usage: {String(error.message || error)}</p>}

              {data && (
                <>
                  <PlanWindows plan={data.plan} />
                  <Totals total={data.total} firstAt={data.firstAt} />
                  <BurnChart data={data} />
                  <div className="grid gap-6 lg:grid-cols-2">
                    <Breakdown title="By person" rows={data.byActor} total={data.total} label={(k) => k === 'system' ? 'Background (system)' : k} />
                    <Breakdown title="By channel" rows={data.byChannel} total={data.total} label={channelLabel} swatch />
                    <Breakdown title="By routine, room or job" rows={data.byKind} total={data.total} label={kindLabel} />
                    <Breakdown title="By model" rows={data.byModel} total={data.total} label={(k) => k} />
                  </div>
                  <Tools rows={data.tools} />
                  <TopTurns rows={data.topTurns} onOpen={setTurnId} />
                  <AlertSettings />
                  <p className="text-[12px] leading-5 text-muted-foreground">
                    Amounts in $ are the API-price equivalent of the tokens: not billed on a subscription, but comparable across models and cache.
                    Turns run by the workspace are counted exactly; the Telegram brain and background jobs report through the Claude CLI&apos;s telemetry, which a very short job may not finish sending.
                    No message text is stored. Usage of the same Claude account outside this workspace is not visible here.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {turnId && <TurnDrawer id={turnId} onClose={() => setTurnId(null)} />}
    </div>
  );
}

/* ─── Plan windows ─────────────────────────────────────────────────────── */

const STATUS = {
  allowed:         { icon: CheckCircle2, label: 'OK', cls: 'text-emerald-700 dark:text-emerald-400' },
  allowed_warning: { icon: AlertTriangle, label: 'Warning', cls: 'text-amber-700 dark:text-amber-400' },
  rejected:        { icon: OctagonX, label: 'Limit reached', cls: 'text-red-700 dark:text-red-400' },
};

function PlanWindows({ plan = [] }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2">
      {plan.map(w => {
        const st = STATUS[w.status] || null;
        const Icon = st?.icon;
        const mins = w.projectedAt ? Math.round((Date.parse(w.projectedAt) - Date.now()) / 60000) : null;
        return (
          <div key={w.window} className="rounded-lg border border-border/70 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold">{w.label}</h3>
              {st ? <span className={cn('flex items-center gap-1 text-[12px] font-medium', st.cls)}><Icon className="size-3.5" />{st.label}</span>
                  : <span className="text-[12px] text-muted-foreground">No status from Claude yet</span>}
            </div>
            <p className="mt-2 text-[22px] font-semibold tabular-nums">{fmtUsd(w.spent?.cost)}<span className="ml-2 text-[13px] font-normal text-muted-foreground">{fmtTokens(w.spent?.tokens)} tokens</span></p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
              {w.utilization != null && (<><dt className="text-muted-foreground">Used</dt><dd className="tabular-nums">{Math.round(w.utilization * (w.utilization <= 1 ? 100 : 1))}%</dd></>)}
              <dt className="text-muted-foreground">Resets</dt><dd>{w.resetsAt ? fmtTime(w.resetsAt) : '—'}</dd>
              <dt className="text-muted-foreground">Pace</dt>
              <dd>{mins != null ? `runs out in about ${mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h`} at the last hour's pace`
                : w.estimatedLimitCost ? 'below the limit at the current pace' : 'no projection until this limit has been hit once'}</dd>
            </dl>
          </div>
        );
      })}
    </section>
  );
}

/* ─── Totals ───────────────────────────────────────────────────────────── */

function Totals({ total, firstAt }) {
  const tiles = [
    ['Tokens', fmtTokens(total.tokens), `${fmtTokens(total.in)} in · ${fmtTokens(total.out)} out · ${fmtTokens(total.cr)} cache read · ${fmtTokens(total.cw)} cache write`],
    ['API-price equivalent', fmtUsd(total.cost), null],
    ['Turns', String(total.turns), total.calls ? `+ ${total.calls} brain/background calls` : null],
    ['Cache hit', `${((total.cacheHit || 0) * 100).toFixed(total.cacheHit > 0.99 && total.cacheHit < 1 ? 1 : 0)}%`, 'of input read from cache'],
  ];
  return (
    <section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map(([label, value, sub]) => (
          <div key={label} className="rounded-lg border border-border/70 p-4">
            <p className="text-[12px] text-muted-foreground">{label}</p>
            <p className="mt-1 text-[20px] font-semibold tabular-nums">{value}</p>
            {sub && <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{sub}</p>}
          </div>
        ))}
      </div>
      {firstAt && <p className="mt-2 text-[11px] text-muted-foreground">Recording since {fmtTime(firstAt)}.</p>}
    </section>
  );
}

/* ─── Burn over time ───────────────────────────────────────────────────── */

function BurnChart({ data }) {
  const known = CHANNELS.map(([k]) => k).filter(k => data.channels.includes(k));
  const others = data.channels.filter(c => !CHANNEL_LABEL[c]);
  const rows = data.series.map(b => {
    const r = { bucket: b.bucket, cost: b.cost || 0 };
    for (const k of known) r[k] = b[k] || 0;
    if (others.length) r.other = others.reduce((s, c) => s + (b[c] || 0), 0);
    return r;
  });
  const keys = [...known, ...(others.length ? ['other'] : [])];
  const tick = (v) => data.hourly ? String(v).slice(11, 16) : new Date(`${v}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return (
    <section className="rounded-lg border border-border/70 p-4">
      <h3 className="text-[13px] font-semibold">Tokens per {data.hourly ? 'hour' : 'day'}, by channel</h3>
      <div className="mt-3 h-64">
        {keys.length === 0 ? <p className="text-[13px] text-muted-foreground">Nothing recorded in this range yet.</p> : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
              <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
              <XAxis dataKey="bucket" tickFormatter={tick} tick={{ fontSize: 11, fill: 'var(--viz-muted)' }} axisLine={false} tickLine={false} minTickGap={16} />
              <YAxis tickFormatter={fmtTokens} tick={{ fontSize: 11, fill: 'var(--viz-muted)' }} axisLine={false} tickLine={false} width={44} />
              <Tooltip cursor={{ fill: 'var(--viz-cursor)' }} content={<BurnTooltip keys={keys} hourly={data.hourly} />} />
              {keys.map((k, i) => (
                <Bar key={k} dataKey={k} stackId="a" fill={k === 'other' ? 'var(--series-other)' : seriesVar(k)}
                  stroke="var(--background)" strokeWidth={2} radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
      {keys.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-foreground/80">
          {keys.map(k => (
            <li key={k} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: k === 'other' ? 'var(--series-other)' : seriesVar(k) }} />
              {k === 'other' ? 'Other' : channelLabel(k)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BurnTooltip({ active, payload, label, keys, hourly }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const total = keys.reduce((s, k) => s + (row[k] || 0), 0);
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-[12px] shadow-md">
      <p className="font-medium">{hourly ? String(label).replace('T', ' ') : label}</p>
      <p className="tabular-nums text-muted-foreground">{fmtTokens(total)} tokens · {fmtUsd(row.cost)}</p>
      <ul className="mt-1 space-y-0.5">
        {keys.filter(k => row[k]).map(k => (
          <li key={k} className="flex items-center gap-2">
            <span className="size-2.5 rounded-sm" style={{ background: k === 'other' ? 'var(--series-other)' : seriesVar(k) }} />
            <span>{k === 'other' ? 'Other' : channelLabel(k)}</span>
            <span className="ml-auto tabular-nums">{fmtTokens(row[k])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─── Breakdowns ───────────────────────────────────────────────────────── */

function Breakdown({ title, rows = [], total, label, swatch = false }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 8);
  const max = Math.max(...rows.map(r => r.cost || 0), 0.000001);
  return (
    <section className="rounded-lg border border-border/70 p-4">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {rows.length === 0 ? <p className="mt-2 text-[13px] text-muted-foreground">Nothing yet.</p> : (
        <table className="mt-2 w-full text-[12px]">
          <thead><tr className="text-left text-muted-foreground"><th className="py-1 font-normal">Name</th><th className="py-1 text-right font-normal">Tokens</th><th className="py-1 text-right font-normal">$ equiv.</th><th className="py-1 text-right font-normal">Share</th></tr></thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.key} className="border-t border-border/40">
                <td className="max-w-[14rem] truncate py-1.5 pr-2" title={label(r.key)}>
                  <span className="flex items-center gap-2">
                    {swatch && <span className="size-2.5 shrink-0 rounded-sm" style={{ background: CHANNEL_LABEL[r.key] ? seriesVar(r.key) : 'var(--series-other)' }} />}
                    <span className="truncate">{label(r.key)}</span>
                  </span>
                  <span className="mt-1 block h-1 rounded-full bg-foreground/[0.06]"><span className="block h-1 rounded-full bg-foreground/40" style={{ width: `${Math.max(2, (r.cost / max) * 100)}%` }} /></span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{fmtTokens(r.tokens)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtUsd(r.cost)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{total.cost ? `${Math.round((r.cost / total.cost) * 100)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 8 && <button type="button" onClick={() => setAll(a => !a)} className="mt-2 text-[12px] text-foreground/60 hover:text-foreground">{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </section>
  );
}

function Tools({ rows = [] }) {
  return (
    <section className="rounded-lg border border-border/70 p-4">
      <h3 className="text-[13px] font-semibold">Tools by how much they put into context</h3>
      <p className="mt-0.5 text-[11px] text-muted-foreground">A tool&apos;s results become input to the next model call; ~4 bytes ≈ 1 token, so this is an estimate.</p>
      {rows.length === 0 ? <p className="mt-2 text-[13px] text-muted-foreground">No tool calls recorded yet.</p> : (
        <table className="mt-2 w-full text-[12px]">
          <thead><tr className="text-left text-muted-foreground"><th className="py-1 font-normal">Tool</th><th className="py-1 text-right font-normal">Calls</th><th className="py-1 text-right font-normal">Result size</th><th className="py-1 text-right font-normal">≈ Tokens</th><th className="py-1 text-right font-normal">Errors</th></tr></thead>
          <tbody>
            {rows.slice(0, 15).map(r => (
              <tr key={r.key} className="border-t border-border/40">
                <td className="max-w-[18rem] truncate py-1.5 pr-2" title={r.key}>{toolName(r.key)}</td>
                <td className="py-1.5 text-right tabular-nums">{r.count}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtBytes(r.bytes)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtTokens(r.estTokens)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{r.errors || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ─── Most expensive turns + drill-down ────────────────────────────────── */

function TopTurns({ rows = [], onOpen }) {
  return (
    <section className="rounded-lg border border-border/70 p-4">
      <h3 className="text-[13px] font-semibold">Most expensive turns</h3>
      {rows.length === 0 ? <p className="mt-2 text-[13px] text-muted-foreground">No turns recorded yet.</p> : (
        <table className="mt-2 w-full text-[12px]">
          <thead><tr className="text-left text-muted-foreground"><th className="py-1 font-normal">When</th><th className="py-1 font-normal">Who · where</th><th className="py-1 font-normal">What</th><th className="py-1 text-right font-normal">Steps</th><th className="py-1 text-right font-normal">Tokens</th><th className="py-1 text-right font-normal">$ equiv.</th></tr></thead>
          <tbody>
            {rows.map(t => (
              <tr key={t.id} onClick={() => onOpen(t.id)} className="cursor-pointer border-t border-border/40 hover:bg-foreground/[0.03]">
                <td className="whitespace-nowrap py-1.5 pr-2">{fmtTime(t.at)}</td>
                <td className="py-1.5 pr-2">{t.actor} · {channelLabel(t.channel)}</td>
                <td className="max-w-[14rem] truncate py-1.5 pr-2" title={kindLabel(t.label ? `${t.kind}: ${t.label}` : t.kind)}>{kindLabel(t.label ? `${t.kind}: ${t.label}` : t.kind)}{t.error ? ' (failed)' : ''}</td>
                <td className="py-1.5 text-right tabular-nums">{t.calls || t.steps}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtTokens(t.tokens)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtUsd(t.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function TurnDrawer({ id, onClose }) {
  const { data: t, loading, error } = useApi(`/api/usage/turns/${encodeURIComponent(id)}`);
  return (
    <div className="fixed inset-0 z-[80] flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-auto bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold">Turn details</h3>
          <button type="button" onClick={onClose} title="Close" className="rounded p-1 hover:bg-muted"><X className="size-4" /></button>
        </div>
        {loading && <p className="mt-4 flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</p>}
        {error && <p className="mt-4 text-[13px] text-red-600">Could not load this turn.</p>}
        {t && (
          <>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-muted-foreground">When</dt><dd>{fmtTime(t.at)}{t.ms ? ` · ${Math.round(t.ms / 1000)} s` : ''}</dd>
              <dt className="text-muted-foreground">Who · where</dt><dd>{t.actor} · {channelLabel(t.channel)}</dd>
              <dt className="text-muted-foreground">What</dt><dd>{kindLabel(t.label ? `${t.kind}: ${t.label}` : t.kind)}</dd>
              <dt className="text-muted-foreground">Total</dt><dd className="tabular-nums">{fmtTokens((t.in || 0) + (t.out || 0) + (t.cr || 0) + (t.cw || 0))} tokens · {fmtUsd(t.cost)}</dd>
              <dt className="text-muted-foreground">Models</dt><dd>{t.models ? Object.entries(t.models).map(([m, v]) => `${m} (${fmtUsd(v.cost)})`).join(', ') : (t.model || '—')}</dd>
            </dl>
            <h4 className="mt-5 text-[13px] font-semibold">Steps</h4>
            <p className="text-[11px] text-muted-foreground">One row per model call. A step&apos;s input includes everything before it, cached or not, plus what the previous step&apos;s tools returned.</p>
            <ol className="mt-2 space-y-2">
              {(t.steps || []).map((s, i) => (
                <li key={i} className="rounded-md border border-border/60 p-2.5 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">#{i + 1} <span className="font-normal text-muted-foreground">{s.model || ''}</span></span>
                    <span className="tabular-nums text-muted-foreground">{fmtTokens(s.in)} in · {fmtTokens(s.cr)} cached · {fmtTokens(s.cw)} cache write · {fmtTokens(s.out)} out</span>
                  </div>
                  {s.tools?.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {s.tools.map((x, j) => (
                        <li key={j} className="flex items-center justify-between gap-3 text-foreground/80">
                          <span className="truncate">{toolName(x.name)}{x.ok === false ? ' (error)' : ''}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">{fmtBytes(x.bytes)} result</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Alerts ───────────────────────────────────────────────────────────── */

function AlertSettings() {
  const { data, reload } = useApi('/api/usage/alerts');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const v = draft || data;
  if (!v) return null;
  const set = (k, val) => { setSaved(false); setDraft({ ...v, [k]: val }); };
  const save = async () => {
    setSaving(true);
    try {
      await fetch('/api/usage/alerts', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
      await reload(); setDraft(null); setSaved(true);
    } finally { setSaving(false); }
  };
  const field = 'w-20 rounded-md border border-border bg-background px-2 py-1 text-right text-[12px] tabular-nums';
  return (
    <section className="rounded-lg border border-border/70 p-4">
      <h3 className="text-[13px] font-semibold">Alerts</h3>
      <p className="mt-0.5 text-[11px] text-muted-foreground">Sent to admins on Telegram when linked, otherwise as a notification here. Each is said once, then stays quiet for a while.</p>
      <div className="mt-3 flex flex-col gap-2 text-[12px]">
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!v.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Alerts on</label>
        <label className="flex items-center gap-2">When a plan window would run out within <input type="number" min="5" className={field} value={v.projectionMinutes} onChange={(e) => set('projectionMinutes', e.target.value)} /> minutes at the last hour&apos;s pace</label>
        <label className="flex items-center gap-2">When one turn costs more than $<input type="number" min="0.05" step="0.05" className={field} value={v.turnCost} onChange={(e) => set('turnCost', e.target.value)} /> (API-price equivalent)</label>
        <label className="flex items-center gap-2">When a routine run costs <input type="number" min="1.5" step="0.5" className={field} value={v.routineFactor} onChange={(e) => set('routineFactor', e.target.value)} /> × its usual</label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="button" disabled={!draft || saving} onClick={save} className="rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background disabled:opacity-40">{saving ? 'Saving…' : 'Save'}</button>
        {saved && <span className="text-[12px] text-muted-foreground">Saved.</span>}
      </div>
    </section>
  );
}

// The data-viz palette's categorical slots, stepped per mode (validated set);
// "other" is a neutral gray. Chart chrome stays recessive.
const VIZ_VARS = `
.usage-viz {
  --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a; --series-4:#eda100;
  --series-5:#e87ba4; --series-6:#008300; --series-7:#6250d6; --series-8:#e34948;
  --series-other:#9b9a95; --viz-grid:rgba(0,0,0,0.07); --viz-muted:#6b6963; --viz-cursor:rgba(0,0,0,0.04);
}
.dark .usage-viz {
  --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70; --series-4:#c98500;
  --series-5:#d55181; --series-6:#0ca30c; --series-7:#9085e9; --series-8:#e66767;
  --series-other:#7a7975; --viz-grid:rgba(255,255,255,0.08); --viz-muted:#a3a29c; --viz-cursor:rgba(255,255,255,0.05);
}`;
