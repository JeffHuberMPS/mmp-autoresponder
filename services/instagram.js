// ── Instagram connection layer ───────────────────────────────────────
// Talks to Meta's Graph API: verifies the webhook handshake, checks that
// incoming events are really from Meta, parses DM events, and sends replies.
// This is the piece ManyChat charges you for — here it's yours, for free.

import crypto from 'node:crypto';
import { config } from '../config.js';

// True once you've pasted your Meta access token into .env. Until then the
// autoresponder still runs in "test mode" — it composes replies but doesn't
// actually send them to Instagram (so you can try it safely first).
export function instagramLive() {
  return Boolean(config.igAccessToken);
}

// Step 1 of connecting: when you click "Verify" in the Meta dashboard, Meta
// hits this with a challenge. We echo it back IF the verify token matches the
// secret word you set. Returns the challenge string to send, or null to reject.
export function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === config.igVerifyToken) return challenge;
  return null;
}

// Confirms an incoming webhook POST really came from Meta (signed with your
// App Secret), not an impostor. Skipped automatically until you set the secret.
export function verifySignature(rawBody, signatureHeader) {
  if (!config.igAppSecret) return true; // test mode — nothing to verify against
  if (!signatureHeader || !rawBody) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.igAppSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Pulls the meaningful bits out of Meta's nested webhook payload and returns a
// flat list of events we care about: incoming DMs, plus "echoes" (messages
// sent FROM your account — used to detect when you reply by hand).
export function parseEvents(body) {
  const events = [];
  if (!body || !Array.isArray(body.entry)) return events;

  for (const entry of body.entry) {
    // Direct messages arrive under `messaging`.
    for (const m of entry.messaging || []) {
      const senderId = m.sender?.id;
      const text = m.message?.text;
      const payload = m.message?.quick_reply?.payload || null; // a tapped button
      if (!text && !payload) continue; // ignore non-text (stickers, reactions) for now
      events.push({
        type: m.message?.is_echo ? 'echo' : 'message',
        contactId: m.message?.is_echo ? m.recipient?.id : senderId,
        text: text || '',
        payload,
        raw: m,
      });
    }
    // Comments arrive under `changes` — the "comment → auto-DM" growth trigger.
    for (const c of entry.changes || []) {
      if (c.field !== 'comments') continue;
      const v = c.value || {};
      const fromId = v.from?.id;
      const commentId = v.id;
      if (!commentId || !fromId) continue;
      events.push({
        type: 'comment',
        contactId: fromId,
        commentId,
        text: v.text || '',
        username: v.from?.username || null,
        mediaId: v.media?.id || null,
        accountId: entry.id || null, // business account id — to skip our own comments
        raw: c,
      });
    }
  }
  return events;
}

// Sends a text reply back to a person on Instagram, optionally with tappable
// "quick reply" buttons. In test mode (no token set) it just logs what it WOULD
// send, so you can develop without a live account.
//   quickReplies: [{ title: '7-Day Discipline Reset', payload: 'RESET' }, ...]
export async function sendMessage(recipientId, text, quickReplies = null, opts = {}) {
  const message = { text };
  if (Array.isArray(quickReplies) && quickReplies.length) {
    message.quick_replies = quickReplies.slice(0, 13).map((q) => ({
      content_type: 'text',
      title: String(q.title).slice(0, 20), // IG limit: 20 chars per button
      payload: String(q.payload || q.title),
    }));
  }
  if (!instagramLive()) {
    const btns = message.quick_replies ? ` [buttons: ${message.quick_replies.map((q) => q.title).join(' | ')}]` : '';
    console.log(`  💬 [test mode] would reply to ${recipientId}: "${text}"${btns}`);
    return { ok: true, testMode: true };
  }
  // Follow-up nudges (sent 1-7 days later) use the HUMAN_AGENT tag, which extends
  // the messaging window from 24h to 7 days. Normal replies use RESPONSE.
  const tagging = opts.humanAgent
    ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' }
    : { messaging_type: 'RESPONSE' };
  const url = `${config.igGraphBase}/me/messages?access_token=${encodeURIComponent(config.igAccessToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message, ...tagging }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Instagram send failed: ${msg}`);
  }
  return { ok: true, ...data };
}

