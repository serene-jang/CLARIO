import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';

export async function verifyApi(url, request = fetch) {
  const response = await request(new URL('/health', url), {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, 'API health must return HTTP 200');
  assert.deepEqual(await response.json(), { status: 'ok' });
}

export async function verifyStatic(url, directory, request = fetch) {
  const expected = await readFile(path.join(directory, 'index.html'), 'utf8');
  const response = await request(new URL('/', url), {
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  assert.equal(response.status, 200, 'Static page must return HTTP 200');
  const actual = await response.text();
  const title = expected.match(/<title>[^<]+<\/title>/)?.[0];
  assert.ok(title, 'Built HTML must contain a title');
  assert.ok(actual.includes(title), 'Deployed title must match the built app');
  const assets = [...expected.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(assets.length > 0, 'Built HTML must reference compiled assets');
  for (const asset of assets) {
    assert.ok(actual.includes(asset), `Deployed page is stale: missing ${asset}`);
    const deployedAsset = await request(new URL(asset, url), {
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(deployedAsset.status, 200, `Missing deployed asset: ${asset}`);
    assert.deepEqual(
      Buffer.from(await deployedAsset.arrayBuffer()),
      await readFile(path.join(directory, asset.slice(1))),
      `Deployed asset differs from the tested build: ${asset}`,
    );
  }
}

async function main() {
  const [mode, url, directory] = process.argv.slice(2);
  assert.ok(mode === 'api' || mode === 'static', 'Expected api or static mode');
  assert.ok(url, 'Deployment URL is required');
  assert.equal(new URL(url).protocol, 'https:', 'Deployment must use HTTPS');
  if (mode === 'static') assert.ok(directory, 'Built static directory required');
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      if (mode === 'api') await verifyApi(url);
      else await verifyStatic(url, directory);
      console.log(`Verified ${mode} deployment: ${url}`);
      return;
    } catch (error) {
      console.error(`Verification attempt ${attempt}/6 failed: ${error.message}`);
      if (attempt === 6) throw error;
      await setTimeout(10_000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
