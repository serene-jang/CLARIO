import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/dist/app.js';
import { verifyApi, verifyStatic } from './verify-deployment.mjs';

test('compiled runtime serves both real builds and API on one origin without Vite', async () => {
  const web = {
    teacher: fileURLToPath(new URL('../apps/teacher/dist/', import.meta.url)),
    student: fileURLToPath(new URL('../apps/student/dist/', import.meta.url)),
  };
  const server = createServer(createApp(undefined, { web }));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    await verifyApi(origin);
    for (const role of ['teacher', 'student']) await verifyStatic(`${origin}/${role}/`, web[role]);
    const ready = await fetch(`${origin}/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'not_ready', code: 'AUTH_NOT_CONFIGURED' });
    const api = await fetch(`${origin}/api/student/session`);
    assert.equal(api.status, 503);
    assert.equal((await api.json()).error.code, 'AUTH_NOT_CONFIGURED');
    for (const path of ['/student/assets/missing.js', '/teacher/not-a-page', '/student/.env']) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404);
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('actual server entrypoint enables web hosting without masking unconfigured authentication', async () => {
  const probe = netServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: '',
      GOOGLE_CLIENT_ID: '',
      APP_ORIGINS: '',
      SERVE_WEB: 'true',
      PORT: String(address.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => (output += data.toString()));
  child.stderr.on('data', (data) => (output += data.toString()));
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    let started = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Server exited before startup: ${output}`);
      if (output.includes('CLARIO API listening')) {
        started = true;
        break;
      }
      await delay(100);
    }
    assert.ok(started, `Server failed to start: ${output}`);
    await verifyApi(origin);
    assert.equal((await fetch(`${origin}/student/`)).status, 200);
    assert.equal((await fetch(`${origin}/teacher/`)).status, 200);
    assert.equal((await fetch(`${origin}/ready`)).status, 503);
    assert.equal((await fetch(`${origin}/api/student/session`)).status, 503);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      await exited;
    } finally {
      clearTimeout(deadline);
    }
  }
});
