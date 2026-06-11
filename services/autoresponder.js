// ── The Autoresponder Agent ──────────────────────────────────────────
// This is the "brain" that decides what to reply to every Instagram DM.
// It is deliberately smarter than ManyChat's free tier:
//   • Keyword rules    — instant canned replies (like ManyChat), checked first.
//   • Real AI (Claude) — understands messages that don't match a rule, instead
//                        of dead-ending with "Sorry, I didn't get that".
//   • Memory           — remembers each person's conversation.
//   • Human handoff    — backs off automatically when YOU reply by hand.
//   • Lead capture     — tags interested people and saves them for you.
//   • Business hours   — sends an away message when you're off the clock.
// All settings live in server/data/autoresponder.json, which you can edit in
// plain English (or through the dashboard) — no code required.

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { userFollowsBusiness, sendMessage } from './instagram.js';

// ── Default settings, written to disk the first time the app runs. This is the
// stuff you'll personalize: your business, your tone, your canned replies.
const DEFAULT_SETTINGS = {
  enabled: true, // master on/off switch for the whole autoresponder
  businessName: 'My Business',
  // The personality + knowledge the AI uses. Write this like you'd brief a new
  // employee answering your DMs. The more you put here, the better it answers.
  persona:
    "You are the friendly Instagram assistant for this business. Be warm, " +
    "concise, and helpful. Keep replies short (1-3 sentences) like a real DM. " +
    "Use the person's name if you know it. Never make up prices, links, or " +
    "facts you weren't given — if you don't know, offer to have a human follow up.",
  // Facts the AI can rely on (prices, hours, links, policies, FAQs). Plain text.
  knowledge:
    "Example facts (edit these!):\n" +
    "- We reply within a few hours.\n" +
    "- Our website is https://example.com\n" +
    "- To book, send the word BOOK and we'll share the link.",
  // Instant keyword replies, checked before the AI. `match` words are matched
  // case-insensitively against the message. `mode`: 'contains' or 'exact'.
  rules: [
    { match: ['price', 'pricing', 'cost', 'how much'], mode: 'contains',
      reply: "Great question! Our pricing depends on what you need — tell me a bit about what you're after and I'll point you the right way. 💛" },
    { match: ['link', 'website', 'shop'], mode: 'contains',
      reply: "Here's our site: https://example.com 🌐" },
    { match: ['book', 'booking', 'appointment'], mode: 'contains',
      reply: "Love it! You can book right here: https://example.com/book 📅" },
  ],
  // Sent for the very first message someone ever sends you.
  greetFirstTime: true,
  greeting: "Hey! 👋 Thanks for the message — how can I help you today?",
  // Away message when outside business hours (set businessHours.enabled true).
  businessHours: {
    enabled: false,
    // 24-hour clock, server local time. days: 0=Sun ... 6=Sat.
    start: 9, end: 18, days: [1, 2, 3, 4, 5],
    awayMessage:
      "Thanks for reaching out! We're away right now but we'll get back to " +
      "you first thing during business hours. 🙏",
  },
  // When you reply to someone by hand in Instagram, the bot goes quiet for this
  // many minutes so it doesn't talk over you. 0 disables handoff.
  handoffMinutes: 60,
  // Words a person can send to permanently stop the bot for themselves.
  stopWords: ['stop', 'unsubscribe', 'human', 'agent', 'real person'],
  // How many past turns of each conversation to give the AI as memory.
  memoryTurns: 12,

  // ── OFFERS: the things you sell/give away. Each has a delivery link (Gumroad,
  // a landing page, etc.) that the bot sends when its keyword is triggered. ──
  offers: [
    {
      id: 'discipline-bundle',
      name: 'Tracker + 7-Day Discipline Reset',
      description: 'The MMP tracker bundle plus the free 7-Day Discipline Reset.',
      link: '', // ← paste your Gumroad link here (or add it in the dashboard)
    },
  ],
  // ── KEYWORDS: comment/DM a trigger word → bot auto-sends that offer's link.
  // This is the ManyChat-style "comment SLEEP, get the link" automation. ──
  keywords: [
    {
      trigger: 'sleep',
      offerId: 'discipline-bundle',
      message: "Here's your 7-Day Discipline Reset + the tracker bundle 👇",
    },
  ],

  // ── FLOW: the first thing a new DMer sees — a question with tappable buttons.
  // Each option either delivers an OFFER (optionally behind a follow-gate) or
  // sends a LINK. This is the "comment → must follow → get the link" funnel. ──
  flow: {
    enabled: true,
    // Gate EVERYTHING behind a follow: no matter which option they pick, if they
    // don't follow you yet, they must follow before the bot delivers anything.
    requireFollow: true,
    // Shown on the very first message, with the options below as buttons.
    question: "Welcome to MMP 🔥 What are you here for?",
    options: [
      {
        title: '7-Day Discipline Reset',
        payload: 'RESET',
        action: 'offer',
        offerId: 'discipline-bundle',
        requireFollow: true, // they must follow before the link is sent
      },
      {
        title: 'MPS Trackers',
        payload: 'TRACKERS',
        action: 'link',
        link: 'https://modular-performance.com',
        requireFollow: false,
        message:
          "The MPS Trackers are our apps for workouts, habits, recovery, and money — built to keep you disciplined. Take a look 👇",
      },
    ],
    // Sent when a follow-gated option is chosen but they don't follow yet.
    followMessage:
      "Almost there! 🔒 Make sure you're following @modern.man.protocol, then reply DONE and I'll send it straight over.",
    // Sent right before the link once we've confirmed they follow.
    followConfirmed: "Locked in. 💪 Here you go:",
    handle: 'modern.man.protocol',
  },

  // ── FOLLOW-UPS: nudge people who engaged but never grabbed anything. Sent a
  // few days later (inside Instagram's 7-day window) with compelling copy. ──
  followups: {
    enabled: true,
    delayHours: 72,   // first nudge ~3 days after their last message
    intervalHours: 48, // additional nudges this far apart (if more than one)
    withinDays: 7,    // never message past IG's 7-day window
    // One entry = one nudge. Add more for a sequence. Edit the copy freely.
    messages: [
      "Hey 👋 you stopped by but never grabbed anything — and honestly, that's the exact move that keeps most guys exactly where they are. The 7-Day Discipline Reset rebuilds your mornings, focus, and follow-through in a week, for $0. No catch. Reply RESET and follow @modern.man.protocol and I'll send it straight over. Don't let another week run you. 💪",
    ],
  },

  // ── UPSELLS: after someone GRABS an offer, check in a few days later and softly
  // present the next step. Timed from when they grabbed it. Stays inside IG's
  // 7-day window (so delayHours must be < ~160). ──
  upsells: {
    enabled: true,
    withinDays: 7,
    steps: [
      {
        id: 'reset-to-fullapp',
        offerId: 'discipline-bundle',
        delayHours: 144, // ~6 days — day 7 is the edge of IG's window
        message:
          "How's the 7-Day Reset treating you? 🔥 Quick heads up — the Reset gets you the Habit tracker. The full MMP app stacks your workouts, finances, and sleep + recovery on top, all in one place. You can start it free or upgrade for the full toolkit whenever — no pressure, just didn't want you to miss that it's an option 👉 https://modular-performance.com",
      },
    ],
  },

  // ── COMMENT AUTOMATION: when someone comments on a post, auto-DM them and drop
  // them into the funnel (the #1 growth move). publicReply also posts under their
  // comment to prompt them to check DMs (blank = skip). ──
  commentAutomation: {
    enabled: true,
    publicReply: "Just sent you a DM 📩",
    // Default = every comment on any post triggers a DM. (Can scope to a specific
    // post or keyword later if you want.)
  },
};

