import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzip = promisify(zlib.gzip);

/**
 * The dashboard ships three static files. Rather than pull in a compression
 * middleware that re-gzips on every request, they are read and compressed once
 * at boot and held in memory — about 10 kB total — then served straight from
 * the cache with a strong ETag.
 */

const PUBLIC_DIR = path.resolve('public');

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

/** url path -> { raw, gz, etag, type } */
const assets = new Map();

export async function load() {
  assets.clear();
  const files = await fs.readdir(PUBLIC_DIR);

  for (const file of files) {
    const type = TYPES.get(path.extname(file));
    if (!type) continue;

    const raw = await fs.readFile(path.join(PUBLIC_DIR, file));
    const entry = {
      raw,
      gz: await gzip(raw, { level: 9 }),
      etag: `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`,
      type,
    };

    assets.set(`/${file}`, entry);
    if (file === 'index.html') assets.set('/', entry);
  }
  return assets.size;
}

export function middleware(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const asset = assets.get(req.path);
  if (!asset) return next();

  res.setHeader('Content-Type', asset.type);
  res.setHeader('ETag', asset.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  // HTML must revalidate so a redeploy is picked up; JS/CSS are checked by ETag.
  res.setHeader('Cache-Control', 'no-cache');

  if (req.headers['if-none-match'] === asset.etag) {
    return res.status(304).end();
  }

  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  const body = wantsGzip ? asset.gz : asset.raw;
  if (wantsGzip) res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Length', body.byteLength);

  if (req.method === 'HEAD') return res.end();
  res.end(body);
}
