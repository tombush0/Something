/**
 * Usage — what the plan's tokens went on, for admins (lib/usage-ledger.js).
 *
 *   GET  /usage/summary?range=1d|7d|30d|90d   ADMIN: totals, plan windows, burn
 *                                             over time, breakdowns, top turns
 *   GET  /usage/turns/:id                     ADMIN: one turn's steps
 *   GET  /usage/alerts · PUT /usage/alerts    ADMIN: alert thresholds
 *   POST /internal/otlp/v1/logs               LOOPBACK: the CLI's own usage
 *                                             export (lib/usage-otlp.js)
 */
import { Router } from 'express';
import * as team from '../lib/team.js';
import { alertSettings, findTurn, setAlertSettings, summary } from '../lib/usage-ledger.js';
import { ingestOtlpLogs } from '../lib/usage-otlp.js';

function requireAdmin(req, res, next) {
  if (!req.actor) return res.status(401).json({ error: 'Unauthorized.' });
  if (!team.isAdmin(req.actor)) return res.status(403).json({ error: 'Only admins can see usage.' });
  next();
}

function loopbackOnly(req, res, next) {
  const ip = req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'loopback only' });
}

export default function usageRouter() {
  const router = Router();

  router.get('/usage/summary', requireAdmin, (req, res) => {
    try { res.json(summary(String(req.query.range || '7d'))); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/usage/turns/:id', requireAdmin, (req, res) => {
    const t = findTurn(String(req.params.id));
    if (!t) return res.status(404).json({ error: 'No such turn.' });
    res.json(t);
  });

  router.get('/usage/alerts', requireAdmin, (_req, res) => res.json(alertSettings()));

  router.put('/usage/alerts', requireAdmin, (req, res) => {
    try { res.json(setAlertSettings(req.body || {})); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // OTLP/HTTP JSON: an empty object is a full success.
  router.post('/internal/otlp/v1/logs', loopbackOnly, (req, res) => {
    try { ingestOtlpLogs(req.body); } catch (err) { process.stderr.write(`[usage] otlp: ${err.message}\n`); }
    res.json({});
  });

  return router;
}