// ── Tiny JSON file helpers (load-or-default, atomic-ish save). ──
function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`  ⚠ could not read ${file}: ${e.message}`);
  }
  return fallback;
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Settings are cached but always re-read if the file changed underneath us, so
// edits in the dashboard or text editor take effect without a restart.
let _settings = null;
export function getSettings() {
  if (!_settings) {
    _settings = readJson(config.autoresponderFile, null);
    if (!_settings) {
      _settings = DEFAULT_SETTINGS;
      writeJson(config.autoresponderFile, _settings);
    } else {
      // Migration: make sure newer fields (offers/keywords) exist on older files.
      let changed = false;
      if (!Array.isArray(_settings.offers)) { _settings.offers = DEFAULT_SETTINGS.offers; changed = true; }
      if (!Array.isArray(_settings.keywords)) { _settings.keywords = DEFAULT_SETTINGS.keywords; changed = true; }
      if (!_settings.flow) { _settings.flow = DEFAULT_SETTINGS.flow; changed = true; }
      if (!_settings.followups) { _settings.followups = DEFAULT_SETTINGS.followups; changed = true; }
      if (!_settings.upsells) { _settings.upsells = DEFAULT_SETTINGS.upsells; changed = true; }
      if (!_settings.commentAutomation) { _settings.commentAutomation = DEFAULT_SETTINGS.commentAutomation; changed = true; }
      if (changed) writeJson(config.autoresponderFile, _settings);
    }
  }
  return _settings;
}

