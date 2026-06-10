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
      if (!text) continue; // ignore non-text (stickers, reactions) for now
      events.push({
        type: m.message?.is_echo ? 'echo' : 'message',
        contactId: m.message?.is_echo ? m.recipient?.id : senderId,
        text,
        raw: m,
      });
    }
    // Comments / story replies arrive under `changes` (best-effort support).
    for (const c of entry.changes || []) {
      const v = c.value || {};
      const text = v.text || v.message;
      const contactId = v.from?.id || v.sender?.id;
      if (c.field === 'comments' && text && contactId) {
        events.push({ type: 'comment', contactId, text, raw: c });
      }
    }
  }
  return events;
}

// Sends a text reply back to a person on Instagram. In test mode (no token set)
// it just logs what it WOULD send, so you can develop without a live account.
export async function sendMessage(recipientId, text) {
  if (!instagramLive()) {
    console.log(`  💬 [test mode] would reply to ${recipientId}: "${text}"`);
    return { ok: true, testMode: true };
  }
  const url = `${config.igGraphBase}/me/messages?access_token=${encodeURIComponent(
    config.igAccessToken
  )}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Instagram send failed: ${msg}`);
  }
  return { ok: true, ...data };
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
