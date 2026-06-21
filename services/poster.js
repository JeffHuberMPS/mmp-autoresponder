// ── Instagram Auto-Poster (cloud, always-on) ────────────────────────────
// Schedules photo posts to your FEED and/or STORY and publishes them at the
// chosen time — running on the same 24/7 host as your autoresponder, so it
// posts even when your laptop is off.
//
// Photos live on Cloudinary (public links Instagram can fetch). The schedule
// lives in Upstash (survives restarts). Publishing uses Instagram's official
// Content Publishing API: create a media container → wait until it's ready →
// publish it. Carousels create one child per photo; stories use STORIES type.

import { config } from '../config.js';
import { loadData, saveData, storeConfigured } from './store.js';
import { uploadImage, deleteImage, cloudinaryConfigured } from './cloudinary.js';

const GRAPH = config.igGraphBase; // e.g. https://graph.instagram.com/v21.0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withDefaults(settings = {}) {
  return {
    // Don't auto-post content that's gone badly stale (host was asleep and no
    // pinger woke it). Overdue past this many hours → flagged 'missed', not posted.
    missedGraceHours: settings.missedGraceHours ?? 6,
    ...settings,
  };
}

export function readiness() {
  return {
    instagramLive: Boolean(config.igAccessToken),
    photoStorage: cloudinaryConfigured(),
    scheduleStorage: storeConfigured(),
  };
}

// ── Instagram account id (needed by the publishing endpoints) ──
let _igUserId = null;
async function getIgUserId() {
  if (_igUserId) return _igUserId;
  const res = await fetch(`${GRAPH}/me?fields=user_id&access_token=${encodeURIComponent(config.igAccessToken)}`, {
    signal: AbortSignal.timeout(15000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) throw new Error(d?.error?.message || 'Could not read your Instagram account');
  _igUserId = d.user_id || d.id;
  if (!_igUserId) throw new Error('Could not find your Instagram account id');
  return _igUserId;
}

// Build a readable error from Instagram's error object (code/subcode help a lot).
function igError(data, status) {
  const e = data?.error;
  if (!e) return new Error(`Instagram HTTP ${status}`);
  const bits = [e.error_user_msg || e.message || 'Instagram error'];
  if (e.code != null) bits.push(`[code ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''}]`);
  const err = new Error(bits.join(' '));
  err.ig = { code: e.code, subcode: e.error_subcode, type: e.type, message: e.message, user_msg: e.error_user_msg };
  return err;
}

// ── Graph helpers ──
async function graphPost(pathPart, params) {
  const res = await fetch(`${GRAPH}/${pathPart}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw igError(data, res.status);
  return data;
}
async function graphGet(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw igError(data, res.status);
  return data;
}

// ── Diagnostic: reproduce the publish path WITHOUT actually posting ──
// Creating a media container does NOT publish anything (only media_publish does),
// so this is safe to run. It tells us exactly where publishing breaks.
export async function diagnose(imageUrl) {
  const out = { graphBase: GRAPH, hasToken: Boolean(config.igAccessToken), steps: {} };
  if (!config.igAccessToken) { out.steps.token = 'MISSING'; return out; }
  // 1) who am I (the id used for /{id}/media)
  try {
    const res = await fetch(`${GRAPH}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(config.igAccessToken)}`, { signal: AbortSignal.timeout(15000) });
    const d = await res.json().catch(() => ({}));
    out.steps.me = { ok: res.ok && !d.error, raw: d };
    _igUserId = d.user_id || d.id || _igUserId;
    out.igUserId = _igUserId || null;
  } catch (e) { out.steps.me = { ok: false, error: e.message }; }
  if (!_igUserId) return out;
  // 2) try to CREATE a feed container (no publish) — surfaces the real error
  if (imageUrl) {
    try {
      const r = await graphPost(`${_igUserId}/media`, { image_url: imageUrl, caption: 'diagnostic (not published)', access_token: config.igAccessToken });
      out.steps.feedContainer = { ok: true, id: r.id };
    } catch (e) { out.steps.feedContainer = { ok: false, error: e.message, ig: e.ig || null }; }
    // 3) try a STORY container too
    try {
      const r = await graphPost(`${_igUserId}/media`, { image_url: imageUrl, media_type: 'STORIES', access_token: config.igAccessToken });
      out.steps.storyContainer = { ok: true, id: r.id };
    } catch (e) { out.steps.storyContainer = { ok: false, error: e.message, ig: e.ig || null }; }
  }
  return out;
}

// Instagram ingests the photo asynchronously — wait until FINISHED before publishing.
// CRITICAL: never return until it's actually FINISHED. If we gave up early and let
// the caller publish a still-processing container, Instagram answers "The requested
// resource does not exist" — which looks like a failure even though nothing was wrong
// but our patience. Carousels (the parent + each child) and cold free-tier hosts can
// take well over 30s, so we wait up to ~2.5 min and tolerate brief "not found yet" blips.
async function waitForContainer(id, tries = 60) {
  let blips = 0;
  for (let i = 0; i < tries; i++) {
    let d;
    try {
      d = await graphGet(`${GRAPH}/${id}?fields=status_code,status&access_token=${encodeURIComponent(config.igAccessToken)}`);
    } catch (e) {
      // A just-created container can be momentarily un-queryable. Tolerate a few.
      if (/does not exist|not available|temporarily|try again/i.test(e.message || '') && blips < 8) {
        blips++; await sleep(2500); continue;
      }
      throw e;
    }
    blips = 0;
    if (d.status_code === 'FINISHED') return;
    if (d.status_code === 'ERROR' || d.status_code === 'EXPIRED') {
      throw new Error(`Instagram couldn't process the photo (${d.status || d.status_code})`);
    }
    await sleep(2500);
  }
  // Still not ready after the full window — fail loudly rather than publishing
  // an unready container (which would error confusingly downstream).
  throw new Error('Instagram is still processing the photo — it took too long. Try scheduling again.');
}