// ── Offers + Keywords accessors (used by the dashboard + the bot). ──
export function getOffers() { return getSettings().offers || []; }
export function getKeywords() { return getSettings().keywords || []; }
export function getCommentAutomation() { return getSettings().commentAutomation || { enabled: false }; }
export function saveOffers(offers) { return saveSettings({ offers: Array.isArray(offers) ? offers : [] }); }
export function saveKeywords(keywords) { return saveSettings({ keywords: Array.isArray(keywords) ? keywords : [] }); }
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  _settings = next;
  writeJson(config.autoresponderFile, next);
  return next;
}

// ── Conversation store: a map of contactId → { history, name, tags, ... }. ──
function loadConversations() {
  return readJson(config.conversationsFile, {});
}
function saveConversations(convos) {
  writeJson(config.conversationsFile, convos);
}
export function getConversation(contactId) {
  return loadConversations()[contactId] || null;
}
export function listConversations() {
  const convos = loadConversations();
  return Object.entries(convos)
    .map(([id, c]) => ({ contactId: id, ...c }))
    .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
}

// ── Leads: people the AI flagged as interested. Saved for you to follow up. ──
function saveLead(lead) {
  const leads = readJson(config.leadsFile, []);
  const existing = leads.find((l) => l.contactId === lead.contactId);
  if (existing) Object.assign(existing, lead);
  else leads.push(lead);
  writeJson(config.leadsFile, leads);
}
export function listLeads() {
  return readJson(config.leadsFile, []);
}

// Track texts we just sent, so the matching "echo" webhook from Instagram is
// recognized as the bot (ignored) vs. you typing by hand (triggers handoff).
const recentlySent = new Set();
export function rememberSent(text) {
  recentlySent.add(text);
  // keep it small; entries are short-lived
  if (recentlySent.size > 200) recentlySent.clear();
}

function withinBusinessHours(s) {
  const bh = s.businessHours;
  if (!bh?.enabled) return true;
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  if (!bh.days.includes(day)) return false;
  return hour >= bh.start && hour < bh.end;
}

function matchRule(rules, text) {
  const t = text.toLowerCase();
  for (const r of rules || []) {
    const words = (r.match || []).map((w) => w.toLowerCase());
    const hit =
      r.mode === 'exact'
        ? words.includes(t.trim())
        : words.some((w) => t.includes(w));
    if (hit) return r;
  }
  return null;
}

// Keyword → offer: if the message contains a trigger word, return the matching
// offer so the bot can auto-send its delivery link (the "comment SLEEP" play).
function matchKeyword(s, text) {
  const t = text.toLowerCase();
  for (const k of s.keywords || []) {
    const trig = String(k.trigger || '').toLowerCase().trim();
    if (!trig) continue;
    if (t.includes(trig)) {
      const offer = (s.offers || []).find((o) => o.id === k.offerId) || null;
      return { keyword: k, offer };
    }
  }
  return null;
}

// Build the reply that delivers an offer's link.
function offerReply(prefix, keyword, offer) {
  const intro = keyword.message || `Here you go — ${offer.name}:`;
  const body = offer.link ? offer.link : '(link coming soon — ask me again shortly!)';
  return (prefix + intro + '\n' + body).trim();
}

