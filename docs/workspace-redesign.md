# Workspace redesign

## Changes

- Flat, local-only visual design with a persistent workspace sidebar, responsive category rail, clearer typography and teal accents.
- Category filters combine with instant search; visible result counts and an explicit clear button help recover from empty results.
- Grid and compact list layouts with a remembered preference.
- Service hostnames and launch affordances make destinations clear. Counts reflect stored links, not invented uptime or health information.
- Light/dark themes, admin authentication, category/link editing, cached/uploaded icons and drag-to-reorder remain available. No data format, API, auth or Docker runtime changes.

## Verification

```sh
npm ci
npx playwright install chromium
npm test
docker build -t dashboard:redesign-review .
```

Tests launch an isolated server on loopback port 3101 with an ephemeral datastore and randomly generated test password. They never use production data or credentials. Coverage includes category/search composition, keyboard search, empty states, theme/layout persistence, responsive grid/list layouts at 320/390/768/1024/1440px, admin forms, actual drag interaction with payload assertions, and real API auth/upload/CRUD/reorder/logout flows.

The browser tests need Chromium system dependencies; on a fresh Linux CI runner install these with `npx playwright install --with-deps chromium`.

Independent review is required before deploying. No `[verified]` commit marker is used until another reviewer has approved the changes.

## Deployment boundaries

The application has no frontend compilation step. Docker copies the HTML, both CSS files and client JavaScript and installs production dependencies only. Backend modules and the image runtime contract are untouched. Existing server-side sessions are held in memory and therefore need a new sign-in after any container restart, as before.
