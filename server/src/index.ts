import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { connectDatabase } from './database.js';
import { googleVerifier } from './identity.js';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const { DATABASE_URL, GOOGLE_CLIENT_ID, APP_ORIGINS } = process.env;
const configured = [DATABASE_URL, GOOGLE_CLIENT_ID, APP_ORIGINS].filter(Boolean).length;
if (configured !== 0 && configured !== 3) {
  throw new Error('Set DATABASE_URL, GOOGLE_CLIENT_ID and APP_ORIGINS together.');
}
const origins = APP_ORIGINS ? APP_ORIGINS.split(',').map((value) => value.trim()) : [];
for (const origin of origins) {
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    url.origin !== origin ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new Error(
      'APP_ORIGINS must contain exact HTTPS origins (HTTP allowed only on localhost).',
    );
  }
}
const pool = DATABASE_URL ? connectDatabase(DATABASE_URL) : undefined;
if (pool) {
  const result = await pool.query('SELECT version FROM schema_migrations WHERE version=5');
  if (!result.rowCount) throw new Error('Run db:migrate before starting the API.');
} else {
  console.warn('auth_not_configured: /health only; /api returns 503');
}
const server = createServer(
  createApp(
    pool && GOOGLE_CLIENT_ID
      ? {
          pool,
          googleClientId: GOOGLE_CLIENT_ID,
          origins,
          verifyGoogle: googleVerifier(GOOGLE_CLIENT_ID),
        }
      : undefined,
  ),
);

server.listen(port, host, () => {
  console.log(`CLARIO API listening at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void pool?.end();
    });
  });
}