async function createImageContainer(igId, imageUrl, { caption, story, carouselChild } = {}) {
  const params = { image_url: imageUrl, access_token: config.igAccessToken };
  if (story) params.media_type = 'STORIES';
  if (carouselChild) params.is_carousel_item = 'true';
  if (caption) params.caption = caption;
  const { id } = await graphPost(`${igId}/media`, params);
  return id;
}
async function publishContainer(igId, creationId, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const { id } = await graphPost(`${igId}/media_publish`, { creation_id: creationId, access_token: config.igAccessToken });
      return id;
    } catch (e) {
      lastErr = e;
      // Right after a container reports FINISHED, media_publish can briefly fail
      // with "resource does not exist" / "media ID not available" while Instagram
      // finishes wiring it up. These are transient — wait and retry.
      const transient = /does not exist|not available|temporarily|try again|media id/i.test(e.message || '');
      if (!transient || i === tries - 1) throw e;
      await sleep(3500);
    }
  }
  throw lastErr;
}

// Publish ONE target ('feed' or 'story') and return the new media ids.
async function publishTarget(igId, target, imageUrls, caption) {
  const ids = [];
  if (target === 'story') {
    for (const url of imageUrls) {
      const cid = await createImageContainer(igId, url, { story: true });
      await waitForContainer(cid);
      ids.push(await publishContainer(igId, cid));
    }
    return ids;
  }
  if (imageUrls.length === 1) {
    const cid = await createImageContainer(igId, imageUrls[0], { caption });
    await waitForContainer(cid);
    ids.push(await publishContainer(igId, cid));
    return ids;
  }
  const children = [];
  for (const url of imageUrls) {
    const childId = await createImageContainer(igId, url, { carouselChild: true });
    await waitForContainer(childId);
    children.push(childId);
  }
  const parent = await graphPost(`${igId}/media`, {
    media_type: 'CAROUSEL',
    children: children.join(','),
    caption: caption || '',
    access_token: config.igAccessToken,
  });
  await waitForContainer(parent.id);
  ids.push(await publishContainer(igId, parent.id));
  return ids;
}

// Actually publish a post object. Returns { ids, permalink }.
async function publishPost(post) {
  if (!config.igAccessToken) throw new Error('Instagram is not connected (no token set on the host).');
  const igId = await getIgUserId();
  const imageUrls = (post.media || []).map((m) => m.url).filter(Boolean);
  if (!imageUrls.length) throw new Error('This post has no photos');
  const allIds = [];
  const postedTargets = [];
  const errors = [];
  // Publish each target independently so a hiccup on one (e.g. Story) never
  // discards a target that already went live (e.g. Feed).
  for (const target of post.targets || [post.type]) {
    try {
      const ids = await publishTarget(igId, target, imageUrls, post.caption);
      allIds.push(...ids);
      postedTargets.push(target);
    } catch (e) {
      errors.push(`${target}: ${e.message}`);
    }
  }
  // Only a TOTAL failure (nothing reached Instagram) counts as failed.
  if (!allIds.length) throw new Error(errors.join(' · ') || 'Nothing was published');
  let permalink = null;
  if (allIds[0] && postedTargets.includes('feed')) {
    try {
      const d = await graphGet(`${GRAPH}/${allIds[0]}?fields=permalink&access_token=${encodeURIComponent(config.igAccessToken)}`);
      permalink = d.permalink || null;
    } catch { /* stories / no permalink */ }
  }
  return { ids: allIds, permalink, postedTargets, partialError: errors.length ? errors.join(' · ') : null };
}

