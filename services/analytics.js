import fs from 'node:fs';
import { config } from '../config.js';
import { storeConfigured, kvGet, kvSet } from './store.js';

// ── Autoresponder analytics ──────────────────────────────────────────────
// Aggregated counters (not raw event logs, so it stays tiny) covering:
//   • keyword fires      • offers sent      • REAL link clicks (via /go/:id)
//   • follow-gate hits + follows   • comment auto-DMs   • follow-ups   • leads
//   • a per-day series   • a per-post breakdown (which posts drive DMs)
//
// Storage is HYBRID so the same code works everywhere:
//   • a local JSON file (fast, survives on a real disk), AND
//   • Upstash Redis when configured (so it survives the free cloud host
//     sleeping/restarting — the numbers actually accumulate over time).
// Every record* call is wrapped so analytics can never break the bot.

const FILE = config.analyticsFile;
const KV_KEY = 'analytics:data';

function emptyState() {
  return {
    counters: {
      keywordFires: {}, offersSent: {}, clicks: {},
      gateHits: 0, gateFollows: 0, commentsAutoDM: 0, followupsSent: 0,
      leadsTotal: 0, dmsTotal: 0, commentsTotal: 0,
    },
    daily: {},   // { 'YYYY-MM-DD': { dms, comments, newLeads, offersSent, clicks } }
    perPost: {}, // { mediaId: { permalink, dms, clicks, lastAt } }
    firstAt: Date.now(),
    lastAt: Date.now(),
  };
}

function merge(d) {
  const e = emptyState();
  if (!d || typeof d !== 'object') return e;
  return {
    ...e, ...d,
    counters: { ...e.counters, ...(d.counters || {}) },
    daily: d.daily || {}, perPost: d.perPost || {},
    firstAt: d.firstAt || e.firstAt,
  };
}

let _state = emptyState();

function readFile() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } }

// Load persisted analytics at boot. Prefers Upstash (the durable source on the
// cloud), falling back to the local file. Safe to call once on startup.
export async function initAnalytics() {
  try {
    if (storeConfigured()) {
      const d = await kvGet(KV_KEY);
      _state = merge(d || readFile());
    } else {
      _state = merge(readFile());
    }
  } catch (e) {
    console.error('⚠ analytics init failed:', e.message);
    _state = merge(readFile());
  }
}

let _saveTimer = null;
function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(_state, null, 2)); } catch {}
  // Debounced push to Upstash so we don't hammer it on every single event.
  if (storeConfigured() && !_saveTimer) {
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      kvSet(KV_KEY, _state).catch((e) => console.error('⚠ analytics save:', e.message));
    }, 3000);
  }
}

function todayKey() { return new Date().toISOString().slice(0, 10); }
function day() {
  const k = todayKey();
  _state.daily[k] = _state.daily[k] || { dms: 0, comments: 0, newLeads: 0, offersSent: 0, clicks: 0 };
  return _state.daily[k];
}
function touch() { _state.lastAt = Date.now(); }

// ── recorders (called from the bot) ──
export function recordDM() { try { _state.counters.dmsTotal++; day().dms++; touch(); save(); } catch {} }
export function recordKeyword(trigger) {
  try { const t = String(trigger || '').toLowerCase(); if (!t) return;
    _state.counters.keywordFires[t] = (_state.counters.keywordFires[t] || 0) + 1; touch(); save(); } catch {}
}
export function recordOfferSent(offerId) {
  try { if (!offerId) return;
    _state.counters.offersSent[offerId] = (_state.counters.offersSent[offerId] || 0) + 1; day().offersSent++; touch(); save(); } catch {}
}
export function recordClick(offerId) {
  try { if (!offerId) return;
    _state.counters.clicks[offerId] = (_state.counters.clicks[offerId] || 0) + 1; day().clicks++; touch(); save(); } catch {}
}
export function recordGateHit() { try { _state.counters.gateHits++; touch(); save(); } catch {} }
export function recordGateFollow() { try { _state.counters.gateFollows++; touch(); save(); } catch {} }
export function recordComment(mediaId, permalink) {
  try {
    _state.counters.commentsAutoDM++; _state.counters.commentsTotal++; day().comments++;
    if (mediaId) {
      const p = _state.perPost[mediaId] = _state.perPost[mediaId] || { permalink: permalink || '', dms: 0, clicks: 0 };
      p.dms++; if (permalink) p.permalink = permalink; p.lastAt = Date.now();
    }
    touch(); save();
  } catch {}
}
export function recordFollowup() { try { _state.counters.followupsSent++; touch(); save(); } catch {} }
export function recordLead() { try { _state.counters.leadsTotal++; day().newLeads++; touch(); save(); } catch {} }

// ── read side (for the dashboard) ──
export function getAnalytics() {
  const c = _state.counters;
  const sent = Object.values(c.offersSent).reduce((a, b) => a + b, 0);
  const clicks = Object.values(c.clicks).reduce((a, b) => a + b, 0);

  const topKeywords = Object.entries(c.keywordFires)
    .map(([keyword, count]) => ({ keyword, count })).sort((a, b) => b.count - a.count).slice(0, 12);

  const offers = Object.keys({ ...c.offersSent, ...c.clicks }).map((offerId) => {
    const se = c.offersSent[offerId] || 0, cl = c.clicks[offerId] || 0;
    return { offerId, sent: se, clicks: cl, ctr: se ? Math.round((cl / se) * 100) : 0 };
  }).sort((a, b) => b.clicks - a.clicks || b.sent - a.sent);

  const perPost = Object.entries(_state.perPost)
    .map(([mediaId, p]) => ({ mediaId, permalink: p.permalink || '', dms: p.dms || 0, clicks: p.clicks || 0 }))
    .sort((a, b) => b.dms - a.dms).slice(0, 15);

  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const row = _state.daily[d] || { dms: 0, comments: 0, newLeads: 0, offersSent: 0, clicks: 0 };
    series.push({ date: d, ...row });
  }

  return {
    ok: true,
    persistent: storeConfigured(),
    totals: {
      leads: c.leadsTotal, dms: c.dmsTotal, comments: c.commentsTotal,
      offersSent: sent, clicks, ctr: sent ? Math.round((clicks / sent) * 100) : 0,
      gateHits: c.gateHits, gateFollows: c.gateFollows,
      followRate: c.gateHits ? Math.round((c.gateFollows / c.gateHits) * 100) : 0,
      commentsAutoDM: c.commentsAutoDM, followupsSent: c.followupsSent,
    },
    topKeywords, offers, perPost, series,
    since: _state.firstAt,
  };
}

export function resetAnalytics() { _state = emptyState(); save(); return _state; }
