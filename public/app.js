/**
 * Dashboard client.
 *
 * The board is rendered once per data change. Search only toggles the `hidden`
 * attribute on already-rendered tiles, so typing never rebuilds the DOM, and a
 * small index of lowercased search text is kept alongside each tile element.
 */

const $ = (selector, root = document) => root.querySelector(selector);

const board = $('#board');
const searchInput = $('#search');
const emptyState = $('#empty');
const noResults = $('#no-results');
const noResultsTerm = $('#no-results-term');
const adminBar = $('#admin-bar');
const adminToggle = $('#admin-toggle');
const toastEl = $('#toast');

const loginDialog = $('#login-dialog');
const linkDialog = $('#link-dialog');
const categoryDialog = $('#category-dialog');
const confirmDialog = $('#confirm-dialog');

/** categories/links mirror the server; `authed` drives every edit affordance. */
const state = { categories: [], links: [], authed: false };
let selectedCategory = null;
const categoryNav = $('#category-nav');

function renderNavigation() {
  if (!state.categories.some((c) => c.id === selectedCategory)) selectedCategory = null;
  const items = [{ id: null, name: 'All services', count: state.links.length },
    ...state.categories.map((c) => ({ ...c, count: state.links.filter((l) => l.categoryId === c.id).length }))];
  categoryNav.replaceChildren(...items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item';
    button.dataset.categoryId = item.id ?? '';
    button.setAttribute('aria-pressed', String(item.id === selectedCategory));
    button.innerHTML = `<span class="nav-item__mark" aria-hidden="true">${item.id === null ? '⊞' : '▦'}</span><span class="nav-item__name">${escapeHtml(item.name)}</span><span class="nav-item__count">${item.count}</span>`;
    return button;
  }));
  $('#service-count').textContent = state.links.length;
  $('#collection-count').textContent = state.categories.length;
}

categoryNav.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  selectedCategory = button.dataset.categoryId || null;
  // Keep the focused button in place for keyboard and assistive-tech users.
  for (const item of categoryNav.children) {
    item.setAttribute('aria-pressed', String((item.dataset.categoryId || null) === selectedCategory));
  }
  applySearch();
});

const VIEW_KEY = 'dashboard:view';
function applyView(view) {
  const list = view === 'list';
  board.classList.toggle('board--list', list);
  $('#view-grid').setAttribute('aria-pressed', String(!list));
  $('#view-list').setAttribute('aria-pressed', String(list));
}
applyView(localStorage.getItem(VIEW_KEY));
for (const view of ['grid', 'list']) {
  $(`#view-${view}`).addEventListener('click', () => {
    applyView(view);
    localStorage.setItem(VIEW_KEY, view);
  });
}
$('#clear-search').addEventListener('click', () => {
  searchInput.value = '';
  applySearch();
  searchInput.focus();
});

/** tile element -> lowercased "title description url" for search. */
const searchIndex = new Map();

