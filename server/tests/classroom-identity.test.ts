import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, join as pathJoin } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool, type PoolConfig } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate, databaseVersion } from '../src/database.js';
import { DocumentStore } from '../src/classroom-documents.js';
import { blockingDomains } from '../src/site-blocking.js';
import { digest } from '../src/access.js';
import type { GoogleIdentity } from '../src/identity.js';
import {
  issuePendingStudentCredential,
  issueApprovedStudentCredential,
  studentCsrfToken,
} from '../src/student-sessions.js';
import { transaction } from '../src/api-core.js';
import {
  generateInvitationCode,
  issueClassroomInvitation,
  stopClassroom,
} from '../src/classroom-management.js';
import { consumeJoinBudget, joinRateSecret, browserIdentifier } from '../src/student-join.js';
import { SyntheticMedia } from '../src/synthetic-media.js';

let pool: Pool;
let database: EmbeddedPostgres;
let directory: string;
let app: ReturnType<typeof createApp>;
let syntheticMedia: SyntheticMedia | undefined;
let databaseConfig: PoolConfig;
const schoolId = randomUUID();
const teacherId = randomUUID();
const studentId = randomUUID();
const adminId = randomUUID();
const classId = randomUUID();
const identities = new Map<string, GoogleIdentity>();
const origin = 'http://127.0.0.1:5173';

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test port.');
      server.close(() => resolve(address.port));
    });
  });
  directory = await mkdtemp(join(tmpdir(), 'clario-identity-'));
  const password = randomBytes(24).toString('hex');
  database = new EmbeddedPostgres({
    databaseDir: join(directory, 'data'),
    port,
    user: 'clario',
    password,
    authMethod: 'scram-sha-256',
    persistent: true,
    postgresFlags: ['-h', '127.0.0.1'],
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: (message) => console.error(message),
  });
  await database.initialise();
  await database.start();
  databaseConfig = { host: '127.0.0.1', port, user: 'clario', password, database: 'postgres' };
  pool = new Pool(databaseConfig);
  await migrate(pool, 5);
  await pool.query('INSERT INTO schools(id,name,google_domain) VALUES ($1,$2,$3)', [
    schoolId,
    'Legacy fixture',
    'legacy.example',
  ]);
  for (const [id, role] of [
    [teacherId, 'teacher'],
    [studentId, 'student'],
    [adminId, 'school_admin'],
  ]) {
    await pool.query(
      'INSERT INTO users(id,school_id,email,name,role,google_sub) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, schoolId, `${role}@legacy.example`, role, role, `legacy-${role}`],
    );
  }
  await pool.query('INSERT INTO classes(id,school_id,teacher_id,name) VALUES ($1,$2,$3,$4)', [
    classId,
    schoolId,
    teacherId,
    'Preserved class',
  ]);
  await pool.query('INSERT INTO class_members(class_id,student_id,school_id) VALUES ($1,$2,$3)', [
    classId,
    studentId,
    schoolId,
  ]);
  await migrate(pool);
  await migrate(pool);
}, 90000);

beforeEach(() => {
  syntheticMedia?.close();
  syntheticMedia = undefined;
  app = createApp({
    pool,
    origins: [origin],
    googleClientId: 'test-client',
    verifyGoogle: async (credential) => {
      const identity = identities.get(credential);
      if (!identity) throw new Error('Invalid test identity.');
      return identity;
    },
  });
});

