/**
 * usage-tap — reads one turn's stream-json events for what it cost, and hands
 * the result to the usage ledger when the turn's `result` arrives.
 *
 * The CLI already says everything: each `assistant` event carries its model
 * call's usage and the tools it asked for, each `user` event the tools'
 * results, `result` the turn's totals (tokens, API-price equivalent, model
 * calls, per-model split), and `rate_limit_event` the plan windows. The tap
 * only watches; it never changes what the turn does, and any error in it is
 * swallowed so a ledger problem cannot end a conversation.
 */
import { randomUUID } from 'node:crypto';
import { normTokens, recordLimit, recordTurn } from './usage-ledger.js';

const resultSize = (content) => {
  if (content == null) return 0;
  if (typeof content === 'string') return Buffer.byteLength(content);
  try { return Buffer.byteLength(JSON.stringify(content)); } catch { return 0; }
};

/**
 * ctx: { actor, channel, kind, label, session } — who and where, as the
 * caller of runClaudeTurn knows it.
 */
export function createUsageTap(ctx = {}) {
  let steps = new Map();          // message id → step
  let toolsById = new Map();      // tool_use_id → { name, bytes, ok }
  let sessionId = null;
  let done = false;

  const observe = (evt) => {
    try {
      if (!evt || typeof evt !== 'object') return;
      if (!sessionId && evt.session_id) sessionId = evt.session_id;

      if (evt.type === 'assistant' && evt.message) {
        const m = evt.message;
        const id = m.id || `step-${steps.size}`;
        const step = steps.get(id) || { model: m.model, at: new Date().toISOString(), tools: [] };
        if (m.usage) Object.assign(step, normTokens(m.usage));
        for (const block of Array.isArray(m.content) ? m.content : []) {
          if (block?.type === 'tool_use' && !toolsById.has(block.id)) {
            const t = { name: String(block.name || '?').slice(0, 120), bytes: 0 };
            toolsById.set(block.id, t);
            step.tools.push(t);
          }
        }
        steps.set(id, step);
        return;
      }

      if (evt.type === 'user' && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block?.type !== 'tool_result') continue;
          const t = toolsById.get(block.tool_use_id);
          if (!t) continue;
          t.bytes = resultSize(block.content);
          if (block.is_error) t.ok = false;
        }
        return;
      }

      if (evt.type === 'rate_limit_event') { recordLimit(evt.rate_limit_info || {}); return; }

      if (evt.type === 'result' && !done) {
        done = true;
        const models = {};
        for (const [model, u] of Object.entries(evt.modelUsage || {})) {
          models[model] = { ...normTokens(u), cost: Number(u.costUSD) || 0 };
        }
        const stepList = [...steps.values()];
        recordTurn({
          id: randomUUID(),
          actor: ctx.actor,
          channel: ctx.channel,
          kind: ctx.kind,
          label: ctx.label,
          session: ctx.session || sessionId || evt.session_id,
          model: Object.keys(models)[0] || stepList.find(s => s.model)?.model,
          usage: evt.usage || {},
          cost: evt.total_cost_usd,
          ms: evt.duration_ms,
          calls: evt.num_turns || stepList.length,
          error: evt.is_error,
          models: Object.keys(models).length ? models : undefined,
          steps: stepList,
        });
      }
    } catch (err) {
      process.stderr.write(`[usage] tap: ${err.message}\n`);
    }
  };

  return { observe };
}

/**
 * Who and where a turn is, when its caller did not say: a room's turn is a
 * group turn, anything else a web conversation.
 */
export function usageContext({ usage, actor, groupContext, groupId, webSessionId, sessionId }) {
  return {
    actor: actor || 'unknown',
    channel: usage?.channel || (groupContext ? 'group' : 'web'),
    kind: usage?.kind || (groupContext ? 'group' : 'chat'),
    label: usage?.label || undefined,
    session: webSessionId || sessionId || (groupContext && groupId ? `group:${groupId}` : undefined),
  };
}
