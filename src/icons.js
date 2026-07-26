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

const MIME_EXT = new Map([
  ['image/png', 'png'],
  ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'],
  ['image/svg+xml', 'svg'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

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

/**
 * Deletes cached icons no link references any more. Runs after deletes and
 * edits so data/icons/ cannot grow without bound.
 */
export async function collectGarbage(links) {
  const inUse = new Set(
    links.filter((l) => l.icon?.type === 'file').map((l) => l.icon.value)
  );
  const now = Date.now();

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
