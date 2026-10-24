import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('health endpoint', () => {
  it('reports that the API process is responding', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
  it('does not confuse a live process with authentication/database readiness', async () => {
    const response = await request(createApp()).get('/ready').expect(503);
    expect(response.body).toEqual({ status: 'not_ready', code: 'AUTH_NOT_CONFIGURED' });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('keeps API-only behavior by default and fails startup for missing web builds', () => {
    expect(() =>
      createApp(undefined, {
        web: { teacher: 'missing-teacher-build', student: 'missing-student-build' },
      }),
    ).toThrow();
  });
  it('serves isolated same-origin builds, redirects canonical entry paths and never falls back for absent assets or APIs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clario-web-test-'));
    try {
      const roots = { teacher: join(directory, 'teacher'), student: join(directory, 'student') };
      for (const [role, root] of Object.entries(roots)) {
        await mkdir(join(root, 'assets'), { recursive: true });
        await writeFile(
          join(root, 'index.html'),
          `<!doctype html><title>${role}</title><script type="module" src="./assets/main.js"></script>`,
        );
        await writeFile(join(root, 'assets', 'main.js'), `console.log('${role}')`);
        await writeFile(join(root, '.env'), 'PRIVATE');
      }
      const app = createApp(undefined, { web: roots });
      await request(app).get('/').expect(302).expect('Location', '/teacher/');
      await request(app).get('/student').expect(302).expect('Location', '/student/');
      for (const role of ['teacher', 'student']) {
        const page = await request(app).get(`/${role}/`).expect(200);
        expect(page.text).toContain(`<title>${role}</title>`);
        expect(page.headers['cache-control']).toBe('no-store');
        await request(app).get(`/${role}/assets/main.js`).expect(200, `console.log('${role}')`);
        await request(app).get(`/${role}/assets/missing.js`).expect(404);
        await request(app).get(`/${role}/.env`).expect(404);
      }
      await request(app).get('/api/no-such-route').expect(503);
      await request(app).get('/student/api/student/session').expect(404);
      await request(app).get('/student/not-a-page').expect(404);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
