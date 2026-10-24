import { randomBytes, randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { CurrentUser, UserRole } from '@clario/shared';
import type { VerifyGoogle } from './identity.js';
import { verifyGoogleLogin } from './identity.js';
import { ApiError, fail, digest, id, text, emailAddress, transaction } from './api-core.js';
import { identityRouter } from './identity-access.js';
import { studentRouter } from './student-access.js';
import { stopClassroom } from './classroom-management.js';
import { materialUrl } from './material-url.js';
import { browserDeviceRouter, blockingSnapshot } from './site-blocking.js';
export { digest, emailAddress } from './api-core.js';

export interface AccessOptions {
  documents?: import('./classroom-documents.js').DocumentStore;
  syntheticMedia?: import('./synthetic-media.js').SyntheticMedia;
  pool: Pool;
  googleClientId: string;
  origins: string[];
  verifyGoogle: VerifyGoogle;
}

async function audit(
  client: Pool | PoolClient,
  actor: CurrentUser,
  action: string,
  targetId: string,
) {
  await client.query(
    `INSERT INTO audit_logs(school_id,actor_id,action,target_id,result)
     VALUES ($1,$2,$3,$4,'success')`,
    [actor.schoolId, actor.id, action, targetId],
  );
}

export function accessRouter(options: AccessOptions) {
  const { pool } = options;
  const router = express.Router();
  router.use((_request, response, next) => {
    response.locals.pool = pool;
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use((request, response, next) => {
    const origin = request.get('origin');
    const deviceExtension =
      (request.path.startsWith('/device/') || request.path.startsWith('/browser-device/')) &&
      origin !== undefined &&
      /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    if (origin && !options.origins.includes(origin) && !deviceExtension) {
      next(new ApiError(403, 'ORIGIN_DENIED', '허용되지 않은 사이트 요청입니다.'));
      return;
    }
    if (origin) {
      response.set('Access-Control-Allow-Origin', origin);
      response.vary('Origin');
      response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.sendStatus(204);
      return;
    }
    next();
  });

  // Bound unauthenticated work without persisting client addresses or credentials.
  const buckets = new Map<string, { count: number; expires: number }>();
  const limitAuth: RequestHandler = (request, _response, next) => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.expires <= now) buckets.delete(key);
    }
    const key = request.socket.remoteAddress ?? 'unknown';
    const bucket = buckets.get(key) ?? { count: 0, expires: now + 60000 };
    if (bucket.count >= 600 || (!buckets.has(key) && buckets.size >= 1000)) {
      next(new ApiError(429, 'RATE_LIMITED', '요청이 많습니다. 잠시 후 다시 시도해 주세요.'));
      return;
    }
    bucket.count++;
    buckets.set(key, bucket);
    next();
  };
  router.use('/auth', limitAuth);
  router.use('/device', limitAuth);
  router.use('/browser-device', limitAuth, browserDeviceRouter(pool));
  router.use('/student', limitAuth, studentRouter(options));
  const workspaceSignupBuckets = new Map<string, { count: number; expires: number }>();
  const limitWorkspaceSignup: RequestHandler = (request, _response, next) => {
    const now = Date.now();
    for (const [key, bucket] of workspaceSignupBuckets) {
      if (bucket.expires <= now) workspaceSignupBuckets.delete(key);
    }
    const key = request.socket.remoteAddress ?? 'unknown';
    const bucket = workspaceSignupBuckets.get(key) ?? { count: 0, expires: now + 15 * 60_000 };
    if (
      bucket.count >= 10 ||
      (!workspaceSignupBuckets.has(key) && workspaceSignupBuckets.size >= 1000)
    ) {
      next(
        new ApiError(
          429,
          'SIGNUP_RATE_LIMITED',
          '가입 요청이 많습니다. 잠시 후 다시 시도해 주세요.',
        ),
      );
      return;
    }
    bucket.count++;
    workspaceSignupBuckets.set(key, bucket);
    next();
  };

  router.post('/device/pair', async (request, response) => {
    const code = text(request.body?.code, 64).toUpperCase();
    const token = randomBytes(32).toString('base64url');
    const result = await transaction(pool, async (client) => {
      const pairing = await client.query<{ device_id: string }>(
        'SELECT device_id FROM device_pairings WHERE code_hash=$1 AND expires_at>now()',
        [digest(code)],
      );
      if (!pairing.rows[0])
        fail(401, 'PAIRING_EXPIRED', '연결 코드가 잘못되었거나 만료되었습니다.');
      const device = await client.query<{
        id: string;
        school_id: string;
        student_id: string;
        name: string;
      }>(
        `SELECT d.id,d.school_id,d.student_id,d.name FROM registered_devices d
         JOIN classes c ON c.id=d.class_id JOIN users u ON u.id=d.student_id
         WHERE d.id=$1 AND c.archived_at IS NULL AND c.closed_at IS NULL AND u.active AND u.role='student'
         FOR UPDATE OF d`,
        [pairing.rows[0].device_id],
      );
      if (!device.rows[0]) fail(401, 'DEVICE_UNAVAILABLE', '연결할 수 없는 기기입니다.');
      const consumed = await client.query(
        'DELETE FROM device_pairings WHERE code_hash=$1 AND expires_at>now() RETURNING device_id',
        [digest(code)],
      );
      if (!consumed.rowCount) fail(401, 'PAIRING_EXPIRED', '이미 사용한 연결 코드입니다.');
      await client.query(
        `UPDATE registered_devices SET credential_hash=$1,
         credential_expires_at=now()+interval '30 days',last_seen_at=NULL WHERE id=$2`,
        [digest(token), device.rows[0].id],
      );
      await client.query(
        `INSERT INTO audit_logs(school_id,action,target_id,result)
         VALUES ($1,'device.paired',$2,'success')`,
        [device.rows[0].school_id, device.rows[0].id],
      );
      return { id: device.rows[0].id, name: device.rows[0].name };
    });
    response.json({ token, device: result });
  });

  router.use('/device', async (request, response, next) => {
    const header = request.get('authorization');
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) {
      fail(401, 'DEVICE_UNAUTHENTICATED', '기기 연결 등록이 필요합니다.');
    }
    const result = await pool.query<{ id: string; class_id: string; school_id: string }>(
      `SELECT d.id,d.class_id,d.school_id FROM registered_devices d
       JOIN classes c ON c.id=d.class_id JOIN users u ON u.id=d.student_id
       WHERE d.credential_hash=$1 AND d.credential_expires_at>now()
       AND c.archived_at IS NULL AND c.closed_at IS NULL AND u.active AND u.role='student'`,
      [digest(header.slice(7))],
    );
    if (!result.rows[0]) fail(401, 'DEVICE_REVOKED', '기기 인증이 만료되었거나 해제되었습니다.');
    response.locals.device = result.rows[0];
    response.locals.deviceHash = digest(header.slice(7));
    next();
  });
  router.post('/device/sync', async (_request, response) => {
    const device: { id: string; class_id: string } = response.locals.device;
    await pool.query('UPDATE registered_devices SET last_seen_at=now() WHERE id=$1', [device.id]);
    const result = await pool.query(
      `SELECT m.id,m.title,m.url,m.created_at AS "createdAt",m.expires_at AS "expiresAt",
       d.received_at AS "receivedAt",d.opened_at AS "openedAt"
       FROM material_deliveries d JOIN class_materials m ON m.id=d.material_id
       WHERE d.device_id=$1 AND m.class_id=$2 AND m.expires_at>now()
       ORDER BY m.created_at DESC LIMIT 100`,
      [device.id, device.class_id],
    );
    const focus = await pool.query<{ enabled: boolean }>(
      'SELECT voluntary_focus AS enabled FROM classes WHERE id=$1',
      [device.class_id],
    );
    if (!focus.rows[0]) fail(401, 'DEVICE_UNAVAILABLE', '학급 연결을 확인하지 못했습니다.');
    const blocking = await transaction(pool, async (client) => {
      await client.query('SELECT id FROM classes WHERE id=$1 FOR UPDATE', [device.class_id]);
      const current = await client.query(
        `SELECT d.id FROM registered_devices d JOIN users u ON u.id=d.student_id
         WHERE d.id=$1 AND d.class_id=$2 AND d.credential_hash=$3
         AND d.credential_expires_at>statement_timestamp() AND u.active AND u.role='student'`,
        [device.id, device.class_id, response.locals.deviceHash],
      );
      if (!current.rowCount)
        fail(401, 'DEVICE_REVOKED', '기기 인증이 만료되었거나 해제되었습니다.');
      return blockingSnapshot(client, device.class_id);
    });
    response.json({ materials: result.rows, focusMode: focus.rows[0].enabled, blocking });
  });
  router.post('/device/materials/:materialId/ack', async (request, response) => {
    const materialId = id(request.params.materialId);
    const action: unknown = request.body?.action;
    if (action !== 'received' && action !== 'opened') {
      fail(400, 'INVALID_INPUT', '자료 확인 상태가 올바르지 않습니다.');
    }
    const device: { id: string; class_id: string } = response.locals.device;
    const result = await pool.query(
      `UPDATE material_deliveries d SET received_at=COALESCE(received_at,now()),
       opened_at=CASE WHEN $4='opened' THEN COALESCE(opened_at,now()) ELSE opened_at END
       FROM class_materials m WHERE d.material_id=m.id AND d.device_id=$1
       AND m.id=$2 AND m.class_id=$3 AND m.expires_at>now() RETURNING d.material_id`,
      [device.id, materialId, device.class_id, action],
    );
    if (!result.rowCount) fail(404, 'NOT_FOUND', '이 기기에 전달된 자료가 없습니다.');
    response.sendStatus(204);
  });
  router.post('/device/disconnect', async (_request, response) => {
    const device: { id: string; school_id: string } = response.locals.device;
    await transaction(pool, async (client) => {
      await client.query(
        'UPDATE registered_devices SET credential_hash=NULL,credential_expires_at=NULL,last_seen_at=NULL WHERE id=$1',
        [device.id],
      );
      await client.query('DELETE FROM device_pairings WHERE device_id=$1', [device.id]);
      await client.query(
        `INSERT INTO audit_logs(school_id,action,target_id,result)
         VALUES ($1,'device.disconnected',$2,'success')`,
        [device.school_id, device.id],
      );
    });
    response.sendStatus(204);
  });
  router.use('/device', (_request, _response) => {
    fail(404, 'NOT_FOUND', '요청한 기기 API가 없습니다.');
  });

  router.get('/auth/config', (_request, response) => {
    response.json({ googleClientId: options.googleClientId, emailPassword: true });
  });
  router.post('/auth/challenge', async (_request, response) => {
    const challengeId = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    await transaction(pool, async (client) => {
      await client.query('DELETE FROM auth_challenges WHERE expires_at <= now()');
      await client.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
      await client.query(
        `INSERT INTO auth_challenges(id,nonce_hash,expires_at)
         VALUES ($1,$2,now() + interval '5 minutes')`,
        [challengeId, digest(nonce)],
      );
    });
    response.status(201).json({ challengeId, nonce });
  });
  router.post('/auth/register', limitWorkspaceSignup, async (request, response) => {
    const challengeId = id(request.body?.challengeId);
    const credential = text(request.body?.credential, 16000);
    const workspaceName = text(request.body?.workspaceName, 100);
    const ownerName = text(request.body?.ownerName, 100);
    const identity = await verifyGoogleLogin(pool, options.verifyGoogle, challengeId, credential);
    const email = emailAddress(identity.email);
    const token = randomBytes(32).toString('base64url');
    const user = await transaction(pool, async (client) => {
      const schoolId = randomUUID();
      const userId = randomUUID();
      try {
        await client.query('INSERT INTO schools(id,name,google_domain) VALUES ($1,$2,$3)', [
          schoolId,
          workspaceName,
          email.split('@')[1],
        ]);
        const created = await client.query<CurrentUser>(
          `INSERT INTO users(id,school_id,email,name,role,google_sub)
           VALUES ($1,$2,$3,$4,'school_admin',$5)
           RETURNING id,school_id AS "schoolId",email,name,role`,
          [userId, schoolId, email, ownerName, identity.sub],
        );
        await client.query(
          `INSERT INTO audit_logs(school_id,actor_id,action,target_id,result)
           VALUES ($1,$2,'workspace.created',$1,'success')`,
          [schoolId, userId],
        );
        await client.query(
          `INSERT INTO auth_sessions(token_hash,user_id,expires_at)
           VALUES ($1,$2,now()+interval '1 hour')`,
          [digest(token), userId],
        );
        return created.rows[0];
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
          fail(409, 'ACCOUNT_EXISTS', '이 Google 계정은 이미 등록되어 있습니다. 로그인해 주세요.');
        }
        throw error;
      }
    });
    response.status(201).json({
      token,
      user,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  });
  router.post('/auth/google', async (request, response) => {
    const challengeId = id(request.body?.challengeId);
    const credential = text(request.body?.credential, 16000);
    const identity = await verifyGoogleLogin(pool, options.verifyGoogle, challengeId, credential);
    const token = randomBytes(32).toString('base64url');
    const result = await transaction(pool, async (client) => {
      const approved = await client.query<CurrentUser>(
        `UPDATE users u SET google_sub=$1
         FROM schools s
         WHERE u.school_id=s.id AND u.email=$2 AND u.active
           AND u.role IN ('teacher','student','school_admin')
           AND (u.google_sub IS NULL OR u.google_sub=$1)
         RETURNING u.id,u.school_id AS "schoolId",u.email,u.name,u.role`,
        [identity.sub, identity.email],
      );
      const user = approved.rows[0];
      if (!user)
        fail(
          403,
          'NOT_APPROVED',
          '계정이 등록되어 있지 않습니다. 먼저 작업공간을 만들거나 관리자에게 초대를 요청하세요.',
        );
      const session = await client.query<{ expiresAt: Date }>(
        `INSERT INTO auth_sessions(token_hash,user_id,expires_at)
         VALUES ($1,$2,now() + interval '1 hour') RETURNING expires_at AS "expiresAt"`,
        [digest(token), user.id],
      );
      await audit(client, user, 'login', user.id);
      return { user, expiresAt: session.rows[0].expiresAt.toISOString() };
    });
    response.json({ token, ...result });
  });

  router.use('/identity', limitAuth, identityRouter(options));

  const authenticate: RequestHandler = async (request, response, next) => {
    const header = request.get('authorization');
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) {
      fail(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    }
    const session = await pool.query<
      Omit<CurrentUser, 'schoolId' | 'role'> & {
        schoolId: string | null;
        role: UserRole | 'member';
      }
    >(
      `SELECT u.id,u.school_id AS "schoolId",u.email,u.name,u.role
       FROM auth_sessions a JOIN users u ON u.id=a.user_id
       WHERE a.token_hash=$1 AND a.expires_at > now() AND u.active`,
      [digest(header.slice(7))],
    );
    if (!session.rows[0]) fail(401, 'SESSION_EXPIRED', '로그인이 만료되었습니다.');
    const user = session.rows[0];
    response.locals.identityUser = { id: user.id, email: user.email, name: user.name };
    if (!user.schoolId || user.role === 'member') {
      fail(403, 'LEGACY_WORKSPACE_REQUIRED', '기존 작업공간 계정에만 허용된 기능입니다.');
    }
    response.locals.user = { ...user, schoolId: user.schoolId, role: user.role };
    response.locals.tokenHash = digest(header.slice(7));
    next();
  };
  router.use(authenticate);
  const actor = (response: express.Response): CurrentUser => response.locals.user;
  const requireRole = (user: CurrentUser, ...roles: UserRole[]) => {
    if (!roles.includes(user.role)) {
      fail(403, 'FORBIDDEN', '이 작업에 필요한 권한이 없습니다.');
    }
  };
  router.get('/auth/me', (_request, response) => response.json({ user: actor(response) }));
  router.post('/auth/logout', async (_request, response) => {
    const user = actor(response);
    await transaction(pool, async (client) => {
      await client.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
        response.locals.tokenHash,
      ]);
      await audit(client, user, 'logout', user.id);
    });
    response.sendStatus(204);
  });

  router.get('/school', async (_request, response) => {
    const school = await pool.query(
      'SELECT id,name,google_domain AS "googleDomain" FROM schools WHERE id=$1',
      [actor(response).schoolId],
    );
    response.json({ school: school.rows[0] });
  });
  router.get('/users', async (_request, response) => {
    const user = actor(response);
    requireRole(user, 'school_admin');
    const users = await pool.query(
      `SELECT id,email,name,role,active,(google_sub IS NOT NULL) AS "hasLoggedIn"
       FROM users WHERE school_id=$1 ORDER BY name,id`,
      [user.schoolId],
    );
    response.json({ users: users.rows });
  });
  router.post('/users', async (request, response) => {
    const user = actor(response);
    requireRole(user, 'school_admin');
    const email = emailAddress(request.body?.email);
    const name = text(request.body?.name, 100);
    const role: unknown = request.body?.role;
    if (role !== 'teacher' && role !== 'student') {
      fail(400, 'INVALID_INPUT', '교사 또는 학생만 초대할 수 있습니다.');
    }
    const userId = randomUUID();
    await transaction(pool, async (client) => {
      const result = await client.query(
        `INSERT INTO users(id,school_id,email,name,role) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [userId, user.schoolId, email, name, role],
      );
      if (!result.rowCount) fail(409, 'ALREADY_REGISTERED', '이미 등록된 계정입니다.');
      await audit(client, user, 'user.invited', userId);
    });
    response.status(201).json({ id: userId });
  });
  router.patch('/users/:userId', async (request, response) => {
    const user = actor(response);
    requireRole(user, 'school_admin');
    const target = id(request.params.userId);
    const role: unknown = request.body?.role;
    const active: unknown = request.body?.active;
    if ((role !== 'teacher' && role !== 'student') || typeof active !== 'boolean') {
      fail(400, 'INVALID_INPUT', '교사·학생 역할과 활성 상태를 입력해 주세요.');
    }
    await transaction(pool, async (client) => {
      const changed = await client.query(
        `UPDATE users SET role=$1,active=$2 WHERE id=$3 AND school_id=$4
         AND role != 'school_admin' RETURNING id`,
        [role, active, target, user.schoolId],
      );
      if (!changed.rowCount) fail(404, 'NOT_FOUND', '관리할 수 있는 계정이 없습니다.');
      await client.query('DELETE FROM auth_sessions WHERE user_id=$1', [target]);
      await client.query(
        `UPDATE registered_devices SET credential_hash=NULL,credential_expires_at=NULL,last_seen_at=NULL
         WHERE student_id=$1`,
        [target],
      );
      await client.query(
        `DELETE FROM device_pairings WHERE device_id IN
         (SELECT id FROM registered_devices WHERE student_id=$1)`,
        [target],
      );
      await audit(client, user, 'user.permissions_changed', target);
    });
    response.sendStatus(204);
  });

  router.get('/classes', async (_request, response) => {
    const user = actor(response);
    const result = await pool.query(
      `SELECT c.id,c.school_id AS "schoolId",c.name,c.teacher_id AS "teacherId"
       FROM classes c WHERE c.school_id=$1 AND c.archived_at IS NULL AND c.closed_at IS NULL
       AND ($3='school_admin' OR ($3='teacher' AND c.teacher_id=$2)
         OR ($3='student' AND EXISTS (
           SELECT 1 FROM class_members m WHERE m.class_id=c.id AND m.student_id=$2)))
       ORDER BY c.name,c.id`,
      [user.schoolId, user.id, user.role],
    );
    response.json({ classes: result.rows });
  });
  router.post('/classes', async (request, response) => {
    const user = actor(response);
    requireRole(user, 'teacher');
    const classId = randomUUID();
    const name = text(request.body?.name, 100);
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO classes(id,school_id,teacher_id,name) VALUES ($1,$2,$3,$4)', [
        classId,
        user.schoolId,
        user.id,
        name,
      ]);
      await audit(client, user, 'class.created', classId);
    });
    response.status(201).json({ id: classId });
  });
  router.use('/classes/:classId', async (request, response, next) => {
    const user = actor(response);
    requireRole(user, 'teacher', 'school_admin');
    const classId = id(request.params.classId);
    const result = await pool.query(
      `SELECT id FROM classes WHERE id=$1 AND school_id=$2 AND archived_at IS NULL AND closed_at IS NULL
       AND ($4='school_admin' OR teacher_id=$3)`,
      [classId, user.schoolId, user.id, user.role],
    );
    if (!result.rowCount) fail(404, 'NOT_FOUND', '접근 가능한 학급이 없습니다.');
    response.locals.classId = classId;
    next();
  });
  router.patch('/classes/:classId', async (request, response) => {
    const user = actor(response);
    const classId: string = response.locals.classId;
    const name = text(request.body?.name, 100);
    await transaction(pool, async (client) => {
      await client.query('UPDATE classes SET name=$1 WHERE id=$2', [name, classId]);
      await audit(client, user, 'class.renamed', classId);
    });
    response.sendStatus(204);
  });
  router.delete('/classes/:classId', async (_request, response) => {
    const user = actor(response);
    const classId: string = response.locals.classId;
    await transaction(pool, async (client) => {
      await client.query('SELECT id FROM classes WHERE id=$1 FOR UPDATE', [classId]);
      await stopClassroom(client, classId, user.id, true);
      const removed = await client.query<{ id: string }>(
        'DELETE FROM registered_devices WHERE class_id=$1 RETURNING id',
        [classId],
      );
      for (const device of removed.rows) {
        await audit(client, user, 'device.unregistered', device.id);
      }
      await audit(client, user, 'class.archived', classId);
    });
    response.sendStatus(204);
  });
  router.get('/classes/:classId/members', async (_request, response) => {
    const members = await pool.query(
      `SELECT u.id,u.name,u.email FROM class_members m JOIN users u ON u.id=m.student_id
       WHERE m.class_id=$1 AND u.role='student' AND u.active ORDER BY u.name,u.id`,
      [response.locals.classId],
    );
    response.json({ members: members.rows });
  });
  router.get('/classes/:classId/devices', async (_request, response) => {
    const result = await pool.query(
      `SELECT d.id,d.student_id AS "studentId",u.name AS "studentName",
       d.name,d.asset_number AS "assetNumber",
       CASE WHEN d.credential_hash IS NULL THEN 'unknown'
         WHEN d.credential_expires_at>now() AND d.last_seen_at>now()-interval '90 seconds'
         THEN 'connected' ELSE 'disconnected' END AS "connectionState",
       d.last_seen_at AS "lastSeenAt",
       'unverified' AS "screenViewingSupport",'unverified' AS "recordingSupport"
       FROM registered_devices d JOIN users u ON u.id=d.student_id
       WHERE d.class_id=$1 ORDER BY d.created_at,d.id`,
      [response.locals.classId],
    );
    response.json({ devices: result.rows });
  });
  router.post('/classes/:classId/devices/:deviceId/pairing', async (request, response) => {
    const user = actor(response);
    const deviceId = id(request.params.deviceId);
    const code = randomBytes(16).toString('hex').toUpperCase();
    const expiresAt = await transaction(pool, async (client) => {
      const result = await client.query(
        `UPDATE registered_devices SET credential_hash=NULL,credential_expires_at=NULL,
         last_seen_at=NULL WHERE id=$1 AND class_id=$2 RETURNING id`,
        [deviceId, response.locals.classId],
      );
      if (!result.rowCount) fail(404, 'NOT_FOUND', '등록된 기기가 없습니다.');
      await client.query('DELETE FROM device_pairings WHERE expires_at<=now() OR device_id=$1', [
        deviceId,
      ]);
      const pairing = await client.query<{ expiresAt: Date }>(
        `INSERT INTO device_pairings(code_hash,device_id,expires_at)
         VALUES ($1,$2,now()+interval '5 minutes') RETURNING expires_at AS "expiresAt"`,
        [digest(code), deviceId],
      );
      await audit(client, user, 'device.pairing_created', deviceId);
      return pairing.rows[0].expiresAt;
    });
    response.json({ code, expiresAt });
  });
  router.delete('/classes/:classId/devices/:deviceId/connection', async (request, response) => {
    const user = actor(response);
    const deviceId = id(request.params.deviceId);
    await transaction(pool, async (client) => {
      const result = await client.query(
        `UPDATE registered_devices SET credential_hash=NULL,credential_expires_at=NULL,last_seen_at=NULL
         WHERE id=$1 AND class_id=$2 RETURNING id`,
        [deviceId, response.locals.classId],
      );
      if (!result.rowCount) fail(404, 'NOT_FOUND', '등록된 기기가 없습니다.');
      await client.query('DELETE FROM device_pairings WHERE device_id=$1', [deviceId]);
      await audit(client, user, 'device.connection_revoked', deviceId);
    });
    response.sendStatus(204);
  });
  router.get('/classes/:classId/materials', async (_request, response) => {
    const materials = await pool.query(
      `SELECT id,title,url,created_at AS "createdAt",expires_at AS "expiresAt"
       FROM class_materials WHERE class_id=$1 AND expires_at>now() AND audience='all'
       ORDER BY created_at DESC LIMIT 100`,
      [response.locals.classId],
    );
    const deliveries = await pool.query(
      `SELECT d.material_id,d.device_id AS "deviceId",d.received_at AS "receivedAt",
       d.opened_at AS "openedAt" FROM material_deliveries d JOIN class_materials m ON m.id=d.material_id
       WHERE m.class_id=$1 AND m.id=ANY($2::uuid[])`,
      [response.locals.classId, materials.rows.map((material: { id: string }) => material.id)],
    );
    response.json({
      materials: materials.rows.map((material: { id: string }) => ({
        ...material,
        deliveries: deliveries.rows
          .filter((delivery: { material_id: string }) => delivery.material_id === material.id)
          .map(({ material_id: _id, ...delivery }) => delivery),
      })),
    });
  });
  router.get('/classes/:classId/focus', async (_request, response) => {
    const result = await pool.query('SELECT voluntary_focus AS enabled FROM classes WHERE id=$1', [
      response.locals.classId,
    ]);
    response.json(result.rows[0]);
  });
  router.patch('/classes/:classId/focus', async (request, response) => {
    const user = actor(response);
    const enabled: unknown = request.body?.enabled;
    if (typeof enabled !== 'boolean')
      fail(400, 'INVALID_INPUT', '집중 안내 상태가 올바르지 않습니다.');
    await transaction(pool, async (client) => {
      const changed = await client.query(
        `UPDATE classes SET voluntary_focus=$1 WHERE id=$2 AND school_id=$3 AND archived_at IS NULL AND closed_at IS NULL
           AND ($5='school_admin' OR teacher_id=$4) RETURNING id`,
        [enabled, response.locals.classId, user.schoolId, user.id, user.role],
      );
      if (!changed.rowCount) fail(404, 'NOT_FOUND', '접근 가능한 학급이 없습니다.');
      await audit(client, user, enabled ? 'focus.started' : 'focus.ended', response.locals.classId);
    });
    response.sendStatus(204);
  });
  router.post('/classes/:classId/materials', async (request, response) => {
    const user = actor(response);
    const title = text(request.body?.title, 100);
    const url = materialUrl(request.body?.url);
    const materialId = randomUUID();
    await transaction(pool, async (client) => {
      const classroom = await client.query(
        `SELECT id FROM classes WHERE id=$1 AND school_id=$2 AND archived_at IS NULL AND closed_at IS NULL
         AND ($4='school_admin' OR teacher_id=$3) FOR SHARE`,
        [response.locals.classId, user.schoolId, user.id, user.role],
      );
      if (!classroom.rowCount) fail(404, 'NOT_FOUND', '접근 가능한 학급이 없습니다.');
      await client.query(
        'INSERT INTO class_materials(id,class_id,title,url) VALUES ($1,$2,$3,$4)',
        [materialId, response.locals.classId, title, url],
      );
      await client.query(
        `INSERT INTO material_deliveries(material_id,device_id)
         SELECT $1,d.id FROM registered_devices d JOIN users u ON u.id=d.student_id
         WHERE d.class_id=$2 AND u.active AND u.role='student'`,
        [materialId, response.locals.classId],
      );
      await audit(client, user, 'material.sent', materialId);
    });
    response.status(201).json({ id: materialId });
  });
  router.delete('/classes/:classId/materials/:materialId', async (request, response) => {
    const user = actor(response);
    const materialId = id(request.params.materialId);
    await transaction(pool, async (client) => {
      const result = await client.query(
        'DELETE FROM class_materials WHERE id=$1 AND class_id=$2 RETURNING id',
        [materialId, response.locals.classId],
      );
      if (!result.rowCount) fail(404, 'NOT_FOUND', '자료가 없습니다.');
      await audit(client, user, 'material.deleted', materialId);
    });
    response.sendStatus(204);
  });
  router.post('/classes/:classId/devices', async (request, response) => {
    const user = actor(response);
    const classId: string = response.locals.classId;
    const studentId = id(request.body?.studentId);
    const name = text(request.body?.name, 100);
    const assetNumber = text(request.body?.assetNumber, 100);
    const deviceId = randomUUID();
    await transaction(pool, async (client) => {
      const classroom = await client.query(
        `SELECT id FROM classes WHERE id=$1 AND school_id=$2 AND archived_at IS NULL AND closed_at IS NULL
         AND ($4='school_admin' OR teacher_id=$3) FOR SHARE`,
        [classId, user.schoolId, user.id, user.role],
      );
      if (!classroom.rowCount) fail(404, 'NOT_FOUND', '접근 가능한 학급이 없습니다.');
      const student = await client.query(
        `SELECT m.student_id FROM class_members m JOIN users u ON u.id=m.student_id
         WHERE m.class_id=$1 AND m.student_id=$2 AND m.school_id=$3
         AND u.active AND u.role='student' FOR UPDATE OF m,u`,
        [classId, studentId, user.schoolId],
      );
      if (!student.rowCount) fail(404, 'NOT_FOUND', '이 학급에 등록된 활성 학생이 없습니다.');
      const saved = await client.query(
        `INSERT INTO registered_devices(id,school_id,class_id,student_id,name,asset_number)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
        [deviceId, user.schoolId, classId, studentId, name, assetNumber],
      );
      if (!saved.rowCount) {
        fail(409, 'ASSET_ALREADY_REGISTERED', '학교에 이미 등록된 자산번호입니다.');
      }
      await audit(client, user, 'device.registered', deviceId);
    });
    response.status(201).json({ id: deviceId });
  });
  router.delete('/classes/:classId/devices/:deviceId', async (request, response) => {
    const user = actor(response);
    const deviceId = id(request.params.deviceId);
    await transaction(pool, async (client) => {
      const removed = await client.query(
        'DELETE FROM registered_devices WHERE id=$1 AND class_id=$2 RETURNING id',
        [deviceId, response.locals.classId],
      );
      if (!removed.rowCount) fail(404, 'NOT_FOUND', '이 학급에 등록된 기기가 없습니다.');
      await audit(client, user, 'device.unregistered', deviceId);
    });
    response.sendStatus(204);
  });
  router.post('/classes/:classId/members', async (request, response) => {
    const user = actor(response);
    const classId: string = response.locals.classId;
    const email = emailAddress(request.body?.email);
    await transaction(pool, async (client) => {
      const student = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE email=$1 AND school_id=$2 AND role='student'
         AND active FOR UPDATE`,
        [email, user.schoolId],
      );
      if (!student.rowCount) fail(404, 'NOT_FOUND', '작업공간에 등록된 학생이 없습니다.');
      await client.query(
        `INSERT INTO class_members(class_id,student_id,school_id) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [classId, student.rows[0].id, user.schoolId],
      );
      await audit(client, user, 'class.student_added', student.rows[0].id);
    });
    response.sendStatus(204);
  });
  router.delete('/classes/:classId/members/:studentId', async (request, response) => {
    const user = actor(response);
    const studentId = id(request.params.studentId);
    await transaction(pool, async (client) => {
      await client.query(
        'SELECT student_id FROM class_members WHERE class_id=$1 AND student_id=$2 FOR UPDATE',
        [response.locals.classId, studentId],
      );
      const devices = await client.query<{ id: string }>(
        'SELECT id FROM registered_devices WHERE class_id=$1 AND student_id=$2',
        [response.locals.classId, studentId],
      );
      const removed = await client.query(
        'DELETE FROM class_members WHERE class_id=$1 AND student_id=$2 RETURNING student_id',
        [response.locals.classId, studentId],
      );
      if (!removed.rowCount) fail(404, 'NOT_FOUND', '등록된 학생이 없습니다.');
      for (const device of devices.rows) {
        await audit(client, user, 'device.unregistered', device.id);
      }
      await audit(client, user, 'class.student_removed', studentId);
    });
    response.sendStatus(204);
  });
  return router;
}