// Did the person pick a menu option? Match a tapped-button payload first, then
// their typed text against the option titles/payloads.
function resolveChoice(flow, text, payload) {
  const opts = (flow && flow.options) || [];
  if (payload) {
    const byPayload = opts.find((o) => o.payload === payload);
    if (byPayload) return byPayload;
  }
  const t = (text || '').toLowerCase().trim();
  if (!t) return null;
  return (
    opts.find((o) => t === o.title.toLowerCase()) ||
    opts.find((o) => o.payload && t === o.payload.toLowerCase()) ||
    opts.find((o) => o.title.length > 4 && t.includes(o.title.toLowerCase())) ||
    null
  );
}

// Buttons to attach to the menu question (title + payload for each option).
function menuButtons(flow) {
  return ((flow && flow.options) || []).map((o) => ({ title: o.title, payload: o.payload }));
}

// Does this offer get the follow-gate (per the flow config)?
function offerRequiresFollow(s, offerId) {
  const opts = (s.flow && s.flow.options) || [];
  return opts.some((o) => o.action === 'offer' && o.offerId === offerId && o.requireFollow);
}

// Actually deliver a chosen option's payload: an offer's link, or a website link.
// `confirmed` = we just verified a follow, so we lead with the "Locked in" line.
function executeChoice(s, convo, contactId, now, choice, confirmed) {
  if (choice.action === 'offer') {
    const offer = (s.offers || []).find((o) => o.id === choice.offerId);
    if (!offer) return { reply: "Hmm, that offer isn't set up yet.", via: 'offer-missing' };
    convo.tags = Array.from(new Set([...(convo.tags || []), 'offer:' + choice.offerId]));
    convo.offerGrabbedAt = { ...(convo.offerGrabbedAt || {}), [choice.offerId]: now }; // time the upsell from here
    saveLead({ contactId, name: convo.name, interest: 'wants ' + offer.name, tag: 'offer-' + choice.offerId, at: now });
    const intro = confirmed ? (s.flow?.followConfirmed || 'Here you go:') : (choice.message || `Here you go — ${offer.name}:`);
    return { reply: (intro + '\n' + (offer.link || '(link coming soon)')).trim(), via: 'offer', offer: choice.offerId };
  }
  // action === 'link'
  convo.tags = Array.from(new Set([...(convo.tags || []), 'picked:' + (choice.payload || 'link')]));
  const intro = confirmed ? (s.flow?.followConfirmed || '') : (choice.message || '');
  return { reply: ((intro ? intro + '\n' : '') + (choice.link || '')).trim(), via: 'link' };
}

// Gate a chosen option behind a follow (when the flow requires it), then deliver.
// If they don't follow yet, remembers the choice and asks them to follow first.
// Graceful: only HARD-blocks when Instagram explicitly says is_user_follow_business=false.
async function gateAndDeliver(s, convo, contactId, now, choice, justFollowed = false) {
  const mustFollow = !!(s.flow?.requireFollow || choice.requireFollow);
  if (mustFollow) {
    const follows = await userFollowsBusiness(contactId);
    if (follows === false) {
      convo.stage = 'awaitFollow';
      convo.pendingChoice = choice;
      return { reply: s.flow?.followMessage || 'Follow me first and I will send it over.', via: 'gate-follow' };
    }
  }
  convo.stage = null;
  convo.pendingChoice = null;
  return executeChoice(s, convo, contactId, now, choice, justFollowed);
}

// ── The AI agent. Builds a system prompt from your settings + this person's
// history, gives Claude two tools (flag a lead, ask for a human), and returns
// the reply text plus any actions it took.
let _client = null;
function ai() {
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set in .env');
  if (!_client) _client = new Anthropic({ apiKey: config.anthropicApiKey });
  return _client;
}