// ── Uploads ──
// Save a dropped photo to Cloudinary; the schedule stores its public URL + id.
export async function saveUpload(name, data) {
  if (!data) throw new Error('No image data');
  return uploadImage(data); // { url, publicId, ... }
}

// ── Scheduling (all reads/writes go through Upstash) ──
export async function getSettings() {
  const d = await loadData();
  return withDefaults(d.settings);
}
export async function saveSettings(patch = {}) {
  const d = await loadData();
  d.settings = { ...d.settings, ...patch };
  await saveData(d);
  return withDefaults(d.settings);
}

// ── Analytics ───────────────────────────────────────────────────────────
// Likes/comments per post are always available; reach/saved are best-effort
// (Instagram limits insights on small accounts). We also keep a daily follower
// snapshot in our own data so we can chart growth even without insights access.
const enc = (s) => encodeURIComponent(s);

export async function getAnalytics({ limit = 50 } = {}) {
  if (!config.igAccessToken) return { connected: false };
  const igId = await getIgUserId();
  const token = config.igAccessToken;

  // Account totals
  let followers = null, mediaCount = null, username = null;
  try {
    const a = await graphGet(`${GRAPH}/${igId}?fields=username,followers_count,media_count&access_token=${enc(token)}`);
    followers = a.followers_count ?? null; mediaCount = a.media_count ?? null; username = a.username || null;
  } catch { /* ignore */ }

  // Recent posts with engagement counts (always available)
  let media = [];
  try {
    const fields = 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,thumbnail_url,media_url';
    const d = await graphGet(`${GRAPH}/${igId}/media?fields=${fields}&limit=${Math.min(limit, 100)}&access_token=${enc(token)}`);
    media = (d.data || []).map((m) => ({
      id: m.id,
      caption: (m.caption || '').replace(/\s+/g, ' ').slice(0, 120),
      type: m.media_product_type === 'STORY' ? 'story' : (m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'feed'),
      timestamp: m.timestamp,
      permalink: m.permalink || null,
      thumb: m.thumbnail_url || m.media_url || null,
      likes: m.like_count ?? 0,
      comments: m.comments_count ?? 0,
      reach: null, saved: null,
    }));
  } catch { /* media unavailable */ }

  // Best-effort reach/saved for the most recent posts (skip silently if blocked)
  for (const m of media.slice(0, 24)) {
    if (m.type === 'story') continue;
    try {
      const ins = await graphGet(`${GRAPH}/${m.id}/insights?metric=reach,saved&access_token=${enc(token)}`);
      for (const row of (ins.data || [])) {
        const v = row.values?.[0]?.value;
        if (row.name === 'reach') m.reach = v ?? null;
        if (row.name === 'saved') m.saved = v ?? null;
      }
    } catch { /* insights not available for this account/post — fine */ }
  }

  // Daily follower snapshot → growth series, stored in our own data blob
  let followerSeries = [];
  try {
    const data = await loadData();
    data.analytics = data.analytics || { followerSeries: [] };
    const series = data.analytics.followerSeries;
    if (followers != null) {
      const today = new Date().toISOString().slice(0, 10);
      const last = series[series.length - 1];
      if (!last || last.date !== today) series.push({ date: today, count: followers });
      else last.count = followers;
      if (series.length > 400) series.splice(0, series.length - 400);
      await saveData(data);
    }
    followerSeries = series;
  } catch { /* store unavailable */ }

  return { connected: true, username, followers, mediaCount, media, followerSeries, fetchedAt: new Date().toISOString() };
}