afterAll(async () => {
  syntheticMedia?.close();
  await pool?.end();
  await database?.stop();
  if (directory)
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 30000);

async function signIn(
  email: string,
  sub = randomUUID(),
  extra: Record<string, unknown> = {},
  nonceOverride?: string,
) {
  const challenge = await request(app).post('/api/auth/challenge').send({});
  const credential = randomUUID();
  identities.set(credential, {
    email,
    sub,
    domain: email.split('@')[1],
    nonce: nonceOverride ?? challenge.body.nonce,
  });
  const body = {
    challengeId: challenge.body.challengeId,
    credential,
    displayName: 'Independent user',
    ...extra,
  };
  return { response: await request(app).post('/api/identity/auth/google').send(body), body };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('account-free join and teacher approval', () => {
  it('normalizes only bounded DNS domains and protects every configured CLARIO web origin and ancestor', () => {
    expect(blockingDomains([' Example.com ', 'example.com', 'a.example.test'])).toEqual([
      'a.example.test',
      'example.com',
    ]);
    const maximum = Array.from({ length: 50 }, (_, n) => `domain-${n}.example.test`);
    expect(blockingDomains(maximum)).toHaveLength(50);
    expect(() => blockingDomains([...maximum, 'extra.example.test'])).toThrow();
    for (const domain of ['example.com', 'api.example.com', 'other.test', 'app.other.test']) {
      expect(() =>
        blockingDomains([domain], ['https://api.example.com', 'https://app.other.test']),
      ).toThrow();
    }
    expect(blockingDomains(['separate.example.com'], ['https://api.example.com'])).toEqual([
      'separate.example.com',
    ]);
  });
  async function enableDocuments() {
    const root = pathJoin(directory, `documents-${randomUUID()}`),
      documents = await DocumentStore.open(root);
    app = createApp({
      pool,
      origins: [origin],
      googleClientId: 'test-client',
      documents,
      verifyGoogle: async (credential) => {
        const identity = identities.get(credential);
        if (!identity) throw new Error('Invalid test identity');
        return identity;
      },
    });
    return { root, documents };
  }
  const pdf = Buffer.from(
    '%PDF-1.7\n1 0 obj <</Type /Catalog>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n',
  );
  const upload = (f: { id: string; token: string }, data = pdf) =>
    request(app)
      .post(`/api/identity/classrooms/${f.id}/documents?title=${encodeURIComponent('Test PDF')}`)
      .set(bearer(f.token))
      .set('Content-Type', 'application/pdf')
      .send(data);
  it('stores PDF privately, authenticates every download, isolates classrooms and deletes the actual original', async () => {
    const { root } = await enableDocuments(),
      { f, active } = await lessonFixture(),
      other = await fixture();
    const base = `/api/identity/classrooms/${f.id}/documents`;
    await request(app).post(`${base}?title=bad`).set(bearer(f.token)).send({}).expect(415);
    await upload(f, Buffer.from('Not PDF')).expect(400);
    const created = (await upload(f).expect(201)).body.id;
    expect(await readFile(pathJoin(root, `${created}.pdf`))).toEqual(pdf);
    const list = await request(app).get(base).set(bearer(f.token)).expect(200);
    expect(list.body.documents[0]).toMatchObject({
      id: created,
      title: 'Test PDF',
      status: 'available',
      bytes: pdf.length,
    });
    const teacherDownload = await request(app)
      .get(`${base}/${created}/download`)
      .set(bearer(f.token))
      .expect(200);
    expect(teacherDownload.body).toEqual(pdf);
    await request(app).get(`${base}/${created}/download`).expect(401);
    await request(app).get(`${base}/${created}/download`).set(bearer(other.token)).expect(404);
    const studentBase = '/api/student/documents';
    const own = await request(app)
      .get(studentBase)
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    expect(own.body.documents.map((d: { id: string }) => d.id)).toEqual([created]);
    const download = await request(app)
      .get(`${studentBase}/${created}/download`)
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    expect(download.body).toEqual(pdf);
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['cache-control']).toBe('no-store');
    const pending = await join(f.code, '002').expect(201);
    await request(app)
      .get(`${studentBase}/${created}/download`)
      .set(site)
      .set('Cookie', cookies(pending))
      .expect(403);
    const foreign = await lessonFixture();
    await request(app)
      .get(`${studentBase}/${created}/download`)
      .set(site)
      .set('Cookie', cookies(foreign.active))
      .expect(404);
    await request(app).get(`/documents/${created}.pdf`).expect(404);
    await request(app).delete(`${base}/${created}`).set(bearer(f.token)).expect(204);
    expect(await readdir(root)).toEqual([]);
    await request(app)
      .get(`${studentBase}/${created}/download`)
      .set(site)
      .set('Cookie', cookies(active))
      .expect(404);
    const audits = (
      await pool.query(
        "SELECT action,target_id FROM classroom_participation_audit WHERE class_id=$1 AND action LIKE 'document.%'",
        [f.id],
      )
    ).rows;
    expect(audits.every((row) => row.target_id === created)).toBe(true);
    const actions = audits.map((r) => r.action);
    expect(actions).toContain('document.uploaded');
    expect(actions).toContain('document.downloaded');
    expect(actions).toContain('document.deleted');
  });
  it('keeps failed uploads and failed original deletions explicit and retryable', async () => {
    const { documents, root } = await enableDocuments(),
      f = await fixture();
    const put = vi.spyOn(documents, 'put').mockRejectedValueOnce(new Error('storage full'));
    await upload(f).expect(500);
    put.mockRestore();
    const row = (
      await pool.query('SELECT id,status FROM classroom_documents WHERE class_id=$1', [f.id])
    ).rows[0];
    expect(row.status).toBe('failed');
    const base = `/api/identity/classrooms/${f.id}/documents`;
    await request(app).delete(`${base}/${row.id}`).set(bearer(f.token)).expect(204);
    const created = (await upload(f).expect(201)).body.id;
    const remove = vi
      .spyOn(documents, 'remove')
      .mockRejectedValueOnce(new Error('filesystem denied'));
    await request(app).delete(`${base}/${created}`).set(bearer(f.token)).expect(500);
    remove.mockRestore();
    expect(
      (await pool.query('SELECT status FROM classroom_documents WHERE id=$1', [created])).rows[0]
        .status,
    ).toBe('deleting');
    expect(await readdir(root)).toEqual([`${created}.pdf`]);
    await request(app).get(`${base}/${created}/download`).set(bearer(f.token)).expect(404);
    await request(app).delete(`${base}/${created}`).set(bearer(f.token)).expect(204);
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects oversized PDFs and public storage paths, reports disabled storage and persists files across app restart', async () => {
    const { root } = await enableDocuments(),
      f = await fixture();
    await upload(f, Buffer.alloc(10 * 1024 * 1024 + 1)).expect(413);
    expect(await readdir(root)).toEqual([]);
    const maximum = Buffer.alloc(10 * 1024 * 1024, 32);
    Buffer.from('%PDF-2.0\n').copy(maximum);
    Buffer.from('\n%%EOF\n').copy(maximum, maximum.length - 7);
    const maxId = (await upload(f, maximum).expect(201)).body.id;
    expect((await readFile(pathJoin(root, `${maxId}.pdf`))).length).toBe(10 * 1024 * 1024);
    await request(app)
      .delete(`/api/identity/classrooms/${f.id}/documents/${maxId}`)
      .set(bearer(f.token))
      .expect(204);
    await expect(DocumentStore.open(pathJoin(process.cwd(), 'public'))).rejects.toThrow('outside');
    const created = (await upload(f).expect(201)).body.id;
    const documents = await DocumentStore.open(root);
    expect(await documents.read(created)).toEqual(pdf);
    await expect(documents.read('../invalid')).rejects.toThrow();
    app = createApp({
      pool,
      origins: [origin],
      googleClientId: 'test-client',
      verifyGoogle: async () => {
        throw new Error('unused');
      },
    });
    const list = await request(app)
      .get(`/api/identity/classrooms/${f.id}/documents`)
      .set(bearer(f.token))
      .expect(200);
    expect(list.body.enabled).toBe(false);
    await upload(f).expect(503);
  });
  it('does not report file upload or deletion complete when its audit commit fails, and can safely retry cleanup', async () => {
    const { root } = await enableDocuments(),
      f = await fixture(),
      base = `/api/identity/classrooms/${f.id}/documents`;
    await pool.query(`CREATE FUNCTION reject_document_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action IN ('document.uploaded','document.deleted') THEN RAISE EXCEPTION 'synthetic document audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_document_audit BEFORE INSERT ON classroom_participation_audit FOR EACH ROW EXECUTE FUNCTION reject_document_audit()`);
    let document: string;
    try {
      await upload(f).expect(500);
      const row = (
        await pool.query('SELECT id,status FROM classroom_documents WHERE class_id=$1', [f.id])
      ).rows[0];
      document = row.id;
      expect(row.status).toBe('failed');
      expect(await readdir(root)).toEqual([`${document}.pdf`]);
      await request(app).delete(`${base}/${document}`).set(bearer(f.token)).expect(500);
      expect(await readdir(root)).toEqual([]);
      expect(
        (await pool.query('SELECT status FROM classroom_documents WHERE id=$1', [document])).rows[0]
          .status,
      ).toBe('deleting');
      expect(
        (
          await pool.query(
            "SELECT id FROM classroom_participation_audit WHERE class_id=$1 AND action IN ('document.uploaded','document.deleted')",
            [f.id],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await pool.query(
        'DROP TRIGGER reject_document_audit ON classroom_participation_audit; DROP FUNCTION reject_document_audit()',
      );
    }
    await request(app).delete(`${base}/${document!}`).set(bearer(f.token)).expect(204);
  });
  async function browserPair(active: request.Response) {
    const code = await request(app)
      .post('/api/student/browser-code')
      .set(site)
      .set('Cookie', cookies(active))
      .set('X-Student-CSRF', active.body.csrfToken)
      .send({})
      .expect(201);
    const paired = await request(app)
      .post('/api/browser-device/pair')
      .send({ code: code.body.code })
      .expect(201);
    return { code: code.body.code, paired };
  }
  it('enforces the exact 100-document class limit and denies a withdrawn student an existing PDF', async () => {
    await enableDocuments();
    const { f, active } = await lessonFixture(),
      document = (await upload(f).expect(201)).body.id;
    await pool.query(
      `INSERT INTO classroom_documents(id,class_id,title,bytes,status,created_by)
       SELECT gen_random_uuid(),d.class_id,'Synthetic capacity',1,'failed',d.created_by
       FROM classroom_documents d CROSS JOIN generate_series(1,99) WHERE d.id=$1`,
      [document],
    );
    const list = await request(app)
      .get(`/api/identity/classrooms/${f.id}/documents`)
      .set(bearer(f.token))
      .expect(200);
    expect(list.body.documents).toHaveLength(100);
    await upload(f).expect(409);
    await request(app)
      .get(`/api/student/documents/${document}/download`)
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    await request(app)
      .post('/api/student/session/end')
      .set(site)
      .set('Cookie', cookies(active))
      .set('X-Student-CSRF', active.body.csrfToken)
      .send({})
      .expect(204);
    await request(app)
      .get(`/api/student/documents/${document}/download`)
      .set(site)
      .set('Cookie', cookies(active))
      .expect(401);
  });
  it('scopes domain policy and one-use student browser credentials to current approval and active lessons', async () => {
    const { f, active } = await lessonFixture(),
      foreign = await fixture(),
      base = `/api/identity/classrooms/${f.id}/blocking`;
    await request(app)
      .patch(base)
      .set(bearer(foreign.token))
      .send({ domains: ['example.com'] })
      .expect(404);
    for (const domain of [
      'https://example.com',
      '*.example.com',
      '127.0.0.1',
      'localhost',
      'a.local',
    ]) {
      await request(app)
        .patch(base)
        .set(bearer(f.token))
        .send({ domains: [domain] })
        .expect(400);
    }
    await request(app)
      .patch(base)
      .set(bearer(f.token))
      .send({ domains: ['Example.com', 'example.com'] })
      .expect(200, { configuredDomains: ['example.com'] });
    await request(app)
      .post('/api/student/browser-code')
      .set(site)
      .set('Cookie', cookies(active))
      .send({})
      .expect(403);
    const { code, paired } = await browserPair(active),
      token = paired.body.token;
    await request(app).post('/api/browser-device/pair').send({ code }).expect(401);
    const sync = () =>
      request(app)
        .post('/api/browser-device/sync')
        .set('Authorization', `Bearer ${token}`)
        .send({});
    expect((await sync().expect(200)).body.blocking.domains).toEqual([]);
    const sessionId = (await lesson(f, 'start')).body.lesson.id;
    const policy = (await sync().expect(200)).body.blocking;
    expect(policy).toMatchObject({ domains: ['example.com'], lessonId: sessionId });
    expect(Date.parse(policy.expiresAt) - Date.parse(policy.observedAt)).toBe(60000);
    await request(app)
      .get('/api/student/blocking')
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    await request(app).get('/api/identity/me').set('Authorization', `Bearer ${token}`).expect(401);
    await request(app)
      .get('/api/student/session')
      .set(site)
      .set('Cookie', `clario-student-dev=${token}`)
      .expect(401);
    await lesson(f, 'end', { sessionId, confirm: true }).expect(200);
    expect((await sync().expect(200)).body.blocking.domains).toEqual([]);
    await request(app)
      .post('/api/student/browser-code')
      .set(site)
      .set('Cookie', cookies(active))
      .set('X-Student-CSRF', active.body.csrfToken)
      .send({})
      .expect(201);
    await sync().expect(401);
    await request(app)
      .patch(base)
      .set(bearer(f.token))
      .send({ domains: [] })
      .expect(200, { configuredDomains: [] });
    await request(app)
      .get(base)
      .set(bearer(f.token))
      .expect(200, { configuredDomains: [], active: false });
    const replacement = await browserPair(active);
    await request(app)
      .post('/api/browser-device/disconnect')
      .set('Authorization', `Bearer ${replacement.paired.body.token}`)
      .send({})
      .expect(204);
    await request(app)
      .post('/api/browser-device/sync')
      .set('Authorization', `Bearer ${replacement.paired.body.token}`)
      .send({})
      .expect(401);
  });
  it('revokes browser capabilities when the underlying student leaves and never converts a pairing code to a student login', async () => {
    const { f, active } = await lessonFixture();
    await lesson(f, 'start');
    const { paired } = await browserPair(active),
      token = paired.body.token;
    await request(app)
      .post('/api/student/session/end')
      .set(site)
      .set('Cookie', cookies(active))
      .set('X-Student-CSRF', active.body.csrfToken)
      .send({})
      .expect(204);
    await request(app)
      .post('/api/browser-device/sync')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(401);
    const row = (await pool.query('SELECT blocked_domains FROM classes WHERE id=$1', [f.id]))
      .rows[0];
    expect(row.blocked_domains).toEqual([]);
  });
  it('expires browser pairing codes after five minutes and bounds successful issuance per participant', async () => {
    const { active } = await lessonFixture();
    const issue = () =>
      request(app)
        .post('/api/student/browser-code')
        .set(site)
        .set('Cookie', cookies(active))
        .set('X-Student-CSRF', active.body.csrfToken)
        .send({});
    const first = await issue().expect(201);
    await pool.query(
      "UPDATE classroom_browser_connections SET code_expires_at=statement_timestamp()-interval '1 second' WHERE code_hash=$1",
      [digest(first.body.code)],
    );
    await request(app).post('/api/browser-device/pair').send({ code: first.body.code }).expect(401);
    for (let count = 0; count < 4; count++) await issue().expect(201);
    await issue().expect(429);
  });
  it('blocks real-screen collection until approved storage and retention are implemented, even with synthetic media enabled', async () => {
    enableSynthetic();
    const { f, active } = await lessonFixture();
    await lesson(f, 'start');
    const path = '/api/student/screen-media';
    await request(app).get(path).set(site).expect(401);
    const pending = await join(f.code, '009').expect(201);
    await request(app).get(path).set(site).set('Cookie', cookies(pending)).expect(403);
    await request(app).get(path).set(site).set('Cookie', cookies(active)).expect(200, {
      enabled: false,
      reason: 'POLICY_NOT_CONFIGURED',
      persistentStorage: false,
    });
    await request(app)
      .post(`${path}/start`)
      .set(site)
      .set('Cookie', cookies(active))
      .send({})
      .expect(403);
    for (const action of ['start', 'chunk', 'complete']) {
      const denied = await request(app)
        .post(`${path}/${action}`)
        .set(site)
        .set('Cookie', cookies(active))
        .set('X-Student-CSRF', active.body.csrfToken)
        .send({
          confirm: true,
          enabled: true,
          policyApproved: true,
          retentionDays: 1,
          data: 'not collected',
        })
        .expect(403);
      expect(denied.body.error.code).toBe('SCREEN_MEDIA_POLICY_REQUIRED');
    }
    const audits = await pool.query(
      "SELECT result FROM classroom_participation_audit WHERE class_id=$1 AND action='screen_media.policy_denied'",
      [f.id],
    );
    expect(audits.rows).toEqual([{ result: 'denied' }, { result: 'denied' }, { result: 'denied' }]);
    expect((await mediaTeacher(f)).body.runs).toEqual([]);
  });
  function enableSynthetic() {
    syntheticMedia = new SyntheticMedia(pool, [origin]);
    app = createApp({
      pool,
      origins: [origin],
      googleClientId: 'test-client',
      syntheticMedia,
      verifyGoogle: async (credential) => {
        const identity = identities.get(credential);
        if (!identity) throw new Error('Invalid identity');
        return identity;
      },
    });
    return syntheticMedia;
  }
  it('reports database/schema readiness independently from liveness without treating a stalled query as success', async () => {
    await request(app).get('/ready').expect(200, { status: 'ready' });
    await pool.query('DELETE FROM schema_migrations WHERE version=$1', [databaseVersion]);
    try {
      await request(app)
        .get('/ready')
        .expect(503, { status: 'not_ready', code: 'MIGRATION_REQUIRED' });
      await request(app).get('/health').expect(200, { status: 'ok' });
    } finally {
      await pool.query('INSERT INTO schema_migrations(version) VALUES($1)', [databaseVersion]);
    }
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await request(app)
        .get('/ready')
        .expect(503, { status: 'not_ready', code: 'DATABASE_UNAVAILABLE' });
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    await request(app).get('/ready').expect(200, { status: 'ready' });
    const unknown = await request(app).get('/api/no-such-route').expect(401);
    expect(unknown.type).toBe('application/json');
    expect(unknown.body.error.code).toBe('UNAUTHENTICATED');
  }, 12000);
  const site = { Origin: origin, Host: new URL(origin).host };
  const cookies = (response: request.Response) => {
    const headers = response.headers['set-cookie'];
    return (Array.isArray(headers) ? headers : headers ? [headers] : [])
      .map((value: string) => value.split(';')[0])
      .join('; ');
  };
  async function fixture(capacity = 40) {
    await pool.query('DELETE FROM student_join_rate_events');
    const { response: owner } = await signIn(`${randomUUID()}@example.test`);
    const created = await request(app)
      .post('/api/identity/classrooms')
      .set(bearer(owner.body.token))
      .send({ name: 'Join fixture', capacity })
      .expect(201);
    return {
      token: owner.body.token as string,
      id: created.body.classroom.id as string,
      code: created.body.invitation.code as string,
    };
  }
  const join = (code: string, studentNumber = '001', kind = 'join') =>
    request(app)
      .post('/api/student/join')
      .set(site)
      .send({ code, name: ' Synthetic student ', studentNumber, kind });
  const list = (f: { token: string; id: string }) =>
    request(app).get(`/api/identity/classrooms/${f.id}/requests`).set(bearer(f.token));
  const resolve = (f: { token: string; id: string }, id: string, action = 'approve') =>
    request(app)
      .post(`/api/identity/classrooms/${f.id}/requests/${id}/${action}`)
      .set(bearer(f.token))
      .send({});
  async function activate(response: request.Response) {
    return request(app)
      .post('/api/student/session/activate')
      .set(site)
      .set('Cookie', cookies(response))
      .set('X-Student-CSRF', response.body.csrfToken)
      .send({});
  }
  const lesson = (f: { id: string; token: string }, action?: string, body: object = {}) => {
    const path = `/api/identity/classrooms/${f.id}/lesson${action ? `/${action}` : ''}`;
    return (action ? request(app).post(path).send(body) : request(app).get(path)).set(
      bearer(f.token),
    );
  };
  const pulse = (active: request.Response, input: object, action = 'heartbeat') =>
    request(app)
      .post(`/api/student/lesson/${action}`)
      .set(site)
      .set('Cookie', cookies(active))
      .set('X-Student-CSRF', active.body.csrfToken)
      .send(input);
  async function lessonFixture() {
    const f = await fixture(),
      pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    return { f, active: await activate(pending) };
  }
  const mediaStudent = (active: request.Response, action?: string, data: object = {}) => {
    const path = `/api/student/synthetic-media${action ? `/${action}` : ''}`;
    const req = action
      ? request(app).post(path).set('X-Student-CSRF', active.body.csrfToken).send(data)
      : request(app).get(path);
    return req.set(site).set('Cookie', cookies(active));
  };
  const mediaTeacher = (f: { id: string; token: string }, run?: string) =>
    request(app)
      .get(`/api/identity/classrooms/${f.id}/synthetic-media${run ? `/${run}/video` : ''}`)
      .set(bearer(f.token));
  it('keeps synthetic media disabled by default and rejects production/nonlocal construction', async () => {
    const { f, active } = await lessonFixture();
    await mediaStudent(active).expect(200, { enabled: false, synthetic: true });
    await mediaStudent(active, 'start', { confirmSynthetic: true }).expect(403);
    await mediaTeacher(f).expect(200, { enabled: false, synthetic: true });
    expect(() => new SyntheticMedia(pool, ['https://example.test'])).toThrow();
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new SyntheticMedia(pool, [origin])).toThrow();
    } finally {
      if (old === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = old;
    }
  });
  it('transports fresh synthetic PNGs and ordered WebM bytes only to a current classroom manager', async () => {
    enableSynthetic();
    const { f, active } = await lessonFixture(),
      other = await fixture();
    await mediaStudent(active, 'start', { confirmSynthetic: true }).expect(409);
    const sessionId = (await lesson(f, 'start')).body.lesson.id;
    await mediaStudent(active, 'start', {}).expect(400);
    const started = await mediaStudent(active, 'start', { confirmSynthetic: true }).expect(200);
    const run = started.body.id;
    expect(started.body).toMatchObject({
      synthetic: true,
      status: 'recording',
      lessonId: sessionId,
    });
    await mediaStudent(active, 'start', { confirmSynthetic: true }).expect(409);
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');
    await mediaStudent(active, 'frame', { id: run, sequence: 1, data: png }).expect(200);
    await mediaStudent(active, 'frame', { id: run, sequence: 1, data: png }).expect(409);
    const view = await mediaTeacher(f).expect(200);
    expect(view.body.runs[0].frame).toBe(png);
    await request(app)
      .get(`/api/identity/classrooms/${f.id}/synthetic-media`)
      .set(bearer(other.token))
      .expect(404);
    await request(app)
      .get(`/api/identity/classrooms/${f.id}/synthetic-media/${run}/video`)
      .expect(401);
    await mediaTeacher(f, run).expect(404);
    await mediaStudent(active, 'stop', { id: run }).expect(200);
    await mediaStudent(active, 'complete', { id: run, bytes: 0, chunks: 0 }).expect(409);
    const webm = Buffer.from('1a45dfa300010203', 'hex');
    await mediaStudent(active, 'chunk', {
      id: run,
      sequence: 1,
      data: webm.toString('base64'),
    }).expect(409);
    await mediaStudent(active, 'chunk', {
      id: run,
      sequence: 0,
      data: webm.toString('base64'),
    }).expect(200);
    await mediaStudent(active, 'complete', { id: run, bytes: webm.length + 1, chunks: 1 }).expect(
      409,
    );
    await mediaStudent(active, 'complete', { id: run, bytes: webm.length, chunks: 1 }).expect(200);
    const video = await mediaTeacher(f, run).expect(200);
    expect(video.headers['content-type']).toContain('video/webm');
    expect(video.headers['cache-control']).toBe('no-store');
    expect(video.body).toEqual(webm);
    expect(
      (
        await pool.query(
          "SELECT id FROM audit_logs WHERE target_id=$1 AND action='synthetic_media.video_viewed'",
          [run],
        )
      ).rowCount,
    ).toBe(1);
    await mediaStudent(active, 'delete', { id: run }).expect(200, { deleted: true });
    await mediaTeacher(f, run).expect(404);
    expect((await mediaTeacher(f)).body.runs).toEqual([]);
  });
  it('requires pending approval/CSRF and removes synthetic bytes on credential revocation and lesson end', async () => {
    const store = enableSynthetic();
    const { f, active } = await lessonFixture();
    await lesson(f, 'start').expect(200);
    const pending = await join(f.code, '002').expect(201);
    await mediaStudent(pending, 'start', { confirmSynthetic: true }).expect(403);
    await request(app)
      .post('/api/student/synthetic-media/start')
      .set(site)
      .set('Cookie', cookies(active))
      .send({ confirmSynthetic: true })
      .expect(403);
    const run = (await mediaStudent(active, 'start', { confirmSynthetic: true }).expect(200)).body
      .id;
    await mediaStudent(active, 'frame', { id: run, sequence: 1, data: 'invalid' }).expect(400);
    await mediaStudent(active, 'frame', { id: run, sequence: 1, data: 'x'.repeat(50000) }).expect(
      400,
    );
    const p = (
      await pool.query(
        'SELECT id,credential_generation FROM classroom_participants WHERE class_id=$1',
        [f.id],
      )
    ).rows[0];
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/participants/${p.id}/block`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: p.credential_generation })
      .expect(200);
    await store.sweep();
    expect((await mediaTeacher(f)).body.runs).toEqual([]);
    await mediaStudent(active, 'frame', { id: run, sequence: 2, data: 'AAAA' }).expect(401);
    const next = await lessonFixture();
    const lessonId = (await lesson(next.f, 'start')).body.lesson.id;
    await mediaStudent(next.active, 'start', { confirmSynthetic: true }).expect(200);
    await lesson(next.f, 'end', { sessionId: lessonId, confirm: true }).expect(200);
    await store.sweep();
    await lesson(next.f, 'start').expect(200);
    expect((await mediaTeacher(next.f)).body.runs).toEqual([]);
  });
  it('does not create a synthetic run if its start audit rolls back and clears all bytes on explicit disposal', async () => {
    const store = enableSynthetic();
    const { f, active } = await lessonFixture();
    await lesson(f, 'start');
    await pool.query(`CREATE FUNCTION reject_synthetic_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='synthetic_media.started' THEN RAISE EXCEPTION 'synthetic media audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_synthetic_audit BEFORE INSERT ON classroom_participation_audit FOR EACH ROW EXECUTE FUNCTION reject_synthetic_audit()`);
    try {
      await mediaStudent(active, 'start', { confirmSynthetic: true }).expect(500);
      expect((await mediaTeacher(f)).body.runs).toEqual([]);
    } finally {
      await pool.query(
        'DROP TRIGGER reject_synthetic_audit ON classroom_participation_audit; DROP FUNCTION reject_synthetic_audit()',
      );
    }
    await mediaStudent(active, 'start', { confirmSynthetic: true }).expect(200);
    store.close();
    expect((await mediaTeacher(f)).body.runs).toEqual([]);
  });
  it('serializes duplicate starts, isolates peers and hides an old frame before marking a silent sender failed', async () => {
    const store = enableSynthetic(),
      { f, active } = await lessonFixture();
    await lesson(f, 'start');
    const results = await Promise.all([
      mediaStudent(active, 'start', { confirmSynthetic: true }),
      mediaStudent(active, 'start', { confirmSynthetic: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const run = results.find((r) => r.status === 200)!.body.id;
    const pending = await join(f.code, '002').expect(201);
    const pendingId = (await list(f)).body.requests.find(
      (r: { studentNumber: string }) => r.studentNumber === '002',
    ).id;
    await resolve(f, pendingId).expect(200);
    const peer = await activate(pending);
    expect(peer.status).toBe(200);
    expect((await mediaStudent(peer)).body.runs).toEqual([]);
    await mediaStudent(peer, 'delete', { id: run }).expect(404);
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');
    await mediaStudent(active, 'frame', { id: run, sequence: 1, data: png }).expect(200);
    const now = Date.now(),
      clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now + 4500);
      expect((await mediaTeacher(f)).body.runs[0]).toMatchObject({
        status: 'recording',
        frame: null,
      });
      clock.mockReturnValue(now + 11000);
      await store.sweep();
      expect((await mediaTeacher(f)).body.runs[0]).toMatchObject({
        status: 'failed',
        frame: null,
        bytes: 0,
      });
    } finally {
      clock.mockRestore();
    }
  });
  const focus = (f: { id: string; token: string }, body?: object) =>
    (body
      ? request(app).patch(`/api/identity/classrooms/${f.id}/focus`).send(body)
      : request(app).get(`/api/identity/classrooms/${f.id}/focus`)
    ).set(bearer(f.token));
  const studentFocus = (active: request.Response) =>
    request(app).get('/api/student/focus').set(site).set('Cookie', cookies(active));
  it('defaults focus off, authorizes the current lesson and gives students only an advisory snapshot', async () => {
    const { f, active } = await lessonFixture();
    const initial = await focus(f).expect(200);
    expect(initial.body).toMatchObject({ enabled: false, version: 0, lesson: null });
    await focus(f, { enabled: true, sessionId: randomUUID(), expectedVersion: 0 }).expect(409);
    const sessionId = (await lesson(f, 'start').expect(200)).body.lesson.id;
    const on = await focus(f, { enabled: true, sessionId, expectedVersion: 0 }).expect(200);
    expect(on.body).toMatchObject({ enabled: true, version: 1, lesson: { id: sessionId } });
    expect(on.body.updatedAt).toBeTruthy();
    const own = await studentFocus(active).expect(200);
    expect(own.body).toMatchObject({ enabled: true, version: 1, lesson: { id: sessionId } });
    expect(Object.keys(own.body).sort()).toEqual(
      ['enabled', 'expiresAt', 'lesson', 'observedAt', 'updatedAt', 'version'].sort(),
    );
    await focus(f, { enabled: true, sessionId, expectedVersion: 1 }).expect(200);
    expect((await focus(f)).body.version).toBe(1);
    const actions = await pool.query(
      "SELECT action FROM audit_logs WHERE target_id=$1 AND action='focus.started'",
      [f.id],
    );
    expect(actions.rowCount).toBe(1);
    const off = await focus(f, { enabled: false, sessionId, expectedVersion: 1 }).expect(200);
    expect(off.body).toMatchObject({ enabled: false, version: 2 });
    expect((await studentFocus(active)).body.enabled).toBe(false);
  });
  it('rejects foreign focus authority, pending and revoked students, strict input and stale versions', async () => {
    const { f, active } = await lessonFixture(),
      other = await fixture();
    const sessionId = (await lesson(f, 'start')).body.lesson.id;
    await request(app)
      .get(`/api/identity/classrooms/${f.id}/focus`)
      .set(bearer(other.token))
      .expect(404);
    await request(app)
      .patch(`/api/identity/classrooms/${f.id}/focus`)
      .set(bearer(other.token))
      .send({ enabled: true, sessionId, expectedVersion: 0 })
      .expect(404);
    for (const body of [
      { enabled: 'true', sessionId, expectedVersion: 0 },
      { enabled: true, sessionId },
      { enabled: true, sessionId, expectedVersion: -1 },
      { enabled: true, sessionId, expectedVersion: 0, role: 'manager' },
    ])
      await focus(f, body).expect(400);
    await focus(f, { enabled: true, sessionId, expectedVersion: 0 }).expect(200);
    await focus(f, { enabled: false, sessionId, expectedVersion: 0 }).expect(409);
    expect((await focus(f)).body.enabled).toBe(true);
    const pending = await join(f.code, '002');
    await studentFocus(pending).expect(403);
    await request(app)
      .patch('/api/student/focus')
      .set(site)
      .set('Cookie', cookies(active))
      .set('X-Student-CSRF', active.body.csrfToken)
      .send({ enabled: false })
      .expect(404);
    await request(app).get('/api/student/focus').set(site).expect(401);
    const participant = (
      await pool.query(
        'SELECT id,credential_generation FROM classroom_participants WHERE class_id=$1',
        [f.id],
      )
    ).rows[0];
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/participants/${participant.id}/block`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: participant.credential_generation })
      .expect(200);
    await studentFocus(active).expect(401);
  });
  it('resets and audits focus atomically at lesson end and starts the next lesson off without revoking approved students', async () => {
    const { f, active } = await lessonFixture();
    const sessionId = (await lesson(f, 'start')).body.lesson.id;
    await focus(f, { enabled: true, sessionId, expectedVersion: 0 }).expect(200);
    await lesson(f, 'end', { sessionId, confirm: true }).expect(200);
    const ended = await studentFocus(active).expect(200);
    expect(ended.body).toMatchObject({ enabled: false, version: 2, lesson: null });
    expect(
      (
        await pool.query(
          "SELECT action FROM audit_logs WHERE target_id=$1 AND action='focus.ended'",
          [f.id],
        )
      ).rowCount,
    ).toBe(1);
    const next = (await lesson(f, 'start')).body.lesson.id;
    await focus(f, { enabled: true, sessionId, expectedVersion: 2 }).expect(409);
    expect((await studentFocus(active)).body).toMatchObject({
      enabled: false,
      lesson: { id: next },
    });
    await focus(f, { enabled: true, sessionId: next, expectedVersion: 2 }).expect(200);
    await transaction(pool, (client) => stopClassroom(client, f.id, teacherId, false));
    await studentFocus(active).expect(401);
    expect((await focus(f)).body).toMatchObject({ enabled: false, lesson: null, version: 4 });
  });
  it('rolls back focus changes and automatic lesson end when focus auditing fails', async () => {
    const { f, active } = await lessonFixture(),
      sessionId = (await lesson(f, 'start')).body.lesson.id;
    await pool.query(`CREATE FUNCTION reject_focus_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('focus.started','focus.ended') THEN RAISE EXCEPTION 'synthetic focus audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_focus_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_focus_audit()`);
    try {
      await focus(f, { enabled: true, sessionId, expectedVersion: 0 }).expect(500);
      expect((await focus(f)).body).toMatchObject({ enabled: false, version: 0 });
      await pool.query('UPDATE classes SET voluntary_focus=true WHERE id=$1', [f.id]);
      await lesson(f, 'end', { sessionId, confirm: true }).expect(500);
      expect((await studentFocus(active)).body).toMatchObject({
        enabled: true,
        version: 1,
        lesson: { id: sessionId },
      });
    } finally {
      await pool.query(
        'DROP TRIGGER reject_focus_audit ON audit_logs; DROP FUNCTION reject_focus_audit()',
      );
    }
  });
  it('serializes simultaneous focus updates and resets legacy focus before a new lesson starts', async () => {
    const { f } = await lessonFixture();
    await pool.query('UPDATE classes SET voluntary_focus=true WHERE id=$1', [f.id]);
    const sessionId = (await lesson(f, 'start').expect(200)).body.lesson.id;
    expect((await focus(f)).body).toMatchObject({
      enabled: false,
      version: 2,
      lesson: { id: sessionId },
    });
    const results = await Promise.all([
      focus(f, { enabled: true, sessionId, expectedVersion: 2 }),
      focus(f, { enabled: true, sessionId, expectedVersion: 2 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await focus(f).expect(200)).body).toMatchObject({ enabled: true, version: 3 });
    expect(
      (
        await pool.query(
          "SELECT id FROM audit_logs WHERE target_id=$1 AND action='focus.started'",
          [f.id],
        )
      ).rowCount,
    ).toBe(1);
  });
  const materialList = (f: { id: string; token: string }, page = 1) =>
    request(app)
      .get(`/api/identity/classrooms/${f.id}/materials?page=${page}`)
      .set(bearer(f.token));
  it('records an erasure hold with atomic revocation, no physical deletion and no recovery bypass', async () => {
    const { f, active } = await lessonFixture();
    const sessionId = (await lesson(f, 'start')).body.lesson.id;
    await pulse(active, { sessionId, connectionId: randomUUID(), sequence: 1 }).expect(200);
    const participant = (
      await pool.query(
        'SELECT id,credential_generation FROM classroom_participants WHERE class_id=$1',
        [f.id],
      )
    ).rows[0];
    const path = `/api/identity/classrooms/${f.id}/participants/${participant.id}/request-erasure`;
    const other = await fixture();
    const body = { confirm: true, expectedGeneration: participant.credential_generation };
    await request(app).post(path).set(bearer(other.token)).send(body).expect(404);
    await request(app)
      .post(path)
      .set(bearer(f.token))
      .send({ ...body, retentionDays: 1 })
      .expect(400);
    const requested = await request(app).post(path).set(bearer(f.token)).send(body).expect(200);
    expect(requested.body.participant).toMatchObject({
      status: 'blocked',
      credentialGeneration: participant.credential_generation + 1,
      erasureRequestedAt: expect.any(String),
    });
    await studentFocus(active).expect(401);
    const held = (
      await pool.query('SELECT * FROM participant_erasure_requests WHERE participant_id=$1', [
        participant.id,
      ])
    ).rows[0];
    expect(held.status).toBe('awaiting_policy');
    expect(
      (
        await pool.query('SELECT name,student_number FROM classroom_participants WHERE id=$1', [
          participant.id,
        ])
      ).rows[0],
    ).toMatchObject({ name: 'Synthetic student', student_number: '001' });
    expect(
      (
        await pool.query(
          'SELECT id FROM classroom_participant_connections WHERE participant_id=$1 AND disconnected_at IS NULL',
          [participant.id],
        )
      ).rowCount,
    ).toBe(0);
    const repeat = await request(app)
      .post(path)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: requested.body.participant.credentialGeneration })
      .expect(200);
    expect(repeat.body.participant.credentialGeneration).toBe(
      requested.body.participant.credentialGeneration,
    );
    expect(
      (
        await pool.query(
          "SELECT id FROM audit_logs WHERE target_id=$1 AND action='privacy.erasure_requested'",
          [participant.id],
        )
      ).rowCount,
    ).toBe(1);
    const recovery = await join(f.code, '001', 'recovery').expect(400);
    expect(recovery.body.error.code).toBe('INVITATION_UNAVAILABLE');
    await request(app).post(path).set(bearer(f.token)).send(body).expect(409);
  });
  it('rolls back an erasure request and credentials when its audit cannot be stored', async () => {
    const { f, active } = await lessonFixture();
    const participant = (
      await pool.query(
        'SELECT id,credential_generation FROM classroom_participants WHERE class_id=$1',
        [f.id],
      )
    ).rows[0];
    await pool.query(`CREATE FUNCTION reject_privacy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='privacy.erasure_requested' THEN RAISE EXCEPTION 'synthetic privacy audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_privacy_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_privacy_audit()`);
    try {
      await request(app)
        .post(`/api/identity/classrooms/${f.id}/participants/${participant.id}/request-erasure`)
        .set(bearer(f.token))
        .send({ confirm: true, expectedGeneration: participant.credential_generation })
        .expect(500);
      await studentFocus(active).expect(200);
      expect(
        (
          await pool.query('SELECT id FROM participant_erasure_requests WHERE participant_id=$1', [
            participant.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query('SELECT status FROM classroom_participants WHERE id=$1', [
            participant.id,
          ])
        ).rows[0].status,
      ).toBe('approved');
    } finally {
      await pool.query(
        'DROP TRIGGER reject_privacy_audit ON audit_logs; DROP FUNCTION reject_privacy_audit()',
      );
    }
  });
  it('accepts closed-classroom requests and cancels recovery credentials even for an already blocked participant', async () => {
    const { f, active } = await lessonFixture();
    const participant = (
      await pool.query(
        'SELECT id,credential_generation FROM classroom_participants WHERE class_id=$1',
        [f.id],
      )
    ).rows[0];
    const path = `/api/identity/classrooms/${f.id}/participants/${participant.id}`;
    const blocked = await request(app)
      .post(`${path}/block`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: participant.credential_generation })
      .expect(200);
    const recovering = await join(f.code, '001', 'recovery').expect(201);
    const pending = (await list(f)).body.requests.find(
      (r: { status: string }) => r.status === 'pending',
    );
    const held = await request(app)
      .post(`${path}/request-erasure`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: blocked.body.participant.credentialGeneration })
      .expect(200);
    expect(held.body.participant.credentialGeneration).toBe(
      blocked.body.participant.credentialGeneration + 1,
    );
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/requests/${pending.id}/approve`)
      .set(bearer(f.token))
      .send({ confirmRecovery: true })
      .expect(409);
    await studentFocus(recovering).expect(401);
    await studentFocus(active).expect(401);
    const second = await lessonFixture();
    const p = (
      await pool.query(
        'SELECT id,credential_generation FROM classroom_participants WHERE class_id=$1',
        [second.f.id],
      )
    ).rows[0];
    await request(app)
      .post(`/api/identity/classrooms/${second.f.id}/close`)
      .set(bearer(second.f.token))
      .send({ confirm: true })
      .expect(200);
    const current = (
      await pool.query('SELECT credential_generation FROM classroom_participants WHERE id=$1', [
        p.id,
      ])
    ).rows[0];
    await request(app)
      .post(`/api/identity/classrooms/${second.f.id}/participants/${p.id}/request-erasure`)
      .set(bearer(second.f.token))
      .send({ confirm: true, expectedGeneration: current.credential_generation })
      .expect(200);
  });
  const sendMaterial = (
    f: { id: string; token: string },
    body: object = { title: 'Lesson link', url: 'https://example.test/lesson' },
  ) =>
    request(app).post(`/api/identity/classrooms/${f.id}/materials`).set(bearer(f.token)).send(body);
  const studentMaterialList = (active: request.Response, page = 1) =>
    request(app)
      .get(`/api/student/materials?page=${page}`)
      .set(site)
      .set('Cookie', cookies(active));
  const materialAction = (
    active: request.Response,
    material: string,
    action: string,
    body: object = {},
  ) =>
    request(app)
      .post(
        action === 'received'
          ? '/api/student/materials/received'
          : `/api/student/materials/${material}/${action}`,
      )
      .set(site)
      .set('Cookie', cookies(active))
      .set('X-Student-CSRF', active.body.csrfToken)
      .send(action === 'received' ? { materialIds: [material] } : body);
  it('delivers selected material only to its persisted recipients at every student access surface', async () => {
    const { f, active } = await lessonFixture();
    const pending = await join(f.code, '002');
    const nextRequest = (await list(f)).body.requests.find(
      (r: { studentNumber: string }) => r.studentNumber === '002',
    );
    await resolve(f, nextRequest.id).expect(200);
    const second = await activate(pending);
    const participant = (
      await pool.query(
        'SELECT id FROM classroom_participants WHERE class_id=$1 AND student_number=$2',
        [f.id, '001'],
      )
    ).rows[0].id;
    const sent = await sendMaterial(f, {
      title: 'Only first',
      url: 'https://example.test/selected',
      participantIds: [participant],
    }).expect(201);
    const material = sent.body.id;
    expect((await studentMaterialList(active).expect(200)).body.total).toBe(1);
    expect((await studentMaterialList(second).expect(200)).body).toMatchObject({
      materials: [],
      total: 0,
    });
    await materialAction(second, material, 'received').expect(404);
    await materialAction(second, material, 'open').expect(404);
    await materialAction(active, material, 'received').expect(200);
    expect((await materialAction(active, material, 'open').expect(200)).body.url).toBe(
      'https://example.test/selected',
    );
    expect((await materialList(f)).body.materials[0]).toMatchObject({
      audience: 'selected',
      recipientCount: 1,
    });
    expect(
      (await pool.query('SELECT * FROM material_deliveries WHERE material_id=$1', [material]))
        .rowCount,
    ).toBe(0);
    const universal = (await sendMaterial(f).expect(201)).body.id;
    expect(
      (await studentMaterialList(second)).body.materials.map((m: { id: string }) => m.id),
    ).toEqual([universal]);
    const restarted = createApp({
      pool,
      origins: [origin],
      googleClientId: '',
      verifyGoogle: async () => {
        throw new Error('unused');
      },
    });
    const restored = await request(restarted)
      .get('/api/student/materials')
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    expect(restored.body.total).toBe(2);
    await request(app)
      .delete(`/api/identity/classrooms/${f.id}/materials/${material}`)
      .set(bearer(f.token))
      .expect(204);
    expect(
      (
        await pool.query('SELECT * FROM classroom_material_recipients WHERE material_id=$1', [
          material,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('rejects empty, duplicated, foreign, removed and malformed selected recipients atomically', async () => {
    const { f, active } = await lessonFixture();
    const other = await lessonFixture();
    const participant = (
      await pool.query('SELECT id FROM classroom_participants WHERE class_id=$1', [f.id])
    ).rows[0].id;
    const foreign = (
      await pool.query('SELECT id FROM classroom_participants WHERE class_id=$1', [other.f.id])
    ).rows[0].id;
    for (const participantIds of [
      [],
      [participant, participant],
      ['bad-id'],
      'all',
      Array(101).fill(participant),
    ]) {
      await sendMaterial(f, {
        title: 'Invalid',
        url: 'https://example.test',
        participantIds,
      }).expect(400);
    }
    await sendMaterial(f, {
      title: 'Foreign',
      url: 'https://example.test',
      participantIds: [participant, foreign],
    }).expect(409);
    await pool.query("UPDATE classroom_participants SET status='removed' WHERE id=$1", [
      participant,
    ]);
    await sendMaterial(f, {
      title: 'Removed',
      url: 'https://example.test',
      participantIds: [participant],
    }).expect(409);
    expect(
      (await pool.query('SELECT id FROM class_materials WHERE class_id=$1', [f.id])).rowCount,
    ).toBe(0);
    await studentMaterialList(active).expect(401);
  });
  it('shows persistent teacher-only notifications with explicit synthetic test provenance', async () => {
    const { f, active } = await lessonFixture(),
      other = await fixture();
    const base = `/api/identity/classrooms/${f.id}/notifications`;
    const initial = await request(app).get(base).set(bearer(f.token)).expect(200);
    expect(
      initial.body.notifications.some(
        (n: { kind: string; action: string }) =>
          n.kind === 'actual' && n.action === 'student.join_requested',
      ),
    ).toBe(true);
    await request(app)
      .post(`${base}/test`)
      .set(bearer(f.token))
      .send({ event: 'screen_difference' })
      .expect(201);
    const listing = await request(app).get(base).set(bearer(f.token)).expect(200);
    expect(listing.body.notifications[0]).toMatchObject({
      kind: 'test',
      action: 'notification.test.screen_difference',
    });
    await request(app).get(base).set(bearer(other.token)).expect(404);
    await request(app)
      .post(`${base}/test`)
      .set(bearer(other.token))
      .send({ event: 'screen_difference' })
      .expect(404);
    await request(app)
      .get('/api/student/notifications')
      .set(site)
      .set('Cookie', cookies(active))
      .expect(404);
    await request(app).get(base).expect(401);
    await request(app)
      .post(`${base}/test`)
      .set(bearer(f.token))
      .send({ event: 'real_screen' })
      .expect(400);
    await request(app)
      .post(`${base}/test`)
      .set(bearer(f.token))
      .send({ event: 'input_activity', studentId: randomUUID() })
      .expect(400);
    const restart = createApp({
      pool,
      origins: [origin],
      googleClientId: '',
      verifyGoogle: async () => {
        throw new Error('unused');
      },
    });
    const persisted = await request(restart).get(base).set(bearer(f.token)).expect(200);
    expect(persisted.body.notifications[0].id).toBe(listing.body.notifications[0].id);
  });
  it('shares valid classroom materials with current approved students and distinguishes receipt/open requests', async () => {
    const { f, active } = await lessonFixture();
    const created = await sendMaterial(f).expect(201),
      material = created.body.id;
    const listing = await studentMaterialList(active).expect(200);
    expect(listing.body.materials[0]).toMatchObject({
      id: material,
      title: 'Lesson link',
      receivedAt: null,
      openedAt: null,
    });
    expect(listing.body.materials[0].url).toBeUndefined();
    expect(JSON.stringify(listing.body)).not.toMatch(
      /participantId|studentNumber|deviceId|receivedCount/,
    );
    await materialAction(active, material, 'received').expect(200);
    const received = (await studentMaterialList(active)).body.materials[0];
    expect(received.receivedAt).toBeTruthy();
    expect(received.openedAt).toBeNull();
    await materialAction(active, material, 'received').expect(200);
    expect((await studentMaterialList(active)).body.materials[0].receivedAt).toBe(
      received.receivedAt,
    );
    expect((await materialAction(active, material, 'open').expect(200)).body.url).toBe(
      'https://example.test/lesson',
    );
    const opened = (await studentMaterialList(active)).body.materials[0].openedAt;
    await materialAction(active, material, 'open').expect(200);
    expect((await studentMaterialList(active)).body.materials[0].openedAt).toBe(opened);
    expect((await materialList(f)).body.materials[0]).toMatchObject({
      receivedCount: 1,
      openedCount: 1,
    });
    await request(app)
      .delete(`/api/identity/classrooms/${f.id}/materials/${material}`)
      .set(bearer(f.token))
      .expect(204);
    expect((await studentMaterialList(active)).body.total).toBe(0);
    await materialAction(active, material, 'open').expect(404);
    expect(
      (
        await pool.query('SELECT * FROM classroom_material_receipts WHERE material_id=$1', [
          material,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query('SELECT action FROM audit_logs WHERE target_id=$1 ORDER BY id', [material])
      ).rows
        .map((r) => r.action)
        .sort(),
    ).toEqual(['material.deleted', 'material.sent']);
  });
  it('rejects unsafe URLs, strict invalid payloads, foreign resources and pending or expired student credentials', async () => {
    const { f, active } = await lessonFixture(),
      other = await fixture();
    for (const url of [
      'javascript:alert(1)',
      'http://example.test',
      'data:text/html,hello',
      'https://user:pass@example.test',
      'https://user@example.test',
      'not a url',
    ]) {
      await sendMaterial(f, { title: 'Unsafe', url }).expect(400);
    }
    await sendMaterial(f, {
      title: 'x',
      url: 'https://example.test',
      participantId: randomUUID(),
    }).expect(400);
    const material = (await sendMaterial(f).expect(201)).body.id;
    await request(app)
      .get(`/api/identity/classrooms/${f.id}/materials`)
      .set(bearer(other.token))
      .expect(404);
    await request(app)
      .delete(`/api/identity/classrooms/${other.id}/materials/${material}`)
      .set(bearer(other.token))
      .expect(404);
    const foreign = (await sendMaterial(other).expect(201)).body.id;
    await materialAction(active, foreign, 'received').expect(404);
    await materialAction(active, foreign, 'open').expect(404);
    await materialAction(active, material, 'open', { url: 'https://attacker.test' }).expect(400);
    await request(app)
      .post(`/api/student/materials/${material}/open`)
      .set(site)
      .set('Cookie', cookies(active))
      .send({})
      .expect(403);
    const pending = await join(f.code, '002');
    await studentMaterialList(pending).expect(403);
    await materialAction(pending, material, 'open').expect(403);
    await request(app).get('/api/student/materials').set(site).expect(401);
    await request(app)
      .get('/api/student/materials')
      .set({ Host: new URL(origin).host, Origin: 'https://foreign.test' })
      .set('Cookie', cookies(active))
      .expect(403);
    await pool.query(
      "UPDATE student_participation_sessions SET idle_expires_at=last_seen_at+interval '1 millisecond',last_seen_at=last_seen_at WHERE token_hash=$1",
      [digest(cookies(active).split('=')[1])],
    );
    await new Promise((r) => setTimeout(r, 5));
    await studentMaterialList(active).expect(401);
  });
  it('lets newly approved/reconnected students fetch valid older materials, but never expired or revoked material access', async () => {
    const f = await fixture(),
      material = (await sendMaterial(f).expect(201)).body.id;
    const pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    const active = await activate(pending);
    expect((await studentMaterialList(active).expect(200)).body.materials[0].id).toBe(material);
    await lesson(f, 'start').expect(200);
    await lesson(f, 'end', { sessionId: (await lesson(f)).body.lesson.id, confirm: true }).expect(
      200,
    );
    expect((await studentMaterialList(active).expect(200)).body.total).toBe(1);
    await pool.query(
      "UPDATE class_materials SET expires_at=statement_timestamp()-interval '1 second' WHERE id=$1",
      [material],
    );
    expect((await studentMaterialList(active).expect(200)).body.total).toBe(0);
    await materialAction(active, material, 'received').expect(404);
    await materialAction(active, material, 'open').expect(404);
    const participant = (
      await pool.query(
        'SELECT id,credential_generation FROM classroom_participants WHERE class_id=$1',
        [f.id],
      )
    ).rows[0];
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/participants/${participant.id}/block`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: participant.credential_generation })
      .expect(200);
    await studentMaterialList(active).expect(401);
  });
  it('paginates all live materials, preserves device snapshots and rolls back failed material mutations', async () => {
    const { f, active } = await lessonFixture();
    const entries = Array.from({ length: 51 }, () => [randomUUID(), f.id]);
    for (const [material, classroom] of entries)
      await pool.query(
        "INSERT INTO class_materials(id,class_id,title,url) VALUES($1,$2,'Paged','https://example.test')",
        [material, classroom],
      );
    expect((await studentMaterialList(active).expect(200)).body).toMatchObject({
      total: 51,
      page: 1,
      pageSize: 50,
    });
    expect((await studentMaterialList(active, 2).expect(200)).body.materials).toHaveLength(1);
    await request(app)
      .get(`/api/identity/classrooms/${f.id}/materials?page=0`)
      .set(bearer(f.token))
      .expect(400);
    const device = randomUUID();
    await pool.query(
      'INSERT INTO registered_devices(id,class_id,student_id,school_id,name,asset_number) VALUES($1,$2,$3,$4,$5,$6)',
      [device, classId, studentId, schoolId, 'Device fixture', randomUUID()],
    );
    const legacy = await signIn('teacher@legacy.example', 'legacy-teacher');
    const legacyClass = { id: classId, token: legacy.response.body.token };
    const material = (await sendMaterial(legacyClass).expect(201)).body.id;
    expect(
      (
        await pool.query('SELECT device_id FROM material_deliveries WHERE material_id=$1', [
          material,
        ])
      ).rows,
    ).toEqual([{ device_id: device }]);
    await request(app)
      .delete(`/api/identity/classrooms/${classId}/materials/${material}`)
      .set(bearer(legacyClass.token))
      .expect(204);
    expect(
      (await pool.query('SELECT * FROM material_deliveries WHERE material_id=$1', [material]))
        .rowCount,
    ).toBe(0);
    await pool.query(`CREATE FUNCTION reject_material_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('material.deleted','material.sent') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_material_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_material_audit()`);
    try {
      await sendMaterial(f).expect(500);
      expect((await materialList(f)).body.total).toBe(51);
      await request(app)
        .delete(`/api/identity/classrooms/${f.id}/materials/${entries[0][0]}`)
        .set(bearer(f.token))
        .expect(500);
      expect(
        (await pool.query('SELECT id FROM class_materials WHERE id=$1', [entries[0][0]])).rowCount,
      ).toBe(1);
    } finally {
      await pool.query(
        'DROP TRIGGER reject_material_audit ON audit_logs; DROP FUNCTION reject_material_audit()',
      );
    }
  });
  it('atomically validates receipt batches, preserves first timestamps, enforces classroom FKs and rejects closed/expired authority', async () => {
    const { f, active } = await lessonFixture(),
      other = await fixture();
    const material = (await sendMaterial(f).expect(201)).body.id,
      foreign = (await sendMaterial(other).expect(201)).body.id;
    const received = (body: object) =>
      request(app)
        .post('/api/student/materials/received')
        .set(site)
        .set('Cookie', cookies(active))
        .set('X-Student-CSRF', active.body.csrfToken)
        .send(body);
    await received({ materialIds: [] }).expect(400);
    await received({ materialIds: Array(51).fill(material) }).expect(400);
    await received({ materialIds: [material], participantId: randomUUID() }).expect(400);
    await received({ materialIds: [material, foreign] }).expect(404);
    expect(
      (
        await pool.query('SELECT * FROM classroom_material_receipts WHERE material_id=$1', [
          material,
        ])
      ).rowCount,
    ).toBe(0);
    await received({ materialIds: [material, material] }).expect(200);
    const participant = (
      await pool.query('SELECT id FROM classroom_participants WHERE class_id=$1', [f.id])
    ).rows[0].id;
    await expect(
      pool.query(
        'INSERT INTO classroom_material_receipts(material_id,class_id,participant_id) VALUES($1,$2,$3)',
        [foreign, other.id, participant],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await pool.query('UPDATE classes SET closed_at=statement_timestamp() WHERE id=$1', [f.id]);
    await studentMaterialList(active).expect(401);
    await sendMaterial(f).expect(409);
    await materialList(f).expect(200);
    await request(app)
      .delete(`/api/identity/classrooms/${f.id}/materials/${material}`)
      .set(bearer(f.token))
      .expect(204);
    await pool.query(
      "UPDATE auth_sessions SET expires_at=statement_timestamp()-interval '1 second' WHERE token_hash=$1",
      [digest(f.token)],
    );
    await materialList(f).expect(401);
    await sendMaterial(f).expect(401);
  });
  it('preserves web and legacy device receipts without converting failed opens into success', async () => {
    const { f, active } = await lessonFixture(),
      material = (await sendMaterial(f).expect(201)).body.id;
    await materialAction(active, material, 'open').expect(200);
    const receipt = (await studentMaterialList(active)).body.materials[0];
    expect(receipt.receivedAt).toBeNull();
    expect(receipt.openedAt).toBeTruthy();
    await materialAction(active, material, 'received').expect(200);
    expect((await studentMaterialList(active)).body.materials[0].openedAt).toBe(receipt.openedAt);
    await pool.query(`CREATE FUNCTION reject_receipt_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$;
      CREATE TRIGGER reject_receipt_write BEFORE UPDATE ON classroom_material_receipts FOR EACH ROW EXECUTE FUNCTION reject_receipt_write()`);
    try {
      await materialAction(active, material, 'open').expect(500);
      expect((await studentMaterialList(active)).body.materials[0].openedAt).toBe(receipt.openedAt);
    } finally {
      await pool.query(
        'DROP TRIGGER reject_receipt_write ON classroom_material_receipts; DROP FUNCTION reject_receipt_write()',
      );
    }
  });
  it('starts one lesson, keeps approval separate, aggregates tabs and rejects reversed heartbeats/disconnects', async () => {
    const { f, active } = await lessonFixture();
    const start = await lesson(f, 'start').expect(200);
    const sessionId = start.body.lesson.id,
      connectionId = randomUUID();
    expect((await lesson(f, 'start')).body.lesson.id).toBe(sessionId);
    const empty = await lesson(f).expect(200);
    expect(empty.body).toMatchObject({ counts: { online: 0, reconnecting: 0, offline: 1 } });
    expect(empty.body.students[0]).toMatchObject({ state: 'offline', lastSeenAt: null });
    const input = { sessionId, connectionId, sequence: 1 };
    await pulse(active, input).expect(200);
    const online = await lesson(f).expect(200);
    expect(online.body.counts.online).toBe(1);
    expect(online.body.students[0].lastSeenAt).toBeTruthy();
    const second = { ...input, connectionId: randomUUID() };
    await pulse(active, second).expect(200);
    await pulse(active, { ...input, sequence: 3 }).expect(200);
    const before = (
      await pool.query(
        'SELECT last_seen_at,generation FROM classroom_participant_connections WHERE id=$1',
        [connectionId],
      )
    ).rows[0];
    await pulse(active, { ...input, sequence: 2 }).expect(200);
    await pulse(active, { ...input, sequence: 2 }, 'disconnect').expect(200);
    expect(
      (
        await pool.query(
          'SELECT last_seen_at,generation,disconnected_at FROM classroom_participant_connections WHERE id=$1',
          [connectionId],
        )
      ).rows[0],
    ).toMatchObject({ ...before, disconnected_at: null });
    await pulse(active, { ...input, sequence: 4 }, 'disconnect').expect(200);
    await pulse(active, { ...input, sequence: 5 }).expect(409);
    expect((await lesson(f)).body.counts.online).toBe(1);
    await pulse(active, { ...second, sequence: 2 }, 'disconnect').expect(200);
    expect((await lesson(f)).body.counts.offline).toBe(1);
    expect(
      JSON.stringify((await pulse(active, { ...input, connectionId: randomUUID() })).body),
    ).not.toMatch(/studentNumber|students|counts|participantId|token_hash/);
    const other = await fixture();
    await lesson({ ...other, id: f.id }).expect(404);
    await request(app)
      .get(`/api/identity/classrooms/${f.id}/lesson`)
      .set(site)
      .set('Cookie', cookies(active))
      .expect(401);
  });
  it('classifies server-time freshness boundaries and excludes expired credentials from online counts', async () => {
    const { f, active } = await lessonFixture(),
      sessionId = (await lesson(f, 'start')).body.lesson.id;
    const input = { sessionId, connectionId: randomUUID(), sequence: 1 };
    await pulse(active, input).expect(200);
    for (const [age, state] of [
      [19, 'online'],
      [20, 'reconnecting'],
      [44, 'reconnecting'],
      [45, 'offline'],
    ] as const) {
      await pool.query(
        `UPDATE classroom_participant_connections SET last_seen_at=statement_timestamp()-($2*interval '1 second'),
        lease_expires_at=statement_timestamp()+((45-$2)*interval '1 second') WHERE id=$1`,
        [input.connectionId, age],
      );
      const snapshot = await lesson(f).expect(200);
      expect(snapshot.body.students[0].state).toBe(state);
      expect(snapshot.body.counts[state]).toBe(1);
    }
    await pulse(active, { ...input, sequence: 2 }).expect(200);
    await pool.query(
      'UPDATE student_participation_sessions SET revoked_at=statement_timestamp() WHERE participant_id=(SELECT participant_id FROM classroom_participant_connections WHERE id=$1)',
      [input.connectionId],
    );
    expect((await lesson(f)).body.counts.offline).toBe(1);
    await pulse(active, { ...input, sequence: 3 }).expect(401);
  });
  it('ends a lesson atomically, cancels pending credentials but preserves approved participation for a new lesson', async () => {
    const { f, active } = await lessonFixture(),
      pending = await join(f.code, '002');
    const sessionId = (await lesson(f, 'start')).body.lesson.id,
      input = { sessionId, connectionId: randomUUID(), sequence: 1 };
    await pulse(active, input).expect(200);
    await pool.query('UPDATE classes SET voluntary_focus=true WHERE id=$1', [f.id]);
    await lesson(f, 'end', { sessionId, confirm: true }).expect(200);
    const state = await lesson(f).expect(200);
    expect(state.body.lesson).toBeNull();
    expect(state.body.counts).toEqual({ online: 0, reconnecting: 0, offline: 0 });
    await pulse(active, { ...input, sequence: 2 }).expect(409);
    await pulse(pending, input).expect(401);
    await request(app)
      .get('/api/student/session')
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    expect(
      (await pool.query('SELECT voluntary_focus FROM classes WHERE id=$1', [f.id])).rows[0]
        .voluntary_focus,
    ).toBe(false);
    expect(
      (
        await pool.query(
          'SELECT left_at FROM classroom_participant_attendance WHERE session_id=$1',
          [sessionId],
        )
      ).rows[0].left_at,
    ).not.toBeNull();
    await join(f.code, '003').expect(400);
    const next = (await lesson(f, 'start')).body.lesson.id;
    expect(next).not.toBe(sessionId);
    await lesson(f, 'end', { sessionId, confirm: true }).expect(409);
    await pulse(active, { sessionId: next, connectionId: randomUUID(), sequence: 1 }).expect(200);
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/close`)
      .set(bearer(f.token))
      .send({})
      .expect(200);
    await lesson(f, 'start').expect(409);
    await pulse(active, { sessionId: next, connectionId: randomUUID(), sequence: 1 }).expect(401);
  });
  it('requires own approved cookies, CSRF and strict heartbeat inputs and limits active tabs', async () => {
    const { f, active } = await lessonFixture(),
      sessionId = (await lesson(f, 'start')).body.lesson.id;
    const input = { sessionId, connectionId: randomUUID(), sequence: 1 };
    await request(app)
      .post('/api/student/lesson/heartbeat')
      .set(site)
      .set('Cookie', cookies(active))
      .send(input)
      .expect(403);
    for (const invalid of [
      { ...input, sequence: 0 },
      { ...input, sequence: '1' },
      { ...input, participantId: randomUUID() },
      { ...input, sessionId: 'x' },
    ]) {
      await pulse(active, invalid).expect(400);
    }
    await pulse(active, { ...input, sessionId: randomUUID() }).expect(409);
    for (let i = 0; i < 16; i++)
      await pulse(active, { ...input, connectionId: randomUUID() }).expect(200);
    await pulse(active, input).expect(429);
    await pool.query(
      'UPDATE classroom_participant_connections SET lease_expires_at=last_seen_at WHERE session_id=$1',
      [sessionId],
    );
    await pulse(active, input).expect(200);
    const discovery = await request(app)
      .get('/api/student/lesson')
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    expect(discovery.body.lesson.id).toBe(sessionId);
    expect(JSON.stringify(discovery.body)).not.toMatch(/students|studentNumber|teacher_id|token/);
    const pending = await join(f.code, '002');
    await resolve(
      f,
      (await list(f)).body.requests.find((r: { status: string }) => r.status === 'pending').id,
    ).expect(200);
    const second = await activate(pending);
    await pulse(second, input).expect(404);
    await pulse(second, { ...input, sequence: 2 }, 'disconnect').expect(404);
  });
  it('keeps an early disconnect as a tombstone and rolls back lesson end when its audit fails', async () => {
    const { f, active } = await lessonFixture(),
      sessionId = (await lesson(f, 'start')).body.lesson.id;
    const input = { sessionId, connectionId: randomUUID(), sequence: 2 };
    await pulse(active, input, 'disconnect').expect(200);
    await pulse(active, { ...input, sequence: 1 }).expect(200);
    expect((await lesson(f)).body.counts.online).toBe(0);
    await pulse(active, { ...input, sequence: 3 }).expect(409);
    await pulse(active, { ...input, connectionId: randomUUID(), sequence: 1 }).expect(200);
    await pool.query(`CREATE FUNCTION fail_phase6_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='classroom.lesson_ended' THEN RAISE EXCEPTION 'Synthetic lesson audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_phase6_audit BEFORE INSERT ON classroom_participation_audit FOR EACH ROW EXECUTE FUNCTION fail_phase6_audit()`);
    try {
      await lesson(f, 'end', { sessionId, confirm: true }).expect(500);
      expect((await lesson(f)).body).toMatchObject({
        lesson: { id: sessionId },
        counts: { online: 1 },
      });
      expect(
        (await pool.query('SELECT revoked_at FROM classroom_invitations WHERE class_id=$1', [f.id]))
          .rows[0].revoked_at,
      ).toBeNull();
    } finally {
      await pool.query(
        'DROP TRIGGER fail_phase6_audit ON classroom_participation_audit; DROP FUNCTION fail_phase6_audit()',
      );
    }
    await lesson(f, 'end', { sessionId, confirm: true }).expect(200);
    await lesson(f, 'end', { sessionId, confirm: true }).expect(200);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM classroom_participation_audit WHERE class_id=$1 AND action='classroom.lesson_ended'",
          [f.id],
        )
      ).rows[0].count,
    ).toBe('1');
  });
  it('shares presence budgets and durable leases between API instances and serializes end against heartbeat', async () => {
    const { f, active } = await lessonFixture(),
      sessionId = (await lesson(f, 'start')).body.lesson.id;
    const input = { sessionId, connectionId: randomUUID(), sequence: 1 };
    await pulse(active, input).expect(200);
    const other = createApp({
      pool,
      origins: [origin],
      googleClientId: 'test-client',
      verifyGoogle: async () => {
        throw new Error('Not used');
      },
    });
    expect(
      (
        await request(other)
          .get(`/api/identity/classrooms/${f.id}/lesson`)
          .set(bearer(f.token))
          .expect(200)
      ).body.counts.online,
    ).toBe(1);
    const participant = (
      await pool.query('SELECT participant_id FROM classroom_participant_connections WHERE id=$1', [
        input.connectionId,
      ])
    ).rows[0].participant_id;
    await pool.query(
      `INSERT INTO student_join_rate_events(key_hash,attempted_at) SELECT $1,statement_timestamp() FROM generate_series(1,239)`,
      [digest(`lesson-presence:${participant}`)],
    );
    await request(other)
      .post('/api/student/lesson/heartbeat')
      .set(site)
      .set('Cookie', cookies(active))
      .set('X-Student-CSRF', active.body.csrfToken)
      .send({ ...input, sequence: 2 })
      .expect(429);
    await pool.query(
      "UPDATE student_join_rate_events SET attempted_at=statement_timestamp()-interval '61 seconds' WHERE key_hash=$1",
      [digest(`lesson-presence:${participant}`)],
    );
    await pulse(active, { ...input, sequence: 2 }).expect(200);
    const [ended, heartbeat] = await Promise.all([
      lesson(f, 'end', { sessionId, confirm: true }),
      pulse(active, { ...input, sequence: 3 }),
    ]);
    expect(ended.status).toBe(200);
    expect([200, 409]).toContain(heartbeat.status);
    expect((await lesson(f)).body.lesson).toBeNull();
    expect(
      (
        await pool.query(
          'SELECT disconnected_at FROM classroom_participant_connections WHERE id=$1',
          [input.connectionId],
        )
      ).rows[0].disconnected_at,
    ).not.toBeNull();
    await pool.query(
      'UPDATE users SET active=false WHERE id=(SELECT teacher_id FROM classes WHERE id=$1)',
      [f.id],
    );
    await lesson(f).expect(401);
    await lesson(f, 'start').expect(401);
  });
  it('handles a full hundred-student heartbeat burst and snapshot within the five-second request budget', async () => {
    const f = await fixture(100),
      sessionId = (await lesson(f, 'start')).body.lesson.id;
    const teacher = (await pool.query('SELECT teacher_id FROM classes WHERE id=$1', [f.id])).rows[0]
      .teacher_id;
    const tokens = [];
    for (let i = 0; i < 100; i++) {
      const participant = randomUUID(),
        token = randomBytes(32).toString('base64url');
      tokens.push(token);
      await pool.query(
        `INSERT INTO classroom_participants(id,class_id,name,student_number,status,approved_by,approved_at)
            VALUES($1,$2,'Load fixture',$3,'approved',$4,statement_timestamp())`,
        [participant, f.id, String(i).padStart(3, '0'), teacher],
      );
      await pool.query(
        `INSERT INTO student_participation_sessions(token_hash,class_id,participant_id,scope,generation,expires_at,idle_expires_at)
            VALUES($1,$2,$3,'participant',1,statement_timestamp()+interval '1 hour',statement_timestamp()+interval '1 hour')`,
        [digest(token), f.id, participant],
      );
    }
    const started = performance.now();
    const results = await Promise.all(
      tokens.map((token) =>
        request(app)
          .post('/api/student/lesson/heartbeat')
          .set(site)
          .set('Cookie', `clario-student-dev=${token}`)
          .set('X-Student-CSRF', studentCsrfToken(token))
          .send({ sessionId, connectionId: randomUUID(), sequence: 1 }),
      ),
    );
    expect(results.every((result) => result.status === 200)).toBe(true);
    const snapshot = await lesson(f).expect(200);
    const durationMs = performance.now() - started;
    expect(snapshot.body.counts).toEqual({ online: 100, reconnecting: 0, offline: 0 });
    expect(snapshot.body.students).toHaveLength(100);
    expect(durationMs).toBeLessThan(5000);
    console.info('phase6_capacity', {
      students: 100,
      heartbeatAndSnapshotMs: Math.ceil(durationMs),
    });
  });
  it('lists only managed participants with literal search, status filters and stable paginated sorting', async () => {
    const f = await fixture(100);
    const owner = (await pool.query('SELECT teacher_id FROM classes WHERE id=$1', [f.id])).rows[0]
      .teacher_id;
    for (let i = 0; i < 53; i++)
      await pool.query(
        `INSERT INTO classroom_participants
      (id,class_id,name,student_number,status,approved_by,approved_at)
      VALUES($1,$2,$3,$4,$5,$6,now())`,
        [
          randomUUID(),
          f.id,
          i === 0 ? 'Literal %_ student' : `Student ${String(i).padStart(2, '0')}`,
          String(i).padStart(3, '0'),
          i === 2 ? 'left' : 'approved',
          owner,
        ],
      );
    const path = `/api/identity/classrooms/${f.id}/participants`;
    const first = await request(app)
      .get(`${path}?sort=studentNumber&direction=asc`)
      .set(bearer(f.token))
      .expect(200);
    expect(first.body).toMatchObject({ total: 53, page: 1, pageSize: 50 });
    expect(first.body.participants).toHaveLength(50);
    expect(first.body.participants[0]).toMatchObject({
      studentNumber: '000',
      status: 'approved',
      connectionState: 'unavailable',
    });
    expect(JSON.stringify(first.body)).not.toMatch(
      /token_hash|csrfToken|approved_by|school_id|email/,
    );
    const second = await request(app)
      .get(`${path}?page=2&sort=studentNumber`)
      .set(bearer(f.token))
      .expect(200);
    expect(second.body.participants).toHaveLength(3);
    expect(second.body.participants[0].studentNumber).toBe('050');
    expect((await request(app).get(`${path}?search=%25_`).set(bearer(f.token))).body.total).toBe(1);
    const left = await request(app).get(`${path}?status=left`).set(bearer(f.token)).expect(200);
    expect(left.body.total).toBe(1);
    for (const query of [
      'sort=owner',
      'direction=random',
      'page=0',
      'page=1.5',
      'status=pending',
      'search=' + 'x'.repeat(101),
      'sort=name&sort=status',
    ]) {
      await request(app).get(`${path}?${query}`).set(bearer(f.token)).expect(400);
    }
    const other = await fixture();
    await request(app).get(path).set(bearer(other.token)).expect(404);
    await request(app).get(path).set(site).expect(401);
    await request(app).get(`${path}?status=left`).set(bearer(f.token)).expect(200);
  });
  it('removes and blocks atomically, revokes participant and pending recovery credentials, and requires a fresh explicit recovery', async () => {
    const f = await fixture(),
      pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    const active = await activate(pending);
    const recovery = await join(f.code, '001', 'recovery');
    const review = (await list(f)).body.requests.find(
      (r: { status: string }) => r.status === 'pending',
    );
    const path = `/api/identity/classrooms/${f.id}/participants`;
    const p = (await request(app).get(path).set(bearer(f.token))).body.participants[0];
    await request(app)
      .post(`${path}/${p.id}/remove`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: p.credentialGeneration })
      .expect(200);
    for (const old of [active, recovery])
      await request(app)
        .get('/api/student/session')
        .set(site)
        .set('Cookie', cookies(old))
        .expect(401);
    await resolve(f, review.id).expect(409);
    expect(
      (await pool.query('SELECT status FROM classroom_participants WHERE id=$1', [p.id])).rows[0]
        .status,
    ).toBe('removed');
    await request(app)
      .post(`${path}/${p.id}/block`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: p.credentialGeneration })
      .expect(409);
    const removed = (await request(app).get(path).set(bearer(f.token))).body.participants[0];
    const blocked = await request(app)
      .post(`${path}/${p.id}/block`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: removed.credentialGeneration })
      .expect(200);
    expect(blocked.body.participant.status).toBe('blocked');
    await request(app)
      .post(`${path}/${p.id}/remove`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: blocked.body.participant.credentialGeneration })
      .expect(409);
    const duplicate = await join(f.code);
    const duplicateRequest = (await list(f)).body.requests.find(
      (r: { status: string }) => r.status === 'pending',
    );
    await resolve(f, duplicateRequest.id).expect(409);
    const freshRecovery = await join(f.code, '001', 'recovery');
    const fresh = (await list(f)).body.requests.find(
      (r: { kind: string; status: string }) => r.kind === 'recovery' && r.status === 'pending',
    );
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/requests/${fresh.id}/approve`)
      .set(bearer(f.token))
      .send({ confirmRecovery: true })
      .expect(200);
    expect((await activate(freshRecovery)).status).toBe(200);
    expect(duplicate.body.state).toBe('request');
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM audit_logs WHERE target_id=$1 AND action IN ('classroom.participant_removed','classroom.participant_blocked')",
          [p.id],
        )
      ).rows[0].count,
    ).toBe('2');
  });
  it('denies participant/classroom forgery and unconfirmed actions, and clears connections and attendance on revocation', async () => {
    const f = await fixture(),
      pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    const active = await activate(pending);
    const path = `/api/identity/classrooms/${f.id}/participants`;
    const p = (await request(app).get(path).set(bearer(f.token))).body.participants[0];
    const other = await fixture();
    const input = { confirm: true, expectedGeneration: p.credentialGeneration };
    await request(app)
      .post(`${path}/${p.id}/block`)
      .set(bearer(other.token))
      .send(input)
      .expect(404);
    await request(app)
      .post(`/api/identity/classrooms/${other.id}/participants/${p.id}/block`)
      .set(bearer(other.token))
      .send(input)
      .expect(404);
    await request(app)
      .post(`${path}/${p.id}/block`)
      .set(site)
      .set('Cookie', cookies(active))
      .send(input)
      .expect(401);
    for (const body of [
      {},
      { ...input, confirm: false },
      { ...input, role: 'manager' },
      { ...input, expectedGeneration: '1' },
    ]) {
      await request(app).post(`${path}/${p.id}/block`).set(bearer(f.token)).send(body).expect(400);
    }
    const lesson = randomUUID(),
      connection = randomUUID();
    const teacher = (await pool.query('SELECT teacher_id FROM classes WHERE id=$1', [f.id])).rows[0]
      .teacher_id;
    await pool.query('INSERT INTO classroom_sessions(id,class_id,started_by) VALUES($1,$2,$3)', [
      lesson,
      f.id,
      teacher,
    ]);
    await pool.query(
      'INSERT INTO classroom_participant_attendance(session_id,class_id,participant_id) VALUES($1,$2,$3)',
      [lesson, f.id, p.id],
    );
    await pool.query(
      `INSERT INTO classroom_participant_connections(id,session_id,class_id,participant_id,credential_generation,lease_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 minute')`,
      [connection, lesson, f.id, p.id, p.credentialGeneration],
    );
    await request(app).post(`${path}/${p.id}/block`).set(bearer(f.token)).send(input).expect(200);
    expect(
      (
        await pool.query(
          'SELECT disconnected_at FROM classroom_participant_connections WHERE id=$1',
          [connection],
        )
      ).rows[0].disconnected_at,
    ).not.toBeNull();
    expect(
      (
        await pool.query(
          'SELECT left_at FROM classroom_participant_attendance WHERE session_id=$1',
          [lesson],
        )
      ).rows[0].left_at,
    ).not.toBeNull();
    await request(app)
      .post('/api/student/session/end')
      .set(site)
      .set('Cookie', cookies(active))
      .set('X-Student-CSRF', active.body.csrfToken)
      .send({})
      .expect(204);
    expect(
      (await pool.query('SELECT status FROM classroom_participants WHERE id=$1', [p.id])).rows[0]
        .status,
    ).toBe('blocked');
  });
  it('rolls back participant revocation on audit failure and refuses stale actions after recovery', async () => {
    const f = await fixture(),
      pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    const active = await activate(pending);
    const path = `/api/identity/classrooms/${f.id}/participants`;
    const p = (await request(app).get(path).set(bearer(f.token))).body.participants[0];
    await pool.query(`CREATE FUNCTION fail_phase5_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER fail_phase5_audit BEFORE INSERT ON classroom_participation_audit FOR EACH ROW EXECUTE FUNCTION fail_phase5_audit()`);
    try {
      await request(app)
        .post(`${path}/${p.id}/remove`)
        .set(bearer(f.token))
        .send({ confirm: true, expectedGeneration: p.credentialGeneration })
        .expect(500);
      expect(
        (
          await pool.query(
            'SELECT status,credential_generation FROM classroom_participants WHERE id=$1',
            [p.id],
          )
        ).rows[0],
      ).toMatchObject({ status: 'approved', credential_generation: p.credentialGeneration });
      await request(app)
        .get('/api/student/session')
        .set(site)
        .set('Cookie', cookies(active))
        .expect(200);
    } finally {
      await pool.query(
        'DROP TRIGGER fail_phase5_audit ON classroom_participation_audit; DROP FUNCTION fail_phase5_audit()',
      );
    }
    const recovery = await join(f.code, '001', 'recovery');
    const r = (await list(f)).body.requests.find((r: { status: string }) => r.status === 'pending');
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/requests/${r.id}/approve`)
      .set(bearer(f.token))
      .send({ confirmRecovery: true })
      .expect(200);
    await activate(recovery);
    await request(app)
      .post(`${path}/${p.id}/remove`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: p.credentialGeneration })
      .expect(409);
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/close`)
      .set(bearer(f.token))
      .send({})
      .expect(200);
    await request(app).get(path).set(bearer(f.token)).expect(200);
    await request(app)
      .post(`${path}/${p.id}/block`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: p.credentialGeneration })
      .expect(409);
  });
  it('serializes blocking against pending activation and recovery approval, and releases the occupied seat', async () => {
    const f = await fixture(1),
      pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    const path = `/api/identity/classrooms/${f.id}/participants`;
    const p = (await request(app).get(path).set(bearer(f.token))).body.participants[0];
    const [blocked, activation] = await Promise.all([
      request(app)
        .post(`${path}/${p.id}/block`)
        .set(bearer(f.token))
        .send({ confirm: true, expectedGeneration: p.credentialGeneration }),
      activate(pending),
    ]);
    expect([200, 409]).toContain(blocked.status);
    expect([200, 401, 403]).toContain(activation.status);
    if (blocked.status === 409) {
      expect(activation.status).toBe(200);
      const latest = (await request(app).get(path).set(bearer(f.token))).body.participants[0];
      await request(app)
        .post(`${path}/${p.id}/block`)
        .set(bearer(f.token))
        .send({ confirm: true, expectedGeneration: latest.credentialGeneration })
        .expect(200);
    }
    if (activation.status === 200)
      await request(app)
        .get('/api/student/session')
        .set(site)
        .set('Cookie', cookies(activation))
        .expect(401);
    await activate(pending).then((r) => expect(r.status).toBe(401));
    const next = await join(f.code, '002');
    const nextRequest = (await list(f)).body.requests.find(
      (r: { status: string }) => r.status === 'pending',
    );
    await resolve(f, nextRequest.id).expect(200);
    expect((await activate(next)).status).toBe(200);
    const recovery = await join(f.code, '002', 'recovery');
    const recoveryRequest = (await list(f)).body.requests.find(
      (r: { status: string }) => r.status === 'pending',
    );
    const second = (await request(app).get(path).set(bearer(f.token))).body.participants.find(
      (p: { studentNumber: string }) => p.studentNumber === '002',
    );
    const [block, approval] = await Promise.all([
      request(app)
        .post(`${path}/${second.id}/block`)
        .set(bearer(f.token))
        .send({ confirm: true, expectedGeneration: second.credentialGeneration }),
      request(app)
        .post(`/api/identity/classrooms/${f.id}/requests/${recoveryRequest.id}/approve`)
        .set(bearer(f.token))
        .send({ confirmRecovery: true }),
    ]);
    expect([200, 409]).toContain(block.status);
    expect([200, 409]).toContain(approval.status);
    expect([block.status, approval.status]).toContain(200);
    if (block.status === 200) {
      expect(
        (await pool.query('SELECT status FROM classroom_participants WHERE id=$1', [second.id]))
          .rows[0].status,
      ).toBe('blocked');
      expect((await activate(recovery)).status).toBe(401);
    } else {
      expect(approval.status).toBe(200);
      const latest = (await request(app).get(path).set(bearer(f.token))).body.participants.find(
        (p: { id: string }) => p.id === second.id,
      );
      await request(app)
        .post(`${path}/${latest.id}/block`)
        .set(bearer(f.token))
        .send({ confirm: true, expectedGeneration: latest.credentialGeneration })
        .expect(200);
      expect((await activate(recovery)).status).toBe(401);
    }
    expect(
      (
        await pool.query(
          'SELECT count(*) FROM student_participation_sessions WHERE participant_id=$1 AND revoked_at IS NULL',
          [second.id],
        )
      ).rows[0].count,
    ).toBe('0');
  });
  it('revalidates current teacher scope and makes repeated moderation idempotent without downgrading a block', async () => {
    const f = await fixture(),
      pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    const path = `/api/identity/classrooms/${f.id}/participants`,
      p = (await request(app).get(path).set(bearer(f.token))).body.participants[0];
    const blocked = await request(app)
      .post(`${path}/${p.id}/block`)
      .set(bearer(f.token))
      .send({ confirm: true, expectedGeneration: p.credentialGeneration })
      .expect(200);
    const input = {
      confirm: true,
      expectedGeneration: blocked.body.participant.credentialGeneration,
    };
    await request(app).post(`${path}/${p.id}/block`).set(bearer(f.token)).send(input).expect(200);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM audit_logs WHERE target_id=$1 AND action='classroom.participant_blocked'",
          [p.id],
        )
      ).rows[0].count,
    ).toBe('1');
    await pool.query("UPDATE classroom_memberships SET status='removed' WHERE class_id=$1", [f.id]);
    await request(app).get(path).set(bearer(f.token)).expect(404);
    await request(app).post(`${path}/${p.id}/block`).set(bearer(f.token)).send(input).expect(404);
    expect((await activate(pending)).status).toBe(401);
  });
  it('joins without an account, waits even with roster match, and activates only after teacher approval', async () => {
    const f = await fixture();
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/roster`)
      .set(bearer(f.token))
      .send({ name: 'Synthetic student', studentNumber: '001' })
      .expect(201);
    const pending = await join(f.code).expect(201);
    expect(pending.body).toMatchObject({
      state: 'request',
      status: 'pending',
      student: { studentNumber: '001' },
    });
    expect(JSON.stringify(pending.body)).not.toMatch(/participantId|roster|kind|requestId/);
    await activate(pending).then((r) => expect(r.status).toBe(403));
    const queue = await list(f).expect(200);
    expect(queue.body.requests[0]).toMatchObject({ rosterMatch: 'match', kind: 'join' });
    await resolve(f, queue.body.requests[0].id).expect(200);
    const active = await activate(pending).then((r) => {
      expect(r.status).toBe(200);
      return r;
    });
    expect(active.body).toMatchObject({ state: 'participant', classroom: { id: f.id } });
    await request(app)
      .get('/api/student/session')
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    expect(
      (await pool.query('SELECT count(*) FROM users WHERE name=$1', ['Synthetic student'])).rows[0]
        .count,
    ).toBe('0');
  });
  it('keeps existing credentials valid during recovery, then revokes them only after explicit teacher confirmation', async () => {
    const f = await fixture();
    const pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    const active = await activate(pending);
    const recovery = await join(f.code, '001', 'recovery').expect(201);
    await request(app)
      .get('/api/student/session')
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    const item = (await list(f)).body.requests.find(
      (r: { status: string }) => r.status === 'pending',
    );
    expect(item.kind).toBe('recovery');
    await resolve(f, item.id).expect(409);
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/requests/${item.id}/approve`)
      .set(bearer(f.token))
      .send({ confirmRecovery: true })
      .expect(200);
    await request(app)
      .get('/api/student/session')
      .set(site)
      .set('Cookie', cookies(active))
      .expect(401);
    expect((await activate(recovery)).body.state).toBe('participant');
    expect((await activate(pending)).status).toBe(401);
  });
  it('does not disclose existing students to a normal duplicate request and never changes their connection', async () => {
    const f = await fixture();
    const pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    const active = await activate(pending);
    const duplicate = await join(f.code).expect(201);
    const item = (await list(f)).body.requests.find(
      (r: { status: string }) => r.status === 'pending',
    );
    await resolve(f, item.id).expect(409);
    expect(duplicate.body.status).toBe('pending');
    await request(app)
      .get('/api/student/session')
      .set(site)
      .set('Cookie', cookies(active))
      .expect(200);
    const other = await fixture();
    await request(app)
      .get(`/api/identity/classrooms/${f.id}/requests`)
      .set(bearer(other.token))
      .expect(404);
    await resolve(other, item.id).expect(404);
    await request(app)
      .get(`/api/identity/classrooms/${f.id}/requests`)
      .set(site)
      .set('Cookie', cookies(active))
      .expect(401);
  });
  it('serializes final-seat approval, rejects expired requests, and preserves accepted pending after code rotation', async () => {
    const f = await fixture(1);
    await join(f.code, '001');
    await join(f.code, '002');
    const queue = (await list(f)).body.requests;
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/invitations`)
      .set(bearer(f.token))
      .send({})
      .expect(201);
    const results = await Promise.all(queue.map((r: { id: string }) => resolve(f, r.id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const waiting = queue.find((_: unknown, i: number) => results[i].status === 409);
    await pool.query(
      "UPDATE classroom_join_requests SET created_at=now()-interval '31 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",
      [waiting.id],
    );
    await resolve(f, waiting.id).expect(409);
  });
  it('rejects bad/expired/revoked codes uniformly, invalid input explicitly, and disallows switching with a live cookie', async () => {
    const f = await fixture();
    const pending = await join(f.code).expect(201);
    await request(app)
      .post('/api/student/join')
      .set(site)
      .set('Cookie', cookies(pending))
      .set('X-Student-CSRF', pending.body.csrfToken)
      .send({ code: f.code, name: 'Second', studentNumber: '002', kind: 'join' })
      .expect(409);
    await join('AAAAAAAAAAAA').expect(400);
    await request(app)
      .delete(`/api/identity/classrooms/${f.id}/invitations`)
      .set(bearer(f.token))
      .expect(200);
    await join(f.code).expect(400);
    await request(app)
      .post('/api/student/join')
      .set(site)
      .send({ code: f.code, name: 'Student', studentNumber: 1, kind: 'join' })
      .expect(400);
    await request(app)
      .post('/api/student/join')
      .set('Host', new URL(origin).host)
      .send({ code: f.code, name: 'Student', studentNumber: '1', kind: 'join' })
      .expect(403);
  });
  it('enforces signed-browser and shared PostgreSQL limits across app instances, ignoring forged forwarded IP', async () => {
    const f = await fixture();
    const initial = await request(app).get('/api/student/session').set(site).expect(200);
    expect(initial.body.joinAvailable).toBe(true);
    const browser = cookies(initial);
    for (let i = 0; i < 10; i++)
      await request(app)
        .post('/api/student/join')
        .set(site)
        .set('Cookie', browser)
        .send({ code: 'AAAAAAAAAAAA', name: 'Student', studentNumber: '001', kind: 'join' })
        .expect(400);
    const second = createApp({ pool, origins: [origin] });
    const denied = await request(second)
      .post('/api/student/join')
      .set(site)
      .set('Cookie', browser)
      .set('X-Forwarded-For', '203.0.113.8')
      .send({ code: f.code, name: 'Student', studentNumber: '001', kind: 'join' })
      .expect(429);
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    expect((await pool.query('SELECT count(*) FROM student_join_rate_events')).rows[0].count).toBe(
      '30',
    );
  });
  it('rejects requests without leaking roster data and permits new application after clearing a rejected cookie', async () => {
    const f = await fixture();
    const pending = await join(f.code);
    const item = (await list(f)).body.requests[0];
    expect(item.rosterMatch).toBe('not_configured');
    await resolve(f, item.id, 'reject').expect(200);
    const own = await request(app)
      .get('/api/student/session')
      .set(site)
      .set('Cookie', cookies(pending))
      .expect(200);
    expect(own.body.status).toBe('rejected');
    await request(app)
      .post('/api/student/session/end')
      .set(site)
      .set('Cookie', cookies(pending))
      .set('X-Student-CSRF', own.body.csrfToken)
      .send({})
      .expect(204);
    await join(f.code).expect(201);
    await resolve(f, item.id).expect(409);
  });
  it('measures exact shared IP and code thresholds, keeps denied calls bounded and allows the sliding window to expire', async () => {
    await fixture();
    const secret = await joinRateSecret(pool);
    const ip = `fixture-ip-${randomUUID()}`,
      code = generateInvitationCode();
    const consume = (browser: string, address: string, target: string) =>
      consumeJoinBudget(pool, secret, browserIdentifier(secret, browser), address, target);
    for (let i = 0; i < 100; i++) expect(await consume('', ip, generateInvitationCode())).toBe(0);
    expect(await consume('', ip, generateInvitationCode())).toBeGreaterThan(0);
    expect(
      Number((await pool.query('SELECT count(*) FROM student_join_rate_events')).rows[0].count),
    ).toBe(300);
    await pool.query('DELETE FROM student_join_rate_events');
    for (let i = 0; i < 100; i++) expect(await consume('', `different-${i}`, code)).toBe(0);
    expect(await consume('', `different-last`, code)).toBeGreaterThan(0);
    await pool.query(
      "UPDATE student_join_rate_events SET attempted_at=now()-interval '16 minutes'",
    );
    expect(await consume('', ip, code)).toBe(0);
    expect((await pool.query('SELECT count(*) FROM student_join_rate_events')).rows[0].count).toBe(
      '3',
    );
  });
  it('bounds the pending queue at 100, does not reserve seats, and permits new requests after pending expiry', async () => {
    const f = await fixture(1);
    const inv = (await pool.query('SELECT id FROM classroom_invitations WHERE class_id=$1', [f.id]))
      .rows[0].id;
    for (let i = 0; i < 100; i++)
      await pool.query(
        `INSERT INTO classroom_join_requests(id,class_id,invitation_id,name,student_number,expires_at)
      VALUES($1,$2,$3,'Queue fixture',$4,now()+interval '30 minutes')`,
        [randomUUID(), f.id, inv, String(i)],
      );
    await join(f.code).expect(429);
    expect(
      (await pool.query('SELECT count(*) FROM classroom_participants WHERE class_id=$1', [f.id]))
        .rows[0].count,
    ).toBe('0');
    await pool.query(
      "UPDATE classroom_join_requests SET created_at=now()-interval '31 minutes',expires_at=now()-interval '1 minute' WHERE class_id=$1",
      [f.id],
    );
    await join(f.code).expect(201);
  });
  it('rolls back join and approval on audit failure, while retaining the committed request budget', async () => {
    const f = await fixture();
    await pool.query(`CREATE FUNCTION fail_phase4_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER fail_phase4_audit BEFORE INSERT ON classroom_participation_audit FOR EACH ROW EXECUTE FUNCTION fail_phase4_audit()`);
    try {
      await join(f.code).expect(500);
      expect(
        (await pool.query('SELECT count(*) FROM classroom_join_requests WHERE class_id=$1', [f.id]))
          .rows[0].count,
      ).toBe('0');
      expect(
        (await pool.query('SELECT count(*) FROM student_join_rate_events')).rows[0].count,
      ).toBe('3');
    } finally {
      await pool.query(
        'DROP TRIGGER fail_phase4_audit ON classroom_participation_audit; DROP FUNCTION fail_phase4_audit()',
      );
    }
    await join(f.code);
    const item = (await list(f)).body.requests[0];
    await pool.query(`CREATE FUNCTION fail_phase4_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER fail_phase4_audit BEFORE INSERT ON classroom_participation_audit FOR EACH ROW EXECUTE FUNCTION fail_phase4_audit()`);
    try {
      await resolve(f, item.id).expect(500);
      expect(
        (await pool.query('SELECT status FROM classroom_join_requests WHERE id=$1', [item.id]))
          .rows[0].status,
      ).toBe('pending');
      expect(
        (await pool.query('SELECT count(*) FROM classroom_participants WHERE class_id=$1', [f.id]))
          .rows[0].count,
      ).toBe('0');
    } finally {
      await pool.query(
        'DROP TRIGGER fail_phase4_audit ON classroom_participation_audit; DROP FUNCTION fail_phase4_audit()',
      );
    }
  });
  it('makes unclaimed approval revocable, prevents superseded approval replay, and checks resolver permission at activation', async () => {
    const f = await fixture();
    const pending = await join(f.code);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
    const recovery = await join(f.code, '001', 'recovery');
    const item = (await list(f)).body.requests.find(
      (r: { status: string }) => r.status === 'pending',
    );
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/requests/${item.id}/approve`)
      .set(bearer(f.token))
      .send({ confirmRecovery: true })
      .expect(200);
    expect((await activate(pending)).status).toBe(403);
    const user = (await pool.query('SELECT teacher_id FROM classes WHERE id=$1', [f.id])).rows[0]
      .teacher_id;
    await pool.query(
      "UPDATE classroom_memberships SET status='removed' WHERE class_id=$1 AND user_id=$2",
      [f.id, user],
    );
    expect((await activate(recovery)).status).toBe(403);
    await pool.query(
      "UPDATE classroom_memberships SET status='approved' WHERE class_id=$1 AND user_id=$2",
      [f.id, user],
    );
    await request(app)
      .post('/api/student/session/end')
      .set(site)
      .set('Cookie', cookies(recovery))
      .set('X-Student-CSRF', recovery.body.csrfToken)
      .send({})
      .expect(204);
    expect(
      (await pool.query('SELECT status FROM classroom_participants WHERE class_id=$1', [f.id]))
        .rows[0].status,
    ).toBe('left');
    const again = await join(f.code);
    await resolve(
      f,
      (await list(f)).body.requests.find((r: { status: string }) => r.status === 'pending').id,
    ).expect(200);
    expect((await activate(again)).status).toBe(200);
  });
  it('never accepts approval or join after classroom closure, even if closure races approval', async () => {
    const f = await fixture();
    await join(f.code);
    const item = (await list(f)).body.requests[0];
    await Promise.all([
      resolve(f, item.id),
      request(app)
        .post(`/api/identity/classrooms/${f.id}/close`)
        .set(bearer(f.token))
        .send({})
        .expect(200),
    ]);
    await resolve(f, item.id).expect(409);
    await join(f.code).expect(400);
    expect(
      (
        await pool.query(
          'SELECT count(*) FROM student_participation_sessions WHERE class_id=$1 AND revoked_at IS NULL',
          [f.id],
        )
      ).rows[0].count,
    ).toBe('0');
  });
  it('never auto-approves roster mismatch, refuses forged ownership fields, and treats expired codes like unknown codes', async () => {
    const f = await fixture();
    await request(app)
      .post(`/api/identity/classrooms/${f.id}/roster`)
      .set(bearer(f.token))
      .send({ name: 'Different fixture name', studentNumber: '001' })
      .expect(201);
    const pending = await join(f.code).expect(201);
    expect(pending.body.status).toBe('pending');
    expect((await list(f)).body.requests[0].rosterMatch).toBe('number_only');
    await request(app)
      .post('/api/student/join')
      .set(site)
      .send({ code: f.code, name: 'Student', studentNumber: '002', kind: 'join', role: 'manager' })
      .expect(400);
    await pool.query(
      "UPDATE classroom_invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE class_id=$1",
      [f.id],
    );
    const expired = await join(f.code).expect(400),
      unknown = await join('AAAAAAAAAAAA').expect(400);
    expect(expired.body).toEqual(unknown.body);
    await resolve(f, (await list(f)).body.requests[0].id).expect(200);
  });
  it('serializes concurrent browser budget consumption at the exact limit and does not accept forged browser signatures', async () => {
    await fixture();
    const secret = await joinRateSecret(pool),
      browser = browserIdentifier(secret, undefined);
    expect(browserIdentifier(secret, browser)).toBe(browser);
    const forged = `${browser.split('.')[0]}.${'0'.repeat(64)}`;
    expect(browserIdentifier(secret, forged)).not.toBe(forged);
    for (let i = 0; i < 8; i++)
      expect(
        await consumeJoinBudget(pool, secret, browser, 'shared-ip', generateInvitationCode()),
      ).toBe(0);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        consumeJoinBudget(pool, secret, browser, 'shared-ip', generateInvitationCode()),
      ),
    );
    expect(results.filter((retry) => retry === 0)).toHaveLength(2);
    expect(results.filter((retry) => retry > 0)).toHaveLength(4);
    expect((await pool.query('SELECT count(*) FROM student_join_rate_events')).rows[0].count).toBe(
      '30',
    );
  });
});

