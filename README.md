# Dashboard

A minimal, self-hosted start page for your web apps and services. Tiles grouped
into categories, instant search, drag-to-reorder, and a password-protected admin
area for adding, editing and removing links.

No database, no build step, no frontend framework — one Node process, one JSON
file, and 11 kB of gzipped frontend.

## Quick start (Docker)

```bash
cp .env.example .env      # then set ADMIN_PASSWORD
docker compose up -d
```

Open <http://localhost:8080>, click **Sign in**, and enter your password.

The image is published to GHCR for `amd64` and `arm64`, so Compose pulls a
prebuilt one — no checkout or build needed. To run it without Compose:

```bash
docker run -d --name dashboard -p 8080:8080 \
  -e ADMIN_PASSWORD='your-password' \
  -v dashboard-data:/data \
  ghcr.io/authortom/dashboard:latest
```

`compose.yaml` is set up to pull. To build from a source checkout instead,
uncomment the `build:` block and run `docker compose up -d --build`.

### Upgrading

```bash
docker compose pull && docker compose up -d
```

Your links live in the `dashboard-data` volume and survive image upgrades and
`docker compose down`. Pin `DASHBOARD_IMAGE` to a `sha-` tag in `.env` if you
want reproducible, rollback-friendly deploys.

## Quick start (without Docker)

```bash
npm install
cp .env.example .env      # then set ADMIN_PASSWORD
node --env-file=.env server.js
```

Open <http://localhost:3000>. Or export the variables yourself:

```bash
ADMIN_PASSWORD='your-password' npm start
```

## Configuration

| Variable         | Default   | Purpose                                                        |
| ---------------- | --------- | -------------------------------------------------------------- |
| `ADMIN_PASSWORD` | *(none)*  | **Required.** Password for the admin area; the server won't start without it. |
| `PORT`           | `3000`    | Port to listen on.                                              |
| `HOST`           | `0.0.0.0` | `127.0.0.1` restricts to this machine; `0.0.0.0` exposes on the LAN. |
| `DASHBOARD_DATA_DIR` | `data` | Where `links.json` and cached favicons live. The container sets this to `/data`. |
| `SECURE_COOKIES` | `0`       | Set to `1` when serving over HTTPS so the session cookie is marked `Secure`. |
| `TRUST_PROXY`    | *(unset)* | Number of reverse proxies in front of the server. Leave unset for direct connections — see below. |

## Using it

**Search** — start typing, or press `/` from anywhere. `Enter` opens the top
result, `Esc` clears the box.

**Adding a link** — sign in, then **Add link**. The URL accepts a bare hostname
(`nas`, `example.com`, `192.168.1.10:8006`) and is upgraded to `https://` if you
omit the scheme.

**Icons** — five options per link:

- *Automatic* reads the site's `<link rel="icon">` tags, falling back to
  `/favicon.ico`. Whatever it finds is downloaded once and cached in
  `data/icons/`, so loading the dashboard never makes an external request.
- *Emoji* uses any character you type.
- *Image URL* downloads an image you point at and caches it the same way.
- *Upload* takes a PNG, JPG, GIF or SVG from your machine — click the box or
  drop a file onto it. Up to 512 kB. Editing a link and leaving *Upload* empty
  keeps the icon it already has.
- *Letter* draws a monogram from the link's name.

Automatic fetching is best-effort. If a service is unreachable or serves no
icon, the link silently falls back to a monogram — the save still succeeds.

Uploads are checked against the file's actual bytes, not its name, so a
mislabelled file is rejected. SVGs additionally have to be inert: one carrying
scripts, event handlers or embedded content is refused rather than sanitised.

**Reordering** — in admin mode, drag any tile. Drop it inside its own category
to reorder, or onto another category to move it there. The new order is saved
as soon as you release.

**Categories** — deleting one also deletes every link inside it, and asks first.

## Data

Everything lives in `data/` (`/data` in the container):