// ------------------------------------------------------------------- helpers

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // Empty or non-JSON body — fall through to the status check.
  }

  if (!res.ok) {
    // The server restarted or the session expired. Without this the UI keeps
    // showing admin controls that fail on every click, with no way back other
    // than a manual reload.
    if (res.status === 401 && !path.startsWith('/auth/')) handleSessionLoss();

    const error = new Error(payload?.error ?? `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return payload;
}

function handleSessionLoss() {
  if (!state.authed) return;
  state.authed = false;
  render();
  for (const open of document.querySelectorAll('dialog[open]')) open.close();
  toast('Session expired — please sign in again', 'error');
  openDialog(loginDialog);
}

let toastTimer;
function toast(message, variant) {
  toastEl.textContent = message;
  toastEl.className = variant === 'error' ? 'toast toast--error' : 'toast';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// --------------------------------------------------------------------- theme

const THEME_KEY = 'dashboard:theme';

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

applyTheme(localStorage.getItem(THEME_KEY));

$('#theme-toggle').addEventListener('click', () => {
  const current =
    document.documentElement.dataset.theme ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
});

// ------------------------------------------------------------------ rendering

const EDIT_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.3l2.5 2.5L5.5 13H3v-2.5z"/></svg>`;

function iconMarkup(link) {
  if (link.icon?.type === 'file') {
    return `<span class="tile__icon"><img src="/icons/${encodeURIComponent(
      link.icon.value
    )}" alt="" loading="lazy" decoding="async" width="42" height="42"></span>`;
  }
  if (link.icon?.type === 'emoji') {
    return `<span class="tile__icon">${escapeHtml(link.icon.value)}</span>`;
  }
  return `<span class="tile__icon tile__icon--letter">${escapeHtml(
    link.icon?.value ?? '?'
  )}</span>`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function buildTile(link) {
  const tile = document.createElement('a');
  tile.className = 'tile';
  tile.href = link.url;
  tile.target = '_blank';
  tile.rel = 'noopener noreferrer';
  tile.dataset.id = link.id;

  const subtitle = link.description || hostOf(link.url);
  tile.innerHTML = `
    ${iconMarkup(link)}
    <span class="tile__body">
      <span class="tile__title">${escapeHtml(link.title)}</span>
      <span class="tile__desc">${escapeHtml(subtitle)}</span>
      <span class="tile__host">${escapeHtml(hostOf(link.url))}</span>
    </span>
    <span class="tile__launch" aria-hidden="true">↗</span>
    <button class="tile__edit" type="button" aria-label="Edit ${escapeHtml(
      link.title
    )}">${EDIT_ICON}</button>`;

  searchIndex.set(
    tile,
    `${link.title} ${link.description} ${hostOf(link.url)}`.toLowerCase()
  );
  return tile;
}

function render() {
  document.body.classList.toggle('is-admin', state.authed);
  adminBar.hidden = !state.authed;
  adminToggle.textContent = state.authed ? 'Sign out' : 'Sign in';

  renderNavigation();
  searchIndex.clear();

  const fragment = document.createDocumentFragment();
  const byCategory = new Map(state.categories.map((c) => [c.id, []]));
  for (const link of state.links) byCategory.get(link.categoryId)?.push(link);

  for (const category of state.categories) {
    const links = byCategory.get(category.id) ?? [];

    const section = document.createElement('section');
    section.className = 'category';
    section.dataset.categoryId = category.id;

    const head = document.createElement('div');
    head.className = 'category__head';
    head.innerHTML = `
      <h2 class="category__name">${escapeHtml(category.name)}</h2>
      <span class="category__count">${links.length}</span>
      <button class="category__edit" type="button">Edit</button>`;

    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.dataset.categoryId = category.id;
    for (const link of links) grid.append(buildTile(link));

    section.append(head, grid);
    fragment.append(section);
  }

  board.replaceChildren(fragment);
  board.setAttribute('aria-busy', 'false');

  const isEmpty = state.categories.length === 0 || state.links.length === 0;
  emptyState.hidden = !isEmpty || Boolean(searchInput.value);
  applySearch();
  refreshDropTargets();
}

// -------------------------------------------------------------------- search

function applySearch() {
  const term = searchInput.value.trim().toLowerCase();
  let visible = 0;

  for (const section of board.children) {
    let shown = 0;
    for (const tile of section.querySelector('.grid').children) {
      const inCategory = !selectedCategory || section.dataset.categoryId === selectedCategory;
      const match = inCategory && (!term || searchIndex.get(tile)?.includes(term));
      tile.hidden = !match;
      if (match) shown += 1;
    }
    // Hide a whole category when the filter empties it, but keep empty
    // categories visible while browsing so they remain drop targets.
    section.hidden = (selectedCategory && section.dataset.categoryId !== selectedCategory) || (term ? shown === 0 : false);
    section.querySelector('.category__count').textContent = shown;
    visible += shown;
  }

  const searching = Boolean(term);
  noResults.hidden = !searching || visible > 0;
  noResultsTerm.textContent = searchInput.value.trim();
  if (searching) emptyState.hidden = true;
  else emptyState.hidden = state.links.length > 0 && state.categories.length > 0;
  $('#clear-search').hidden = !searchInput.value;
  const categoryName = state.categories.find((c) => c.id === selectedCategory)?.name;
  $('#collection-title').textContent = categoryName ?? 'All services';
  $('#results-summary').textContent = `${visible} service${visible === 1 ? '' : 's'}${searching ? ' matching your search' : ' in your workspace'}`;
}

searchInput.addEventListener('input', applySearch);

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    searchInput.value = '';
    applySearch();
    searchInput.blur();
  }
  if (event.key === 'Enter') {
    const first = board.querySelector('.tile:not([hidden])');
    if (first) window.open(first.href, '_blank', 'noopener');
  }
});

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (event.key === '/' && !typing && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    searchInput.focus();
  }
});