// Sends a DM to whoever made a comment (a "private reply"). This is the
// comment→auto-DM growth trigger. recipient is the comment id, not a user id.
export async function sendPrivateReply(commentId, text, quickReplies = null) {
  const message = { text };
  if (Array.isArray(quickReplies) && quickReplies.length) {
    message.quick_replies = quickReplies.slice(0, 13).map((q) => ({
      content_type: 'text',
      title: String(q.title).slice(0, 20),
      payload: String(q.payload || q.title),
    }));
  }
  if (!instagramLive()) {
    console.log(`  💬 [test mode] private DM to commenter (${commentId}): "${text}"`);
    return { ok: true, testMode: true };
  }
  const url = `${config.igGraphBase}/me/messages?access_token=${encodeURIComponent(config.igAccessToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Private reply failed: ${data?.error?.message || res.status}`);
  return { ok: true, ...data };
}

// Posts a PUBLIC reply under a comment (e.g. "Just sent you a DM 📩").
export async function replyToComment(commentId, text) {
  if (!instagramLive()) {
    console.log(`  💬 [test mode] public reply on comment ${commentId}: "${text}"`);
    return { ok: true, testMode: true };
  }
  const url = `${config.igGraphBase}/${encodeURIComponent(commentId)}/replies?access_token=${encodeURIComponent(config.igAccessToken)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Comment reply failed: ${data?.error?.message || res.status}`);
  return { ok: true, ...data };
}

// Looks up a person who messaged you and returns whether they follow your
// account. Returns true / false, or null if Instagram doesn't tell us (so the
// bot can fall back gracefully instead of blocking someone forever).
export async function userFollowsBusiness(igsid) {
  // Test hooks: set FORCE_NO_FOLLOW=1 (or FORCE_FOLLOW=1) to simulate follow
  // status without a real Instagram user. Off in production (env unset).
  if (process.env.FORCE_NO_FOLLOW === '1') return false;
  if (process.env.FORCE_FOLLOW === '1') return true;
  if (!instagramLive() || !igsid) return null;
  try {
    const url = `${config.igGraphBase}/${encodeURIComponent(igsid)}?fields=name,username,is_user_follow_business,follower_count&access_token=${encodeURIComponent(config.igAccessToken)}`;
    const res = await fetch(url);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`  ⚠ follow-check failed for ${igsid}: ${d?.error?.message || res.status}`);
      return null;
    }
    return typeof d.is_user_follow_business === 'boolean' ? d.is_user_follow_business : null;
  } catch (e) {
    console.error(`  ⚠ follow-check error: ${e.message}`);
    return null;
  }
}

