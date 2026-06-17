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

// ── Graph helpers ──
async function graphPost(pathPart, params) {
  const res = await fetch(`${GRAPH}/${pathPart}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data?.error?.message || `Instagram HTTP ${res.status}`);
  return data;
}
async function graphGet(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data?.error?.message || `Instagram HTTP ${res.status}`);
  return data;
}

// Instagram ingests the photo asynchronously — wait until FINISHED before publishing.
async function waitForContainer(id, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const d = await graphGet(`${GRAPH}/${id}?fields=status_code,status&access_token=${encodeURIComponent(config.igAccessToken)}`);
    if (d.status_code === 'FINISHED') return;
    if (d.status_code === 'ERROR' || d.status_code === 'EXPIRED') {
      throw new Error(`Instagram couldn't process the photo (${d.status || d.status_code})`);
    }
    await sleep(2500);
  }
}

async function createImageContainer(igId, imageUrl, { caption, story, carouselChild } = {}) {
  const params = { image_url: imageUrl, access_token: config.igAccessToken };
  if (story) params.media_type = 'STORIES';
  if (carouselChild) params.is_carousel_item = 'true';
  if (caption) params.caption = caption;
  const { id } = await graphPost(`${igId}/media`, params);
  return id;
}
async function publishContainer(igId, creationId) {
  const { id } = await graphPost(`${igId}/media_publish`, { creation_id: creationId, access_token: config.igAccessToken });
  return id;
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
  for (const target of post.targets || [post.type]) {
    const ids = await publishTarget(igId, target, imageUrls, post.caption);
    allIds.push(...ids);
  }
  let permalink = null;
  if (allIds[0] && (post.targets || []).includes('feed')) {
    try {
      const d = await graphGet(`${GRAPH}/${allIds[0]}?fields=permalink&access_token=${encodeURIComponent(config.igAccessToken)}`);
      permalink = d.permalink || null;
    } catch { /* stories / no permalink */ }
  }
  return { ids: allIds, permalink };
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
    const { ids, permalink } = await publishPost(p);
    p.status = 'posted';
    p.postedAt = new Date().toISOString();
    p.resultIds = ids;
    p.permalink = permalink;
    p.error = null;
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
        const { ids, permalink } = await publishPost(p);
        p.status = 'posted';
        p.postedAt = new Date().toISOString();
        p.resultIds = ids;
        p.permalink = permalink;
        p.error = null;
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
