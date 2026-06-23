// ── Google Photos connection (where Jeff stores his posts) ──────────────
// Uses Google's official Photos Picker API: we create a "picker session", send
// Jeff to Google's own photo picker, he selects shots, then we pull just those
// chosen photos in and hand them to Cloudinary (so Instagram can fetch them).
//
// Nothing is read from his library wholesale — only the exact photos he picks.
// A one-time "Connect Google Photos" sign-in stores a refresh token (in Upstash)
// so he stays connected.

import { config } from '../config.js';
import { kvGet, kvSet, kvDel } from './store.js';
import { uploadImage } from './cloudinary.js';

const TOKEN_KEY = 'google:tokens';
const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const PICKER = 'https://photospicker.googleapis.com/v1';
const REDIRECT = () => `${config.publicBaseUrl.replace(/\/+$/, '')}/api/google/callback`;

export function googleConfigured() {
  return Boolean(config.googleClientId && config.googleClientSecret);
}
export async function googleConnected() {
  if (!googleConfigured()) return false;
  const t = await kvGet(TOKEN_KEY);
  return Boolean(t && t.refresh_token);
}

// Step 1: the consent URL Jeff visits to connect his Google account.
export function authUrl() {
  const p = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: REDIRECT(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent', // force a refresh_token every time he reconnects
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

// Step 2: exchange the code Google sends back for tokens, and store them.
export async function handleCallback(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: REDIRECT(),
      grant_type: 'authorization_code',
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error(d.error_description || d.error || 'Google sign-in failed');
  const existing = (await kvGet(TOKEN_KEY)) || {};
  await kvSet(TOKEN_KEY, {
    refresh_token: d.refresh_token || existing.refresh_token, // Google only returns it on first consent
    access_token: d.access_token,
    expiry: Date.now() + (d.expires_in || 3600) * 1000,
  });
}

export async function disconnect() {
  await kvDel(TOKEN_KEY);
}

// A valid access token, refreshing with the stored refresh token if needed.
async function accessToken() {
  const t = await kvGet(TOKEN_KEY);
  if (!t || !t.refresh_token) throw new Error('Google Photos isn’t connected — tap Connect Google Photos first.');
  if (t.access_token && t.expiry && Date.now() < t.expiry - 60_000) return t.access_token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    // Refresh token revoked/expired → force a reconnect.
    await kvDel(TOKEN_KEY);
    throw new Error('Google connection expired — tap Connect Google Photos again.');
  }
  await kvSet(TOKEN_KEY, { ...t, access_token: d.access_token, expiry: Date.now() + (d.expires_in || 3600) * 1000 });
  return d.access_token;
}

async function gapi(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${PICKER}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d?.error?.message || `Google Photos HTTP ${res.status}`);
  return d;
}

// Create a picker session → returns the URL Jeff opens to choose photos.
export async function startPicker() {
  const token = await accessToken();
  const s = await gapi('sessions', { method: 'POST', token, body: {} });
  return { sessionId: s.id, pickerUri: s.pickerUri, pollMs: 2500 };
}

// Has he finished picking yet?
export async function pollPicker(sessionId) {
  const token = await accessToken();
  const s = await gapi(`sessions/${encodeURIComponent(sessionId)}`, { token });
  return Boolean(s.mediaItemsSet);
}

// Pull the photos he picked, push each to Cloudinary, return their public links.
// `limit` caps how many we take (1 for a single post, up to 10 for a carousel).
export async function importPicked(sessionId, limit = 10) {
  const token = await accessToken();
  // 1) Gather the picked image items (metadata only — fast, no downloads yet).
  const picked = [];
  let pageToken = '';
  while (picked.length < limit) {
    const q = new URLSearchParams({ sessionId, pageSize: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const d = await gapi(`mediaItems?${q}`, { token });
    for (const it of (d.mediaItems || [])) {
      const mf = it.mediaFile || {};
      if (mf.mimeType && !mf.mimeType.startsWith('image/')) continue; // images only for now
      if (!mf.baseUrl) continue;
      picked.push(mf);
      if (picked.length >= limit) break;
    }
    pageToken = d.nextPageToken || '';
    if (!pageToken) break;
  }
  // 2) Download from Google + upload to Cloudinary ALL IN PARALLEL (was one-at-a-
  //    time — the main source of the lag). Order is preserved.
  const results = await Promise.all(picked.map(async (mf) => {
    try {
      // Download at 1600px (the picker supports =w/-h sizing) instead of the full
      // original. Instagram displays at 1080px wide, so 1600 is crisp with no
      // visible quality loss — but it's a fraction of the bytes, so download +
      // Cloudinary upload are roughly twice as fast.
      const imgRes = await fetch(`${mf.baseUrl}=w1600-h1600`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
      if (!imgRes.ok) return null;
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const dataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
      const up = await uploadImage(dataUri);
      return { url: up.url, publicId: up.publicId };
    } catch { return null; }
  }));
  const out = results.filter(Boolean);
  if (!out.length) throw new Error('No photos came through — try picking again.');
  return out;
}