// -------------------------------------------------------------------- dialogs

function openDialog(dialog) {
  hideError(dialog);
  dialog.showModal();
}

function showError(dialog, message) {
  const el = dialog.querySelector('[data-error]');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

function hideError(dialog) {
  const el = dialog.querySelector('[data-error]');
  if (el) el.hidden = true;
}

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
  // Clicking the backdrop closes; clicks inside the form must not bubble here.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

/** Promise-based replacement for window.confirm. */
function confirmAction({ title, message, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    $('[data-title]', confirmDialog).textContent = title;
    $('[data-message]', confirmDialog).textContent = message;
    const button = $('[data-confirm]', confirmDialog);
    button.textContent = confirmLabel;

    const onConfirm = () => {
      confirmDialog.close();
      resolve(true);
    };
    button.addEventListener('click', onConfirm, { once: true });
    confirmDialog.addEventListener(
      'close',
      () => {
        button.removeEventListener('click', onConfirm);
        resolve(false);
      },
      { once: true }
    );
    confirmDialog.showModal();
  });
}

/** Prevents double submits and gives the button a pending label. */
async function withPending(dialog, fn) {
  const submit = dialog.querySelector('[data-submit]');
  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = 'Saving…';
  try {
    await fn();
  } finally {
    submit.disabled = false;
    submit.textContent = label;
  }
}

// --------------------------------------------------------------------- auth

adminToggle.addEventListener('click', async () => {
  if (!state.authed) return openDialog(loginDialog);

  await api('/auth/logout', { method: 'POST' });
  state.authed = false;
  render();
  toast('Signed out');
});

$('[data-form="login"]', loginDialog).addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('#login-password').value;

  await withPending(loginDialog, async () => {
    try {
      await api('/auth/login', { method: 'POST', body: { password } });
      state.authed = true;
      loginDialog.close();
      $('#login-password').value = '';
      render();
      toast('Signed in');
    } catch (err) {
      showError(loginDialog, err.message);
    }
  });
});

// ---------------------------------------------------------------- link form

const linkForm = $('[data-form="link"]', linkDialog);
const iconValueInput = linkForm.elements.iconValue;
const iconNote = $('[data-icon-note]', linkForm);

const uploadPanel = $('[data-upload]', linkForm);
const uploadDrop = $('[data-upload-drop]', linkForm);
const uploadInput = linkForm.elements.iconFile;
const uploadPreview = $('[data-upload-preview]', linkForm);
const uploadText = $('[data-upload-text]', linkForm);
const uploadClear = $('[data-upload-clear]', linkForm);

const ICON_HINTS = {
  auto: { note: 'Fetched from the site automatically.', placeholder: '' },
  emoji: { note: 'Any single emoji or character.', placeholder: '🎬' },
  url: { note: 'Downloaded once and served from this dashboard.', placeholder: 'https://…/icon.png' },
  upload: { note: 'PNG, JPG, GIF or SVG, up to 512 kB.', placeholder: '' },
  none: { note: 'Uses the first letter of the name.', placeholder: '' },
};