- `links.json` — categories and links. Human-readable; back it up by copying it.
- `icons/` — cached favicons and uploaded icons, named by content hash. Safe to
  delete, though uploads are gone for good; fetched icons come back next time
  you save a link. Unreferenced files are pruned automatically whenever a link
  or category is edited or removed.

Writes go to a temporary file and are renamed into place, so an unexpected
shutdown cannot leave a half-written `links.json`. Concurrent writes are
serialised, and the server finishes any pending write before exiting on
`SIGINT`/`SIGTERM`.

## Security notes

Read access is public — anyone who can reach the page sees the links. Only
writes require the password. That matches the usual use case (a start page on
your own network), but it does mean **this is not designed to be exposed to the
open internet as-is**. If you do expose it, put it behind HTTPS and set
`SECURE_COOKIES=1`.

- The password is never stored; a scrypt hash is derived at boot and compared in
  constant time.
- Sessions are random 32-byte tokens in an httpOnly, SameSite=Strict cookie,
  valid for 7 days. They are held in memory, so **restarting the server signs
  you out** — deliberate, and it keeps the process stateless on disk.
- Login is rate-limited to 8 attempts per IP per 15 minutes.
- Only `http:` and `https:` URLs are accepted, so a `javascript:` link cannot be
  stored. All user text is escaped at render time.
- A strict Content-Security-Policy is sent, and the page needs no external
  origins to render.

Behind a reverse proxy, forward the client IP (`X-Forwarded-For`) **and** set
`TRUST_PROXY` to the number of proxies in front of the server, so the login rate
limit applies per client rather than per proxy.

Do not set `TRUST_PROXY` when clients connect directly. It tells the server to
believe `X-Forwarded-For`, and a direct client can forge that header to present
a different IP on every request — which defeats the rate limit entirely.

## Running as a service

```ini
# /etc/systemd/system/dashboard.service
[Unit]
Description=Dashboard
After=network.target

[Service]
WorkingDirectory=/opt/dashboard
ExecStart=/usr/bin/node server.js
Environment=ADMIN_PASSWORD=your-password
Environment=PORT=3000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Project layout

```
server.js            Express bootstrap, security headers, graceful shutdown
src/store.js         In-memory state + atomic JSON persistence
src/auth.js          Password hashing, sessions, rate limiting
src/icons.js         Favicon discovery, uploads, caching, garbage collection
src/static.js        Pre-gzipped asset cache
src/routes/api.js    REST API and input validation
public/              index.html, app.js, styles.css
Dockerfile           Single-stage runtime image, non-root, healthchecked
compose.yaml         Production Compose file
```

### API

Reads are public; every write requires the session cookie.

| Method   | Path                   | Purpose                          |
| -------- | ---------------------- | -------------------------------- |
| `GET`    | `/api/health`          | Liveness probe for the container healthcheck |
| `GET`    | `/api/state`           | Categories, links, auth status   |
| `POST`   | `/api/auth/login`      | `{ password }` → session cookie  |
| `POST`   | `/api/auth/logout`     | Clear the session                |
| `POST`   | `/api/icons`           | Upload an icon — raw image bytes as the body, `Content-Type` set to `image/png`, `image/jpeg`, `image/gif` or `image/svg+xml`. Returns the cached name to pass as `icon: { mode: "upload", value }` |
| `POST`   | `/api/links`           | Create a link                    |
| `PUT`    | `/api/links/:id`       | Update a link                    |
| `DELETE` | `/api/links/:id`       | Delete a link                    |
| `POST`   | `/api/categories`      | Create a category                |
| `PUT`    | `/api/categories/:id`  | Rename a category                |
| `DELETE` | `/api/categories/:id`  | Delete a category and its links  |
| `POST`   | `/api/reorder`         | Apply a drag-and-drop result     |

Omitting `icon` on a `PUT /api/links/:id` keeps the existing icon, so editing a
link's name does not trigger a fresh favicon fetch.
