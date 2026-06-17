// ── Permanent storage for the Auto-Poster schedule ──────────────────────
// The free host wipes its disk when it restarts, so the schedule can't live in
// a local file — a post you queue for next week would vanish. Instead we keep
// it in Upstash Redis (a free, permanent key-value store) reached over a simple
// HTTPS REST call. The whole schedule is one JSON blob under one key.

import { config } from '../config.js';

const KEY = 'poster:data';
const EMPTY = { posts: [], settings: {} };

export function storeConfigured() {
  return Boolean(config.upstashUrl && config.upstashToken);
}

// One small helper for both reads (GET) and writes (POST with a body).
async function redis(commandPath, body) {
  const res = await fetch(`${config.upstashUrl.replace(/\/+$/, '')}/${commandPath}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${config.upstashToken}` },
    body: body !== undefined ? body : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data?.error || `Storage HTTP ${res.status}`);
  return data.result;
}

// Read the whole schedule. Returns the empty shape if nothing's stored yet (or
// if storage isn't set up — so the dashboard still loads in that state).
export async function loadData() {
  if (!storeConfigured()) return { ...EMPTY };
  try {
    const raw = await redis(`get/${KEY}`);
    if (!raw) return { ...EMPTY };
    const d = JSON.parse(raw);
    if (!Array.isArray(d.posts)) d.posts = [];
    if (!d.settings) d.settings = {};
    return d;
  } catch (e) {
    // Never crash the scheduler on a transient storage hiccup.
    console.error('⚠ poster store read failed:', e.message);
    throw e;
  }
}

export async function saveData(data) {
  if (!storeConfigured()) throw new Error('Schedule storage (Upstash) is not set up yet');
  await redis(`set/${KEY}`, JSON.stringify(data));
  return data;
}

// Generic key-value (reused for the Google Photos login tokens).
export async function kvGet(key) {
  if (!storeConfigured()) return null;
  const raw = await redis(`get/${encodeURIComponent(key)}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export async function kvSet(key, value) {
  if (!storeConfigured()) throw new Error('Storage (Upstash) is not set up yet');
  await redis(`set/${encodeURIComponent(key)}`, JSON.stringify(value));
  return value;
}
export async function kvDel(key) {
  if (!storeConfigured()) return;
  await redis(`del/${encodeURIComponent(key)}`);
}
