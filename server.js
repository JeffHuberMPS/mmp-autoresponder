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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

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

// ── The visual Control Center page ──
app.get('/ig', (req, res) => res.sendFile(path.join(__dirname, 'views', 'ig.html')));
app.get('/autoresponder', (req, res) => res.sendFile(path.join(__dirname, 'views', 'ig.html')));

app.listen(config.port, () => {
  console.log(`\n  🤖  MMP Autoresponder online → port ${config.port}`);
  console.log(`      Instagram: ${instagramLive() ? 'LIVE' : 'test mode (no IG token)'}`);
  if (!config.anthropicApiKey) console.log('      ⚠  ANTHROPIC_API_KEY not set');
  console.log('');
});
