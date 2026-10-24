import { randomBytes, randomUUID } from 'node:crypto';
import { documentRouter } from './classroom-documents.js';
import { blockingRouter } from './site-blocking.js';
import express from 'express';
import type { PoolClient } from 'pg';
import { studentReviewRouter } from './student-join.js';
import { participantManagementRouter } from './participant-management.js';
import { lessonManagementRouter } from './lesson-presence.js';
import { focusManagementRouter } from './classroom-focus.js';
import { materialManagementRouter } from './classroom-materials.js';
import type { IdentityUser, IdentityClassroom } from '@clario/shared';
import { classroomPolicy } from '@clario/shared';
import type { AccessOptions } from './access.js';
import { digest, emailAddress, fail, id, text, transaction } from './api-core.js';
import { verifyGoogleLogin } from './identity.js';
import { hashPassword, matchesPassword, passwordInput } from './password.js';
import { notificationRouter } from './classroom-notifications.js';
import {
  classroomManagementRouter,
  identityClassroomAccess,
  manager,
} from './classroom-management.js';

const capabilities = { canCreateClassroom: classroomPolicy.canCreateClassroom };

async function issueSession(client: PoolClient, user: IdentityUser, action: string) {
  const token = randomBytes(32).toString('base64url');
  const session = await client.query<{ expiresAt: Date }>(
    `INSERT INTO auth_sessions(token_hash,user_id,expires_at)
     VALUES ($1,$2,now()+interval '1 hour') RETURNING expires_at AS "expiresAt"`,
    [digest(token), user.id],
  );
  await client.query(
    `INSERT INTO audit_logs(actor_id,action,target_id,result) VALUES ($1,$2,$1,'success')`,
    [user.id, action],
  );
  return { user, capabilities, token, expiresAt: session.rows[0].expiresAt.toISOString() };
}