describe('teacher classroom management', () => {
  async function teacher() {
    const { response } = await signIn(`${randomUUID()}@example.test`);
    expect(response.status).toBe(200);
    return { token: response.body.token as string, userId: response.body.user.id as string };
  }
  async function create(token: string, name = 'Managed classroom') {
    return request(app)
      .post('/api/identity/classrooms')
      .set(bearer(token))
      .send({ name, capacity: 40 });
  }
  it('atomically creates a personal classroom, manager membership and one hashed 12-character/24-hour invitation', async () => {
    const owner = await teacher();
    const response = await create(owner.token);
    expect(response.status).toBe(201);
    const { classroom, invitation } = response.body;
    expect(classroom).toMatchObject({
      name: 'Managed classroom',
      capacity: 40,
      approvalRequired: true,
      roster: [],
    });
    expect(invitation.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
    const stored = (
      await pool.query('SELECT * FROM classroom_invitations WHERE class_id=$1', [classroom.id])
    ).rows[0];
    expect(stored.code_hash).toBe(digest(invitation.code));
    expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBe(86400000);
    const relation = (
      await pool.query(
        'SELECT role,status,source FROM classroom_memberships WHERE class_id=$1 AND user_id=$2',
        [classroom.id, owner.userId],
      )
    ).rows[0];
    expect(relation).toEqual({ role: 'manager', status: 'approved', source: 'direct' });
    expect(
      (await pool.query('SELECT school_id,teacher_id FROM classes WHERE id=$1', [classroom.id]))
        .rows[0],
    ).toEqual({ school_id: null, teacher_id: owner.userId });
    const read = await request(app)
      .get(`/api/identity/classrooms/${classroom.id}`)
      .set(bearer(owner.token));
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(invitation.code);
    expect(JSON.stringify(read.body)).not.toContain(stored.code_hash);
    expect(
      (await request(app).get('/api/identity/classrooms').set(bearer(owner.token))).body.classrooms,
    ).toContainEqual({ id: classroom.id, name: classroom.name, role: 'manager' });
    const audit = (
      await pool.query('SELECT * FROM classroom_participation_audit WHERE class_id=$1', [
        classroom.id,
      ])
    ).rows;
    expect(audit.some((row) => row.action === 'classroom.created')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(invitation.code);
  });
  it('denies other teachers and student memberships across every management surface', async () => {
    const owner = await teacher(),
      other = await teacher();
    const created = await create(owner.token);
    const classroom = created.body.classroom.id;
    for (const student of [false, true]) {
      if (student)
        await pool.query(
          "INSERT INTO classroom_memberships(class_id,user_id,role,status) VALUES ($1,$2,'student','approved')",
          [classroom, other.userId],
        );
      for (const [method, path, body] of [
        ['get', '', undefined],
        ['patch', '', { name: 'Stolen' }],
        ['post', '/invitations', {}],
        ['delete', '/invitations', undefined],
        ['get', '/roster', undefined],
        ['post', '/roster', { name: 'Secret student', studentNumber: '001' }],
        ['patch', `/roster/${randomUUID()}`, { name: 'Stolen', studentNumber: '001' }],
        ['delete', `/roster/${randomUUID()}`, undefined],
        ['post', '/close', {}],
        ['post', '/archive', {}],
      ] as const) {
        const response = await request(app)
          [method](`/api/identity/classrooms/${classroom}${path}`)
          .set(bearer(other.token))
          .send(body);
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(
      (await request(app).post('/api/identity/classrooms').send({ name: 'No auth' })).status,
    ).toBe(401);
    expect(
      (await pool.query('SELECT name FROM classes WHERE id=$1', [classroom])).rows[0].name,
    ).toBe('Managed classroom');
  });
  it('validates settings without accepting forged owners, auto-approval or invalid capacities', async () => {
    const owner = await teacher();
    for (const body of [
      { name: '' },
      { name: 'Invalid', capacity: 0 },
      { name: 'Invalid', capacity: 101 },
      { name: 'Invalid', capacity: 1.5 },
      { name: 'Invalid', capacity: '40' },
      { name: 'Invalid', approvalRequired: false },
      { name: 'Invalid', teacherId: teacherId },
    ]) {
      expect(
        (await request(app).post('/api/identity/classrooms').set(bearer(owner.token)).send(body))
          .status,
      ).toBe(400);
    }
    const created = await create(owner.token);
    const classroom = created.body.classroom.id;
    expect(
      (
        await request(app)
          .patch(`/api/identity/classrooms/${classroom}`)
          .set(bearer(owner.token))
          .send({ name: ' Renamed ', capacity: 25 })
      ).body.classroom,
    ).toMatchObject({ name: 'Renamed', capacity: 25, approvalRequired: true });
    expect(
      (
        await request(app)
          .patch(`/api/identity/classrooms/${classroom}`)
          .set(bearer(owner.token))
          .send({ approvalRequired: false })
      ).status,
    ).toBe(400);
  });
  it('rotates and revokes invitations without exposing old plaintext or cancelling existing requests', async () => {
    const owner = await teacher();
    const created = await create(owner.token),
      classroom = created.body.classroom.id;
    const join = randomUUID();
    await pool.query(
      `INSERT INTO classroom_join_requests(id,class_id,invitation_id,name,student_number,expires_at)
       VALUES($1,$2,$3,'Pending student','001',now()+interval '30 minutes')`,
      [join, classroom, created.body.invitation.id],
    );
    const rotated = await request(app)
      .post(`/api/identity/classrooms/${classroom}/invitations`)
      .set(bearer(owner.token))
      .send({});
    expect(rotated.status).toBe(201);
    expect(rotated.body.invitation.code).not.toBe(created.body.invitation.code);
    expect(
      (
        await pool.query(
          'SELECT count(*) FROM classroom_invitations WHERE class_id=$1 AND revoked_at IS NULL',
          [classroom],
        )
      ).rows[0].count,
    ).toBe('1');
    await request(app)
      .delete(`/api/identity/classrooms/${classroom}/invitations`)
      .set(bearer(owner.token))
      .expect(200);
    expect(
      (await pool.query('SELECT status FROM classroom_join_requests WHERE id=$1', [join])).rows[0]
        .status,
    ).toBe('pending');
    const read = await request(app)
      .get(`/api/identity/classrooms/${classroom}`)
      .set(bearer(owner.token));
    expect(read.body.classroom.invitation.status).toBe('revoked');
    expect(JSON.stringify(read.body)).not.toContain(rotated.body.invitation.code);
  });
  it('normalizes roster entries, preserves leading zeros, prevents duplicates and isolates entry IDs', async () => {
    const owner = await teacher();
    const first = await create(owner.token),
      second = await create(owner.token, 'Other classroom');
    const path = `/api/identity/classrooms/${first.body.classroom.id}/roster`;
    const added = await request(app)
      .post(path)
      .set(bearer(owner.token))
      .send({ name: ' 가 ', studentNumber: ' 001 ' });
    expect(added.status).toBe(201);
    const entry = added.body.classroom.roster[0];
    expect(entry).toMatchObject({ name: '가', studentNumber: '001' });
    expect(
      (
        await request(app)
          .post(path)
          .set(bearer(owner.token))
          .send({ name: 'Duplicate', studentNumber: '001' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(path)
          .set(bearer(owner.token))
          .send({ name: 'Bad', studentNumber: 1 })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch(`${path}/${entry.id}`)
          .set(bearer(owner.token))
          .send({ name: 'Updated', studentNumber: '0002' })
      ).body.classroom.roster[0],
    ).toMatchObject({ name: 'Updated', studentNumber: '0002' });
    const wrongPath = `/api/identity/classrooms/${second.body.classroom.id}/roster/${entry.id}`;
    await request(app).delete(wrongPath).set(bearer(owner.token)).expect(404);
    await request(app).get(path).set(bearer(owner.token)).expect(200);
    await request(app).delete(`${path}/${entry.id}`).set(bearer(owner.token)).expect(200);
    expect(
      (
        await pool.query('SELECT 1 FROM classroom_participants WHERE class_id=$1', [
          first.body.classroom.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('serializes concurrent rotations leaving only the last code active', async () => {
    const owner = await teacher(),
      created = await create(owner.token);
    const classroom = created.body.classroom.id;
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        request(app)
          .post(`/api/identity/classrooms/${classroom}/invitations`)
          .set(bearer(owner.token))
          .send({}),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    const active = (
      await pool.query(
        'SELECT code_hash FROM classroom_invitations WHERE class_id=$1 AND revoked_at IS NULL',
        [classroom],
      )
    ).rows;
    expect(active).toHaveLength(1);
    expect(
      responses.filter((response) => digest(response.body.invitation.code) === active[0].code_hash),
    ).toHaveLength(1);
  });
  it('closes/archives atomically, revoking invitations and student access while preserving participant records', async () => {
    for (const action of ['close', 'archive']) {
      const owner = await teacher(),
        created = await create(owner.token);
      const classroom = created.body.classroom.id,
        participant = randomUUID(),
        join = randomUUID();
      await pool.query(
        `INSERT INTO classroom_participants(id,class_id,name,student_number,approved_by,approved_at)
         VALUES($1,$2,'Approved student','001',$3,now())`,
        [participant, classroom, owner.userId],
      );
      await pool.query(
        `INSERT INTO classroom_join_requests(id,class_id,invitation_id,name,student_number,expires_at)
         VALUES($1,$2,$3,'Pending student','002',now()+interval '30 minutes')`,
        [join, classroom, created.body.invitation.id],
      );
      const credential = await transaction(pool, (client) =>
        issuePendingStudentCredential(client, join),
      );
      await pool.query('UPDATE classes SET voluntary_focus=true WHERE id=$1', [classroom]);
      const closed = await request(app)
        .post(`/api/identity/classrooms/${classroom}/${action}`)
        .set(bearer(owner.token))
        .send({});
      expect(closed.status).toBe(200);
      expect(closed.body.classroom.closedAt).toBeTruthy();
      expect(
        (await pool.query('SELECT voluntary_focus FROM classes WHERE id=$1', [classroom])).rows[0]
          .voluntary_focus,
      ).toBe(false);
      expect(
        (await pool.query('SELECT status FROM classroom_join_requests WHERE id=$1', [join])).rows[0]
          .status,
      ).toBe('cancelled');
      expect(
        (
          await pool.query(
            'SELECT revoked_at FROM student_participation_sessions WHERE token_hash=$1',
            [digest(credential.token)],
          )
        ).rows[0].revoked_at,
      ).not.toBeNull();
      expect(
        (await pool.query('SELECT status FROM classroom_participants WHERE id=$1', [participant]))
          .rows[0].status,
      ).toBe('approved');
      await request(app)
        .post(`/api/identity/classrooms/${classroom}/invitations`)
        .set(bearer(owner.token))
        .send({})
        .expect(409);
      await request(app)
        .post(`/api/identity/classrooms/${classroom}/${action}`)
        .set(bearer(owner.token))
        .send({})
        .expect(200);
    }
  });
  it('reports expired invitations, retries hash collisions, and rolls back exhausted rotation attempts', async () => {
    const owner = await teacher(),
      created = await create(owner.token);
    const classroom = created.body.classroom.id;
    await pool.query(
      "UPDATE classroom_invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE class_id=$1",
      [classroom],
    );
    const read = await request(app)
      .get(`/api/identity/classrooms/${classroom}`)
      .set(bearer(owner.token));
    expect(read.body.classroom.invitation.status).toBe('expired');
    let count = 0;
    const fresh = generateInvitationCode();
    const rotated = await transaction(pool, async (client) => {
      await client.query('SELECT id FROM classes WHERE id=$1 FOR UPDATE', [classroom]);
      return issueClassroomInvitation(client, classroom, owner.userId, () => {
        count++;
        return count < 3 ? created.body.invitation.code : fresh;
      });
    });
    expect(count).toBe(3);
    expect(rotated.code).toBe(fresh);
    await expect(
      transaction(pool, async (client) => {
        await client.query('SELECT id FROM classes WHERE id=$1 FOR UPDATE', [classroom]);
        return issueClassroomInvitation(client, classroom, owner.userId, () => fresh);
      }),
    ).rejects.toMatchObject({ status: 503, code: 'INVITATION_UNAVAILABLE' });
    expect(
      (
        await pool.query(
          'SELECT code_hash FROM classroom_invitations WHERE class_id=$1 AND revoked_at IS NULL',
          [classroom],
        )
      ).rows[0].code_hash,
    ).toBe(digest(fresh));
  });
  it('rechecks teacher access, disabled accounts and occupied capacity on every mutation', async () => {
    const owner = await teacher(),
      created = await create(owner.token),
      classroom = created.body.classroom.id;
    for (const number of ['001', '002'])
      await pool.query(
        `INSERT INTO classroom_participants(id,class_id,name,student_number,approved_by,approved_at)
       VALUES($1,$2,'Student',$3,$4,now())`,
        [randomUUID(), classroom, number, owner.userId],
      );
    await request(app)
      .patch(`/api/identity/classrooms/${classroom}`)
      .set(bearer(owner.token))
      .send({ capacity: 1 })
      .expect(409);
    await pool.query(
      "UPDATE classroom_memberships SET status='removed' WHERE class_id=$1 AND user_id=$2",
      [classroom, owner.userId],
    );
    await request(app)
      .post(`/api/identity/classrooms/${classroom}/invitations`)
      .set(bearer(owner.token))
      .send({})
      .expect(404);
    await pool.query('UPDATE users SET active=false WHERE id=$1', [owner.userId]);
    await create(owner.token).then((response) => expect(response.status).toBe(401));
  });
  it('serializes classroom closure against code rotation so no usable code survives closure', async () => {
    const owner = await teacher(),
      created = await create(owner.token),
      classroom = created.body.classroom.id;
    const [rotate, close] = await Promise.all([
      request(app)
        .post(`/api/identity/classrooms/${classroom}/invitations`)
        .set(bearer(owner.token))
        .send({}),
      request(app)
        .post(`/api/identity/classrooms/${classroom}/close`)
        .set(bearer(owner.token))
        .send({}),
    ]);
    expect([201, 409]).toContain(rotate.status);
    expect(close.status).toBe(200);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM classroom_invitations WHERE class_id=$1 AND revoked_at IS NULL',
          [classroom],
        )
      ).rowCount,
    ).toBe(0);
  });
  it('rolls back creation and code rotation when the management audit cannot be saved', async () => {
    const owner = await teacher(),
      created = await create(owner.token),
      classroom = created.body.classroom.id;
    const before = (
      await pool.query('SELECT count(*) FROM classes WHERE teacher_id=$1', [owner.userId])
    ).rows[0].count;
    const name = `manage_audit_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`
      CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.teacher_id='${owner.userId}' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON classroom_participation_audit FOR EACH ROW EXECUTE FUNCTION ${name}();
    `);
    try {
      expect((await create(owner.token, 'Audit failed creation')).status).toBe(500);
      await request(app)
        .post(`/api/identity/classrooms/${classroom}/invitations`)
        .set(bearer(owner.token))
        .send({})
        .expect(500);
      expect(
        (await pool.query('SELECT count(*) FROM classes WHERE teacher_id=$1', [owner.userId]))
          .rows[0].count,
      ).toBe(before);
      expect(
        (
          await pool.query(
            'SELECT code_hash FROM classroom_invitations WHERE class_id=$1 AND revoked_at IS NULL',
            [classroom],
          )
        ).rows[0].code_hash,
      ).toBe(digest(created.body.invitation.code));
    } finally {
      await pool.query(
        `DROP TRIGGER ${name} ON classroom_participation_audit; DROP FUNCTION ${name}();`,
      );
    }
  });
  it('preserves scoped school admin/teacher access, denies stale legacy mirrors and closes legacy device access', async () => {
    const ownSchool = randomUUID(),
      legacyTeacher = randomUUID(),
      legacyStudent = randomUUID(),
      legacyClass = randomUUID();
    await pool.query('INSERT INTO schools(id,name,google_domain) VALUES($1,$2,$3)', [
      ownSchool,
      'Phase 3 fixture',
      'phase3.example',
    ]);
    for (const [user, role] of [
      [legacyTeacher, 'teacher'],
      [legacyStudent, 'student'],
    ])
      await pool.query(
        'INSERT INTO users(id,school_id,email,name,role,google_sub) VALUES($1,$2,$3,$4,$5,$6)',
        [user, ownSchool, `${role}@phase3.example`, role, role, `phase3-${role}`],
      );
    await pool.query('INSERT INTO classes(id,school_id,teacher_id,name) VALUES($1,$2,$3,$4)', [
      legacyClass,
      ownSchool,
      legacyTeacher,
      'Closure legacy fixture',
    ]);
    await pool.query('INSERT INTO class_members(class_id,student_id,school_id) VALUES($1,$2,$3)', [
      legacyClass,
      legacyStudent,
      ownSchool,
    ]);
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [digest(token), legacyTeacher],
    );
    await request(app)
      .get(`/api/identity/classrooms/${legacyClass}`)
      .set(bearer(token))
      .expect(200);
    const adminToken = randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [digest(adminToken), adminId],
    );
    await request(app)
      .get(`/api/identity/classrooms/${legacyClass}`)
      .set(bearer(adminToken))
      .expect(404);
    await pool.query("UPDATE users SET role='student' WHERE id=$1", [legacyTeacher]);
    await request(app)
      .get(`/api/identity/classrooms/${legacyClass}`)
      .set(bearer(token))
      .expect(404);
    await pool.query("UPDATE users SET role='teacher' WHERE id=$1", [legacyTeacher]);
    await pool.query("UPDATE users SET role='school_admin' WHERE id=$1", [legacyTeacher]);
    await request(app)
      .get(`/api/identity/classrooms/${legacyClass}`)
      .set(bearer(token))
      .expect(200);
    await pool.query("UPDATE users SET role='teacher' WHERE id=$1", [legacyTeacher]);
    const device = randomUUID(),
      deviceToken = randomBytes(32).toString('base64url'),
      pairingCode = generateInvitationCode();
    await pool.query(
      `INSERT INTO registered_devices(id,class_id,school_id,student_id,name,asset_number,credential_hash,credential_expires_at)
       VALUES($1,$2,$3,$4,'Legacy device','fixture',$5,now()+interval '1 day')`,
      [device, legacyClass, ownSchool, legacyStudent, digest(deviceToken)],
    );
    await pool.query(
      "INSERT INTO device_pairings(code_hash,device_id,expires_at) VALUES($1,$2,now()+interval '5 minutes')",
      [digest(pairingCode), device],
    );
    await request(app)
      .post(`/api/identity/classrooms/${legacyClass}/close`)
      .set(bearer(token))
      .send({})
      .expect(200);
    await request(app).get(`/api/classes/${legacyClass}/members`).set(bearer(token)).expect(404);
    await request(app).post('/api/device/sync').set(bearer(deviceToken)).send({}).expect(401);
    await request(app).post('/api/device/pair').send({ code: pairingCode }).expect(401);
    expect(
      (await pool.query('SELECT credential_hash FROM registered_devices WHERE id=$1', [device]))
        .rows[0].credential_hash,
    ).toBeNull();
  });
  it('applies guest/code shutdown when the legacy classroom archive endpoint is used', async () => {
    const classroom = randomUUID(),
      invitation = randomUUID(),
      join = randomUUID();
    await pool.query('INSERT INTO classes(id,school_id,teacher_id,name) VALUES($1,$2,$3,$4)', [
      classroom,
      schoolId,
      teacherId,
      'Legacy archive compatibility',
    ]);
    await pool.query(
      "INSERT INTO classroom_invitations(id,class_id,code_hash,issued_by,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",
      [invitation, classroom, digest(generateInvitationCode()), teacherId],
    );
    await pool.query(
      `INSERT INTO classroom_join_requests(id,class_id,invitation_id,name,student_number,expires_at)
       VALUES($1,$2,$3,'Synthetic pending','001',now()+interval '30 minutes')`,
      [join, classroom, invitation],
    );
    const pending = await transaction(pool, (client) =>
      issuePendingStudentCredential(client, join),
    );
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [digest(token), teacherId],
    );
    await request(app).delete(`/api/classes/${classroom}`).set(bearer(token)).expect(204);
    expect(
      (await pool.query('SELECT status FROM classroom_join_requests WHERE id=$1', [join])).rows[0]
        .status,
    ).toBe('cancelled');
    expect(
      (
        await pool.query(
          'SELECT revoked_at FROM student_participation_sessions WHERE token_hash=$1',
          [digest(pending.token)],
        )
      ).rows[0].revoked_at,
    ).not.toBeNull();
    expect(
      (await pool.query('SELECT revoked_at FROM classroom_invitations WHERE id=$1', [invitation]))
        .rows[0].revoked_at,
    ).not.toBeNull();
  });
  it('serves every classroom/code/roster endpoint over HTTP and keeps closed records visible only to managers', async () => {
    const owner = await teacher();
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No HTTP listener');
      const url = `http://127.0.0.1:${address.port}`;
      async function call(path: string, method: string, status: number, body?: object) {
        const response = await fetch(`${url}/api/identity/classrooms${path}`, {
          method,
          headers: {
            ...bearer(owner.token),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status, `${method} ${path}`).toBe(status);
        return response.json();
      }
      const created = await call('', 'POST', 201, { name: 'HTTP classroom', capacity: 40 });
      const base = `/${created.classroom.id}`;
      await call(base, 'GET', 200);
      await call(base, 'PATCH', 200, { name: 'Updated HTTP classroom' });
      await call(`${base}/invitations`, 'POST', 201, {});
      await call(`${base}/invitations`, 'DELETE', 200);
      const added = await call(`${base}/roster`, 'POST', 201, {
        name: 'Synthetic student',
        studentNumber: '001',
      });
      const entry = added.classroom.roster[0].id;
      await call(`${base}/roster`, 'GET', 200);
      await call(`${base}/roster/${entry}`, 'PATCH', 200, {
        name: 'Updated student',
        studentNumber: '002',
      });
      await call(`${base}/roster/${entry}`, 'DELETE', 200);
      await call(`${base}/close`, 'POST', 200, {});
      await call(`${base}/archive`, 'POST', 200, {});
      const active = await call('', 'GET', 200);
      expect(active.classrooms).not.toContainEqual(
        expect.objectContaining({ id: created.classroom.id }),
      );
      const all = await call('?includeInactive=true', 'GET', 200);
      expect(all.classrooms).toContainEqual(
        expect.objectContaining({
          id: created.classroom.id,
          role: 'manager',
          closedAt: expect.any(String),
          archivedAt: expect.any(String),
        }),
      );
      const other = await teacher();
      await pool.query(
        "INSERT INTO classroom_memberships(class_id,user_id,role,status) VALUES($1,$2,'student','approved')",
        [created.classroom.id, other.userId],
      );
      const studentRead = await request(app)
        .get('/api/identity/classrooms?includeInactive=true')
        .set(bearer(other.token));
      expect(studentRead.body.classrooms).not.toContainEqual(
        expect.objectContaining({ id: created.classroom.id }),
      );
      expect(
        (await pool.query('SELECT name FROM classes WHERE id=$1', [created.classroom.id])).rows[0]
          .name,
      ).toBe('Updated HTTP classroom');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe('student cookie session boundary', () => {
  const site = { Origin: origin, Host: new URL(origin).host };
  const cookie = (token: string) => `clario-student-dev=${token}`;

  async function seed() {
    const classroom = randomUUID();
    const invitation = randomUUID();
    const join = randomUUID();
    const owner = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,name,role) VALUES($1,$2,'Cookie fixture manager','member')",
      [owner, `${owner}@example.test`],
    );
    await pool.query('INSERT INTO classes(id,teacher_id,name) VALUES ($1,$2,$3)', [
      classroom,
      owner,
      'Cookie classroom',
    ]);
    await pool.query(
      `INSERT INTO classroom_memberships(class_id,user_id,role,status,approved_by)
      VALUES($1,$2,'manager','approved',$2)`,
      [classroom, owner],
    );
    await pool.query(
      `INSERT INTO classroom_invitations(id,class_id,code_hash,issued_by,expires_at)
       VALUES ($1,$2,$3,$4,now()+interval '24 hours')`,
      [invitation, classroom, digest(randomUUID()), owner],
    );
    await pool.query(
      `INSERT INTO classroom_join_requests(id,class_id,invitation_id,name,student_number,expires_at)
       VALUES ($1,$2,$3,'테스트 학생','001',now()+interval '30 minutes')`,
      [join, classroom, invitation],
    );
    const pending = await transaction(pool, (client) =>
      issuePendingStudentCredential(client, join),
    );
    return { classroom, join, pending, owner };
  }

  async function approve(fixture: Awaited<ReturnType<typeof seed>>) {
    const participant = randomUUID();
    await pool.query(
      `INSERT INTO classroom_participants(id,class_id,name,student_number,approved_by,approved_at)
       VALUES ($1,$2,'테스트 학생','001',$3,now())`,
      [participant, fixture.classroom, fixture.owner],
    );
    await pool.query(
      `UPDATE classroom_join_requests SET status='approved',participant_id=$1,
       resolved_at=now(),resolved_by=$2 WHERE id=$3`,
      [participant, fixture.owner, fixture.join],
    );
    return participant;
  }

  it('does not authenticate an account, bearer, or client supplied participant ID', async () => {
    const response = await request(app).get('/api/student/session').set(site);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ state: 'none', joinAvailable: true });
    const forged = await request(app)
      .get(`/api/student/session?participantId=${studentId}`)
      .set(site)
      .set(bearer('a'.repeat(43)));
    expect(forged.status).toBe(200);
    expect(forged.body.state).toBe('none');
  });

  it('returns only own pending request and keeps raw credentials out of JSON/database', async () => {
    const fixture = await seed();
    const response = await request(app)
      .get('/api/student/session')
      .set(site)
      .set('Cookie', cookie(fixture.pending.token));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      state: 'request',
      status: 'pending',
      student: { name: '테스트 학생', studentNumber: '001' },
    });
    expect(response.body.csrfToken).toBe(studentCsrfToken(fixture.pending.token));
    expect(JSON.stringify(response.body)).not.toContain(fixture.pending.token);
    expect(response.body).not.toHaveProperty('participants');
    expect(
      (
        await pool.query(
          'SELECT token_hash FROM student_participation_sessions WHERE request_id=$1',
          [fixture.join],
        )
      ).rows[0].token_hash,
    ).toBe(digest(fixture.pending.token));
    expect(
      (
        await request(app)
          .get('/api/classes')
          .set(site)
          .set('Cookie', cookie(fixture.pending.token))
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/student/session/activate')
          .set(site)
          .set('Cookie', cookie(fixture.pending.token))
          .set('X-Student-CSRF', response.body.csrfToken)
          .send({})
      ).status,
    ).toBe(403);
  });

  it('requires same-origin requests, explicit JSON/CSRF and rejects duplicate or malformed cookies', async () => {
    const fixture = await seed();
    const activeCookie = cookie(fixture.pending.token);
    for (const headers of [
      { Host: new URL(origin).host },
      { Origin: 'https://evil.example', Host: new URL(origin).host },
      { Origin: origin, Host: 'other.example' },
      { ...site, 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      expect(
        (await request(app).get('/api/student/session').set(headers).set('Cookie', activeCookie))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await request(app)
          .get('/api/student/session')
          .set({ Host: new URL(origin).host, 'Sec-Fetch-Site': 'same-origin' })
          .set('Cookie', activeCookie)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/student/session/end')
          .set(site)
          .set('Cookie', activeCookie)
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/student/session/end')
          .set({ Host: new URL(origin).host, 'Sec-Fetch-Site': 'same-origin' })
          .set('Cookie', activeCookie)
          .set('X-Student-CSRF', studentCsrfToken(fixture.pending.token))
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/student/session/end')
          .set(site)
          .set('Cookie', activeCookie)
          .set('X-Student-CSRF', 'é'.repeat(43))
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/student/session/end')
          .set(site)
          .set('Cookie', activeCookie)
          .set('X-Student-CSRF', studentCsrfToken(fixture.pending.token))
          .type('form')
          .send('x=1')
      ).status,
    ).toBe(415);
    for (const value of ['clario-student-dev=invalid', `${activeCookie}; ${activeCookie}`]) {
      const response = await request(app)
        .get('/api/student/session')
        .set(site)
        .set('Cookie', value);
      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toBeTruthy();
    }
  });

  it('activates only an approved request, rotates the cookie and cannot replay pending credentials', async () => {
    const fixture = await seed();
    await approve(fixture);
    const response = await request(app)
      .post('/api/student/session/activate')
      .set(site)
      .set('Cookie', cookie(fixture.pending.token))
      .set('X-Student-CSRF', studentCsrfToken(fixture.pending.token))
      .send({ participantId: randomUUID(), role: 'manager' });
    expect(response.status).toBe(200);
    expect(response.body.state).toBe('participant');
    expect(response.body).not.toHaveProperty('token');
    const header = response.headers['set-cookie'];
    const setCookie = Array.isArray(header) ? header[0] : header;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    const nextCookie = setCookie.split(';')[0];
    expect(nextCookie).not.toContain(fixture.pending.token);
    expect(
      (await request(app).get('/api/student/session').set(site).set('Cookie', nextCookie)).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/student/session')
          .set(site)
          .set('Cookie', cookie(fixture.pending.token))
      ).status,
    ).toBe(401);
  });

  it('returns Secure host-only production cookies and denies direct cross-origin API access', async () => {
    const secureOrigin = 'https://students.example';
    const secure = createApp({
      pool,
      origins: [secureOrigin],
      googleClientId: 'test-client',
      verifyGoogle: async () => {
        throw new Error('Student path must not verify Google.');
      },
    });
    const fixture = await seed();
    await approve(fixture);
    const response = await request(secure)
      .post('/api/student/session/activate')
      .set({
        Origin: secureOrigin,
        Host: 'students.example',
        Cookie: `__Host-clario-student=${fixture.pending.token}`,
        'X-Student-CSRF': studentCsrfToken(fixture.pending.token),
      })
      .send({});
    expect(response.status).toBe(200);
    const headers = String(response.headers['set-cookie']);
    expect(headers).toContain('__Host-clario-student=');
    expect(headers).toContain('Secure');
    expect(headers).toContain('HttpOnly');
    expect(headers).not.toContain('Domain=');
    expect(
      (
        await request(secure)
          .get('/api/student/session')
          .set({ Origin: secureOrigin, Host: 'api.example' })
      ).status,
    ).toBe(403);
  });

  it('rejects expired, blocked, generation-mismatched and closed classroom credentials', async () => {
    for (const change of [
      'expired',
      'idle',
      'blocked',
      'generation',
      'closed',
      'archived',
    ] as const) {
      const fixture = await seed();
      const student = await approve(fixture);
      const session = await transaction(pool, (client) =>
        issueApprovedStudentCredential(client, fixture.join),
      );
      if (change === 'expired' || change === 'idle') {
        await pool.query(
          `UPDATE student_participation_sessions SET ${change === 'expired' ? "expires_at=last_seen_at+interval '1 millisecond'," : ''}
           idle_expires_at=last_seen_at+interval '1 millisecond' WHERE token_hash=$1`,
          [digest(session.token)],
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      } else if (change === 'blocked') {
        await pool.query("UPDATE classroom_participants SET status='blocked' WHERE id=$1", [
          student,
        ]);
      } else if (change === 'generation') {
        await pool.query(
          'UPDATE classroom_participants SET credential_generation=credential_generation+1 WHERE id=$1',
          [student],
        );
      } else {
        await pool.query(
          `UPDATE classes SET ${change === 'closed' ? 'closed_at' : 'archived_at'}=now() WHERE id=$1`,
          [fixture.classroom],
        );
      }
      const response = await request(app)
        .get('/api/student/session')
        .set(site)
        .set('Cookie', cookie(session.token));
      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toBeTruthy();
    }
  });

  it('ends pending participation and approved sessions with audit, generation revocation and connection cleanup', async () => {
    for (const approved of [false, true]) {
      const fixture = await seed();
      let token = fixture.pending.token;
      let student: string | undefined;
      if (approved) {
        student = await approve(fixture);
        token = (
          await transaction(pool, (client) => issueApprovedStudentCredential(client, fixture.join))
        ).token;
        const lesson = randomUUID();
        await pool.query(
          'INSERT INTO classroom_sessions(id,class_id,started_by) VALUES ($1,$2,$3)',
          [lesson, fixture.classroom, teacherId],
        );
        await pool.query(
          'INSERT INTO classroom_participant_attendance(session_id,class_id,participant_id) VALUES ($1,$2,$3)',
          [lesson, fixture.classroom, student],
        );
        await pool.query(
          `INSERT INTO classroom_participant_connections(id,session_id,class_id,participant_id,credential_generation,lease_expires_at)
           VALUES ($1,$2,$3,$4,1,now()+interval '1 minute')`,
          [randomUUID(), lesson, fixture.classroom, student],
        );
      }
      const response = await request(app)
        .post('/api/student/session/end')
        .set(site)
        .set('Cookie', cookie(token))
        .set('X-Student-CSRF', studentCsrfToken(token))
        .send({});
      expect(response.status).toBe(204);
      expect(response.headers['set-cookie']).toBeTruthy();
      expect(
        (await request(app).get('/api/student/session').set(site).set('Cookie', cookie(token)))
          .status,
      ).toBe(401);
      expect(
        (
          await pool.query('SELECT action FROM classroom_participation_audit WHERE class_id=$1', [
            fixture.classroom,
          ])
        ).rows.some((row) => row.action === 'student.session_ended'),
      ).toBe(true);
      if (student) {
        expect(
          (await pool.query('SELECT status FROM classroom_participants WHERE id=$1', [student]))
            .rows[0].status,
        ).toBe('left');
        expect(
          (
            await pool.query(
              'SELECT disconnected_at FROM classroom_participant_connections WHERE participant_id=$1',
              [student],
            )
          ).rows[0].disconnected_at,
        ).not.toBeNull();
      } else {
        expect(
          (
            await pool.query('SELECT status FROM classroom_join_requests WHERE id=$1', [
              fixture.join,
            ])
          ).rows[0].status,
        ).toBe('cancelled');
      }
    }
  });

  it('serializes concurrent activation and does not let the consumed pending cookie end the new session', async () => {
    const fixture = await seed();
    const participant = await approve(fixture);
    const responses = await Promise.all(
      [1, 2].map(() =>
        request(app)
          .post('/api/student/session/activate')
          .set(site)
          .set('Cookie', cookie(fixture.pending.token))
          .set('X-Student-CSRF', studentCsrfToken(fixture.pending.token))
          .send({}),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(
      responses.find((response) => response.status === 401)?.headers['set-cookie'],
    ).toBeUndefined();
    expect(
      (
        await pool.query(
          'SELECT token_hash FROM student_participation_sessions WHERE participant_id=$1 AND revoked_at IS NULL',
          [participant],
        )
      ).rowCount,
    ).toBe(1);
    await request(app)
      .post('/api/student/session/end')
      .set(site)
      .set('Cookie', cookie(fixture.pending.token))
      .set('X-Student-CSRF', studentCsrfToken(fixture.pending.token))
      .send({})
      .expect(204);
    expect(
      (await pool.query('SELECT status FROM classroom_participants WHERE id=$1', [participant]))
        .rows[0].status,
    ).toBe('approved');
  });

  it('refreshes idle expiry only up to the fixed absolute expiry and logs no token', async () => {
    const fixture = await seed();
    await approve(fixture);
    const session = await transaction(pool, (client) =>
      issueApprovedStudentCredential(client, fixture.join),
    );
    const hash = digest(session.token);
    await pool.query(
      `UPDATE student_participation_sessions SET expires_at=last_seen_at+interval '10 minutes',
       idle_expires_at=last_seen_at+interval '1 minute' WHERE token_hash=$1`,
      [hash],
    );
    const before = (
      await pool.query(
        'SELECT expires_at,idle_expires_at FROM student_participation_sessions WHERE token_hash=$1',
        [hash],
      )
    ).rows[0];
    await request(app)
      .get('/api/student/session')
      .set(site)
      .set('Cookie', cookie(session.token))
      .expect(200);
    const after = (
      await pool.query(
        'SELECT expires_at,idle_expires_at FROM student_participation_sessions WHERE token_hash=$1',
        [hash],
      )
    ).rows[0];
    expect(after.expires_at).toEqual(before.expires_at);
    expect(after.idle_expires_at).toEqual(after.expires_at);
    expect(after.idle_expires_at.getTime()).toBeGreaterThan(before.idle_expires_at.getTime());
    expect(
      JSON.stringify(
        (
          await pool.query('SELECT * FROM classroom_participation_audit WHERE class_id=$1', [
            fixture.classroom,
          ])
        ).rows,
      ),
    ).not.toContain(session.token);
  });

  it('keeps rejected/cancelled status private and refuses activation or refresh of an expired request', async () => {
    for (const status of ['rejected', 'cancelled', 'expired'] as const) {
      const fixture = await seed();
      if (status === 'expired') {
        await pool.query(
          "UPDATE classroom_join_requests SET expires_at=created_at+interval '1 millisecond' WHERE id=$1",
          [fixture.join],
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      } else {
        await pool.query(
          `UPDATE classroom_join_requests SET status=$1,resolved_at=now(),resolved_by=$2 WHERE id=$3`,
          [status, teacherId, fixture.join],
        );
      }
      const response = await request(app)
        .get('/api/student/session')
        .set(site)
        .set('Cookie', cookie(fixture.pending.token));
      expect(response.status).toBe(status === 'expired' ? 401 : 200);
      if (status !== 'expired') expect(response.body.status).toBe(status);
      const activate = await request(app)
        .post('/api/student/session/activate')
        .set(site)
        .set('Cookie', cookie(fixture.pending.token))
        .set('X-Student-CSRF', studentCsrfToken(fixture.pending.token))
        .send({});
      expect(activate.status).toBe(status === 'expired' ? 401 : 403);
      expect(
        (
          await pool.query('SELECT 1 FROM classroom_participants WHERE class_id=$1', [
            fixture.classroom,
          ])
        ).rowCount,
      ).toBe(0);
    }
  });

  it('rolls back credential revocation and cancellation when the audit insert fails', async () => {
    const fixture = await seed();
    const name = `audit_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`
      CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.class_id='${fixture.classroom}' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER ${name} BEFORE INSERT ON classroom_participation_audit FOR EACH ROW EXECUTE FUNCTION ${name}();
    `);
    try {
      const response = await request(app)
        .post('/api/student/session/end')
        .set(site)
        .set('Cookie', cookie(fixture.pending.token))
        .set('X-Student-CSRF', studentCsrfToken(fixture.pending.token))
        .send({});
      expect(response.status).toBe(500);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(
        (await pool.query('SELECT status FROM classroom_join_requests WHERE id=$1', [fixture.join]))
          .rows[0].status,
      ).toBe('pending');
      await request(app)
        .get('/api/student/session')
        .set(site)
        .set('Cookie', cookie(fixture.pending.token))
        .expect(200);
    } finally {
      await pool.query(
        `DROP TRIGGER ${name} ON classroom_participation_audit; DROP FUNCTION ${name}();`,
      );
    }
  });

  it('serves restore, activation and end over a running HTTP listener with committed database effects', async () => {
    const fixture = await seed();
    const participant = await approve(fixture);
    const runtimeOrigins: string[] = [];
    const running = createApp({
      pool,
      origins: runtimeOrigins,
      googleClientId: 'test-client',
      verifyGoogle: async () => {
        throw new Error('Student HTTP must not call Google.');
      },
    });
    const server = running.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP listener.');
      const url = `http://127.0.0.1:${address.port}`;
      runtimeOrigins.push(url);
      const httpSite = { Origin: url };
      expect((await fetch(`${url}/health`)).status).toBe(200);
      const headers = { ...httpSite, Cookie: cookie(fixture.pending.token) };
      const restore = await fetch(`${url}/api/student/session`, { headers });
      expect(restore.status).toBe(200);
      const activate = await fetch(`${url}/api/student/session/activate`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'X-Student-CSRF': studentCsrfToken(fixture.pending.token),
        },
        body: '{}',
      });
      expect(activate.status).toBe(200);
      const nextCookie = activate.headers.getSetCookie()[0].split(';')[0];
      const status = await fetch(`${url}/api/student/session`, {
        headers: { ...httpSite, Cookie: nextCookie },
      });
      expect(status.status).toBe(200);
      const view = await status.json();
      const end = await fetch(`${url}/api/student/session/end`, {
        method: 'POST',
        headers: {
          ...httpSite,
          Cookie: nextCookie,
          'Content-Type': 'application/json',
          'X-Student-CSRF': view.csrfToken,
        },
        body: '{}',
      });
      expect(end.status).toBe(204);
      expect(
        (await pool.query('SELECT status FROM classroom_participants WHERE id=$1', [participant]))
          .rows[0].status,
      ).toBe('left');
      expect(
        (
          await fetch(`${url}/api/student/session`, {
            headers: { ...httpSite, Cookie: nextCookie },
          })
        ).status,
      ).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('preserves the student Origin and Host through the actual Vite proxy for cookie restore and mutations', async () => {
    const { createServer: createVite } = await import('vite');
    const fixture = await seed();
    const participant = await approve(fixture);
    const origins: string[] = [];
    const running = createApp({
      pool,
      origins,
      googleClientId: 'test-client',
      verifyGoogle: async () => {
        throw new Error('Students must not call Google');
      },
    });
    const server = running.listen(0, '127.0.0.1');
    let vite: Awaited<ReturnType<typeof createVite>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing API listener');
      vite = await createVite({
        root: fileURLToPath(new URL('../../apps/student', import.meta.url)),
        configFile: fileURLToPath(new URL('../../apps/student/vite.config.ts', import.meta.url)),
        logLevel: 'silent',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
          host: '127.0.0.1',
          port: 0,
          preTransformRequests: false,
          proxy: { '/api': { target: `http://127.0.0.1:${address.port}` } },
        },
      });
      await vite.listen();
      const web = vite.httpServer?.address();
      if (!web || typeof web === 'string') throw new Error('Missing student listener');
      const url = `http://127.0.0.1:${web.port}`;
      origins.push(url);
      const restore = await fetch(`${url}/api/student/session`, {
        headers: { 'Sec-Fetch-Site': 'same-origin', Cookie: cookie(fixture.pending.token) },
        signal: AbortSignal.timeout(5000),
      });
      expect(restore.status).toBe(200);
      expect((await restore.json()).state).toBe('request');
      const activate = await fetch(`${url}/api/student/session/activate`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: {
          Origin: url,
          'Content-Type': 'application/json',
          Cookie: cookie(fixture.pending.token),
          'X-Student-CSRF': studentCsrfToken(fixture.pending.token),
        },
        body: '{}',
      });
      expect(activate.status).toBe(200);
      const nextCookie = activate.headers.getSetCookie()[0].split(';')[0];
      const view = await activate.json();
      expect(
        (
          await fetch(`${url}/api/student/session/end`, {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
            headers: {
              Origin: url,
              'Content-Type': 'application/json',
              Cookie: nextCookie,
              'X-Student-CSRF': view.csrfToken,
            },
            body: '{}',
          })
        ).status,
      ).toBe(204);
      expect(
        (await pool.query('SELECT status FROM classroom_participants WHERE id=$1', [participant]))
          .rows[0].status,
      ).toBe('left');
    } finally {
      await vite?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30000);
});

describe('version six identity and classroom schema', () => {
  it('rolls back a failed upgrade completely and preserves an oversized legacy roster for repair', async () => {
    const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new Pool({ ...databaseConfig, options: `-c search_path=${schema}` });
    try {
      await migrate(isolated, 5);
      await isolated.query('INSERT INTO schools(id,name,google_domain) VALUES ($1,$2,$3)', [
        schoolId,
        'Upgrade test',
        'upgrade.example',
      ]);
      await isolated.query(
        "INSERT INTO users(id,school_id,email,name,role) VALUES ($1,$2,'teacher@upgrade.example','Teacher','teacher')",
        [teacherId, schoolId],
      );
      await isolated.query(
        "INSERT INTO classes(id,school_id,teacher_id,name) VALUES ($1,$2,$3,'Large legacy class')",
        [classId, schoolId, teacherId],
      );
      const students = Array.from({ length: 101 }, () => randomUUID());
      await isolated.query(
        `INSERT INTO users(id,school_id,email,name,role)
         SELECT id,$2,id::text||'@upgrade.example','Student','student' FROM unnest($1::uuid[]) id`,
        [students, schoolId],
      );
      await isolated.query(
        'INSERT INTO class_members(class_id,student_id,school_id) SELECT $1,id,$3 FROM unnest($2::uuid[]) id',
        [classId, students, schoolId],
      );
      await expect(migrate(isolated)).rejects.toMatchObject({ code: '23514' });
      expect(
        (await isolated.query('SELECT count(*)::integer AS count FROM class_members')).rows[0]
          .count,
      ).toBe(101);
      expect(
        (
          await isolated.query(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='users' AND column_name='school_id'",
            [schema],
          )
        ).rows[0].is_nullable,
      ).toBe('NO');
      expect(
        (await isolated.query('SELECT max(version) AS version FROM schema_migrations')).rows[0]
          .version,
      ).toBe(5);
      await isolated.query('DELETE FROM class_members WHERE student_id=$1', [students[0]]);
      await migrate(isolated);
      expect(
        (await isolated.query('SELECT capacity FROM classes WHERE id=$1', [classId])).rows[0]
          .capacity,
      ).toBe(100);
    } finally {
      await isolated.end();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  it('upgrades existing v5 rows idempotently without moving users or losing classroom roles', async () => {
    const result = await pool.query(
      'SELECT user_id,role,source FROM classroom_memberships WHERE class_id=$1 ORDER BY role',
      [classId],
    );
    expect(result.rows).toEqual([
      { user_id: teacherId, role: 'manager', source: 'legacy_teacher' },
      { user_id: studentId, role: 'student', source: 'legacy_student' },
    ]);
    expect(
      (await pool.query('SELECT school_id FROM users WHERE id=$1', [studentId])).rows[0],
    ).toEqual({ school_id: schoolId });
    expect(
      (await pool.query('SELECT capacity,approval_required FROM classes WHERE id=$1', [classId]))
        .rows[0],
    ).toEqual({ capacity: 40, approval_required: true });
    expect(
      (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows,
    ).toEqual(Array.from({ length: databaseVersion }, (_, index) => ({ version: index + 1 })));
  });

  it('enforces identity scope, membership uniqueness, capacity and one active session', async () => {
    await expect(
      pool.query(
        "INSERT INTO users(id,email,name,role) VALUES ($1,'invalid@example.com','Invalid','teacher')",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        "INSERT INTO classroom_memberships(class_id,user_id,role,status) VALUES ($1,$2,'student','approved')",
        [classId, studentId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query('UPDATE classes SET capacity=101 WHERE id=$1', [classId]),
    ).rejects.toMatchObject({ code: '23514' });
    const sessionId = randomUUID();
    await pool.query('INSERT INTO classroom_sessions(id,class_id,started_by) VALUES ($1,$2,$3)', [
      sessionId,
      classId,
      teacherId,
    ]);
    await expect(
      pool.query('INSERT INTO classroom_sessions(id,class_id,started_by) VALUES ($1,$2,$3)', [
        randomUUID(),
        classId,
        teacherId,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    await pool.query('DELETE FROM classroom_sessions WHERE id=$1', [sessionId]);
  });
});

describe('version seven account-free student storage', () => {
  async function guestClass(capacity = 40) {
    const id = randomUUID();
    await pool.query('INSERT INTO classes(id,teacher_id,name,capacity) VALUES ($1,$2,$3,$4)', [
      id,
      teacherId,
      'Guest classroom',
      capacity,
    ]);
    return id;
  }

  async function participant(classroom: string, number = '001') {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO classroom_participants(id,class_id,name,student_number,approved_by,approved_at)
       VALUES ($1,$2,'학생',$3,$4,now())`,
      [id, classroom, number, teacherId],
    );
    return id;
  }

  async function invitation(classroom: string) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO classroom_invitations(id,class_id,code_hash,issued_by,expires_at)
       VALUES ($1,$2,$3,$4,now()+interval '24 hours')`,
      [id, classroom, digest(randomUUID()), teacherId],
    );
    return id;
  }

  async function joinRequest(classroom: string, invite: string, target?: string) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO classroom_join_requests
       (id,class_id,invitation_id,name,student_number,kind,participant_id,expires_at)
       VALUES ($1,$2,$3,'학생','001',$4,$5,now()+interval '30 minutes')`,
      [id, classroom, invite, target ? 'recovery' : 'join', target ?? null],
    );
    return id;
  }

  it('upgrades v6 transactionally without creating guest accounts or silently importing a roster', async () => {
    const schema = `guest_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new Pool({ ...databaseConfig, options: `-c search_path=${schema}` });
    try {
      await migrate(isolated, 6);
      await isolated.query(
        "INSERT INTO users(id,email,name,role) VALUES ($1,'old@example.com','Existing','member')",
        [teacherId],
      );
      await isolated.query("INSERT INTO classes(id,teacher_id,name) VALUES ($1,$2,'Existing')", [
        classId,
        teacherId,
      ]);
      // A deterministic DDL collision must roll back the preceding policy update.
      await isolated.query('CREATE TABLE classroom_participants(collision integer)');
      await expect(migrate(isolated)).rejects.toMatchObject({ code: '42P07' });
      expect(
        (await isolated.query('SELECT approval_required FROM classes')).rows[0].approval_required,
      ).toBe(false);
      expect(
        (await isolated.query('SELECT max(version) AS version FROM schema_migrations')).rows[0]
          .version,
      ).toBe(6);
      await isolated.query('DROP TABLE classroom_participants');
      await migrate(isolated);
      await migrate(isolated);
      expect((await isolated.query('SELECT id,email FROM users')).rows).toEqual([
        { id: teacherId, email: 'old@example.com' },
      ]);
      expect(
        (await isolated.query('SELECT approval_required FROM classes')).rows[0].approval_required,
      ).toBe(true);
      for (const table of [
        'classroom_participants',
        'classroom_roster_entries',
        'classroom_join_requests',
      ]) {
        expect(
          (await isolated.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count,
        ).toBe(0);
      }
      await expect(
        isolated.query('UPDATE classes SET approval_required=false'),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await isolated.end();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  it('stores classroom-scoped students without users and preserves leading zeros and blocked identities', async () => {
    const a = await guestClass();
    const b = await guestClass();
    const before = (await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count;
    const first = await participant(a);
    await participant(b);
    await expect(participant(a)).rejects.toMatchObject({ code: '23505' });
    await participant(a, '1');
    await pool.query("UPDATE classroom_participants SET status='blocked' WHERE id=$1", [first]);
    await expect(participant(a)).rejects.toMatchObject({ code: '23505' });
    expect(
      (await pool.query('SELECT student_number FROM classroom_participants WHERE id=$1', [first]))
        .rows[0],
    ).toEqual({ student_number: '001' });
    expect((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count).toBe(
      before,
    );
    for (const [name, number] of [
      ['', '2'],
      ['Student', ' 2'],
      ['Student', '１２'],
      ['김', '2'],
      ['\tStudent', '2'],
      ['Student\u00a0', '2'],
      ['Student\ufeff', '2'],
    ]) {
      await expect(
        pool.query(
          `INSERT INTO classroom_roster_entries(id,class_id,name,student_number)
         VALUES ($1,$2,$3,$4)`,
          [randomUUID(), a, name, number],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('keeps matching roster entries and recovery requests pending without changing existing credentials', async () => {
    const classroom = await guestClass();
    const student = await participant(classroom);
    await pool.query(
      `INSERT INTO classroom_roster_entries(id,class_id,name,student_number)
       VALUES ($1,$2,'학생','001')`,
      [randomUUID(), classroom],
    );
    const invite = await invitation(classroom);
    const pending = await joinRequest(classroom, invite);
    const recovery = await joinRequest(classroom, invite, student);
    const hash = digest(randomUUID());
    await pool.query(
      `INSERT INTO student_participation_sessions
       (token_hash,class_id,participant_id,scope,generation,expires_at,idle_expires_at)
       VALUES ($1,$2,$3,'participant',1,now()+interval '12 hours',now()+interval '2 hours')`,
      [hash, classroom, student],
    );
    await joinRequest(classroom, invite, student);
    expect(
      (
        await pool.query('SELECT status FROM classroom_join_requests WHERE id=ANY($1::uuid[])', [
          [pending, recovery],
        ])
      ).rows,
    ).toEqual([{ status: 'pending' }, { status: 'pending' }]);
    expect(
      (
        await pool.query(
          'SELECT revoked_at,generation FROM student_participation_sessions WHERE token_hash=$1',
          [hash],
        )
      ).rows[0],
    ).toEqual({ revoked_at: null, generation: 1 });
    expect(
      (
        await pool.query('SELECT credential_generation FROM classroom_participants WHERE id=$1', [
          student,
        ])
      ).rows[0].credential_generation,
    ).toBe(1);
  });

  it('enforces request, credential and attendance classroom boundaries', async () => {
    const a = await guestClass();
    const b = await guestClass();
    const student = await participant(a);
    const invite = await invitation(a);
    const pending = await joinRequest(a, invite);
    await expect(joinRequest(b, invite)).rejects.toMatchObject({ code: '23503' });
    await expect(joinRequest(b, await invitation(b), student)).rejects.toMatchObject({
      code: '23503',
    });
    await expect(
      pool.query(
        `INSERT INTO student_participation_sessions
       (token_hash,class_id,request_id,scope,expires_at,idle_expires_at)
       VALUES ($1,$2,$3,'pending',now()+interval '30 minutes',now()+interval '30 minutes')`,
        [digest(randomUUID()), b, pending],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    const session = randomUUID();
    await pool.query('INSERT INTO classroom_sessions(id,class_id,started_by) VALUES ($1,$2,$3)', [
      session,
      b,
      teacherId,
    ]);
    await expect(
      pool.query(
        `INSERT INTO classroom_participant_attendance(session_id,class_id,participant_id)
       VALUES ($1,$2,$3)`,
        [session, b, student],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects invalid credential scopes, raw tokens and lifetime extensions at storage boundary', async () => {
    const classroom = await guestClass();
    const invite = await invitation(classroom);
    const pending = await joinRequest(classroom, invite);
    const insert = (hash: string, lifetime: string) =>
      pool.query(
        `INSERT INTO student_participation_sessions
       (token_hash,class_id,request_id,scope,expires_at,idle_expires_at)
       VALUES ($1,$2,$3,'pending',now()+$4::interval,now()+$4::interval)`,
        [hash, classroom, pending, lifetime],
      );
    await expect(insert('raw-secret', '30 minutes')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(digest(randomUUID()), '31 minutes')).rejects.toMatchObject({
      code: '23514',
    });
    const hash = digest(randomUUID());
    await insert(hash, '20 minutes');
    await expect(
      pool.query(
        "UPDATE student_participation_sessions SET expires_at=issued_at+interval '25 minutes' WHERE token_hash=$1",
        [hash],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      'UPDATE student_participation_sessions SET revoked_at=now() WHERE token_hash=$1',
      [hash],
    );
    await expect(
      pool.query('UPDATE student_participation_sessions SET revoked_at=NULL WHERE token_hash=$1', [
        hash,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const student = await participant(classroom);
    await expect(
      pool.query(
        `INSERT INTO student_participation_sessions
       (token_hash,class_id,participant_id,scope,generation,expires_at,idle_expires_at)
       VALUES ($1,$2,$3,'participant',1,now()+interval '13 hours',now()+interval '2 hours')`,
        [digest(randomUUID()), classroom, student],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO student_participation_sessions
       (token_hash,class_id,participant_id,scope,generation,expires_at,idle_expires_at)
       VALUES ($1,$2,$3,'participant',1,now()+interval '12 hours',now()+interval '3 hours')`,
        [digest(randomUUID()), classroom, student],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('shares capacity with preserved legacy students rather than granting extra seats to guest records', async () => {
    const classroom = randomUUID();
    await pool.query(
      'INSERT INTO classes(id,school_id,teacher_id,name,capacity) VALUES ($1,$2,$3,$4,1)',
      [classroom, schoolId, teacherId, 'Legacy and guest capacity'],
    );
    await pool.query('INSERT INTO class_members(class_id,student_id,school_id) VALUES ($1,$2,$3)', [
      classroom,
      studentId,
      schoolId,
    ]);
    await expect(participant(classroom)).rejects.toMatchObject({ code: '23514' });
    await pool.query('DELETE FROM class_members WHERE class_id=$1 AND student_id=$2', [
      classroom,
      studentId,
    ]);
    await participant(classroom);
    await expect(
      pool.query('INSERT INTO class_members(class_id,student_id,school_id) VALUES ($1,$2,$3)', [
        classroom,
        studentId,
        schoolId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query('UPDATE classes SET archived_at=now() WHERE id=$1', [classroom]);
  });

  it('serializes final-seat approvals and prevents capacity reduction below approved attendance', async () => {
    const classroom = await guestClass(1);
    const results = await Promise.allSettled([
      participant(classroom, '01'),
      participant(classroom, '02'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: '23514' } });
    const other = await guestClass(2);
    await participant(other, '01');
    await participant(other, '02');
    await expect(
      pool.query('UPDATE classes SET capacity=1 WHERE id=$1', [other]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('records guest audit actors without a dummy user and scopes connections to actual attendance', async () => {
    const classroom = await guestClass();
    const student = await participant(classroom);
    await pool.query(
      `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
       VALUES ($1,$2,'participant',$3,'participation.ended','success')`,
      [randomUUID(), classroom, student],
    );
    await expect(
      pool.query(
        `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,action,result)
       VALUES ($1,$2,'participant','participation.ended','success')`,
        [randomUUID(), classroom],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const session = randomUUID();
    await pool.query('INSERT INTO classroom_sessions(id,class_id,started_by) VALUES ($1,$2,$3)', [
      session,
      classroom,
      teacherId,
    ]);
    const connection = () =>
      pool.query(
        `INSERT INTO classroom_participant_connections
       (id,session_id,class_id,participant_id,credential_generation,lease_expires_at)
       VALUES ($1,$2,$3,$4,1,now()+interval '1 minute')`,
        [randomUUID(), session, classroom, student],
      );
    await expect(connection()).rejects.toMatchObject({ code: '23503' });
    await pool.query(
      `INSERT INTO classroom_participant_attendance(session_id,class_id,participant_id)
       VALUES ($1,$2,$3)`,
      [session, classroom, student],
    );
    await connection();
  });
});

describe('public email and password accounts', () => {
  const password = 'Correct horse battery staple 42';
  const email = () => `${randomUUID()}@example.net`;
  const register = (address = email(), extra: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/identity/auth/email/register')
      .send({
        email: address,
        password,
        displayName: 'Independent teacher',
        ...extra,
      });
  const login = (address: string, value = password) =>
    request(app).post('/api/identity/auth/email/login').send({ email: address, password: value });
  beforeEach(async () => {
    await pool.query('DELETE FROM identity_auth_budgets');
  });

  it('starts the real API entrypoint and completes registration over HTTP without Google or school setup', async () => {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const port = probe.address();
    if (!port || typeof port === 'string') throw new Error('Missing test port.');
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const url = new URL('postgresql://127.0.0.1/postgres');
    url.username = String(databaseConfig.user);
    url.password = String(databaseConfig.password);
    url.port = String(databaseConfig.port);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port.port),
      DATABASE_URL: url.toString(),
      GOOGLE_CLIENT_ID: '',
      APP_ORIGINS: origin,
      SERVE_WEB: 'false',
      CLARIO_SYNTHETIC_MEDIA: 'false',
      DOTENV_CONFIG_PATH: pathJoin(directory, 'no-env-file'),
    };
    delete env.CLARIO_DOCUMENTS_DIR;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url))],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    const base = `http://127.0.0.1:${port.port}`;
    try {
      for (let attempt = 0; attempt < 100 && !output.includes('CLARIO API listening'); attempt++) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error('Email-only API exited before startup.');
        await delay(100);
      }
      expect(output).toContain('CLARIO API listening');
      expect((await fetch(`${base}/ready`)).status).toBe(200);
      const config = await fetch(`${base}/api/auth/config`);
      expect(await config.json()).toEqual({ googleClientId: '', emailPassword: true });
      const registered = await fetch(`${base}/api/identity/auth/email/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ email: email(), password, displayName: 'HTTP teacher' }),
      });
      expect(registered.status).toBe(201);
      const session = await registered.json();
      const classrooms = await fetch(`${base}/api/identity/classrooms`, {
        headers: bearer(session.token),
      });
      expect(await classrooms.json()).toEqual({ classrooms: [] });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    }
  }, 30000);

  it('registers without Google, school or role grants, persists a salted hash and issues a scoped session', async () => {
    app = createApp({
      pool,
      origins: [origin],
      googleClientId: '',
      verifyGoogle: async () => {
        throw new Error('Google must not be called');
      },
    });
    expect((await request(app).get('/api/auth/config')).body).toEqual({
      googleClientId: '',
      emailPassword: true,
    });
    const address = email();
    const first = await register(address.toUpperCase(), {
      role: 'school_admin',
      schoolId,
      userId: adminId,
    }).expect(201);
    expect(first.body.user).toEqual({
      id: expect.any(String),
      email: address,
      name: 'Independent teacher',
    });
    expect(first.body.capabilities).toEqual({ canCreateClassroom: true });
    expect(first.body).not.toHaveProperty('password');
    expect(first.body.user).not.toHaveProperty('password_hash');
    const stored = (
      await pool.query('SELECT role,school_id,password_hash,google_sub FROM users WHERE id=$1', [
        first.body.user.id,
      ])
    ).rows[0];
    expect(stored).toMatchObject({ role: 'member', school_id: null, google_sub: null });
    expect(stored.password_hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(stored.password_hash).not.toContain(password);
    const second = await register().expect(201);
    const secondHash = (
      await pool.query('SELECT password_hash FROM users WHERE id=$1', [second.body.user.id])
    ).rows[0].password_hash;
    expect(secondHash).not.toBe(stored.password_hash);
    expect(
      (
        await pool.query('SELECT token_hash FROM auth_sessions WHERE user_id=$1', [
          first.body.user.id,
        ])
      ).rows,
    ).toEqual([{ token_hash: digest(first.body.token) }]);
    const classroom = await request(app)
      .post('/api/identity/classrooms')
      .set(bearer(first.body.token))
      .send({ name: 'My independent class', capacity: 40 })
      .expect(201);
    expect(classroom.body.invitation.code).toBeTruthy();
    await request(app)
      .get(`/api/identity/classrooms/${classroom.body.classroom.id}`)
      .set(bearer(second.body.token))
      .expect(404);
    await request(app).get('/api/users').set(bearer(first.body.token)).expect(403);
    await request(app).post('/api/identity/logout').set(bearer(first.body.token)).expect(204);
    await request(app).get('/api/identity/me').set(bearer(first.body.token)).expect(401);
    const returning = await login(address).expect(200);
    expect(returning.body.user).toEqual(first.body.user);
    expect(returning.body.token).not.toBe(first.body.token);
    await request(app).post('/api/identity/auth/google').send({}).expect(503);
    expect(
      (
        await pool.query('SELECT action FROM audit_logs WHERE actor_id=$1 ORDER BY id', [
          first.body.user.id,
        ])
      ).rows.map((row) => row.action),
    ).toEqual(
      expect.arrayContaining([
        'identity.email_registered',
        'identity.email_login',
        'identity.logout',
      ]),
    );
  });

  it('rejects wrong, unknown, disabled and expired accounts without exposing credentials', async () => {
    const address = email();
    const first = await register(address).expect(201);
    const wrong = await login(address, 'The wrong password 42').expect(401);
    const unknown = await login(email()).expect(401);
    expect(wrong.body).toEqual(unknown.body);
    await pool.query(
      "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
      [first.body.user.id],
    );
    await request(app).get('/api/identity/me').set(bearer(first.body.token)).expect(401);
    await pool.query('UPDATE users SET active=false WHERE id=$1', [first.body.user.id]);
    expect((await login(address).expect(401)).body).toEqual(wrong.body);
  });

  it('rejects invalid inputs, existing identities and concurrent registration without takeover or automatic linking', async () => {
    await register('invalid-address').expect(400);
    for (const value of ['short', 'x'.repeat(129), null]) {
      await register(email(), { password: value }).expect(400);
    }
    const address = email();
    const raced = await Promise.all([register(address), register(address)]);
    expect(raced.map((value) => value.status).sort()).toEqual([201, 409]);
    expect((await signIn(address)).response.status).toBe(409);
    const googleAddress = email();
    const google = await signIn(googleAddress);
    await register(googleAddress).expect(409);
    await login(googleAddress).expect(401);
    await register('teacher@legacy.example').expect(409);
    expect(
      (
        await pool.query('SELECT password_hash FROM users WHERE id=$1', [
          google.response.body.user.id,
        ])
      ).rows[0],
    ).toEqual({ password_hash: null });
    expect(
      (await pool.query('SELECT count(*)::integer AS count FROM users WHERE email=$1', [address]))
        .rows[0].count,
    ).toBe(1);
  });

  it('retains password whitespace exactly and rejects a hostile origin', async () => {
    const address = email();
    await request(app)
      .post('/api/identity/auth/email/register')
      .set('Origin', 'https://evil.example')
      .send({ email: address, password, displayName: 'Teacher' })
      .expect(403);
    await register(address, { password: ` ${password} ` }).expect(201);
    await login(address).expect(401);
    await login(address, ` ${password} `).expect(200);
  });

  it('shares durable attempt limits across app instances and allows retry after expiry', async () => {
    const address = email();
    const key = digest(`email:${address}`);
    await pool.query(
      "INSERT INTO identity_auth_budgets(key_hash,attempts,expires_at) VALUES($1,10,now()+interval '15 minutes')",
      [key],
    );
    await register(address).expect(429);
    const next = createApp({
      pool,
      origins: [origin],
      googleClientId: 'test-client',
      verifyGoogle: async () => {
        throw new Error('unused');
      },
    });
    await request(next)
      .post('/api/identity/auth/email/login')
      .send({ email: address, password })
      .expect(429);
    await pool.query(
      "UPDATE identity_auth_budgets SET expires_at=now()-interval '1 second' WHERE key_hash=$1",
      [key],
    );
    await register(address).expect(201);
  });
});

describe('independent Google identity API', () => {
  it('serves a complete login/read/logout flow over a real loopback HTTP listener', async () => {
    const listener = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('listening', resolve);
        listener.once('error', reject);
      });
      const address = listener.address();
      if (!address || typeof address === 'string') throw new Error('No runtime API port.');
      const base = `http://127.0.0.1:${address.port}/api`;
      const config = await fetch(`${base}/auth/config`);
      expect(config.status).toBe(200);
      expect(await config.json()).toEqual({ googleClientId: 'test-client', emailPassword: true });
      const challengeResponse = await fetch(`${base}/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const challenge = await challengeResponse.json();
      const credential = randomUUID();
      identities.set(credential, {
        sub: 'runtime-sub',
        email: 'runtime@example.com',
        domain: 'example.com',
        nonce: challenge.nonce,
      });
      const login = await fetch(`${base}/identity/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential,
          challengeId: challenge.challengeId,
          displayName: 'Runtime user',
        }),
      });
      expect(login.status).toBe(200);
      const session = await login.json();
      const headers = bearer(session.token);
      const me = await fetch(`${base}/identity/me`, { headers });
      expect(me.status).toBe(200);
      expect((await me.json()).user.email).toBe('runtime@example.com');
      const classrooms = await fetch(`${base}/identity/classrooms`, { headers });
      expect(classrooms.status).toBe(200);
      expect(await classrooms.json()).toEqual({ classrooms: [] });
      expect((await fetch(`${base}/identity/logout`, { method: 'POST', headers })).status).toBe(
        204,
      );
      expect((await fetch(`${base}/identity/me`, { headers })).status).toBe(401);
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('serializes concurrent first logins and allows a classroom behind one shared IP to sign in', async () => {
    const results = await Promise.all([
      signIn('racing@gmail.com', 'racing-sub'),
      signIn('racing@gmail.com', 'racing-sub'),
    ]);
    expect(results.map((result) => result.response.status)).toEqual([200, 200]);
    expect(results[0].response.body.user.id).toBe(results[1].response.body.user.id);
    for (let index = 0; index < 10; index++) {
      expect((await signIn('racing@gmail.com', 'racing-sub')).response.status).toBe(200);
    }
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM users WHERE google_sub='racing-sub'",
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it('registers a new principal without an organization, role grant or administrator approval', async () => {
    const { response, body } = await signIn('new@gmail.com', 'new-google-sub', {
      role: 'school_admin',
      schoolId,
      userId: adminId,
    });
    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({
      id: expect.any(String),
      email: 'new@gmail.com',
      name: 'Independent user',
    });
    expect(response.body.capabilities).toEqual({ canCreateClassroom: true });
    expect(response.body.user.role).toBeUndefined();
    const stored = (
      await pool.query('SELECT school_id,role,google_sub FROM users WHERE id=$1', [
        response.body.user.id,
      ])
    ).rows[0];
    expect(stored).toEqual({ school_id: null, role: 'member', google_sub: 'new-google-sub' });
    const session = await pool.query('SELECT token_hash FROM auth_sessions WHERE user_id=$1', [
      response.body.user.id,
    ]);
    expect(session.rows).toEqual([{ token_hash: digest(response.body.token) }]);
    const me = await request(app).get('/api/identity/me').set(bearer(response.body.token));
    expect(me.body.user).toEqual(response.body.user);
    const classes = await request(app)
      .get('/api/identity/classrooms')
      .set(bearer(response.body.token));
    expect(classes.body).toEqual({ classrooms: [] });
    expect((await request(app).get('/api/users').set(bearer(response.body.token))).status).toBe(
      403,
    );
    expect(
      (
        await request(app)
          .post('/api/classes')
          .set(bearer(response.body.token))
          .send({ name: 'Forged legacy class' })
      ).status,
    ).toBe(403);
    expect((await request(app).post('/api/identity/auth/google').send(body)).status).toBe(401);
    expect(
      (await request(app).post('/api/identity/logout').set(bearer(response.body.token))).status,
    ).toBe(204);
    expect(
      (await request(app).get('/api/identity/me').set(bearer(response.body.token))).status,
    ).toBe(401);
  });

  it('keeps a subject stable across email changes and rejects same-email identity takeover', async () => {
    const first = await signIn('stable@gmail.com', 'stable-sub');
    const changed = await signIn('renamed@gmail.com', 'stable-sub');
    expect(changed.response.status).toBe(200);
    expect(changed.response.body.user.id).toBe(first.response.body.user.id);
    expect(changed.response.body.user.email).toBe('renamed@gmail.com');
    const takeover = await signIn('renamed@gmail.com', 'different-sub');
    expect(takeover.response.status).toBe(409);
    expect(takeover.response.body.error.code).toBe('IDENTITY_CONFLICT');
    expect(
      (await pool.query('SELECT google_sub FROM users WHERE id=$1', [first.response.body.user.id]))
        .rows[0].google_sub,
    ).toBe('stable-sub');
  });

  it('refuses an email-only legacy account link until existing approval flow verifies the link', async () => {
    const unboundId = randomUUID();
    await pool.query(
      "INSERT INTO users(id,school_id,email,name,role) VALUES ($1,$2,'unbound@legacy.example','Unbound','student')",
      [unboundId, schoolId],
    );
    const result = await signIn('unbound@legacy.example', 'unbound-sub');
    expect(result.response.status).toBe(409);
    expect(result.response.body.error.code).toBe('LEGACY_LINK_REQUIRED');
    expect(
      (await pool.query('SELECT google_sub FROM users WHERE id=$1', [unboundId])).rows[0],
    ).toEqual({ google_sub: null });
  });

  it('preserves legacy classroom roles without exposing other students and honors current revocation', async () => {
    for (const [email, sub, expected] of [
      ['teacher@legacy.example', 'legacy-teacher', 'manager'],
      ['student@legacy.example', 'legacy-student', 'student'],
      ['school_admin@legacy.example', 'legacy-school_admin', 'manager'],
    ]) {
      const signed = await signIn(email, sub);
      expect(signed.response.status).toBe(200);
      const list = await request(app)
        .get('/api/identity/classrooms')
        .set(bearer(signed.response.body.token));
      expect(list.body.classrooms).toEqual([
        { id: classId, name: 'Preserved class', role: expected },
      ]);
      expect(JSON.stringify(list.body)).not.toContain('student@legacy.example');
    }
    const signed = await signIn('student@legacy.example', 'legacy-student');
    await pool.query('DELETE FROM class_members WHERE class_id=$1 AND student_id=$2', [
      classId,
      studentId,
    ]);
    expect(
      (await request(app).get('/api/identity/classrooms').set(bearer(signed.response.body.token)))
        .body.classrooms,
    ).toEqual([]);
    await pool.query('INSERT INTO class_members(class_id,student_id,school_id) VALUES ($1,$2,$3)', [
      classId,
      studentId,
      schoolId,
    ]);
  });

  it('supports a cross-workspace student membership without moving the user or granting management', async () => {
    const signed = await signIn('cross@gmail.com', 'cross-sub');
    const userId = signed.response.body.user.id;
    await pool.query(
      "INSERT INTO classroom_memberships(class_id,user_id,role,status) VALUES ($1,$2,'student','approved')",
      [classId, userId],
    );
    const list = await request(app)
      .get('/api/identity/classrooms')
      .set(bearer(signed.response.body.token));
    expect(list.body.classrooms).toEqual([
      { id: classId, name: 'Preserved class', role: 'student' },
    ]);
    expect(
      (await pool.query('SELECT school_id,role FROM users WHERE id=$1', [userId])).rows[0],
    ).toEqual({ school_id: null, role: 'member' });
    await pool.query(
      "UPDATE classroom_memberships SET status='blocked' WHERE class_id=$1 AND user_id=$2",
      [classId, userId],
    );
    expect(
      (await request(app).get('/api/identity/classrooms').set(bearer(signed.response.body.token)))
        .body.classrooms,
    ).toEqual([]);
  });

  it('rejects missing auth, expired sessions, stopped users, bad nonces and untrusted origins', async () => {
    expect((await request(app).get('/api/identity/me')).status).toBe(401);
    expect((await signIn('nonce@gmail.com', 'nonce-sub', {}, 'wrong')).response.status).toBe(401);
    const signed = await signIn('inactive@gmail.com', 'inactive-sub');
    await pool.query('UPDATE users SET active=false WHERE id=$1', [signed.response.body.user.id]);
    expect(
      (await request(app).get('/api/identity/me').set(bearer(signed.response.body.token))).status,
    ).toBe(401);
    expect((await signIn('inactive@gmail.com', 'inactive-sub')).response.status).toBe(403);
    const expired = await signIn('expired@gmail.com', 'expired-sub');
    await pool.query('UPDATE auth_sessions SET expires_at=now() WHERE token_hash=$1', [
      digest(expired.response.body.token),
    ]);
    expect(
      (await request(app).get('/api/identity/me').set(bearer(expired.response.body.token))).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/identity/auth/google')
          .set('Origin', 'https://untrusted.example')
          .send({})
      ).status,
    ).toBe(403);
  });
});