const AI_TOOLS = [
  {
    name: 'capture_lead',
    description:
      'Call this when the person shows clear buying interest, asks to purchase, ' +
      'requests a quote, or shares contact details. Saves them as a lead to follow up.',
    input_schema: {
      type: 'object',
      properties: {
        interest: { type: 'string', description: 'What they want, in a few words.' },
        name: { type: 'string', description: "The person's name if they gave it." },
        tag: { type: 'string', description: 'A short label, e.g. "hot-lead", "pricing", "booking".' },
      },
      required: ['interest'],
    },
  },
  {
    name: 'request_human',
    description:
      'Call this when the question is sensitive, a complaint, or something you ' +
      "genuinely cannot answer from the knowledge you were given. Flags it for a human.",
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why a human is needed.' } },
      required: ['reason'],
    },
  },
];

function systemPrompt(s, convo) {
  return [
    `You are the Instagram DM assistant for "${s.businessName}".`,
    '',
    'PERSONALITY & RULES:',
    s.persona,
    '',
    'WHAT YOU KNOW (only state facts from here — never invent prices/links):',
    s.knowledge,
    '',
    convo?.name ? `The person you're talking to is named ${convo.name}.` : '',
    convo?.tags?.length ? `Tags on this contact: ${convo.tags.join(', ')}.` : '',
    '',
    'FORMAT: reply like a real Instagram DM — short, friendly, natural. No markdown.',
    'If they show buying interest, call capture_lead. If you truly cannot answer, call request_human and tell them a person will follow up.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function aiReply(s, convo, text) {
  const anthropic = ai();
  const history = (convo?.history || []).slice(-s.memoryTurns).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const messages = [...history, { role: 'user', content: text }];
  const actions = [];

  for (let turn = 0; turn < 3; turn++) {
    const resp = await anthropic.messages.create({
      model: config.claudeModel,
      max_tokens: 350,
      system: systemPrompt(s, convo),
      tools: AI_TOOLS,
      messages,
    });
    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const reply = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      return { reply, actions };
    }
    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const tu of toolUses) {
      if (tu.name === 'capture_lead') actions.push({ type: 'lead', ...tu.input });
      if (tu.name === 'request_human') actions.push({ type: 'human', ...tu.input });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'noted' });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: "Thanks for your message! Someone will get back to you shortly. 🙏", actions };
}

