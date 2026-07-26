import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The whole dataset is a handful of kilobytes, so it lives in memory and is
 * flushed to disk on every mutation. Writes go to a temp file and are renamed
 * into place, so a crash mid-write can never leave a truncated links.json.
 * Concurrent writes are serialised through a single promise chain.
 */

// Configurable so the container can point it at a mounted volume (/data)
// while a local checkout keeps using ./data.
const DATA_DIR = path.resolve(process.env.DASHBOARD_DATA_DIR ?? 'data');
const DATA_FILE = path.join(DATA_DIR, 'links.json');

const EMPTY = { version: 1, categories: [], links: [] };

let state = structuredClone(EMPTY);
let writeChain = Promise.resolve();
let dirty = false;

export function dataDir() {
  return DATA_DIR;
}

export async function load() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = {
      version: 1,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      links: Array.isArray(parsed.links) ? parsed.links : [],
    };
    const recovered = recoverOrphans();
    normalise();
    if (recovered) await flush();
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Could not read ${DATA_FILE}: ${err.message}`);
    }
    state = seed();
    await flush();
  }
  return state;
}

/** A first-run dashboard that shows what the thing does. */
function seed() {
  const general = { id: randomUUID(), name: 'General', position: 0 };
  return {
    version: 1,
    categories: [general],
    links: [
      {
        id: randomUUID(),
        title: 'Add your first link',
        url: 'https://github.com',
        description: 'Sign in to the admin area to edit this dashboard',
        categoryId: general.id,
        icon: { type: 'emoji', value: '👋' },
        position: 0,
      },
    ],
  };
}

const RECOVERED = 'Recovered';

/**
 * Rehomes links whose category is missing — a hand-edited or partially
 * restored links.json — instead of discarding them. Dropping them here would
 * be silent, permanent data loss on the next write.
 */
function recoverOrphans() {
  const known = new Set(state.categories.map((c) => c.id));
  const orphans = state.links.filter((l) => !known.has(l.categoryId));
  if (orphans.length === 0) return false;

  let bucket = state.categories.find((c) => c.name === RECOVERED);
  if (!bucket) {
    bucket = { id: randomUUID(), name: RECOVERED, position: state.categories.length };
    state.categories.push(bucket);
  }
  for (const link of orphans) link.categoryId = bucket.id;

  console.warn(
    `[store] ${orphans.length} link(s) referenced a missing category; ` +
      `moved to "${RECOVERED}" rather than deleted.`
  );
  return true;
}

/** Keeps positions dense and contiguous within each category. */
function normalise() {
  state.categories.sort((a, b) => a.position - b.position);
  state.categories.forEach((c, i) => {
    c.position = i;
  });

  const byCategory = new Map();
  state.links.sort((a, b) => a.position - b.position);
  for (const link of state.links) {
    const n = byCategory.get(link.categoryId) ?? 0;
    link.position = n;
    byCategory.set(link.categoryId, n + 1);
  }
}

async function flush() {
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, DATA_FILE);
}

/** Serialises writes so two requests can never interleave a flush. */
function persist() {
  dirty = true;
  writeChain = writeChain.then(async () => {
    if (!dirty) return;
    dirty = false;
    try {
      await flush();
    } catch (err) {
      console.error('[store] failed to persist:', err.message);
    }
  });
  return writeChain;
}

/** Read-only snapshot for the API. */
export function snapshot() {
  return {
    categories: state.categories.map((c) => ({ ...c })),
    links: state.links.map((l) => ({ ...l, icon: { ...l.icon } })),
  };
}

export function getLink(id) {
  return state.links.find((l) => l.id === id) ?? null;
}

export function getCategory(id) {
  return state.categories.find((c) => c.id === id) ?? null;
}

export async function addCategory({ name }) {
  const category = {
    id: randomUUID(),
    name,
    position: state.categories.length,
  };
  state.categories.push(category);
  await persist();
  return category;
}

export async function updateCategory(id, { name }) {
  const category = getCategory(id);
  if (!category) return null;
  if (name !== undefined) category.name = name;
  await persist();
  return category;
}

/** Removes a category and every link inside it. Returns the removed links. */
export async function removeCategory(id) {
  const index = state.categories.findIndex((c) => c.id === id);
  if (index === -1) return null;
  const [category] = state.categories.splice(index, 1);
  const orphaned = state.links.filter((l) => l.categoryId === id);
  state.links = state.links.filter((l) => l.categoryId !== id);
  normalise();
  await persist();
  return { category, links: orphaned };
}

export async function addLink({ title, url, description, categoryId, icon }) {
  const siblings = state.links.filter((l) => l.categoryId === categoryId);
  const link = {
    id: randomUUID(),
    title,
    url,
    description: description ?? '',
    categoryId,
    icon,
    position: siblings.length,
  };
  state.links.push(link);
  await persist();
  return link;
}

export async function updateLink(id, patch) {
  const link = getLink(id);
  if (!link) return null;

  const movingCategory =
    patch.categoryId !== undefined && patch.categoryId !== link.categoryId;

  for (const key of ['title', 'url', 'description', 'categoryId', 'icon']) {
    if (patch[key] !== undefined) link[key] = patch[key];
  }
  // Send it to the end of its new group, then close the gap it left behind.
  if (movingCategory) {
    link.position = Number.MAX_SAFE_INTEGER;
    normalise();
  }
  await persist();
  return link;
}

export async function removeLink(id) {
  const index = state.links.findIndex((l) => l.id === id);
  if (index === -1) return null;
  const [link] = state.links.splice(index, 1);
  normalise();
  await persist();
  return link;
}

/**
 * Applies a drag-and-drop result: an ordered list of category ids, and for
 * each, the ordered link ids it now contains. Anything the client omits keeps
 * its existing place rather than being dropped.
 */
export async function reorder({ categoryOrder, linkOrder }) {
  if (Array.isArray(categoryOrder)) {
    categoryOrder.forEach((id, i) => {
      const category = getCategory(id);
      if (category) category.position = i;
    });
  }

  if (linkOrder && typeof linkOrder === 'object') {
    for (const [categoryId, ids] of Object.entries(linkOrder)) {
      if (!getCategory(categoryId) || !Array.isArray(ids)) continue;
      ids.forEach((id, i) => {
        const link = getLink(id);
        if (!link) return;
        link.categoryId = categoryId;
        link.position = i;
      });
    }
  }

  normalise();
  await persist();
  return snapshot();
}

/** Lets the server wait for pending writes before exiting. */
export function pendingWrites() {
  return writeChain;
}
