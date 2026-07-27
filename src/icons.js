import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './store.js';

/**
 * Favicons are fetched once, when an admin saves a link, and cached on disk.
 * The dashboard itself then serves them from /icons/*, so loading the page
 * never touches the network. Fetching is best-effort: if everything fails the
 * client falls back to a coloured monogram, which needs no request at all.
 */

const ICON_DIR = path.join(dataDir(), 'icons');
const FETCH_TIMEOUT_MS = 5000;
const MAX_ICON_BYTES = 256 * 1024;
const MAX_HTML_BYTES = 128 * 1024;
const GC_GRACE_MS = 60 * 1000;

export const MAX_UPLOAD_BYTES = 512 * 1024;

const MIME_EXT = new Map([
  ['image/png', 'png'],
  ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'],
  ['image/svg+xml', 'svg'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** What an admin may upload by hand. A subset of MIME_EXT, by design. */
const UPLOAD_MIME_EXT = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/svg+xml', 'svg'],
]);

/** Content-addressed names written by save(). Nothing else may be referenced. */
const CACHED_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|svg|ico|webp)$/;

export async function init() {
  await fs.mkdir(ICON_DIR, { recursive: true });
}

async function fetchWithTimeout(url, { accept, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; Dashboard/1.0)' },
    });
    if (!res.ok) return null;

    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return null;

    return { buffer, type: (res.headers.get('content-type') ?? '').split(';')[0].trim() };
  } catch {
    return null; // Timeout, DNS failure, bad TLS — all mean "no icon".
  } finally {
    clearTimeout(timer);
  }
}