// ── The main entry point. Webhook (and the test endpoint) call this with an
// incoming message. Returns { reply, ... } — or { reply: null } if the bot
// should stay silent (disabled, handed off, or the person opted out).
export async function handleIncoming(contactId, text, opts = {}) {
  const s = getSettings();
  const convos = loadConversations();
  const convo = convos[contactId] || { history: [], tags: [], firstAt: opts.now };
  const now = opts.now || new Date().toISOString();
  const result = { contactId, reply: null, actions: [], via: null };

  const finish = (extra = {}) => {
    convo.lastAt = now;
    convos[contactId] = convo;
    saveConversations(convos);
    return { ...result, ...extra };
  };

  // Master switch off → silent.
  if (!s.enabled) return finish({ via: 'disabled' });

  // Person previously opted out → stay silent forever.
  if (convo.optedOut) return finish({ via: 'opted-out' });

  // They're asking for a human / to stop.
  if ((s.stopWords || []).some((w) => text.toLowerCase().includes(w.toLowerCase()))) {
    convo.optedOut = true;
    convo.tags = Array.from(new Set([...(convo.tags || []), 'wants-human']));
    convo.history.push({ role: 'user', content: text, at: now });
    saveLead({ contactId, name: convo.name, interest: 'asked for a human', tag: 'wants-human', at: now });
    const reply = "No problem — I'll have a real person take it from here. 🙏";
    convo.history.push({ role: 'assistant', content: reply, at: now });
    return finish({ reply, via: 'handoff-requested' });
  }

  // You replied by hand recently → don't talk over you.
  if (convo.handoffUntil && convo.handoffUntil > now) return finish({ via: 'human-active' });

  // Record the incoming message.
  convo.history.push({ role: 'user', content: text, at: now });

  // ── FLOW: the menu + follow-gate funnel (runs first when enabled) ──
  if (s.flow?.enabled) {
    // (a) Waiting for them to follow → re-check, then deliver what they wanted
    //     (whatever they originally picked — offer OR website).
    if (convo.stage === 'awaitFollow' && convo.pendingChoice) {
      const res = await gateAndDeliver(s, convo, contactId, now, convo.pendingChoice, true);
      convo.history.push({ role: 'assistant', content: res.reply, at: now });
      return finish(res);
    }
    // (b) They picked an option (tapped a button or typed its name) → gate + deliver.
    const choice = resolveChoice(s.flow, text, opts.payload);
    if (choice) {
      convo.greeted = true;
      const res = await gateAndDeliver(s, convo, contactId, now, choice);
      convo.history.push({ role: 'assistant', content: res.reply, at: now });
      return finish(res);
    }
    // (c) First contact (menu not shown yet) → show the question + buttons.
    if (!convo.menuShown) {
      convo.greeted = true;
      convo.menuShown = true;
      const reply = s.flow.question;
      convo.history.push({ role: 'assistant', content: reply, at: now });
      return finish({ reply, via: 'menu', quickReplies: menuButtons(s.flow) });
    }
    // Otherwise (returning user, said something off-menu) → fall through to AI.
  }

  // First-ever message → optional greeting (prepended to whatever we answer).
  const isFirst = !convo.greeted;
  let prefix = '';
  if (isFirst && s.greetFirstTime) {
    prefix = s.greeting + '\n\n';
    convo.greeted = true;
  }

  // Outside business hours → away message (still records the lead context).
  if (!withinBusinessHours(s)) {
    const reply = (prefix + s.businessHours.awayMessage).trim();
    convo.history.push({ role: 'assistant', content: reply, at: now });
    return finish({ reply, via: 'away' });
  }

  // Keyword → OFFER: send the delivery link (the money path) — behind the same
  // follow-gate as the menu.
  const kw = matchKeyword(s, text);
  if (kw && kw.offer) {
    const choice = {
      action: 'offer',
      offerId: kw.offer.id,
      message: kw.keyword.message,
      requireFollow: !!(s.flow?.enabled && (s.flow?.requireFollow || offerRequiresFollow(s, kw.offer.id))),
    };
    const res = await gateAndDeliver(s, convo, contactId, now, choice);
    convo.history.push({ role: 'assistant', content: res.reply, at: now });
    return finish(res);
  }

  // Keyword rule → instant canned reply.
  const rule = matchRule(s.rules, text);
  if (rule) {
    const reply = (prefix + rule.reply).trim();
    convo.history.push({ role: 'assistant', content: reply, at: now });
    return finish({ reply, via: 'rule' });
  }

  // Otherwise → real AI.
  const { reply: aiText, actions } = await aiReply(s, convo, text);
  const reply = (prefix + aiText).trim();
  convo.history.push({ role: 'assistant', content: reply, at: now });

  // Apply any actions the AI took (lead capture / human flag).
  for (const a of actions) {
    if (a.type === 'lead') {
      if (a.name) convo.name = a.name;
      if (a.tag) convo.tags = Array.from(new Set([...(convo.tags || []), a.tag]));
      saveLead({ contactId, name: a.name || convo.name, interest: a.interest, tag: a.tag, at: now });
    }
    if (a.type === 'human') {
      convo.tags = Array.from(new Set([...(convo.tags || []), 'needs-human']));
      saveLead({ contactId, name: convo.name, interest: a.reason, tag: 'needs-human', at: now });
    }
  }

  return finish({ reply, via: 'ai', actions });
}

// Called when an "echo" webhook arrives — a message sent FROM your account. If
// it wasn't sent by the bot, it was YOU typing by hand → trigger handoff.
export function handleEcho(contactId, text) {
  if (recentlySent.has(text)) return { handoff: false }; // it was the bot
  const s = getSettings();
  if (!s.handoffMinutes) return { handoff: false };
  const convos = loadConversations();
  const convo = convos[contactId] || { history: [], tags: [] };
  const until = new Date(Date.now() + s.handoffMinutes * 60_000).toISOString();
  convo.handoffUntil = until;
  convo.history.push({ role: 'assistant', content: text, at: new Date().toISOString(), byHuman: true });
  convos[contactId] = convo;
  saveConversations(convos);
  return { handoff: true, until };
}

