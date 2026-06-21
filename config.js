// Slim config for the standalone 24/7 autoresponder. Everything sensitive comes
// from environment variables (set in your host's dashboard, never committed).
import 'dotenv/config';
import path from 'node:path';

const root = process.cwd();

export const config = {
  port: Number(process.env.PORT) || 8787,

  // Claude (the bot's brain)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',

  // Instagram connection (from your Meta app)
  igVerifyToken: process.env.IG_VERIFY_TOKEN || 'jarvis-secret-handshake',
  igAppSecret: process.env.IG_APP_SECRET || '',
  igAccessToken: process.env.IG_ACCESS_TOKEN || '',
  igGraphBase: process.env.IG_GRAPH_BASE || 'https://graph.instagram.com/v21.0',

  // Local data files (offers/keywords/settings + conversations + leads)
  autoresponderFile: path.join(root, 'data', 'autoresponder.json'),
  conversationsFile: path.join(root, 'data', 'ig-conversations.json'),
  leadsFile: path.join(root, 'data', 'ig-leads.json'),
  analyticsFile: path.join(root, 'data', 'ig-analytics.json'),

  // Public URL of THIS bot — used to build tracked redirect links (/go/:id).
  publicBase: process.env.PUBLIC_BASE || process.env.PUBLIC_BASE_URL || 'https://mmp-autoresponder.onrender.com',

  // ── Auto-Poster (schedule posts to feed + story) ──
  // Cloudinary = free image hosting. It gives Instagram a public link to each
  // photo (Instagram fetches images by URL; it can't read our server's disk).
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
  // Upstash Redis = free permanent storage for the schedule itself, so queued
  // posts survive the free host restarting/sleeping.
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',

  // Google Photos (where Jeff keeps his posts) — the Photos Picker API. He picks
  // photos in Google's own picker; we pull the chosen ones straight in.
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  // Public URL of THIS app (for the OAuth redirect back). Falls back to the
  // known Render URL if not set explicitly.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://mmp-autoresponder.onrender.com',
};
