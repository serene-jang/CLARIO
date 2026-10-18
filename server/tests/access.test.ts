import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/database.js';
import { digest } from '../src/access.js';
import type { GoogleIdentity } from '../src/identity.js';
import { bootstrapSchool } from '../src/bootstrap.js';

const origin = 'http://127.0.0.1:5173';
const schoolId = randomUUID();
const secondSchoolId = randomUUID();
const userIds = {
  admin: randomUUID(),
  teacher: randomUUID(),
  otherTeacher: randomUUID(),
  student: randomUUID(),
  otherStudent: randomUUID(),
  foreignTeacher: randomUUID(),
};
const tokens = Object.fromEntries(
  Object.keys(userIds).map((key) => [key, randomBytes(32).toString('base64url')]),
);
let pool: Pool;
let database: EmbeddedPostgres;
let directory: string;
let app: ReturnType<typeof createApp>;
let classId: string;
const identities = new Map<string, GoogleIdentity>();

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test port.');
      server.close(() => resolve(address.port));
    });
  });
  directory = await mkdtemp(join(tmpdir(), 'clario-phase2-'));
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
  pool = new Pool({ host: '127.0.0.1', port, user: 'clario', password, database: 'postgres' });
  await migrate(pool);
  await migrate(pool);
  await pool.query(
    `INSERT INTO schools(id,name,google_domain) VALUES
     ($1,'Test School','school.example'),($2,'Other School','other.example')`,
    [schoolId, secondSchoolId],
  );
  for (const [key, userId] of Object.entries(userIds)) {
    const role =
      key === 'admin'
        ? 'school_admin'
        : key.toLowerCase().includes('student')
          ? 'student'
          : 'teacher';
    const foreign = key === 'foreignTeacher';
    await pool.query(`INSERT INTO users(id,school_id,email,name,role) VALUES ($1,$2,$3,$4,$5)`, [
      userId,
      foreign ? secondSchoolId : schoolId,
      `${key.toLowerCase()}@${foreign ? 'other.example' : 'school.example'}`,
      key,
      role,
    ]);
    await pool.query(
      `INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')`,
      [digest(tokens[key]), userId],
    );
  }
  app = createApp({
    pool,
    origins: [origin],
    googleClientId: 'test-client.apps.googleusercontent.com',
    verifyGoogle: async (credential) => {
      const identity = identities.get(credential);
      if (!identity) throw new Error('Invalid signed token fixture.');
      return identity;
    },
  });
}, 90000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
  if (directory)
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 30000);

const auth = (key: keyof typeof userIds) => ({ Authorization: `Bearer ${tokens[key]}` });
describe('initial school registration', () => {
  it('registers and audits once, supports identical setup retry, and never overwrites roles', async () => {
    const input = {
      schoolName: 'Setup Test School',
      domain: 'setup.example',
      email: 'admin@setup.example',
      adminName: 'Setup Admin',
    };
    await bootstrapSchool(pool, input);
    await bootstrapSchool(pool, input, true);
    const registered = await pool.query(
      `SELECT s.id, u.role, u.active FROM schools s JOIN users u ON u.school_id=s.id
       WHERE s.google_domain=$1`,
      [input.domain],
    );
    expect(registered.rows).toHaveLength(1);
    expect(registered.rows[0]).toMatchObject({ role: 'school_admin', active: true });
    const logs = await pool.query(
      "SELECT id FROM audit_logs WHERE school_id=$1 AND action='school.bootstrapped'",
      [registered.rows[0].id],
    );
    expect(logs.rowCount).toBe(1);
    await expect(
      bootstrapSchool(pool, { ...input, adminName: 'Replacement' }, true),
    ).rejects.toThrow();
    await expect(bootstrapSchool(pool, input)).rejects.toThrow();
    await pool.query('UPDATE users SET active=false WHERE email=$1', [input.email]);
    await expect(bootstrapSchool(pool, input, true)).rejects.toThrow();
    const original = await pool.query('SELECT name,active FROM users WHERE email=$1', [
      input.email,
    ]);
    expect(original.rows[0]).toEqual({ name: input.adminName, active: false });
  });
});

async function signIn(email: string, domain = 'school.example', sub = email, badNonce = false) {
  const challenge = await request(app).post('/api/auth/challenge').send({});
  const credential = randomUUID();
  identities.set(credential, {
    sub,
    email,
    domain,
    nonce: badNonce ? 'not-the-challenge' : challenge.body.nonce,
  });
  return {
    response: await request(app).post('/api/auth/google').send({
      challengeId: challenge.body.challengeId,
      credential,
    }),
    challenge: challenge.body,
    credential,
  };
}

