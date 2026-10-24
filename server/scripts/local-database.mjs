import EmbeddedPostgres from 'embedded-postgres';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function startLocalDatabase(directory = resolve('.local-postgres')) {
  await mkdir(directory, { recursive: true });
  const configPath = resolve(directory, 'connection.json');
  const config = existsSync(configPath)
    ? JSON.parse(await readFile(configPath, 'utf8'))
    : { password: randomBytes(32).toString('hex'), port: 55432 };
  if (!existsSync(configPath)) {
    await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  }
  const database = new EmbeddedPostgres({
    databaseDir: resolve(directory, 'data'),
    user: 'clario',
    password: config.password,
    port: config.port,
    authMethod: 'scram-sha-256',
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1'],
  });
  if (!existsSync(resolve(directory, 'data', 'PG_VERSION'))) await database.initialise();
  await database.start();
  try {
    const client = database.getPgClient('postgres', '127.0.0.1');
    try {
      await client.connect();
      const result = await client.query("SELECT 1 FROM pg_database WHERE datname='clario'");
      if (!result.rowCount) await client.query('CREATE DATABASE clario');
    } finally {
      await client.end();
    }
    await writeFile(
      resolve(directory, 'connection.env'),
      `DATABASE_URL=postgresql://clario:${config.password}@127.0.0.1:${config.port}/clario\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    await database.stop();
    throw error;
  }
  console.log(
    `Local PostgreSQL ready at 127.0.0.1:${config.port}. Private connection file: ${resolve(directory, 'connection.env')}`,
  );
  return database;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const database = await startLocalDatabase();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await database.stop();
      process.exitCode = 0;
    });
  }
}