/** Pulls icon hrefs out of <link rel="...icon..."> tags, largest hint first. */
function iconHrefsFromHtml(html, base) {
  const candidates = [];
  const tagPattern = /<link\b[^>]*>/gi;

  for (const [tag] of html.matchAll(tagPattern)) {
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!rel || !/\bicon\b/.test(rel)) continue;

    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;

    const size = Number(tag.match(/\bsizes\s*=\s*["'](\d+)/i)?.[1] ?? 0);
    // Prefer apple-touch-icon: it is reliably a large, square PNG.
    const bonus = rel.includes('apple-touch-icon') ? 180 : 0;

    try {
      candidates.push({ url: new URL(href, base).href, score: size + bonus });
    } catch {
      // Malformed href — skip it.
    }
  }

  return candidates.sort((a, b) => b.score - a.score).map((c) => c.url);
}

async function save(buffer, type) {
  const ext = MIME_EXT.get(type);
  if (!ext) return null;

  const name = `${createHash('sha256').update(buffer).digest('hex').slice(0, 32)}.${ext}`;
  const file = path.join(ICON_DIR, name);
  try {
    await fs.access(file); // Already cached — identical bytes, identical name.
  } catch {
    await fs.writeFile(file, buffer);
  }
  return name;
}

/**
 * Resolves the best icon for a site and caches it.
 * Returns { type: 'file', value } on success, or null if nothing was found.
 */
export async function fetchFavicon(siteUrl) {
  let origin;
  try {
    const parsed = new URL(siteUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    origin = parsed.origin;
  } catch {
    return null;
  }

  const sources = [];

  const page = await fetchWithTimeout(siteUrl, {
    accept: 'text/html,application/xhtml+xml',
    maxBytes: MAX_HTML_BYTES,
  });
  if (page?.type.startsWith('text/html')) {
    sources.push(...iconHrefsFromHtml(page.buffer.toString('utf8'), siteUrl));
  }

  sources.push(new URL('/favicon.ico', origin).href);

  for (const source of sources) {
    const icon = await fetchWithTimeout(source, {
      accept: 'image/*',
      maxBytes: MAX_ICON_BYTES,
    });
    if (!icon || !MIME_EXT.has(icon.type)) continue;
    const name = await save(icon.buffer, icon.type);
    if (name) return { type: 'file', value: name };
  }

  return null;
}

/** Caches an icon the admin supplied by URL, so it is served locally too. */
export async function cacheFromUrl(iconUrl) {
  try {
    const parsed = new URL(iconUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  const icon = await fetchWithTimeout(iconUrl, {
    accept: 'image/*',
    maxBytes: MAX_ICON_BYTES,
  });
  if (!icon || !MIME_EXT.has(icon.type)) return null;

  const name = await save(icon.buffer, icon.type);
  return name ? { type: 'file', value: name } : null;
}

// ------------------------------------------------------------------ uploads

/** Content types the upload endpoint accepts, for express.raw(). */
export function uploadTypes() {
  return [...UPLOAD_MIME_EXT.keys()];
}

/**
 * An SVG is the one upload that is also a document: served from /icons it is
 * same-origin, so a hostile one could try to script. The page CSP already
 * blocks inline script, but an icon has no legitimate need for any of this,
 * so anything active is rejected outright rather than stripped.
 */
const SVG_FORBIDDEN = [
  [/<\s*script/i, 'scripts'],
  [/<\s*foreignObject/i, 'embedded HTML'],
  [/<\s*(iframe|embed|object|animate|set)\b/i, 'embedded or animated content'],
  [/\son[a-z]+\s*=/i, 'event handlers'],
  [/(href|xlink:href|src)\s*=\s*["']?\s*(javascript|data:text\/html)/i, 'script URLs'],
  [/<!ENTITY/i, 'entity definitions'],
];

function checkSvg(buffer) {
  const text = buffer.toString('utf8');
  if (!/<svg[\s>]/i.test(text)) return 'That file is not a valid SVG.';
  for (const [pattern, what] of SVG_FORBIDDEN) {
    if (pattern.test(text)) return `That SVG contains ${what}, which is not allowed in an icon.`;
  }
  return null;
}

/** Guards against a mislabelled — or disguised — upload. */
function checkMagic(ext, buffer) {
  if (ext === 'png') {
    return buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  }
  if (ext === 'jpg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (ext === 'gif') {
    return /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('latin1'));
  }
  return true; // SVG is text; checkSvg() covers it.
}

/**
 * Stores a PNG, JPG, GIF or SVG the admin uploaded. Returns
 * { icon } on success or { error } with a message fit to show them.
 */
export async function saveUpload(buffer, contentType) {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const ext = UPLOAD_MIME_EXT.get(type);
  if (!ext) return { error: 'Icons must be a PNG, JPG, GIF or SVG.' };

  if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
    return { error: 'That file is empty.' };
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    return { error: `Icons must be ${Math.round(MAX_UPLOAD_BYTES / 1024)} kB or smaller.` };
  }
  if (!checkMagic(ext, buffer)) {
    return { error: `That file is not really a ${ext === 'jpg' ? 'JPG' : ext.toUpperCase()}.` };
  }
  if (ext === 'svg') {
    const problem = checkSvg(buffer);
    if (problem) return { error: problem };
  }

  const name = await save(buffer, type);
  if (!name) return { error: 'Could not store that icon.' };
  reserve(name);
  return { icon: { type: 'file', value: name } };
}

/**
 * Uploads land on disk before the link that references them is saved, so the
 * collector has to be told to leave them alone in between — the admin may sit
 * on a half-filled form for a while, and an unrelated edit runs a GC pass.
 */
const RESERVE_MS = 30 * 60 * 1000;
const reserved = new Map(); // name -> expiry

function reserve(name) {
  reserved.set(name, Date.now() + RESERVE_MS);
}

/** True if `name` is one of our cached icons and still on disk. */
export async function isCached(name) {
  if (typeof name !== 'string' || !CACHED_NAME.test(name)) return false;
  try {
    await fs.access(path.join(ICON_DIR, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes cached icons no link references any more. Runs after deletes and
 * edits so data/icons/ cannot grow without bound.
 */
export async function collectGarbage(links) {
  const inUse = new Set(
    links.filter((l) => l.icon?.type === 'file').map((l) => l.icon.value)
  );
  const now = Date.now();

  for (const [name, expiry] of reserved) {
    if (expiry <= now) reserved.delete(name);
    else inUse.add(name);
  }

  try {
    const files = await fs.readdir(ICON_DIR);
    await Promise.all(
      files.map(async (file) => {
        if (inUse.has(file)) return;
        // A concurrent save may have just written this icon and not yet stored
        // the link that references it. Leave anything recent alone; it will be
        // collected on a later pass if it really is unused.
        const full = path.join(ICON_DIR, file);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || now - stat.mtimeMs < GC_GRACE_MS) return;
        await fs.unlink(full).catch(() => {});
      })
    );
  } catch {
    // Cache directory missing or unreadable — nothing to clean.
  }
}

export function iconDir() {
  return ICON_DIR;
}
