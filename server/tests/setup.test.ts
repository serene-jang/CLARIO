import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parse } from 'dotenv';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createSetupApp, validateSetup } from '../src/setup-app.js';
import { readEnvironment, saveSetupEnvironment } from '../src/setup-environment.js';

const origin = 'http://127.0.0.1:5180';
const token = randomBytes(32).toString('base64url');
const input = {
  googleClientId: '123456-test.apps.googleusercontent.com',
  schoolName: 'Test School',
  domain: 'school.example',
  email: 'admin@school.example',
  adminName: 'Test Admin',
};
function fixture(apply = vi.fn(async () => {})) {
  return {
    apply,
    app: createSetupApp({ origin, token, assets: resolve('setup'), apply }),
  };
}
const headers = { Host: '127.0.0.1:5180', Origin: origin, 'X-Setup-Token': token };

describe('local setup boundary', () => {
  it('persists configuration, preserves unrelated settings and rejects stale writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clario-setup-env-'));
    try {
      const path = join(directory, '.env');
      expect(await readEnvironment(path)).toBe('');
      const previous = '# Existing settings\nCUSTOM_SETTING=keep\nGOOGLE_CLIENT_ID=old\n';
      await writeFile(path, previous);
      const values = {
        DATABASE_URL: 'postgresql://local:test@127.0.0.1:55432/clario',
        GOOGLE_CLIENT_ID: input.googleClientId,
        APP_ORIGINS: 'http://127.0.0.1:5173,http://127.0.0.1:5174',
        PORT: '4000',
      };
      await saveSetupEnvironment(path, previous, values);
      const saved = await readFile(path, 'utf8');
      expect(parse(saved)).toEqual({ CUSTOM_SETTING: 'keep', ...values });
      expect(saved).toContain('# Existing settings');
      expect(saved.match(/^GOOGLE_CLIENT_ID=/gm)).toHaveLength(1);
      await expect(saveSetupEnvironment(path, previous, values)).rejects.toThrow('concurrently');
      expect(await readFile(path, 'utf8')).toBe(saved);
      expect(await readdir(directory)).toEqual(['.env']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serves the form without embedding a token or external dependencies', async () => {
    const { app } = fixture();
    const response = await request(app).get('/').set('Host', headers.Host);
    expect(response.status).toBe(200);
    expect(response.text).toContain('Google OAuth 클라이언트 ID');
    expect(response.text).not.toContain(token);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('rejects DNS rebinding, foreign origins, missing and wrong tokens', async () => {
    const { app, apply } = fixture();
    for (const extra of [
      { Host: 'evil.example' },
      { Origin: 'https://evil.example' },
      { 'X-Setup-Token': '' },
      { 'X-Setup-Token': 'x'.repeat(token.length) },
    ]) {
      const response = await request(app)
        .post('/apply')
        .set({ ...headers, ...extra })
        .send(input);
      expect(response.status).toBe(403);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('validates client ID, required fields, domain and administrator address', async () => {
    const { app, apply } = fixture();
    for (const extra of [
      { googleClientId: 'client-secret' },
      { schoolName: '' },
      { email: 'admin@other.example' },
      { domain: 'https://school.example' },
      { adminName: 42 },
    ]) {
      expect(
        (
          await request(app)
            .post('/apply')
            .set(headers)
            .send({ ...input, ...extra })
        ).status,
      ).toBe(400);
    }
    expect(apply).not.toHaveBeenCalled();
    expect(validateSetup({ ...input, domain: ' SCHOOL.EXAMPLE ' }).domain).toBe('school.example');
    expect(validateSetup({ ...input, domain: 'gmail.com', email: 'owner@gmail.com' }).email).toBe(
      'owner@gmail.com',
    );
  });

  it('applies once and refuses additional registration in the same setup session', async () => {
    const { app, apply } = fixture();
    expect((await request(app).post('/apply').set(headers).send(input)).status).toBe(200);
    expect(apply).toHaveBeenCalledExactlyOnceWith(input);
    expect((await request(app).post('/apply').set(headers).send(input)).status).toBe(409);
  });

  it('reports an apply failure without claiming success and permits a retry', async () => {
    const apply = vi.fn(async () => {});
    apply.mockRejectedValueOnce(new Error('Local database unavailable.'));
    const { app } = fixture(apply);
    const failed = await request(app).post('/apply').set(headers).send(input);
    expect(failed.status).toBe(500);
    expect(failed.body.ok).toBeUndefined();
    expect(failed.body.error).toContain('unavailable');
    expect((await request(app).post('/apply').set(headers).send(input)).status).toBe(200);
  });

  it('rejects overlapping submissions and invalid JSON', async () => {
    let finish = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { app } = fixture(
      vi.fn(async () => {
        entered();
        await waiting;
      }),
    );
    const first = request(app)
      .post('/apply')
      .set(headers)
      .send(input)
      .then((response) => response);
    await started;
    expect((await request(app).post('/apply').set(headers).send(input)).status).toBe(409);
    finish();
    expect((await first).status).toBe(200);
    expect(
      (
        await request(app)
          .post('/apply')
          .set(headers)
          .set('Content-Type', 'application/json')
          .send('{')
      ).status,
    ).toBe(400);
  });
});