// ── FOLLOW-UP NUDGES ─────────────────────────────────────────────────
// Did this person already grab something (so we should NOT keep nudging)?
function isConverted(convo) {
  return (convo.tags || []).some((t) => t.startsWith('offer:') || t.startsWith('picked:'));
}
// Timestamp (ms) of their last message FROM them (not the bot).
function lastUserAtMs(convo) {
  for (let i = (convo.history || []).length - 1; i >= 0; i--) {
    if (convo.history[i].role === 'user') return Date.parse(convo.history[i].at) || 0;
  }
  return convo.firstAt ? Date.parse(convo.firstAt) || 0 : 0;
}

// Decide the ONE message (if any) that's due for a contact right now. Checks the
// post-offer UPSELL first, then the no-grab NUDGE. Returns {text, mark} or null.
function dueMessage(s, convo, lastUser, now) {
  const HOUR = 3600_000;
  const ageUserH = (now - lastUser) / HOUR;

  // 1) UPSELL — they grabbed an offer; check in a few days later (timed from the grab).
  const up = s.upsells;
  if (up?.enabled && Array.isArray(up.steps)) {
    convo.sentUpsells = convo.sentUpsells || [];
    if (ageUserH <= (up.withinDays || 7) * 24) {
      for (const step of up.steps) {
        if (convo.sentUpsells.includes(step.id)) continue;
        if (!(convo.tags || []).includes('offer:' + step.offerId)) continue;
        const grabbedMs = convo.offerGrabbedAt?.[step.offerId] ? Date.parse(convo.offerGrabbedAt[step.offerId]) : lastUser;
        if ((now - grabbedMs) / HOUR < step.delayHours) continue;
        return { text: step.message, kind: 'upsell:' + step.id, mark: () => convo.sentUpsells.push(step.id) };
      }
    }
  }

  // 2) NUDGE — they engaged but grabbed nothing.
  const fu = s.followups;
  if (fu?.enabled && Array.isArray(fu.messages) && fu.messages.length && !isConverted(convo)) {
    if (ageUserH <= (fu.withinDays || 7) * 24) {
      const count = convo.nudgeCount || 0;
      if (count < fu.messages.length) {
        const dueAfterH = count === 0 ? fu.delayHours : fu.delayHours + count * (fu.intervalHours || 48);
        const sinceLastH = convo.lastNudgeAt ? (now - Date.parse(convo.lastNudgeAt)) / HOUR : Infinity;
        if (ageUserH >= dueAfterH && (count === 0 || sinceLastH >= (fu.intervalHours || 48))) {
          return { text: fu.messages[count], kind: 'nudge:' + (count + 1), mark: () => { convo.nudgeCount = count + 1; } };
        }
      }
    }
  }
  return null;
}

// Find everyone due for a nudge/upsell and send it. Safe to call often (timer or
// external cron) — only sends when due, and at most ONE message per person per run.
export async function runFollowups(opts = {}) {
  const s = getSettings();
  if (!s.followups?.enabled && !s.upsells?.enabled) return { ran: true, sent: 0, reason: 'disabled' };
  const now = opts.now || Date.now();
  const convos = loadConversations();
  let sent = 0;
  const detail = [];

  for (const [contactId, convo] of Object.entries(convos)) {
    if (convo.optedOut) continue;            // they asked for a human / to stop
    const lastUser = lastUserAtMs(convo);
    if (!lastUser) continue;
    const due = dueMessage(s, convo, lastUser, now);
    if (!due) continue;
    try {
      rememberSent(due.text); // so the echo isn't mistaken for Jeff typing
      await sendMessage(contactId, due.text, null, { humanAgent: true });
      due.mark();
      convo.lastNudgeAt = new Date(now).toISOString();
      convo.history.push({ role: 'assistant', content: due.text, at: convo.lastNudgeAt, drip: due.kind });
      sent++;
      detail.push({ contactId, kind: due.kind });
    } catch (e) {
      detail.push({ contactId, error: e.message });
    }
  }
  if (sent) saveConversations(convos);
  return { ran: true, sent, detail };
}
