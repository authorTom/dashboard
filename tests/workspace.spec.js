import { test, expect } from '@playwright/test';

const fixture = {
  categories: [{ id: 'infra', name: 'Infrastructure' }, { id: 'apps', name: 'Apps' }, { id: 'empty', name: 'Empty collection' }],
  links: [
    { id: 'p', categoryId: 'infra', title: 'Proxmox', description: 'Virtual machines and storage', url: 'https://pve.local:8006', icon: { type: 'letter', value: 'P' } },
    { id: 'd', categoryId: 'apps', title: 'Deckle', description: 'Notes and bookmarks', url: 'https://notes.local', icon: { type: 'emoji', value: '📓' } },
    { id: 'long', categoryId: 'apps', title: 'A very long service title that must remain readable on a narrow phone', description: 'A long description for checking wrapping without making the page wider than the screen.', url: 'https://long.example.test', icon: { type: 'letter', value: 'L' } },
  ], authed: false,
};
async function mockState(page, state = fixture) {
  await page.route('**/api/state', (route) => route.fulfill({ json: state }));
  await page.goto('/');
  await expect(page.locator('#board')).toHaveAttribute('aria-busy', 'false');
}

test('search, category filters, clear button and result counts compose', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockState(page);
  await expect(page.locator('.tile:visible')).toHaveCount(3);
  await expect(page.locator('#service-count')).toHaveText('3');
  await page.getByRole('button', { name: 'Apps 2', exact: true }).click();
  await expect(page.locator('.tile:visible')).toHaveCount(2);
  await page.locator('#search').fill('notes');
  await expect(page.locator('.tile:visible')).toHaveCount(1);
  await expect(page.locator('#results-summary')).toHaveText('1 service matching your search');
  await page.getByRole('button', { name: 'Infrastructure 1', exact: true }).click();
  await expect(page.locator('#no-results')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('.tile:visible')).toHaveCount(1);
  await expect(page.locator('#search')).toBeFocused();
  await expect(page.locator('#no-results')).toBeHidden();
  expect(errors).toEqual([]);
});

test('keyboard search, Escape and persisted layout/theme', async ({ page }) => {
  await mockState(page);
  await page.keyboard.press('/');
  await expect(page.locator('#search')).toBeFocused();
  await page.keyboard.type('not-a-service');
  await expect(page.locator('#no-results')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tile:visible')).toHaveCount(3);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.getByRole('button', { name: 'Switch theme' }).click();
  await page.reload();
  await expect(page.locator('#view-list')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.tile').first()).toHaveAttribute('rel', 'noopener noreferrer');
});

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`responsive grid and list have no page overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockState(page);
    for (const view of ['Grid view', 'List view']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('.tile').last()).toBeVisible();
    }
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#login-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#login-dialog')).toBeHidden();
  });
}

test('empty workspace stays correct after clearing a failed search', async ({ page }) => {
  await mockState(page, { categories: [], links: [], authed: false });
  await expect(page.locator('#empty')).toBeVisible();
  await page.locator('#search').fill('missing');
  await expect(page.locator('#empty')).toBeHidden();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('#empty')).toBeVisible();
});

test('admin dialogs and icon options retain their controls', async ({ page }) => {
  await mockState(page, { ...fixture, authed: true });
  await page.getByRole('button', { name: 'Edit Deckle', exact: true }).click();
  await expect(page.locator('#link-dialog')).toBeVisible();
  await expect(page.locator('[name=title]')).toHaveValue('Deckle');
  await page.getByText('Upload', { exact: true }).click();
  await expect(page.locator('[data-upload]')).toBeVisible();
  await page.getByText('Letter', { exact: true }).click();
  await expect(page.locator('[data-upload]')).toBeHidden();
  await page.locator('#link-dialog [data-close]').click();
  await page.getByRole('button', { name: 'New category', exact: true }).click();
  await expect(page.locator('#category-dialog')).toBeVisible();
  await page.locator('#category-dialog [data-close]').click();
  await expect(page.locator('.tile').first()).toHaveAttribute('draggable', 'true');
});

test('admin drag-to-reorder updates collections and navigation counts', async ({ page }) => {
  let posted;
  await page.route('**/api/reorder', async (route) => {
    posted = route.request().postDataJSON();
    const moved = structuredClone(fixture);
    moved.authed = true;
    moved.links[0].categoryId = 'apps';
    await route.fulfill({ json: moved });
  });
  await page.setViewportSize({ width: 1280, height: 1200 });
  await mockState(page, { ...fixture, authed: true });
  await page.locator('.tile[data-id="p"]').dragTo(page.locator('.tile[data-id="d"]'), { targetPosition: { x: 10, y: 10 } });
  await expect(page.getByRole('button', { name: 'Apps 3', exact: true })).toBeVisible();
  expect(posted.categoryOrder).toEqual(['infra', 'apps', 'empty']);
  expect(posted.linkOrder.apps).toContain('p');
  expect(posted.linkOrder.infra).toEqual([]);
});

test('real isolated API: auth gate, upload, CRUD, reorder, logout and persisted reads', async ({ request }) => {
  expect((await request.post('/api/categories', { data: { name: 'Forbidden' } })).status()).toBe(401);
  expect((await request.post('/api/auth/login', { data: { password: process.env.DASHBOARD_TEST_PASSWORD } })).ok()).toBe(true);
  const category = await (await request.post('/api/categories', { data: { name: 'Test collection' } })).json();
  const other = await (await request.post('/api/categories', { data: { name: 'Other collection' } })).json();
  const upload = await request.post('/api/icons', { headers: { 'content-type': 'image/svg+xml' }, data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>') });
  expect(upload.status()).toBe(201);
  const icon = (await upload.json()).icon;
  const link = await (await request.post('/api/links', { data: { title: 'Test app', description: 'Test description', url: 'https://example.test', categoryId: category.id, icon: { mode: 'upload', value: icon.value } } })).json();
  expect((await request.get(`/icons/${icon.value}`)).ok()).toBe(true);
  expect((await request.put(`/api/links/${link.id}`, { data: { title: 'Edited app', url: link.url, description: 'Updated', categoryId: category.id } })).ok()).toBe(true);
  const snapshot = await (await request.get('/api/state')).json();
  expect(snapshot.links.find((l) => l.id === link.id).icon).toEqual(icon);
  const reordered = await request.post('/api/reorder', { data: { categoryOrder: snapshot.categories.map((c) => c.id), linkOrder: Object.fromEntries(snapshot.categories.map((c) => [c.id, c.id === other.id ? [link.id] : snapshot.links.filter((l) => l.categoryId === c.id && l.id !== link.id).map((l) => l.id)])) } });
  expect(reordered.ok()).toBe(true);
  expect((await reordered.json()).links.find((l) => l.id === link.id).categoryId).toBe(other.id);
  expect((await request.delete(`/api/links/${link.id}`)).ok()).toBe(true);
  expect((await request.delete(`/api/categories/${category.id}`)).ok()).toBe(true);
  expect((await request.delete(`/api/categories/${other.id}`)).ok()).toBe(true);
  await request.post('/api/auth/logout');
  expect((await request.get('/api/auth/me')).ok()).toBe(true);
  expect((await (await request.get('/api/auth/me')).json()).authed).toBe(false);
  expect((await request.post('/api/categories', { data: { name: 'Forbidden' } })).status()).toBe(401);
});