describe('Google school identity and sessions with real PostgreSQL', () => {
  it('keeps health available and explicitly refuses unconfigured authentication', async () => {
    expect((await request(createApp()).get('/health')).body).toEqual({ status: 'ok' });
    expect((await request(createApp()).get('/api/auth/config')).status).toBe(503);
  });
  it('requires authentication and rejects forged roles, cookies and invalid tokens', async () => {
    for (const path of ['/api/auth/me', '/api/classes', '/api/users', '/api/school']) {
      expect((await request(app).get(path).set('X-Role', 'school_admin')).status).toBe(401);
    }
    expect((await request(app).get('/api/classes').set('Cookie', 'role=school_admin')).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .get('/api/classes')
          .set('Authorization', `Bearer ${'a'.repeat(43)}`)
      ).status,
    ).toBe(401);
  });
  it('restricts CORS to explicit origins', async () => {
    const allowed = await request(app).options('/api/classes').set('Origin', origin);
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(origin);
    const denied = await request(app).get('/api/auth/config').set('Origin', 'https://evil.example');
    expect(denied.status).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('uses server-approved roles, stores only session hashes and prevents nonce reuse', async () => {
    const login = await signIn('teacher@school.example');
    expect(login.response.status).toBe(200);
    expect(login.response.body.user.role).toBe('teacher');
    expect(login.response.body.user.schoolId).toBe(schoolId);
    const token: string = login.response.body.token;
    const stored = await pool.query('SELECT token_hash FROM auth_sessions WHERE token_hash=$1', [
      digest(token),
    ]);
    expect(stored.rows[0].token_hash).not.toBe(token);
    expect(
      (
        await request(app).post('/api/auth/google').send({
          challengeId: login.challenge.challengeId,
          credential: login.credential,
          role: 'school_admin',
        })
      ).status,
    ).toBe(401);
    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(logout.status).toBe(204);
    expect(
      (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(401);
  });
  it('rejects unapproved accounts, mismatched subjects and nonce but does not trust email domains as workspace proof', async () => {
    expect((await signIn('unknown@school.example')).response.status).toBe(403);
    expect((await signIn('teacher@school.example', 'other.example')).response.status).toBe(200);
    expect(
      (await signIn('teacher@school.example', 'school.example', 'different-sub')).response.status,
    ).toBe(403);
    expect(
      (await signIn('student@school.example', 'school.example', 'student-sub', true)).response
        .status,
    ).toBe(401);
  });
  it('rejects invalid and expired authentication challenges and invalid Google credentials', async () => {
    const challenge = await request(app).post('/api/auth/challenge').send({});
    expect(
      (
        await request(app).post('/api/auth/google').send({
          challengeId: challenge.body.challengeId,
          credential: 'not-valid',
        })
      ).status,
    ).toBe(401);
    const expired = await request(app).post('/api/auth/challenge').send({});
    await pool.query(
      "UPDATE auth_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.body.challengeId],
    );
    expect(
      (
        await request(app).post('/api/auth/google').send({
          challengeId: expired.body.challengeId,
          credential: 'not-valid',
        })
      ).status,
    ).toBe(401);
  });
  it('expires sessions and cannot extend them with client-supplied data', async () => {
    const login = await signIn('student@school.example', 'school.example', 'student-sub');
    expect(login.response.status).toBe(200);
    await pool.query(
      "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [digest(login.response.body.token)],
    );
    const expired = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.response.body.token}`);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('SESSION_EXPIRED');
  });
});

describe('public Google workspace signup', () => {
  async function register(email: string, workspaceName: string, ownerName: string, sub = email) {
    const challenge = await request(app).post('/api/auth/challenge').send({});
    const credential = randomUUID();
    identities.set(credential, {
      sub,
      email,
      domain: email.split('@')[1],
      nonce: challenge.body.nonce,
    });
    return request(app).post('/api/auth/register').send({
      challengeId: challenge.body.challengeId,
      credential,
      workspaceName,
      ownerName,
    });
  }
  it('lets a verified consumer Google identity create an isolated administrator workspace', async () => {
    const result = await register('creator@gmail.com', 'Independent Classroom', 'Creator');
    expect(result.status).toBe(201);
    expect(result.body.user).toMatchObject({
      email: 'creator@gmail.com',
      name: 'Creator',
      role: 'school_admin',
    });
    const stored = await pool.query(
      `SELECT s.name,s.google_domain,u.google_sub,u.role,a.token_hash
       FROM schools s JOIN users u ON u.school_id=s.id
       JOIN auth_sessions a ON a.user_id=u.id WHERE u.email=$1`,
      ['creator@gmail.com'],
    );
    expect(stored.rows[0]).toMatchObject({
      name: 'Independent Classroom',
      google_domain: 'gmail.com',
      google_sub: 'creator@gmail.com',
      role: 'school_admin',
      token_hash: digest(result.body.token),
    });
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${result.body.token}`);
    expect(me.body.user.id).toBe(result.body.user.id);
    const auditResult = await pool.query('SELECT action FROM audit_logs WHERE school_id=$1', [
      result.body.user.schoolId,
    ]);
    expect(auditResult.rows.map((row) => row.action)).toEqual(['workspace.created']);
    const secondConsumerWorkspace = await register(
      'another@gmail.com',
      'Another Independent Classroom',
      'Another Creator',
    );
    expect(secondConsumerWorkspace.status).toBe(201);
  });
  it('rejects reused and expired challenges, duplicate accounts, invalid names and replayed Google subjects', async () => {
    expect((await register('creator@gmail.com', 'Another Workspace', 'Creator')).status).toBe(409);
    expect((await register('teacher@school.example', '', 'Owner')).status).toBe(400);
    expect(
      (await register('teacher@school.example', 'Different Person', 'Owner', 'teacher-sub')).status,
    ).toBe(409);
    const challenge = await request(app).post('/api/auth/challenge').send({});
    await pool.query(
      "UPDATE auth_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
      [challenge.body.challengeId],
    );
    expect(
      (
        await request(app).post('/api/auth/register').send({
          challengeId: challenge.body.challengeId,
          credential: 'unused',
          workspaceName: 'Expired',
          ownerName: 'Owner',
        })
      ).status,
    ).toBe(401);
    const challengeReuse = await register(
      'newuser@outlook.com',
      'New Workspace',
      'New User',
      'new-user-sub',
    );
    expect(challengeReuse.status).toBe(201);
  });
});

describe('school approval and classroom authorization', () => {
  it('allows only workspace administrators to invite any email, without privilege escalation', async () => {
    const body = {
      email: 'new@school.example',
      name: 'New Student',
      role: 'student',
      schoolId: secondSchoolId,
    };
    expect((await request(app).post('/api/users').set(auth('teacher')).send(body)).status).toBe(
      403,
    );
    expect(
      (
        await request(app)
          .post('/api/users')
          .set(auth('admin'))
          .send({ ...body, role: 'school_admin' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/users')
          .set(auth('admin'))
          .send({ ...body, email: 'new@other.example' })
      ).status,
    ).toBe(201);
    expect((await request(app).post('/api/users').set(auth('admin')).send(body)).status).toBe(201);
    expect((await request(app).post('/api/users').set(auth('admin')).send(body)).status).toBe(409);
    const created = await pool.query('SELECT school_id FROM users WHERE email=$1', [body.email]);
    expect(created.rows[0].school_id).toBe(schoolId);
    const users = await request(app).get('/api/users').set(auth('admin'));
    expect(
      users.body.users.some((user: { email: string }) => user.email === 'new@other.example'),
    ).toBe(true);
    expect(
      users.body.users.some((user: { email: string }) => user.email.startsWith('foreignTeacher')),
    ).toBe(false);
    expect((await request(app).get('/api/users').set(auth('student'))).status).toBe(403);
  });
  it('creates classes with server-side ownership, ignoring school and teacher impersonation', async () => {
    expect(
      (await request(app).post('/api/classes').set(auth('student')).send({ name: 'No' })).status,
    ).toBe(403);
    const result = await request(app).post('/api/classes').set(auth('teacher')).send({
      name: 'Class A',
      teacherId: userIds.otherTeacher,
      schoolId: secondSchoolId,
    });
    expect(result.status).toBe(201);
    classId = result.body.id;
    const stored = await pool.query('SELECT teacher_id,school_id FROM classes WHERE id=$1', [
      classId,
    ]);
    expect(stored.rows[0]).toEqual({ teacher_id: userIds.teacher, school_id: schoolId });
  });
  it('isolates teacher, student and other-school class lists and member endpoints', async () => {
    const own = await request(app).get('/api/classes').set(auth('teacher'));
    expect(own.body.classes.map((item: { id: string }) => item.id)).toEqual([classId]);
    for (const key of ['otherTeacher', 'foreignTeacher', 'student'] as const) {
      const result = await request(app).get('/api/classes').set(auth(key));
      expect(result.body.classes).toEqual([]);
      expect(
        (await request(app).get(`/api/classes/${classId}/members`).set(auth(key))).status,
      ).toBe(key === 'student' ? 403 : 404);
    }
    expect(
      (
        await request(app)
          .patch(`/api/classes/${classId}`)
          .set(auth('otherTeacher'))
          .send({ name: 'Stolen' })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/classes/${classId}`).set(auth('foreignTeacher'))).status,
    ).toBe(404);
  });
  it('registers only approved same-school students and handles duplicate enrollment', async () => {
    const endpoint = `/api/classes/${classId}/members`;
    for (const email of [
      'unknown@school.example',
      'teacher@school.example',
      'foreignteacher@other.example',
    ]) {
      expect((await request(app).post(endpoint).set(auth('teacher')).send({ email })).status).toBe(
        404,
      );
    }
    expect(
      (
        await request(app)
          .post(endpoint)
          .set(auth('student'))
          .send({ email: 'student@school.example' })
      ).status,
    ).toBe(403);
    for (let index = 0; index < 2; index++) {
      expect(
        (
          await request(app)
            .post(endpoint)
            .set(auth('teacher'))
            .send({ email: 'student@school.example' })
        ).status,
      ).toBe(204);
    }
    const members = await request(app).get(endpoint).set(auth('teacher'));
    expect(members.body.members.map((member: { id: string }) => member.id)).toEqual([
      userIds.student,
    ]);
    const studentClasses = await request(app).get('/api/classes').set(auth('student'));
    expect(studentClasses.body.classes.map((item: { id: string }) => item.id)).toEqual([classId]);
    expect((await request(app).get('/api/classes').set(auth('otherStudent'))).body.classes).toEqual(
      [],
    );
    expect((await request(app).get(endpoint).set(auth('student'))).status).toBe(403);
  });
  it('renames and archives classes, and removes students without deleting their accounts', async () => {
    expect(
      (
        await request(app)
          .patch(`/api/classes/${classId}`)
          .set(auth('teacher'))
          .send({ name: 'Renamed' })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .delete(`/api/classes/${classId}/members/${userIds.student}`)
          .set(auth('teacher'))
      ).status,
    ).toBe(204);
    expect((await request(app).get('/api/classes').set(auth('student'))).body.classes).toEqual([]);
    expect((await request(app).get('/api/auth/me').set(auth('student'))).status).toBe(200);
    expect((await request(app).delete(`/api/classes/${classId}`).set(auth('teacher'))).status).toBe(
      204,
    );
    expect((await request(app).get('/api/classes').set(auth('teacher'))).body.classes).toEqual([]);
    expect(
      (await request(app).get(`/api/classes/${classId}/members`).set(auth('teacher'))).status,
    ).toBe(404);
  });
  it('revokes all sessions on role changes and suspension, and rejects cross-school management', async () => {
    const endpoint = `/api/users/${userIds.otherTeacher}`;
    expect(
      (
        await request(app)
          .patch(`/api/users/${userIds.foreignTeacher}`)
          .set(auth('admin'))
          .send({ role: 'student', active: false })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`/api/users/${userIds.admin}`)
          .set(auth('admin'))
          .send({ role: 'teacher', active: false })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(endpoint)
          .set(auth('admin'))
          .send({ role: 'student', active: false })
      ).status,
    ).toBe(204);
    expect((await request(app).get('/api/auth/me').set(auth('otherTeacher'))).status).toBe(401);
    expect((await signIn('otherteacher@school.example')).response.status).toBe(403);
  });
  it('validates malformed JSON, identifier and field boundaries without SQL interpolation', async () => {
    expect(
      (await request(app).get('/api/classes/not-a-uuid/members').set(auth('teacher'))).status,
    ).toBe(400);
    expect(
      (await request(app).post('/api/classes').set(auth('teacher')).send({ name: ' ' })).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/classes')
          .set(auth('teacher'))
          .send({ name: 'x'.repeat(101) })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/classes')
          .set(auth('teacher'))
          .set('Content-Type', 'application/json')
          .send('{')
      ).status,
    ).toBe(400);
    expect((await request(app).get('/api/no-such-route').set(auth('teacher'))).status).toBe(404);
    const injection = await request(app)
      .post('/api/classes')
      .set(auth('teacher'))
      .send({ name: "'; DROP TABLE users; --" });
    expect(injection.status).toBe(201);
    expect((await pool.query('SELECT count(*) FROM users')).rows[0].count).not.toBe('0');
  });
  it('persists identity data across API instances and records management actions without credentials', async () => {
    const otherInstance = createApp({
      pool,
      origins: [origin],
      googleClientId: 'test',
      verifyGoogle: async () => {
        throw new Error('Not used');
      },
    });
    expect(
      (await request(otherInstance).get('/api/auth/me').set(auth('teacher'))).body.user.id,
    ).toBe(userIds.teacher);
    const logs = await pool.query('SELECT action,result FROM audit_logs');
    for (const action of [
      'login',
      'logout',
      'user.invited',
      'class.created',
      'class.student_added',
      'class.archived',
      'user.permissions_changed',
    ]) {
      expect(logs.rows.some((row: { action: string }) => row.action === action)).toBe(true);
    }
    const serialized = JSON.stringify(logs.rows);
    expect(serialized).not.toContain(tokens.teacher);
    expect(serialized).not.toContain('credential');
  });
});

describe('student device inventory', () => {
  let endpoint: string;
  let deviceClassId: string;
  let deviceId: string;
  beforeAll(async () => {
    const result = await request(app)
      .post('/api/classes')
      .set(auth('teacher'))
      .send({ name: 'Device class' });
    expect(result.status).toBe(201);
    deviceClassId = result.body.id;
    endpoint = `/api/classes/${deviceClassId}/devices`;
    expect(
      (
        await request(app)
          .post(`/api/classes/${deviceClassId}/members`)
          .set(auth('teacher'))
          .send({ email: 'student@school.example' })
      ).status,
    ).toBe(204);
  });
  const registration = () => ({
    studentId: userIds.student,
    name: 'Chromebook 01',
    assetNumber: 'CB-001',
    schoolId: secondSchoolId,
    connectionState: 'connected',
  });
  it('stores a school-scoped inventory without claiming device authentication or online status', async () => {
    const result = await request(app).post(endpoint).set(auth('teacher')).send(registration());
    expect(result.status).toBe(201);
    deviceId = result.body.id;
    const stored = await pool.query(
      'SELECT school_id,asset_number FROM registered_devices WHERE id=$1',
      [deviceId],
    );
    expect(stored.rows[0]).toEqual({ school_id: schoolId, asset_number: 'CB-001' });
    const otherInstance = createApp({
      pool,
      origins: [origin],
      googleClientId: 'test',
      verifyGoogle: async () => {
        throw new Error('Not used');
      },
    });
    const list = await request(otherInstance).get(endpoint).set(auth('admin'));
    expect(list.body.devices).toEqual([
      {
        id: deviceId,
        studentId: userIds.student,
        studentName: 'student',
        name: 'Chromebook 01',
        assetNumber: 'CB-001',
        connectionState: 'unknown',
        lastSeenAt: null,
        screenViewingSupport: 'unverified',
        recordingSupport: 'unverified',
      },
    ]);
  });
  it('rejects duplicates case-insensitively, invalid fields and students outside the class', async () => {
    expect(
      (
        await request(app)
          .post(endpoint)
          .set(auth('teacher'))
          .send({ ...registration(), assetNumber: ' cb-001 ' })
      ).status,
    ).toBe(409);
    for (const body of [
      { ...registration(), name: ' ' },
      { ...registration(), assetNumber: 'x'.repeat(101) },
      { ...registration(), studentId: 'invalid' },
    ]) {
      expect((await request(app).post(endpoint).set(auth('teacher')).send(body)).status).toBe(400);
    }
    for (const studentId of [userIds.otherStudent, userIds.teacher, userIds.foreignTeacher]) {
      expect(
        (
          await request(app)
            .post(endpoint)
            .set(auth('teacher'))
            .send({ ...registration(), studentId, assetNumber: randomUUID() })
        ).status,
      ).toBe(404);
    }
  });
  it('blocks unauthenticated, student, other-teacher and other-school access', async () => {
    expect((await request(app).get(endpoint)).status).toBe(401);
    const teacherId = randomUUID();
    const otherToken = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO users(id,school_id,email,name,role) VALUES ($1,$2,'device-teacher@school.example','Device Teacher','teacher')`,
      [teacherId, schoolId],
    );
    await pool.query(
      `INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')`,
      [digest(otherToken), teacherId],
    );
    for (const [headers, status] of [
      [auth('student'), 403],
      [auth('foreignTeacher'), 404],
      [{ Authorization: `Bearer ${otherToken}` }, 404],
    ] as const) {
      expect((await request(app).get(endpoint).set(headers)).status).toBe(status);
      expect((await request(app).post(endpoint).set(headers).send(registration())).status).toBe(
        status,
      );
      expect((await request(app).delete(`${endpoint}/${deviceId}`).set(headers)).status).toBe(
        status,
      );
    }
  });
  it('allows scoped removal, audits actions and cleans up inventory on membership removal', async () => {
    const anotherClass = await request(app)
      .post('/api/classes')
      .set(auth('teacher'))
      .send({ name: 'Other device class' });
    expect(
      (
        await request(app)
          .delete(`/api/classes/${anotherClass.body.id}/devices/${deviceId}`)
          .set(auth('admin'))
      ).status,
    ).toBe(404);
    expect((await request(app).delete(`${endpoint}/${deviceId}`).set(auth('admin'))).status).toBe(
      204,
    );
    expect((await request(app).delete(`${endpoint}/${deviceId}`).set(auth('admin'))).status).toBe(
      404,
    );
    const second = await request(app).post(endpoint).set(auth('admin')).send(registration());
    expect(second.status).toBe(201);
    expect(
      (
        await request(app)
          .delete(`/api/classes/${deviceClassId}/members/${userIds.student}`)
          .set(auth('teacher'))
      ).status,
    ).toBe(204);
    expect((await request(app).get(endpoint).set(auth('teacher'))).body.devices).toEqual([]);
    const logs = await pool.query('SELECT action FROM audit_logs WHERE target_id=$1 ORDER BY id', [
      second.body.id,
    ]);
    expect(logs.rows.map((row) => row.action)).toEqual([
      'device.registered',
      'device.unregistered',
    ]);
    await migrate(pool);
    expect(
      (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows,
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
  });
  it('releases asset numbers and audits inventory removal when a classroom is archived', async () => {
    await request(app)
      .post(`/api/classes/${deviceClassId}/members`)
      .set(auth('teacher'))
      .send({ email: 'student@school.example' })
      .expect(204);
    const created = await request(app)
      .post(endpoint)
      .set(auth('teacher'))
      .send(registration())
      .expect(201);
    await request(app).delete(`/api/classes/${deviceClassId}`).set(auth('teacher')).expect(204);
    expect(
      (await pool.query('SELECT id FROM registered_devices WHERE id=$1', [created.body.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(`SELECT action FROM audit_logs WHERE target_id=$1 ORDER BY id`, [
          created.body.id,
        ])
      ).rows,
    ).toEqual([{ action: 'device.registered' }, { action: 'device.unregistered' }]);
    await request(app).post(endpoint).set(auth('teacher')).send(registration()).expect(404);
  });
});

describe('device pairing, presence and classroom material delivery', () => {
  let classroom: string;
  let device: string;
  let deviceToken: string;
  let material: string;
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
  beforeAll(async () => {
    const result = await request(app)
      .post('/api/classes')
      .set(auth('teacher'))
      .send({ name: 'Connected classroom' })
      .expect(201);
    classroom = result.body.id;
    await request(app)
      .post(`/api/classes/${classroom}/members`)
      .set(auth('teacher'))
      .send({ email: 'student@school.example' })
      .expect(204);
    const registration = await request(app)
      .post(`/api/classes/${classroom}/devices`)
      .set(auth('teacher'))
      .send({
        studentId: userIds.student,
        name: 'Connected Chromebook',
        assetNumber: 'CONNECTED-01',
      })
      .expect(201);
    device = registration.body.id;
  });
  const deviceHeaders = () => ({ Authorization: `Bearer ${deviceToken}`, Origin: extensionOrigin });
  const classPath = () => `/api/classes/${classroom}`;
  const pair = async () => {
    const result = await request(app)
      .post(`${classPath()}/devices/${device}/pairing`)
      .set(auth('teacher'))
      .send({})
      .expect(200);
    const paired = await request(app)
      .post('/api/device/pair')
      .set('Origin', extensionOrigin)
      .send({ code: result.body.code })
      .expect(200);
    deviceToken = paired.body.token;
    return result.body.code;
  };
  it('issues hashed expiring single-use codes and separate hashed device credentials', async () => {
    const code = await pair();
    expect(code).toHaveLength(32);
    expect(deviceToken).toHaveLength(43);
    await request(app).post('/api/device/pair').send({ code }).expect(401);
    await request(app).get('/api/classes').set(deviceHeaders()).expect(403);
    await request(app)
      .get('/api/classes')
      .set('Authorization', `Bearer ${deviceToken}`)
      .expect(401);
    await request(app).post('/api/device/sync').set(auth('teacher')).send({}).expect(401);
    const stored = await pool.query('SELECT credential_hash FROM registered_devices WHERE id=$1', [
      device,
    ]);
    expect(stored.rows[0].credential_hash).toBe(digest(deviceToken));
    expect(JSON.stringify((await pool.query('SELECT * FROM audit_logs')).rows)).not.toContain(
      deviceToken,
    );
  });
  it('rejects expired codes and prevents unauthorized pairing and revocation', async () => {
    for (const role of ['student', 'foreignTeacher'] as const) {
      const status = role === 'student' ? 403 : 404;
      await request(app)
        .post(`${classPath()}/devices/${device}/pairing`)
        .set(auth(role))
        .send({})
        .expect(status);
      await request(app)
        .delete(`${classPath()}/devices/${device}/connection`)
        .set(auth(role))
        .expect(status);
    }
    const result = await request(app)
      .post(`${classPath()}/devices/${device}/pairing`)
      .set(auth('teacher'))
      .send({})
      .expect(200);
    await pool.query(
      `UPDATE device_pairings SET expires_at=now()-interval '1 second' WHERE device_id=$1`,
      [device],
    );
    await request(app).post('/api/device/pair').send({ code: result.body.code }).expect(401);
    await pair();
  });
  it('derives online status from server heartbeat and expires offline after 90 seconds', async () => {
    await request(app)
      .post('/api/device/sync')
      .set(deviceHeaders())
      .send({ lastSeenAt: '2099-01-01' })
      .expect(200);
    let list = await request(app).get(`${classPath()}/devices`).set(auth('teacher')).expect(200);
    expect(list.body.devices[0].connectionState).toBe('connected');
    expect(Date.parse(list.body.devices[0].lastSeenAt)).toBeLessThan(Date.now() + 1000);
    await pool.query(
      `UPDATE registered_devices SET last_seen_at=now()-interval '91 seconds' WHERE id=$1`,
      [device],
    );
    list = await request(app).get(`${classPath()}/devices`).set(auth('teacher')).expect(200);
    expect(list.body.devices[0].connectionState).toBe('disconnected');
  });
  it('validates URLs and classroom permissions before queueing materials', async () => {
    for (const url of [
      'javascript:alert(1)',
      'http://example.com',
      'https://user:pass@example.com',
      'bad',
    ]) {
      await request(app)
        .post(`${classPath()}/materials`)
        .set(auth('teacher'))
        .send({ title: 'Test', url })
        .expect(400);
    }
    for (const role of ['student', 'foreignTeacher'] as const) {
      await request(app)
        .post(`${classPath()}/materials`)
        .set(auth(role))
        .send({ title: 'Test', url: 'https://example.com' })
        .expect(role === 'student' ? 403 : 404);
    }
    const result = await request(app)
      .post(`${classPath()}/materials`)
      .set(auth('teacher'))
      .send({ title: 'Lesson', url: 'https://example.com/lesson' })
      .expect(201);
    material = result.body.id;
    const list = await request(app)
      .get(`${classPath()}/materials`)
      .set(auth('teacher'))
      .expect(200);
    expect(list.body.materials[0].deliveries).toEqual([
      { deviceId: device, receivedAt: null, openedAt: null },
    ]);
  });
  it('authorizes voluntary focus settings and delivers notices without device control', async () => {
    await request(app)
      .patch(`${classPath()}/focus`)
      .set(auth('student'))
      .send({ enabled: true })
      .expect(403);
    await request(app)
      .patch(`${classPath()}/focus`)
      .set(auth('foreignTeacher'))
      .send({ enabled: true })
      .expect(404);
    await request(app)
      .patch(`${classPath()}/focus`)
      .set(auth('teacher'))
      .send({ enabled: 'true' })
      .expect(400);
    for (const enabled of [true, false]) {
      await request(app)
        .patch(`${classPath()}/focus`)
        .set(auth('teacher'))
        .send({ enabled })
        .expect(204);
      expect(
        (await request(app).get(`${classPath()}/focus`).set(auth('teacher')).expect(200)).body
          .enabled,
      ).toBe(enabled);
      expect(
        (await request(app).post('/api/device/sync').set(deviceHeaders()).send({}).expect(200)).body
          .focusMode,
      ).toBe(enabled);
    }
  });
  it('redelivers pending materials, records acknowledgments idempotently, and isolates recipients', async () => {
    const result = await request(app)
      .post('/api/device/sync')
      .set(deviceHeaders())
      .send({})
      .expect(200);
    expect(result.body.materials[0].id).toBe(material);
    for (let index = 0; index < 2; index++) {
      await request(app)
        .post(`/api/device/materials/${material}/ack`)
        .set(deviceHeaders())
        .send({ action: 'received' })
        .expect(204);
    }
    await request(app)
      .post(`/api/device/materials/${randomUUID()}/ack`)
      .set(deviceHeaders())
      .send({ action: 'opened' })
      .expect(404);
    const anotherClass = await request(app)
      .post('/api/classes')
      .set(auth('teacher'))
      .send({ name: 'Isolated material class' })
      .expect(201);
    const anotherPath = `/api/classes/${anotherClass.body.id}`;
    await request(app)
      .post(`${anotherPath}/members`)
      .set(auth('teacher'))
      .send({ email: 'student@school.example' })
      .expect(204);
    const otherDevice = await request(app)
      .post(`${anotherPath}/devices`)
      .set(auth('teacher'))
      .send({ studentId: userIds.student, name: 'Other device', assetNumber: 'ISOLATED-01' })
      .expect(201);
    const pairing = await request(app)
      .post(`${anotherPath}/devices/${otherDevice.body.id}/pairing`)
      .set(auth('teacher'))
      .send({})
      .expect(200);
    const paired = await request(app)
      .post('/api/device/pair')
      .send({ code: pairing.body.code })
      .expect(200);
    expect(
      (
        await request(app)
          .post('/api/device/sync')
          .set('Authorization', `Bearer ${paired.body.token}`)
          .send({})
          .expect(200)
      ).body.materials,
    ).toEqual([]);
    await request(app)
      .post(`/api/device/materials/${material}/ack`)
      .set('Authorization', `Bearer ${paired.body.token}`)
      .send({ action: 'opened' })
      .expect(404);
    await request(app)
      .post(`/api/device/materials/${material}/ack`)
      .set(deviceHeaders())
      .send({ action: 'fake' })
      .expect(400);
    await request(app)
      .post(`/api/device/materials/${material}/ack`)
      .set(deviceHeaders())
      .send({ action: 'opened' })
      .expect(204);
    const list = await request(app)
      .get(`${classPath()}/materials`)
      .set(auth('teacher'))
      .expect(200);
    expect(list.body.materials[0].deliveries[0].receivedAt).toBeTruthy();
    expect(list.body.materials[0].deliveries[0].openedAt).toBeTruthy();
    await pool.query(
      `UPDATE class_materials SET expires_at=now()-interval '1 second' WHERE id=$1`,
      [material],
    );
    expect(
      (await request(app).post('/api/device/sync').set(deviceHeaders()).send({}).expect(200)).body
        .materials,
    ).toEqual([]);
    await request(app)
      .post(`/api/device/materials/${material}/ack`)
      .set(deviceHeaders())
      .send({ action: 'opened' })
      .expect(404);
    await request(app)
      .delete(`${classPath()}/materials/${material}`)
      .set(auth('admin'))
      .expect(204);
  });
  it('revokes old credentials on new pairing and blocks suspended students and archived classes', async () => {
    const oldToken = deviceToken;
    await pair();
    await request(app)
      .post('/api/device/sync')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({})
      .expect(401);
    await pool.query('UPDATE users SET active=false WHERE id=$1', [userIds.student]);
    await request(app).post('/api/device/sync').set(deviceHeaders()).send({}).expect(401);
    await pool.query('UPDATE users SET active=true WHERE id=$1', [userIds.student]);
    await request(app).post('/api/device/sync').set(deviceHeaders()).send({}).expect(200);
    await request(app)
      .delete(`${classPath()}/devices/${device}/connection`)
      .set(auth('teacher'))
      .expect(204);
    await request(app).post('/api/device/sync').set(deviceHeaders()).send({}).expect(401);
    await pair();
    await request(app).post('/api/device/disconnect').set(deviceHeaders()).send({}).expect(204);
    await request(app).post('/api/device/sync').set(deviceHeaders()).send({}).expect(401);
    await pair();
    await request(app).delete(`/api/classes/${classroom}`).set(auth('teacher')).expect(204);
    await request(app).post('/api/device/sync').set(deviceHeaders()).send({}).expect(401);
  });
  it('permanently revokes device credentials when account permissions are changed', async () => {
    const result = await request(app)
      .post('/api/classes')
      .set(auth('teacher'))
      .send({ name: 'Revocation test' })
      .expect(201);
    const path = `/api/classes/${result.body.id}`;
    await request(app)
      .post(`${path}/members`)
      .set(auth('teacher'))
      .send({ email: 'otherstudent@school.example' })
      .expect(204);
    const registration = await request(app)
      .post(`${path}/devices`)
      .set(auth('teacher'))
      .send({
        studentId: userIds.otherStudent,
        name: 'Revoke test device',
        assetNumber: 'REVOKE-01',
      })
      .expect(201);
    const code = await request(app)
      .post(`${path}/devices/${registration.body.id}/pairing`)
      .set(auth('teacher'))
      .send({})
      .expect(200);
    const paired = await request(app)
      .post('/api/device/pair')
      .send({ code: code.body.code })
      .expect(200);
    await request(app)
      .patch(`/api/users/${userIds.otherStudent}`)
      .set(auth('admin'))
      .send({ role: 'student', active: false })
      .expect(204);
    await request(app)
      .patch(`/api/users/${userIds.otherStudent}`)
      .set(auth('admin'))
      .send({ role: 'student', active: true })
      .expect(204);
    await request(app)
      .post('/api/device/sync')
      .set('Authorization', `Bearer ${paired.body.token}`)
      .send({})
      .expect(401);
  });
});
