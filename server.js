// ── MMP Instagram Autoresponder — standalone 24/7 server ──────────────
// A lightweight version of the Jarvis autoresponder that runs on a cloud host
// so it replies to Instagram DMs even when your laptop is off. It only contains
// the Instagram + autoresponder logic (no dashboard/finance/etc.), so it's small
// and reliable to deploy.

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import {
  verifyWebhook, verifySignature, parseEvents, sendMessage, sendPrivateReply, replyToComment, instagramLive, getAccountInfo,
} from './services/instagram.js';
import {
  handleIncoming, handleEcho, rememberSent, getSettings, saveSettings,
  listConversations, getConversation, listLeads,
  getOffers, getKeywords, saveOffers, saveKeywords, runFollowups, getCommentAutomation,
} from './services/autoresponder.js';
import * as poster from './services/poster.js';
import * as gphotos from './services/googlePhotos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
// Generous limit so the auto-poster can receive full-size photos (base64).
app.use(express.json({ limit: '30mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, err, code = 500) => res.status(code).json({ ok: false, error: err?.message || String(err) });

process.on('uncaughtException', (err) => console.error('⚠ uncaught:', err?.message || err));
process.on('unhandledRejection', (err) => console.error('⚠ unhandled rejection:', err?.message || err));

// Comment → auto-DM. Someone comments → DM them the funnel + optional public reply.
const _seenComments = new Set();
async function handleCommentEvent(ev) {
  const cfg = getCommentAutomation();
  if (!cfg.enabled) return;
  if (ev.accountId && ev.contactId === ev.accountId) return; // our own comment
  if (_seenComments.has(ev.commentId)) return;
  _seenComments.add(ev.commentId);
  if (_seenComments.size > 500) _seenComments.clear();
  try {
    const result = await handleIncoming(ev.contactId, ev.text, {});
    if (result.reply) {
      rememberSent(result.reply);
      await sendPrivateReply(ev.commentId, result.reply, result.quickReplies).catch((e) => console.error('⚠ comment DM failed:', e.message));
    }
    if (cfg.publicReply) await replyToComment(ev.commentId, cfg.publicReply).catch((e) => console.error('⚠ public reply failed:', e.message));
  } catch (e) {
    console.error('⚠ comment automation error:', e.message);
  }
}

// Health check (hosts ping this).
app.get('/health', (req, res) => ok(res, { status: 'online', instagramLive: instagramLive() }));
app.get('/', (req, res) => res.redirect('/ig'));

// ── Instagram webhook (the doorbell) ──
app.get('/webhook/instagram', (req, res) => {
  const challenge = verifyWebhook(req.query);
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post('/webhook/instagram', async (req, res) => {
  if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) return res.sendStatus(403);
  res.sendStatus(200); // ACK fast, then process
  try {
    for (const ev of parseEvents(req.body)) {
      if (ev.type === 'echo') { handleEcho(ev.contactId, ev.text); continue; }
      if (ev.type === 'comment') { await handleCommentEvent(ev); continue; }
      const result = await handleIncoming(ev.contactId, ev.text, { payload: ev.payload });
      if (result.reply) {
        rememberSent(result.reply);
        await sendMessage(ev.contactId, result.reply, result.quickReplies).catch((e) => console.error('⚠ IG send failed:', e.message));
      }
    }
  } catch (err) {
    console.error('⚠ webhook processing error:', err.message);
  }
  // Any activity also fires due follow-up nudges (baseline; a cron makes it punctual).
  runFollowups().catch(() => {});
});

// ── Control Center APIs ──
app.post('/api/autoresponder/test', async (req, res) => {
  try {
    const { text, contactId = 'test-user', payload } = req.body || {};
    if ((!text || !text.trim()) && !payload) return fail(res, new Error('Send some text to test with'), 400);
    ok(res, await handleIncoming(contactId, (text || '').trim(), { payload }));
  } catch (err) { fail(res, err); }
});
app.get('/api/autoresponder/settings', (req, res) => ok(res, { settings: getSettings() }));
app.post('/api/autoresponder/settings', (req, res) => {
  try { ok(res, { settings: saveSettings(req.body || {}) }); } catch (err) { fail(res, err, 400); }
});
app.get('/api/autoresponder/status', (req, res) =>
  ok(res, { enabled: getSettings().enabled, instagramLive: instagramLive(), mode: instagramLive() ? 'live' : 'test' })
);
app.get('/api/autoresponder/conversations', (req, res) => ok(res, { conversations: listConversations() }));
app.get('/api/autoresponder/conversations/:id', (req, res) => ok(res, { conversation: getConversation(req.params.id) }));
app.get('/api/autoresponder/leads', (req, res) => ok(res, { leads: listLeads() }));
app.get('/api/autoresponder/offers', (req, res) => ok(res, { offers: getOffers() }));
app.post('/api/autoresponder/offers', (req, res) => {
  try { ok(res, { offers: saveOffers(req.body?.offers).offers }); } catch (err) { fail(res, err, 400); }
});
app.get('/api/autoresponder/keywords', (req, res) => ok(res, { keywords: getKeywords() }));
app.post('/api/autoresponder/keywords', (req, res) => {
  try { ok(res, { keywords: saveKeywords(req.body?.keywords).keywords }); } catch (err) { fail(res, err, 400); }
});
app.get('/api/instagram/metrics', async (req, res) => {
  res.json(await getAccountInfo().catch((e) => ({ ok: false, connected: false, error: e.message })));
});

// Follow-up nudges — run any that are due. A cron/uptime ping hits this to both
// keep the free instance awake AND fire scheduled nudges.
app.get('/api/followups/run', async (req, res) => res.json(await runFollowups().catch((e) => ({ ran: false, error: e.message }))));
app.post('/api/followups/run', async (req, res) => res.json(await runFollowups().catch((e) => ({ ran: false, error: e.message }))));
setInterval(() => { runFollowups().catch((e) => console.error('⚠ followups:', e.message)); }, 30 * 60_000);

// ── Auto-Poster (schedule posts to feed + story) ──
app.post('/api/poster/upload', async (req, res) => {
  try {
    const { name, data } = req.body || {};
    ok(res, await poster.saveUpload(name, data));
  } catch (err) { fail(res, err, 400); }
});
app.post('/api/poster/schedule', async (req, res) => {
  try { ok(res, { post: await poster.schedulePost(req.body || {}) }); }
  catch (err) { fail(res, err, 400); }
});
app.get('/api/poster/list', async (req, res) => {
  try { ok(res, await poster.listPosts()); } catch (err) { fail(res, err); }
});
app.post('/api/poster/cancel', async (req, res) => {
  try { ok(res, { post: await poster.cancelPost((req.body || {}).id) }); }
  catch (err) { fail(res, err, 400); }
});
app.post('/api/poster/publish-now', async (req, res) => {
  try { res.json(await poster.publishById((req.body || {}).id)); }
  catch (err) { fail(res, err, 400); }
});
app.get('/api/poster/status', async (req, res) => {
  try {
    const googleConnected = await gphotos.googleConnected().catch(() => false);
    ok(res, { ...poster.readiness(), googleConfigured: gphotos.googleConfigured(), googleConnected, settings: await poster.getSettings() });
  } catch (err) {
    ok(res, { ...poster.readiness(), settings: { missedGraceHours: 6 }, error: err.message });
  }
});

// ── Google Photos (pull posts straight from Jeff's library) ──
app.get('/api/google/auth', (req, res) => {
  if (!gphotos.googleConfigured()) return fail(res, new Error('Google connection not set up on the host yet'), 400);
  res.redirect(gphotos.authUrl());
});
app.get('/api/google/callback', async (req, res) => {
  try {
    if (req.query.error) return res.redirect('/poster?google=denied');
    await gphotos.handleCallback(String(req.query.code || ''));
    res.redirect('/poster?google=connected');
  } catch (err) {
    res.redirect('/poster?google=error');
  }
});
app.post('/api/google/disconnect', async (req, res) => {
  try { await gphotos.disconnect(); ok(res, { connected: false }); } catch (err) { fail(res, err); }
});
app.post('/api/google/picker/start', async (req, res) => {
  try { ok(res, await gphotos.startPicker()); } catch (err) { fail(res, err, 400); }
});
app.get('/api/google/picker/poll', async (req, res) => {
  try { ok(res, { ready: await gphotos.pollPicker(String(req.query.sessionId || '')) }); } catch (err) { fail(res, err, 400); }
});
app.post('/api/google/picker/import', async (req, res) => {
  try {
    const { sessionId, limit } = req.body || {};
    ok(res, { media: await gphotos.importPicked(String(sessionId || ''), Number(limit) || 10) });
  } catch (err) { fail(res, err, 400); }
});
app.get('/api/poster/settings', async (req, res) => {
  try { ok(res, { settings: await poster.getSettings() }); } catch (err) { fail(res, err); }
});
app.post('/api/poster/settings', async (req, res) => {
  try { ok(res, { settings: await poster.saveSettings(req.body || {}) }); }
  catch (err) { fail(res, err, 400); }
});
// External pinger hits this every few minutes: wakes the host AND fires due posts.
app.get('/api/poster/run', async (req, res) => res.json(await poster.runDuePosts().catch((e) => ({ ran: 0, error: e.message }))));
app.post('/api/poster/run', async (req, res) => res.json(await poster.runDuePosts().catch((e) => ({ ran: 0, error: e.message }))));

// ── The visual pages ──
app.get('/ig', (req, res) => res.sendFile(path.join(__dirname, 'views', 'ig.html')));
app.get('/autoresponder', (req, res) => res.sendFile(path.join(__dirname, 'views', 'ig.html')));
app.get('/poster', (req, res) => res.sendFile(path.join(__dirname, 'views', 'poster.html')));

// ── "Install on phone" support (PWA) — makes Add-to-Home-Screen give a real
// full-screen app icon, so it feels like a native app. ──
app.get('/manifest.webmanifest', (req, res) =>
  res.type('application/manifest+json').json({
    name: 'MMP Instagram',
    short_name: 'MMP',
    description: 'Auto-responder + post scheduler for Instagram',
    start_url: '/poster',
    scope: '/',
    display: 'standalone',
    background_color: '#05070b',
    theme_color: '#0b0e15',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  })
);
for (const ic of ['icon-192.png', 'icon-512.png', 'icon-180.png', 'mmp-logo.jpg']) {
  app.get(`/${ic}`, (req, res) => res.sendFile(path.join(__dirname, 'views', ic)));
}

app.listen(config.port, () => {
  const r = poster.readiness();
  console.log(`\n  🤖  MMP Autoresponder online → port ${config.port}`);
  console.log(`      Instagram: ${instagramLive() ? 'LIVE' : 'test mode (no IG token)'}`);
  console.log(`      Auto-Poster: photos ${r.photoStorage ? '✓' : '✗'}  schedule ${r.scheduleStorage ? '✓' : '✗'}`);
  if (!config.anthropicApiKey) console.log('      ⚠  ANTHROPIC_API_KEY not set');
  console.log('');
  poster.startScheduler(); // backup timer; the external pinger is the primary trigger
});