export async function schedulePost({ type, media, caption, scheduledAt, targets } = {}) {
  const kind = type === 'story' ? 'story' : 'feed';
  const items = (Array.isArray(media) ? media : [media]).filter((m) => m && m.url);
  if (!items.length) throw new Error('Add at least one photo');
  if (items.length > 10) throw new Error('At most 10 photos per post');
  const when = scheduledAt ? new Date(scheduledAt) : null;
  if (!when || Number.isNaN(when.getTime())) throw new Error('Pick a valid date and time');

  const tgts = Array.isArray(targets) && targets.length ? targets : [kind];
  const post = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    type: kind,
    media: items.map((m) => ({ url: m.url, publicId: m.publicId || null })),
    caption: tgts.length === 1 && tgts[0] === 'story' ? '' : String(caption || ''),
    targets: tgts,
    scheduledAt: when.toISOString(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    postedAt: null,
    error: null,
    resultIds: [],
    permalink: null,
  };
  const d = await loadData();
  d.posts.push(post);
  await saveData(d);
  return post;
}

export async function listPosts() {
  const d = await loadData();
  const posts = [...d.posts].sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  return {
    upcoming: posts.filter((p) => p.status === 'pending'),
    history: posts
      .filter((p) => p.status !== 'pending')
      .sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt)),
  };
}

export async function cancelPost(id) {
  const d = await loadData();
  const p = d.posts.find((x) => x.id === id);
  if (!p) throw new Error('Post not found');
  if (p.status === 'pending') {
    p.status = 'canceled';
    // Free up the stored photos we no longer need.
    for (const m of p.media || []) deleteImage(m.publicId);
    await saveData(d);
  }
  return p;
}

export async function publishById(id) {
  const d = await loadData();
  const p = d.posts.find((x) => x.id === id);
  if (!p) throw new Error('Post not found');
  try {
    const { ids, permalink, postedTargets, partialError } = await publishPost(p);
    p.status = 'posted';
    p.postedAt = new Date().toISOString();
    p.resultIds = ids;
    p.permalink = permalink;
    p.postedTargets = postedTargets || null;
    p.error = partialError || null;
    await saveData(d);
    for (const m of p.media || []) deleteImage(m.publicId);
    return { ok: true, post: p };
  } catch (e) {
    p.status = 'failed';
    p.error = e.message;
    await saveData(d);
    return { ok: false, error: e.message };
  }
}

// ── The schedule keeper ──
// Called by the in-process timer AND by an external pinger hitting /api/poster/run
// (which also wakes the free host). A guard prevents the two from overlapping.
let _runningDue = false;
export async function runDuePosts() {
  if (_runningDue) return { ran: 0, busy: true };
  if (!storeConfigured()) return { ran: 0, notConfigured: true };
  _runningDue = true;
  try {
    const d = await loadData();
    const settings = withDefaults(d.settings);
    const graceMs = Math.max(0, Number(settings.missedGraceHours) || 0) * 3600_000;
    const now = Date.now();
    let ran = 0;
    for (const p of d.posts) {
      if (p.status !== 'pending') continue;
      const t = new Date(p.scheduledAt).getTime();
      if (t > now) continue;
      const lateBy = now - t;
      if (graceMs > 0 && lateBy > graceMs) {
        p.status = 'missed';
        p.error = `Skipped — was ${Math.round(lateBy / 3600_000)}h overdue. Re-schedule it anytime.`;
        await saveData(d);
        continue;
      }
      p.status = 'posting';
      await saveData(d); // persist the lock before the slow network calls
      try {
        const { ids, permalink, postedTargets, partialError } = await publishPost(p);
        p.status = 'posted';
        p.postedAt = new Date().toISOString();
        p.resultIds = ids;
        p.permalink = permalink;
        p.postedTargets = postedTargets || null;
        p.error = partialError || null;
        ran++;
        console.log(`  📸 Auto-poster published ${p.type} (${p.media.length} photo${p.media.length > 1 ? 's' : ''})`);
        for (const m of p.media || []) deleteImage(m.publicId);
      } catch (e) {
        p.status = 'failed';
        p.error = e.message;
        console.error(`  ⚠ Auto-poster failed: ${e.message}`);
      }
      await saveData(d);
    }
    return { ran };
  } catch (e) {
    console.error('⚠ runDuePosts error:', e.message);
    return { ran: 0, error: e.message };
  } finally {
    _runningDue = false;
  }
}

// In-process backup timer (the external pinger is the primary trigger on free tier).
export function startScheduler() {
  setTimeout(() => runDuePosts().catch(() => {}), 10_000);
  setInterval(() => runDuePosts().catch((e) => console.error('⚠ poster tick:', e.message)), 60_000);
}
