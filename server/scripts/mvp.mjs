import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { startLocalDatabase } from './local-database.mjs';
import { connectDatabase, migrate } from '../dist/database.js';
import { createApp } from '../dist/app.js';

const port = Number(process.env.CLARIO_MVP_PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('CLARIO_MVP_PORT must be an integer between 1 and 65535.');
if (process.env.NODE_ENV === 'production')
  throw new Error('The local MVP launcher is not a production deployment command.');
const directory = resolve(process.env.CLARIO_MVP_DATA_DIR ?? '.local-postgres');
const origin = `http://127.0.0.1:${port}`;
console.log(
  'Starting local MVP. Classrooms and accounts persist on this machine. No external login, capture, Drive or device control.',
);
const database = await startLocalDatabase(directory);
let pool;
let server;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    console.error('mvp_shutdown_timeout');
    process.exit(1);
  }, 10000);
  deadline.unref();
  try {
    if (server?.listening) {
      server.closeIdleConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await pool?.end();
    await database.stop();
  } finally {
    clearTimeout(deadline);
  }
}
try {
  const configuration = parse(await readFile(resolve(directory, 'connection.env')));
  pool = connectDatabase(configuration.DATABASE_URL);
  // Only the launcher's own loopback development database is migrated.
  await migrate(pool);
  const app = createApp(
    {
      pool,
      origins: [origin],
      googleClientId: '',
      verifyGoogle: async () => {
        throw new Error('External login is unavailable in the MVP.');
      },
    },
    {
      web: {
        teacher: fileURLToPath(new URL('../../apps/teacher/dist/', import.meta.url)),
        student: fileURLToPath(new URL('../../apps/student/dist/', import.meta.url)),
      },
    },
  );
  server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Teacher: ${origin}/teacher/`);
  console.log(`Student: ${origin}/student/`);
  console.log(
    'Use separate browser profiles for teacher/students. Ctrl+C stops services without deleting data.',
  );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void stop().catch(() => {
        console.error('mvp_shutdown_failed');
        process.exitCode = 1;
      });
    });
  }
} catch (error) {
  console.error('mvp_start_failed:', error instanceof Error ? error.message : 'Unknown error.');
  await stop();
  process.exitCode = 1;
}
