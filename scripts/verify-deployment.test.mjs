import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyApi, verifyStatic } from './verify-deployment.mjs';

test('API verification rejects successful HTTP responses with wrong bodies', async () => {
  await verifyApi('https://example.test', async () => Response.json({ status: 'ok' }));
  await assert.rejects(() =>
    verifyApi('https://example.test', async () => Response.json({ status: 'failed' })),
  );
  await assert.rejects(() =>
    verifyApi('https://example.test', async () => Response.json({ status: 'ok' }, { status: 503 })),
  );
});

test('static verification rejects stale HTML and incorrect or missing assets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clario-verify-'));
  try {
    const html = '<title>CLARIO</title><script src="/assets/current.js"></script>';
    await mkdir(path.join(directory, 'assets'));
    await writeFile(path.join(directory, 'index.html'), html);
    await writeFile(path.join(directory, 'assets', 'current.js'), 'current');
    const request = async (url) => new Response(url.pathname === '/' ? html : 'current');
    await verifyStatic('https://example.test', directory, request);
    await assert.rejects(() =>
      verifyStatic(
        'https://example.test',
        directory,
        async () => new Response('<title>CLARIO</title>'),
      ),
    );
    await assert.rejects(() =>
      verifyStatic(
        'https://example.test',
        directory,
        async (url) => new Response(url.pathname === '/' ? html : 'outdated'),
      ),
    );
    await assert.rejects(() =>
      verifyStatic('https://example.test', directory, async (url) =>
        url.pathname === '/' ? new Response(html) : new Response('Not found', { status: 404 }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