export function identityRouter(options: AccessOptions) {
  const { pool } = options;
  const router = express.Router();
  router.use('/auth/email', async (request, _response, next) => {
    const email = emailAddress(request.body?.email);
    const keys = [
      digest(`ip:${request.socket.remoteAddress ?? 'unknown'}`),
      digest(`email:${email}`),
    ];
    const attempts = await transaction(pool, async (client) => {
      await client.query('DELETE FROM identity_auth_budgets WHERE expires_at<=now()');
      return client.query<{ key_hash: string; attempts: number }>(
        `INSERT INTO identity_auth_budgets(key_hash,attempts,expires_at)
         SELECT key,1,now()+interval '15 minutes' FROM unnest($1::text[]) AS key ORDER BY key
         ON CONFLICT (key_hash) DO UPDATE SET
           attempts=CASE WHEN identity_auth_budgets.expires_at<=now() THEN 1
             ELSE identity_auth_budgets.attempts+1 END,
           expires_at=CASE WHEN identity_auth_budgets.expires_at<=now()
             THEN now()+interval '15 minutes' ELSE identity_auth_budgets.expires_at END
         RETURNING key_hash,attempts`,
        [keys],
      );
    });
    if (attempts.rows.some((row) => row.attempts > (row.key_hash === keys[0] ? 40 : 10))) {
      fail(
        429,
        'EMAIL_AUTH_RATE_LIMITED',
        '가입·로그인 요청이 많습니다. 15분 후 다시 시도해 주세요.',
      );
    }
    next();
  });
  router.post('/auth/email/register', async (request, response) => {
    const email = emailAddress(request.body?.email);
    const name = text(request.body?.displayName, 100);
    const password = passwordInput(request.body?.password);
    const passwordHash = await hashPassword(password);
    const result = await transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`email:${email}`]);
      const exists = await client.query('SELECT id FROM users WHERE email=$1', [email]);
      if (exists.rowCount) {
        fail(
          409,
          'EMAIL_UNAVAILABLE',
          '이 이메일로 가입할 수 없습니다. 기존 로그인 방식을 이용해 주세요.',
        );
      }
      const created = await client.query<IdentityUser>(
        `INSERT INTO users(id,email,name,role,password_hash)
         VALUES($1,$2,$3,'member',$4) RETURNING id,email,name`,
        [randomUUID(), email, name, passwordHash],
      );
      return issueSession(client, created.rows[0], 'identity.email_registered');
    });
    response.status(201).json(result);
  });
  router.post('/auth/email/login', async (request, response) => {
    const email = emailAddress(request.body?.email);
    const password = passwordInput(request.body?.password);
    const result = await transaction(pool, async (client) => {
      const found = await client.query<
        IdentityUser & { password_hash: string | null; active: boolean }
      >('SELECT id,email,name,password_hash,active FROM users WHERE email=$1 FOR UPDATE', [email]);
      const user = found.rows[0];
      const valid = await matchesPassword(password, user?.password_hash ?? null);
      if (!valid || !user?.active) {
        fail(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.');
      }
      return issueSession(
        client,
        { id: user.id, email: user.email, name: user.name },
        'identity.email_login',
      );
    });
    response.json(result);
  });
  router.post('/auth/google', async (request, response) => {
    if (!options.googleClientId) {
      fail(
        503,
        'GOOGLE_NOT_CONFIGURED',
        'Google 로그인이 아직 설정되지 않았습니다. 이메일로 가입·로그인해 주세요.',
      );
    }
    const challengeId = id(request.body?.challengeId);
    const credential = text(request.body?.credential, 16000);
    const displayName = text(request.body?.displayName, 100);
    const identity = await verifyGoogleLogin(pool, options.verifyGoogle, challengeId, credential);
    const email = emailAddress(identity.email);
    const result = await transaction(pool, async (client) => {
      // Serialize both identifiers, including first-login races and email changes.
      for (const key of [`email:${email}`, `google:${identity.sub}`].sort()) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      }
      const existing = await client.query<
        IdentityUser & { google_sub: string | null; password_hash: string | null; active: boolean }
      >(
        'SELECT id,email,name,google_sub,password_hash,active FROM users WHERE google_sub=$1 OR email=$2 ORDER BY id FOR UPDATE',
        [identity.sub, email],
      );
      const bySubject = existing.rows.find((user) => user.google_sub === identity.sub);
      const byEmail = existing.rows.find((user) => user.email === email);
      if (byEmail && byEmail.id !== bySubject?.id) {
        fail(
          409,
          byEmail.google_sub === null && !byEmail.password_hash
            ? 'LEGACY_LINK_REQUIRED'
            : 'IDENTITY_CONFLICT',
          byEmail.password_hash
            ? '이메일·비밀번호로 가입한 계정입니다. 이메일 로그인을 이용해 주세요. 계정은 자동 연결되지 않습니다.'
            : byEmail.google_sub === null
              ? '기존에 등록된 계정입니다. 기존 작업공간 로그인으로 계정을 연결한 뒤 다시 로그인해 주세요.'
              : '계정 정보가 기존 인증 정보와 충돌합니다. 관리자에게 문의해 주세요.',
        );
      }
      if (bySubject && !bySubject.active)
        fail(403, 'ACCOUNT_DISABLED', '사용이 중지된 계정입니다.');
      let user: IdentityUser;
      if (bySubject) {
        const updated = await client.query<IdentityUser>(
          'UPDATE users SET email=$1 WHERE id=$2 RETURNING id,email,name',
          [email, bySubject.id],
        );
        user = updated.rows[0];
      } else {
        const created = await client.query<IdentityUser>(
          `INSERT INTO users(id,email,name,role,google_sub)
           VALUES ($1,$2,$3,'member',$4) RETURNING id,email,name`,
          [randomUUID(), email, displayName, identity.sub],
        );
        user = created.rows[0];
      }
      return issueSession(client, user, bySubject ? 'identity.login' : 'identity.registered');
    }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        fail(
          409,
          'IDENTITY_CONFLICT',
          '계정 정보가 다른 등록 요청과 충돌합니다. 다시 로그인해 주세요.',
        );
      }
      throw error;
    });
    response.json(result);
  });

  router.use(async (request, response, next) => {
    const header = request.get('authorization');
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) {
      fail(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    }
    const tokenHash = digest(header.slice(7));
    const current = await pool.query<IdentityUser>(
      `SELECT u.id,u.email,u.name FROM auth_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,
      [tokenHash],
    );
    if (!current.rows[0]) fail(401, 'SESSION_EXPIRED', '로그인이 만료되었습니다.');
    response.locals.identityUser = current.rows[0];
    response.locals.identityTokenHash = tokenHash;
    next();
  });
  router.get('/me', (_request, response) => {
    response.json({ user: response.locals.identityUser, capabilities });
  });
  router.get('/classrooms', async (request, response) => {
    const user: IdentityUser = response.locals.identityUser;
    const classrooms = await pool.query<IdentityClassroom>(
      request.query.includeInactive === 'true'
        ? `SELECT access.*,c.closed_at AS "closedAt",c.archived_at AS "archivedAt"
           FROM (${identityClassroomAccess}) access JOIN classes c ON c.id=access.id
           WHERE access.role='manager' OR (c.archived_at IS NULL AND c.closed_at IS NULL)
           ORDER BY access.name,access.id`
        : `${identityClassroomAccess} AND c.archived_at IS NULL AND c.closed_at IS NULL ORDER BY c.name,c.id`,
      [user.id],
    );
    response.json({ classrooms: classrooms.rows });
  });
  router.use('/classrooms', studentReviewRouter(pool));
  router.use('/classrooms', participantManagementRouter(pool));
  router.use('/classrooms', lessonManagementRouter(pool));
  router.use('/classrooms', focusManagementRouter(pool));
  router.use('/classrooms', notificationRouter(pool));
  if (options.syntheticMedia) router.use('/classrooms', options.syntheticMedia.teacherRouter());
  else
    router.get('/classrooms/:classroomId/synthetic-media', async (request, response) => {
      await transaction(pool, (client) =>
        manager(client, response.locals.identityTokenHash, id(request.params.classroomId), false),
      );
      response.json({ enabled: false, synthetic: true });
    });
  router.use(documentRouter(pool, options.documents));
  router.use('/classrooms', blockingRouter(pool, options.origins));
  router.use(materialManagementRouter(pool));
  router.use('/classrooms', classroomManagementRouter(pool));
  router.post('/logout', async (_request, response) => {
    const user: IdentityUser = response.locals.identityUser;
    await transaction(pool, async (client) => {
      await client.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
        response.locals.identityTokenHash,
      ]);
      await client.query(
        "INSERT INTO audit_logs(actor_id,action,target_id,result) VALUES ($1,'identity.logout',$1,'success')",
        [user.id],
      );
    });
    response.sendStatus(204);
  });
  router.use((_request, _response) => fail(404, 'NOT_FOUND', '요청한 API가 없습니다.'));
  return router;
}
