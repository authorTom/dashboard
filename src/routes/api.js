import express from 'express';
import * as auth from '../auth.js';
import * as icons from '../icons.js';
import * as store from '../store.js';

const router = express.Router();

const MAX_TITLE = 80;
const MAX_DESCRIPTION = 200;
const MAX_CATEGORY_NAME = 40;
const MAX_URL = 2048;
// Counted in UTF-16 units, so this has to allow for ZWJ sequences: a family
// emoji is 11 units and a flag with a skin-tone modifier can be longer still.
const MAX_EMOJI = 32;

class ValidationError extends Error {}

function str(value, field, { max, required = true, fallback = '' }) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required.`);
    return fallback;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new ValidationError(`${field} is required.`);
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

// A hostname (bare "nas", "plex.local", "example.com") or a bracketed IPv6
// literal. Deliberately permissive about TLDs so LAN hostnames work.
const HOSTNAME = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;

/** Accepts "example.com" and upgrades it to a full https URL. */
function normaliseUrl(value) {
  const raw = str(value, 'URL', { max: MAX_URL });
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ValidationError('That does not look like a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Only http:// and https:// links are allowed.');
  }
  if (!parsed.hostname) throw new ValidationError('That URL has no host.');
  // The URL parser is lenient — it happily reads "ht!tp://x" as host "ht!tp".
  if (!HOSTNAME.test(parsed.hostname)) {
    throw new ValidationError('That does not look like a valid address.');
  }
  return parsed.href;
}

function monogram(title) {
  return { type: 'letter', value: (title.trim()[0] ?? '?').toUpperCase() };
}

/**
 * Turns the client's icon choice into a stored icon. Network fetches are
 * best-effort; a failure degrades to a monogram rather than failing the save.
 */
async function resolveIcon(input, { url, title }) {
  const mode = input?.mode ?? 'auto';

  if (mode === 'emoji') {
    const value = str(input.value, 'Icon', { max: MAX_EMOJI });
    return { type: 'emoji', value };
  }

  if (mode === 'url') {
    const iconUrl = normaliseUrl(input.value);
    return (await icons.cacheFromUrl(iconUrl)) ?? monogram(title);
  }

  // The file itself went to POST /api/icons; what arrives here is the cached
  // name that call handed back. Re-check it: it decides a path under /icons.
  if (mode === 'upload') {
    const value = str(input.value, 'Icon', { max: 64 });
    if (!(await icons.isCached(value))) {
      throw new ValidationError('That uploaded icon is no longer available — choose the file again.');
    }
    return { type: 'file', value };
  }

  if (mode === 'none') return monogram(title);

  return (await icons.fetchFavicon(url)) ?? monogram(title);
}

function requireCategory(id) {
  const categoryId = str(id, 'Category', { max: 64 });
  if (!store.getCategory(categoryId)) {
    throw new ValidationError('That category no longer exists.');
  }
  return categoryId;
}

/** Wraps a handler so ValidationErrors become 400s instead of 500s. */
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  };
}

// ---------------------------------------------------------------- public read

/** Liveness probe for the container healthcheck. Cheap and unauthenticated. */
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

router.get('/state', (req, res) => {
  res.json({ ...store.snapshot(), authed: auth.isAuthed(req) });
});

// ------------------------------------------------------------------- sessions

router.get('/auth/me', (req, res) => {
  res.json({ authed: auth.isAuthed(req) });
});

router.post(
  '/auth/login',
  handle(async (req, res) => {
    const result = await auth.login(req, res, req.body?.password);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ authed: true });
  })
);

router.post('/auth/logout', (req, res) => {
  auth.logout(req, res);
  res.json({ authed: false });
});

// ----------------------------------------------------------------- categories

router.post(
  '/categories',
  auth.requireAuth,
  handle(async (req, res) => {
    const name = str(req.body?.name, 'Category name', { max: MAX_CATEGORY_NAME });
    res.status(201).json(await store.addCategory({ name }));
  })
);

router.put(
  '/categories/:id',
  auth.requireAuth,
  handle(async (req, res) => {
    const name = str(req.body?.name, 'Category name', { max: MAX_CATEGORY_NAME });
    const updated = await store.updateCategory(req.params.id, { name });
    if (!updated) return res.status(404).json({ error: 'Category not found.' });
    res.json(updated);
  })
);

router.delete(
  '/categories/:id',
  auth.requireAuth,
  handle(async (req, res) => {
    const removed = await store.removeCategory(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Category not found.' });
    await icons.collectGarbage(store.snapshot().links);
    res.json({ removed: removed.links.length });
  })
);

// ---------------------------------------------------------------------- icons

/**
 * Takes the raw image bytes as the request body — no multipart parser, and so
 * no dependency, for a single-file upload. The response carries the cached
 * name, which the client then sends back as the link's icon.
 */
router.post(
  '/icons',
  auth.requireAuth,
  express.raw({ type: icons.uploadTypes(), limit: icons.MAX_UPLOAD_BYTES }),
  handle(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      return res.status(415).json({ error: 'Icons must be a PNG, JPG, GIF or SVG.' });
    }
    const { icon, error } = await icons.saveUpload(req.body, req.get('content-type'));
    if (error) return res.status(400).json({ error });
    res.status(201).json({ icon });
  })
);

// ---------------------------------------------------------------------- links

router.post(
  '/links',
  auth.requireAuth,
  handle(async (req, res) => {
    const body = req.body ?? {};
    const title = str(body.title, 'Name', { max: MAX_TITLE });
    const url = normaliseUrl(body.url);
    const description = str(body.description, 'Description', {
      max: MAX_DESCRIPTION,
      required: false,
    });
    const categoryId = requireCategory(body.categoryId);
    const icon = await resolveIcon(body.icon, { url, title });

    res.status(201).json(
      await store.addLink({ title, url, description, categoryId, icon })
    );
  })
);

router.put(
  '/links/:id',
  auth.requireAuth,
  handle(async (req, res) => {
    const existing = store.getLink(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Link not found.' });

    const body = req.body ?? {};
    const title = str(body.title, 'Name', { max: MAX_TITLE });
    const url = normaliseUrl(body.url);
    const description = str(body.description, 'Description', {
      max: MAX_DESCRIPTION,
      required: false,
    });
    const categoryId = requireCategory(body.categoryId);

    // Only re-resolve the icon when the admin actually changed the choice;
    // otherwise an unrelated edit would refetch the favicon every time.
    const icon = body.icon?.mode
      ? await resolveIcon(body.icon, { url, title })
      : existing.icon;

    const updated = await store.updateLink(req.params.id, {
      title,
      url,
      description,
      categoryId,
      icon,
    });
    await icons.collectGarbage(store.snapshot().links);
    res.json(updated);
  })
);

router.delete(
  '/links/:id',
  auth.requireAuth,
  handle(async (req, res) => {
    const removed = await store.removeLink(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Link not found.' });
    await icons.collectGarbage(store.snapshot().links);
    res.json({ id: removed.id });
  })
);

router.post(
  '/reorder',
  auth.requireAuth,
  handle(async (req, res) => {
    const { categoryOrder, linkOrder } = req.body ?? {};
    res.json(await store.reorder({ categoryOrder, linkOrder }));
  })
);

export default router;