function syncIconMode() {
  const mode = linkForm.elements.iconMode.value;
  const hint = ICON_HINTS[mode];
  const needsValue = mode === 'emoji' || mode === 'url';
  iconValueInput.hidden = !needsValue;
  iconValueInput.required = needsValue;
  iconValueInput.placeholder = hint.placeholder;
  uploadPanel.hidden = mode !== 'upload';
  iconNote.textContent = hint.note;
}

for (const radio of linkForm.elements.iconMode) {
  radio.addEventListener('change', syncIconMode);
}

// -------------------------------------------------------------- icon upload

const MAX_UPLOAD_BYTES = 512 * 1024; // Matches the server's limit.
const CHOOSE_TEXT = '<strong>Choose a file</strong> or drop one here';
const EXT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};
const UPLOAD_TYPES = new Set(Object.values(EXT_TYPES));

/** The icon the link being edited already has, so it can be shown and kept. */
let currentIconSrc = null;

/**
 * Some platforms hand over an empty or generic type — notably for SVG — so
 * the extension is the fallback. The server checks the bytes regardless.
 */
function uploadType(file) {
  if (UPLOAD_TYPES.has(file.type)) return file.type;
  return EXT_TYPES[file.name.split('.').pop()?.toLowerCase()] ?? null;
}

function resetUpload() {
  uploadInput.value = '';
  uploadClear.hidden = true;
  if (currentIconSrc) {
    uploadPreview.src = currentIconSrc;
    uploadPreview.hidden = false;
    uploadText.textContent = 'Current icon — choose a file to replace it.';
  } else {
    uploadPreview.hidden = true;
    uploadPreview.removeAttribute('src');
    uploadText.innerHTML = CHOOSE_TEXT;
  }
}

function showChosenFile(file) {
  // A data URL keeps the preview inside the page's img-src CSP, and the file
  // is capped at 512 kB, so reading it whole costs nothing worth measuring.
  const reader = new FileReader();
  reader.onload = () => {
    uploadPreview.src = reader.result;
    uploadPreview.hidden = false;
  };
  reader.readAsDataURL(file);
  uploadText.textContent = file.name;
  uploadClear.hidden = false;
}

uploadInput.addEventListener('change', () => {
  const file = uploadInput.files?.[0];
  if (!file) return resetUpload();

  if (!uploadType(file)) {
    resetUpload();
    return showError(linkDialog, 'Icons must be a PNG, JPG, GIF or SVG.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    resetUpload();
    return showError(linkDialog, 'That image is larger than 512 kB.');
  }

  hideError(linkDialog);
  showChosenFile(file);
});

uploadClear.addEventListener('click', () => {
  resetUpload();
  hideError(linkDialog);
});

uploadDrop.addEventListener('dragover', (event) => {
  event.preventDefault();
  uploadDrop.classList.add('is-dropping');
});

uploadDrop.addEventListener('dragleave', () => {
  uploadDrop.classList.remove('is-dropping');
});

uploadDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadDrop.classList.remove('is-dropping');

  const file = event.dataTransfer?.files?.[0];
  if (!file) return;

  // Route the drop through the input so selection and validation have one path.
  const transfer = new DataTransfer();
  transfer.items.add(file);
  uploadInput.files = transfer.files;
  uploadInput.dispatchEvent(new Event('change', { bubbles: true }));
});

