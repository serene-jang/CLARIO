import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, databaseVersion } from './database.js';
import { googleVerifier } from './identity.js';
import { fileURLToPath } from 'node:url';
import { SyntheticMedia } from './synthetic-media.js';
import { DocumentStore } from './classroom-documents.js';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
if (process.env.SERVE_WEB !== undefined && !['true', 'false'].includes(process.env.SERVE_WEB)) {
  throw new Error('SERVE_WEB must be true or false.');
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const { DATABASE_URL, GOOGLE_CLIENT_ID, APP_ORIGINS } = process.env;
if (Boolean(DATABASE_URL) !== Boolean(APP_ORIGINS) || (GOOGLE_CLIENT_ID && !DATABASE_URL)) {
  throw new Error('Set DATABASE_URL and APP_ORIGINS together. GOOGLE_CLIENT_ID is optional.');
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
if (process.env.CLARIO_DOCUMENTS_DIR !== undefined && (!process.env.CLARIO_DOCUMENTS_DIR || !pool))
  throw new Error(
    'CLARIO_DOCUMENTS_DIR requires a private absolute path and configured authentication/database.',
  );
if (
  process.env.CLARIO_SYNTHETIC_MEDIA !== undefined &&
  !['true', 'false'].includes(process.env.CLARIO_SYNTHETIC_MEDIA)
)
  throw new Error('CLARIO_SYNTHETIC_MEDIA must be true or false.');
if (process.env.CLARIO_SYNTHETIC_MEDIA === 'true' && !pool)
  throw new Error('Synthetic media requires configured authentication and a database.');
const syntheticMedia =
  process.env.CLARIO_SYNTHETIC_MEDIA === 'true' && pool
    ? new SyntheticMedia(pool, origins)
    : undefined;
if (pool) {
  const result = await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [
    databaseVersion,
  ]);
  if (!result.rowCount) throw new Error('Run db:migrate before starting the API.');
} else {
  console.warn('auth_not_configured: /health only; /api returns 503');
}
const server = createServer(
  createApp(
    pool
      ? {
          pool,
          googleClientId: GOOGLE_CLIENT_ID ?? '',
          origins,
          verifyGoogle: GOOGLE_CLIENT_ID
            ? googleVerifier(GOOGLE_CLIENT_ID)
            : async () => {
                throw new Error('Google login is not configured.');
              },
          syntheticMedia,
          documents: process.env.CLARIO_DOCUMENTS_DIR
            ? await DocumentStore.open(process.env.CLARIO_DOCUMENTS_DIR)
            : undefined,
        }
      : undefined,
    process.env.SERVE_WEB === 'true'
      ? {
          web: {
            teacher: fileURLToPath(new URL('../../apps/teacher/dist/', import.meta.url)),
            student: fileURLToPath(new URL('../../apps/student/dist/', import.meta.url)),
          },
        }
      : undefined,
  ),
);

server.listen(port, host, () => {
  console.log(`CLARIO API listening at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    syntheticMedia?.close();
    const deadline = setTimeout(() => {
      console.error('shutdown_timeout');
      process.exit(1);
    }, 10000);
    deadline.unref();
    server.close(() => {
      void (async () => {
        try {
          await pool?.end();
          clearTimeout(deadline);
        } catch {
          console.error('shutdown_database_failed');
          process.exitCode = 1;
        }
      })();
    });
    server.closeIdleConnections();
  });
}