export const apiErrors: ErrorRequestHandler = async (error: unknown, _request, response, _next) => {
  if (error instanceof ApiError) {
    if ([401, 403, 404, 409, 429].includes(error.status)) {
      console.warn('access_denied', { code: error.code });
      const user: CurrentUser | undefined = response.locals.user;
      const identityUser: { id: string } | undefined = response.locals.identityUser;
      const pool: Pool | undefined = response.locals.pool;
      try {
        await pool?.query(
          `INSERT INTO audit_logs(school_id,actor_id,action,result)
           VALUES ($1,$2,'access.denied',$3)`,
          [user?.schoolId ?? null, user?.id ?? identityUser?.id ?? null, error.code],
        );
      } catch {
        console.error('access_denied_audit_failed');
        response.status(503).json({
          error: {
            code: 'AUDIT_UNAVAILABLE',
            message: '감사 기록 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.',
          },
        });
        return;
      }
    }
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (
    error instanceof SyntaxError ||
    (error instanceof Error && 'status' in error && error.status === 413)
  ) {
    response
      .status(400)
      .json({ error: { code: 'INVALID_INPUT', message: '요청 형식이 올바르지 않습니다.' } });
    return;
  }
  console.error('api_request_failed');
  response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: '요청 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.',
    },
  });
};