/** Stores the file and returns the cached name to attach to the link. */
async function uploadIcon(file) {
  const res = await fetch('/api/icons', {
    method: 'POST',
    headers: { 'content-type': uploadType(file) },
    body: file,
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // Non-JSON body — the status check below still reports something useful.
  }

  if (!res.ok) {
    if (res.status === 401) handleSessionLoss();
    if (res.status === 413) throw new Error('That image is larger than 512 kB.');
    throw new Error(payload?.error ?? `Could not upload that image (${res.status})`);
  }
  return payload.icon.value;
}

/** `link` is null when adding. */
function openLinkDialog(link) {
  const select = linkForm.elements.categoryId;
  select.replaceChildren(
    ...state.categories.map((c) => new Option(c.name, c.id))
  );

  $('[data-title]', linkForm).textContent = link ? 'Edit link' : 'Add link';
  linkForm.elements.title.value = link?.title ?? '';
  linkForm.elements.url.value = link?.url ?? '';
  linkForm.elements.description.value = link?.description ?? '';
  select.value = link?.categoryId ?? state.categories[0]?.id ?? '';

  // Editing starts on "Automatic" but only refetches if the admin touches it.
  linkForm.elements.iconMode.value = link?.icon?.type === 'emoji' ? 'emoji' : 'auto';
  iconValueInput.value = link?.icon?.type === 'emoji' ? link.icon.value : '';
  currentIconSrc =
    link?.icon?.type === 'file' ? `/icons/${encodeURIComponent(link.icon.value)}` : null;
  resetUpload();
  syncIconMode();
  if (link) iconNote.textContent = 'Leave as-is to keep the current icon.';

  const del = $('[data-delete]', linkForm);
  del.hidden = !link;
  linkForm.dataset.editing = link?.id ?? '';

  openDialog(linkDialog);
  linkForm.elements.title.focus();
}

linkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = linkForm.dataset.editing;
  const mode = linkForm.elements.iconMode.value;
  const file = mode === 'upload' ? (uploadInput.files?.[0] ?? null) : null;

  if (mode === 'upload' && !file && !currentIconSrc) {
    return showError(linkDialog, 'Choose an image to upload, or pick another icon option.');
  }

  const body = {
    title: linkForm.elements.title.value,
    url: linkForm.elements.url.value,
    description: linkForm.elements.description.value,
    categoryId: linkForm.elements.categoryId.value,
  };

  await withPending(linkDialog, async () => {
    try {
      // Omitting `icon` on an edit tells the server to keep the existing one —
      // which is also how "Upload" with no new file keeps the current image.
      if (mode === 'upload') {
        if (file) body.icon = { mode, value: await uploadIcon(file) };
      } else if (!id || mode !== 'auto' || linkForm.dataset.iconTouched === '1') {
        body.icon = { mode, value: iconValueInput.value };
      }

      await api(id ? `/links/${id}` : '/links', {
        method: id ? 'PUT' : 'POST',
        body,
      });
      linkDialog.close();
      await refresh();
      toast(id ? 'Link updated' : 'Link added');
    } catch (err) {
      showError(linkDialog, err.message);
    }
  });
});

// Any deliberate icon change marks the icon as touched for the next save.
linkForm.addEventListener('change', (event) => {
  if (/^icon(Mode|Value|File)$/.test(event.target.name)) {
    linkForm.dataset.iconTouched = '1';
  }
});
linkDialog.addEventListener('close', () => {
  linkForm.dataset.iconTouched = '0';
  currentIconSrc = null;
  resetUpload();
});

$('[data-delete]', linkForm).addEventListener('click', async () => {
  const id = linkForm.dataset.editing;
  const link = state.links.find((l) => l.id === id);
  if (!link) return;

  const ok = await confirmAction({
    title: 'Delete link',
    message: `“${link.title}” will be removed from the dashboard.`,
  });
  if (!ok) return;

  try {
    await api(`/links/${id}`, { method: 'DELETE' });
    linkDialog.close();
    await refresh();
    toast('Link deleted');
  } catch (err) {
    showError(linkDialog, err.message);
  }
});

$('#add-link').addEventListener('click', () => {
  if (state.categories.length === 0) {
    return toast('Create a category first', 'error');
  }
  openLinkDialog(null);
});

// ------------------------------------------------------------ category form

const categoryForm = $('[data-form="category"]', categoryDialog);

function openCategoryDialog(category) {
  $('[data-title]', categoryForm).textContent = category
    ? 'Rename category'
    : 'New category';
  categoryForm.elements.name.value = category?.name ?? '';
  $('[data-delete]', categoryForm).hidden = !category;
  categoryForm.dataset.editing = category?.id ?? '';

  openDialog(categoryDialog);
  categoryForm.elements.name.focus();
}

categoryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = categoryForm.dataset.editing;
  const body = { name: categoryForm.elements.name.value };

  await withPending(categoryDialog, async () => {
    try {
      await api(id ? `/categories/${id}` : '/categories', {
        method: id ? 'PUT' : 'POST',
        body,
      });
      categoryDialog.close();
      await refresh();
      toast(id ? 'Category renamed' : 'Category added');
    } catch (err) {
      showError(categoryDialog, err.message);
    }
  });
});

$('[data-delete]', categoryForm).addEventListener('click', async () => {
  const id = categoryForm.dataset.editing;
  const category = state.categories.find((c) => c.id === id);
  if (!category) return;

  const count = state.links.filter((l) => l.categoryId === id).length;
  const ok = await confirmAction({
    title: 'Delete category',
    message: count
      ? `“${category.name}” and its ${count} link${count === 1 ? '' : 's'} will be deleted.`
      : `“${category.name}” will be deleted.`,
  });
  if (!ok) return;

  try {
    await api(`/categories/${id}`, { method: 'DELETE' });
    categoryDialog.close();
    await refresh();
    toast('Category deleted');
  } catch (err) {
    showError(categoryDialog, err.message);
  }
});

$('#add-category').addEventListener('click', () => openCategoryDialog(null));

// ------------------------------------------------------- board interactions

board.addEventListener('click', (event) => {
  const editTile = event.target.closest('.tile__edit');
  if (editTile) {
    event.preventDefault();
    const id = editTile.closest('.tile').dataset.id;
    const link = state.links.find((l) => l.id === id);
    if (link) openLinkDialog(link);
    return;
  }

  const editCategory = event.target.closest('.category__edit');
  if (editCategory) {
    const id = editCategory.closest('.category').dataset.categoryId;
    const category = state.categories.find((c) => c.id === id);
    if (category) openCategoryDialog(category);
  }
});

// ----------------------------------------------------------- drag to reorder

let dragged = null;

function refreshDropTargets() {
  for (const tile of board.querySelectorAll('.tile')) {
    tile.draggable = state.authed;
  }
  for (const grid of board.querySelectorAll('.grid')) {
    grid.classList.toggle('is-empty-target', state.authed && grid.children.length === 0);
  }
}

board.addEventListener('dragstart', (event) => {
  const tile = event.target.closest('.tile');
  if (!tile || !state.authed) return;
  dragged = tile;
  tile.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  // Firefox refuses to start a drag without data on the transfer.
  event.dataTransfer.setData('text/plain', tile.dataset.id);
});

board.addEventListener('dragover', (event) => {
  if (!dragged) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';

  const grid = event.target.closest('.grid');
  if (!grid) return;

  const target = event.target.closest('.tile');
  if (!target || target === dragged) {
    if (!target) grid.append(dragged);
    return;
  }

  // Insert before or after the hovered tile depending on which half the
  // pointer is in, so the placeholder tracks the cursor naturally.
  const box = target.getBoundingClientRect();
  const after = event.clientX > box.left + box.width / 2;
  target.parentNode.insertBefore(dragged, after ? target.nextSibling : target);
});

board.addEventListener('drop', (event) => {
  if (dragged) event.preventDefault();
});

board.addEventListener('dragend', async () => {
  if (!dragged) return;
  dragged.classList.remove('is-dragging');
  dragged = null;

  const linkOrder = {};
  for (const grid of board.querySelectorAll('.grid')) {
    linkOrder[grid.dataset.categoryId] = [...grid.children].map((t) => t.dataset.id);
  }
  const categoryOrder = [...board.children].map((s) => s.dataset.categoryId);

  try {
    const next = await api('/reorder', { method: 'POST', body: { categoryOrder, linkOrder } });
    Object.assign(state, next);
    render();
  } catch (err) {
    toast(err.message, 'error');
    await refresh(); // Snap back to the server's truth.
  }
});

// ---------------------------------------------------------------- lifecycle

async function refresh() {
  const next = await api('/state');
  Object.assign(state, next);
  render();
}

refresh().catch((err) => {
  board.setAttribute('aria-busy', 'false');
  toast(`Could not load dashboard: ${err.message}`, 'error');
});
