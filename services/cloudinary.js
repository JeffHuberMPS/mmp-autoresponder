// ── Photo hosting for the Auto-Poster (Cloudinary, free) ────────────────
// Instagram publishes a photo by FETCHING it from a public web link — it can't
// read bytes off our server. Cloudinary stores each uploaded photo permanently
// and hands back a public https link we pass straight to Instagram.
//
// We talk to Cloudinary's REST API directly with a signed request (a SHA-1 of
// the parameters + your API secret), so there's no extra library to install.

import crypto from 'node:crypto';
import { config } from '../config.js';

export function cloudinaryConfigured() {
  return Boolean(config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret);
}

// Cloudinary wants the signed params joined alphabetically as `k=v&k=v`, then
// the API secret appended, hashed with SHA-1.
function sign(params) {
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(toSign + config.cloudinaryApiSecret).digest('hex');
}

// Upload one image. `dataUri` is a base64 data URL (data:image/...;base64,XXXX).
// Returns the permanent public URL + the id we use to delete it later.
export async function uploadImage(dataUri, { folder = 'mmp-poster' } = {}) {
  if (!cloudinaryConfigured()) throw new Error('Photo storage (Cloudinary) is not set up yet');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign({ folder, timestamp });
  const form = new URLSearchParams();
  form.set('file', dataUri);
  form.set('api_key', config.cloudinaryApiKey);
  form.set('timestamp', String(timestamp));
  form.set('folder', folder);
  form.set('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.secure_url) throw new Error(data?.error?.message || `Cloudinary HTTP ${res.status}`);
  return { url: data.secure_url, publicId: data.public_id, bytes: data.bytes, width: data.width, height: data.height };
}

// Best-effort cleanup of a photo after it's posted (keeps the free tier tidy).
export async function deleteImage(publicId) {
  if (!cloudinaryConfigured() || !publicId) return;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = sign({ public_id: publicId, timestamp });
    const form = new URLSearchParams({
      public_id: publicId,
      api_key: config.cloudinaryApiKey,
      timestamp: String(timestamp),
      signature,
    });
    await fetch(`https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    /* not important enough to fail anything */
  }
}
