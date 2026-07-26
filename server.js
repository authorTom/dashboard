import express from 'express';
import * as assets from './src/static.js';
import * as auth from './src/auth.js';
import * as icons from './src/icons.js';
import api from './src/routes/api.js';
import * as store from './src/store.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = express();

app.disable('x-powered-by');

// Only trust X-Forwarded-For when explicitly told to. Trusting it
// unconditionally lets any client spoof the header, hand itself a fresh
// identity per request, and walk straight through the login rate limit.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    // Everything is served from this origin; icons are cached locally, so no
    // external host needs to be reachable for the page to render.
    "default-src 'self'; img-src 'self' data:; style-src 'self'; " +
      "script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
  );
  next();
});

// The payloads here are a few link records at most.
app.use(express.json({ limit: '64kb' }));

app.use('/api', api);

// Cached favicons. Content-addressed filenames, so they can be cached forever.
app.use(
  '/icons',
  express.static(icons.iconDir(), {
    maxAge: '365d',
    immutable: true,
    fallthrough: false,
    index: false,
    dotfiles: 'deny',
  })
);

// index.html, app.js and styles.css, pre-gzipped in memory at boot.
app.use(assets.middleware);

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
app.use((err, req, res, next) => {
  if (err?.status === 404) return res.status(404).json({ error: 'Not found.' });
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large.' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON.' });
  }
  console.error('[server]', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

async function main() {
  await auth.init();
  await store.load();
  await icons.init();
  await assets.load();

  const server = app.listen(PORT, HOST, () => {
    console.log(`Dashboard listening on http://${HOST}:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Set PORT to a free port.`);
    } else if (err.code === 'EACCES') {
      console.error(`Not allowed to bind port ${PORT}. Try a port above 1024.`);
    } else {
      console.error('[server]', err);
    }
    process.exit(1);
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down.`);
    server.close();
    await store.pendingWrites(); // Never exit mid-write.
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