// Pulls REAL, live account metrics straight from Instagram: the actual
// published post count, followers, and time-windowed counts (this week / month)
// computed from each post's real timestamp. This is "what's actually been done."
export async function getAccountInfo() {
  if (!instagramLive()) return { ok: false, connected: false, error: 'No Instagram token set' };
  const base = config.igGraphBase;
  const t = encodeURIComponent(config.igAccessToken);

  // Account-level numbers.
  const meRes = await fetch(
    `${base}/me?fields=user_id,username,name,account_type,profile_picture_url,media_count,followers_count,follows_count&access_token=${t}`
  );
  const me = await meRes.json();
  if (!meRes.ok) throw new Error(me?.error?.message || `me HTTP ${meRes.status}`);

  // The actual posts (most recent 50) — used for time-based counts + a feed.
  const mediaRes = await fetch(
    `${base}/me/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count&limit=50&access_token=${t}`
  );
  const mediaJson = await mediaRes.json();
  const posts = Array.isArray(mediaJson?.data) ? mediaJson.data : [];

  const now = Date.now();
  const DAY = 86400000;
  const within = (iso, days) => {
    const ts = Date.parse(iso);
    return !Number.isNaN(ts) && now - ts <= days * DAY;
  };
  const postsThisWeek = posts.filter((p) => within(p.timestamp, 7)).length;
  const postsThisMonth = posts.filter((p) => within(p.timestamp, 30)).length;
  const lastTs = posts.length ? Math.max(...posts.map((p) => Date.parse(p.timestamp) || 0)) : 0;
  const daysSinceLast = lastTs ? Math.floor((now - lastTs) / DAY) : null;

  return {
    ok: true,
    connected: true,
    username: me.username,
    name: me.name || null,
    profilePic: me.profile_picture_url || null,
    accountType: me.account_type,
    followers: me.followers_count ?? null,
    following: me.follows_count ?? null,
    totalPosts: me.media_count ?? posts.length,
    postsThisWeek,
    postsThisMonth,
    daysSinceLast,
    lastPostAt: lastTs ? new Date(lastTs).toISOString() : null,
    recent: posts.slice(0, 8).map((p) => ({
      caption: (p.caption || '').slice(0, 80),
      type: p.media_type,
      link: p.permalink,
      at: p.timestamp,
      likes: p.like_count ?? 0,
      comments: p.comments_count ?? 0,
    })),
  };
}

// Pull candidate keyword call-to-actions out of a caption — words you told people
// to comment/DM (e.g. "comment SLEEP", "type RESET", "DM 'grow'").
const CTA_STOP = new Set(['BELOW', 'NOW', 'HERE', 'THIS', 'THAT', 'AND', 'FOR', 'YOU', 'YOUR', 'THE', 'WORD', 'ME', 'MY', 'IT', 'LINK', 'BIO', 'DM', 'DMS']);
function extractKeywords(caption) {
  if (!caption) return [];
  const out = new Set();
  // verb + optional filler ("the word", "me", "below") + a CAPS word or quoted word
  const re = /\b(?:comment|type|drop|reply|dm|send|say|write|text)\b[^A-Za-z0-9"'“]*(?:the word\s+|me\s+|below\s+)?["'“]?([A-Za-z][A-Za-z0-9]{1,18})["'”]?/gi;
  let m;
  while ((m = re.exec(caption)) !== null) {
    const raw = m[1];
    // Heuristic: keep ALL-CAPS words (classic CTA style) or quoted words.
    if (raw === raw.toUpperCase() && raw.length >= 2 && !CTA_STOP.has(raw.toUpperCase())) {
      out.add(raw);
    }
  }
  return [...out];
}

// Scan every post's caption and compile the keyword CTAs you've used, with which
// posts each came from. Powers the dashboard "Scan my posts for keywords" button.
export async function scanCaptionsForKeywords() {
  if (!instagramLive()) return { ok: false, connected: false, error: 'No Instagram token set' };
  const base = config.igGraphBase;
  const t = encodeURIComponent(config.igAccessToken);
  const res = await fetch(`${base}/me/media?fields=id,caption,permalink,timestamp&limit=50&access_token=${t}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `media HTTP ${res.status}`);
  const posts = Array.isArray(data.data) ? data.data : [];
  const map = new Map();
  for (const p of posts) {
    for (const kw of extractKeywords(p.caption)) {
      const key = kw.toLowerCase();
      if (!map.has(key)) map.set(key, { keyword: key, display: kw, posts: [] });
      map.get(key).posts.push({ permalink: p.permalink, snippet: (p.caption || '').replace(/\s+/g, ' ').slice(0, 90) });
    }
  }
  const found = [...map.values()].map((x) => ({ keyword: x.keyword, display: x.display, count: x.posts.length, posts: x.posts }));
  found.sort((a, b) => b.count - a.count);
  return { ok: true, connected: true, scanned: posts.length, found };
}
