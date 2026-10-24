import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import type { Pool, PoolClient } from 'pg';
import { audit, manager } from './classroom-management.js';
import { digest, fail, id, transaction } from './api-core.js';
import { readStudentSession } from './student-sessions.js';

export function blockingDomains(value: unknown, origins: string[] = []): string[] {
  if (!Array.isArray(value) || value.length > 50 || value.some((v) => typeof v !== 'string'))
    fail(400, 'INVALID_DOMAINS', '도메인은 최대 50개입니다.');
  const domains = [...new Set((value as string[]).map((v) => v.trim().toLowerCase()))];
  if (
    domains.some(
      (domain) =>
        domain.length > 253 ||
        !domain.includes('.') ||
        !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        !/[a-z]/.test(domain.split('.').at(-1)!) ||
        /(?:^|\.)(?:localhost|local|internal)$/.test(domain) ||
        origins.some((origin) => {
          const host = new URL(origin).hostname;
          return host === domain || host.endsWith(`.${domain}`);
        }),
    )
  )
    fail(
      400,
      'INVALID_DOMAINS',
      'URL·IP·와일드카드·로컬 주소·CLARIO 접속 도메인은 차단할 수 없습니다.',
    );
  return domains.sort();
}
export async function blockingSnapshot(client: PoolClient, classroom: string) {
  const result = await client.query<{
    blocked_domains: string[];
    lesson: string | null;
    observed: Date;
    expires: Date;
  }>(
    `SELECT c.blocked_domains,l.id AS lesson,statement_timestamp() AS observed,
     statement_timestamp()+interval '60 seconds' AS expires
     FROM classes c LEFT JOIN classroom_sessions l ON l.class_id=c.id AND l.ended_at IS NULL
     WHERE c.id=$1 AND c.closed_at IS NULL AND c.archived_at IS NULL`,
    [classroom],
  );
  const row = result.rows[0];
  if (!row) fail(401, 'CLASSROOM_CLOSED', '교실이 종료되었습니다.');
  return {
    domains: row.lesson ? row.blocked_domains : [],
    configuredDomains: row.blocked_domains,
    lessonId: row.lesson,
    observedAt: row.observed.toISOString(),
    expiresAt: row.expires.toISOString(),
  };
}
export function blockingRouter(pool: Pool, origins: string[]) {
  const router = express.Router();
  router.get('/:classroomId/blocking', async (request, response) => {
    response.json(
      await transaction(pool, async (client) => {
        const classroom = id(request.params.classroomId);
        await manager(client, response.locals.identityTokenHash, classroom, false);
        const domains = await client.query<{ blocked_domains: string[] }>(
          'SELECT blocked_domains FROM classes WHERE id=$1',
          [classroom],
        );
        const current = await client.query(
          'SELECT id FROM classroom_sessions WHERE class_id=$1 AND ended_at IS NULL',
          [classroom],
        );
        return {
          configuredDomains: domains.rows[0].blocked_domains,
          active: Boolean(current.rowCount),
        };
      }),
    );
  });
  router.patch('/:classroomId/blocking', async (request, response) => {
    if (
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body) ||
      Object.keys(request.body).some((key) => key !== 'domains')
    )
      fail(400, 'INVALID_INPUT', '차단 도메인 목록만 입력하세요.');
    const domains = blockingDomains(request.body.domains, origins);
    await transaction(pool, async (client) => {
      const classroom = id(request.params.classroomId),
        teacher = await manager(client, response.locals.identityTokenHash, classroom, true);
      await client.query('UPDATE classes SET blocked_domains=$2 WHERE id=$1', [classroom, domains]);
      await audit(client, classroom, teacher, 'classroom.blocking_changed');
    });
    response.json({ configuredDomains: domains });
  });
  return router;
}
async function approved(client: PoolClient, token: string) {
  const current = await readStudentSession(client, token);
  if (current.view.state !== 'participant')
    fail(403, 'APPROVAL_REQUIRED', '교사 승인이 필요합니다.');
  return current;
}
export async function studentBlocking(client: PoolClient, token: string) {
  const current = await approved(client, token);
  const extension = await client.query<{ last_seen_at: Date | null }>(
    `SELECT last_seen_at FROM classroom_browser_connections WHERE participant_id=$1 AND generation=$2
     AND student_credential=$3 AND revoked_at IS NULL AND token_hash IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1`,
    [current.row.participant_id, current.row.generation, current.row.token_hash],
  );
  const seen = extension.rows[0]?.last_seen_at;
  return {
    ...(await blockingSnapshot(client, current.row.class_id)),
    extensionLastSeenAt: seen?.toISOString() ?? null,
  };
}
export async function issueBrowserCode(client: PoolClient, token: string) {
  const current = await approved(client, token),
    code = randomBytes(16).toString('hex').toUpperCase();
  const attempts = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM classroom_participation_audit
     WHERE class_id=$1 AND participant_id=$2 AND action='browser.code_issued'
     AND created_at>statement_timestamp()-interval '1 minute'`,
    [current.row.class_id, current.row.participant_id],
  );
  if (attempts.rows[0].count >= 5)
    fail(429, 'BROWSER_CODE_RATE_LIMITED', '확장 코드는 학생당 1분에 5회까지 발급할 수 있습니다.');
  await client.query(
    'UPDATE classroom_browser_connections SET revoked_at=statement_timestamp(),code_hash=NULL,token_hash=NULL WHERE participant_id=$1 AND revoked_at IS NULL',
    [current.row.participant_id],
  );
  const row = await client.query<{ code_expires_at: Date }>(
    `INSERT INTO classroom_browser_connections(id,class_id,participant_id,generation,student_credential,code_hash,code_expires_at)
     VALUES($1,$2,$3,$4,$5,$6,statement_timestamp()+interval '5 minutes') RETURNING code_expires_at`,
    [
      randomUUID(),
      current.row.class_id,
      current.row.participant_id,
      current.row.generation,
      current.row.token_hash,
      digest(code),
    ],
  );
  await client.query(
    `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
     VALUES($1,$2,'participant',$3,'browser.code_issued','success')`,
    [randomUUID(), current.row.class_id, current.row.participant_id],
  );
  return { code, expiresAt: row.rows[0].code_expires_at.toISOString() };
}
async function validBrowser(client: PoolClient, hash: string, kind: 'code_hash' | 'token_hash') {
  const found = await client.query<{ class_id: string; id: string }>(
    `SELECT id,class_id FROM classroom_browser_connections WHERE ${kind}=$1`,
    [hash],
  );
  if (!found.rows[0]) fail(401, 'BROWSER_REVOKED', '확장 연결 자격이 만료되었거나 해제되었습니다.');
  const row = found.rows[0];
  await client.query('SELECT id FROM classes WHERE id=$1 FOR UPDATE', [row.class_id]);
  const result = await client.query<{
    id: string;
    class_id: string;
    name: string;
    participant_id: string;
  }>(
    `SELECT b.id,b.class_id,p.name,b.participant_id FROM classroom_browser_connections b
     JOIN classroom_participants p ON p.id=b.participant_id AND p.class_id=b.class_id
     JOIN classes c ON c.id=b.class_id
     JOIN student_participation_sessions s ON s.token_hash=b.student_credential
     WHERE b.id=$1 AND b.${kind}=$2 AND b.revoked_at IS NULL
     AND ($3='token_hash' OR b.code_expires_at>statement_timestamp())
     AND p.status='approved' AND p.credential_generation=b.generation AND s.generation=b.generation
     AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND s.idle_expires_at>statement_timestamp()
     AND c.closed_at IS NULL AND c.archived_at IS NULL`,
    [row.id, hash, kind],
  );
  if (!result.rows[0])
    fail(401, 'BROWSER_REVOKED', '확장 연결 자격이 만료되었거나 해제되었습니다.');
  return result.rows[0];
}
export function browserDeviceRouter(pool: Pool) {
  const router = express.Router();
  router.post('/pair', async (request, response) => {
    const code: unknown = request.body?.code;
    if (typeof code !== 'string' || !/^[A-Fa-f0-9]{32}$/.test(code))
      fail(400, 'INVALID_CODE', '학생 웹에서 발급한 32자리 코드를 입력하세요.');
    const token = randomBytes(32).toString('base64url');
    const device = await transaction(pool, async (client) => {
      const current = await validBrowser(client, digest(code.toUpperCase()), 'code_hash');
      await client.query(
        'UPDATE classroom_browser_connections SET code_hash=NULL,token_hash=$2 WHERE id=$1',
        [current.id, digest(token)],
      );
      await client.query(
        `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
        VALUES($1,$2,'participant',$3,'browser.paired','success')`,
        [randomUUID(), current.class_id, current.participant_id],
      );
      return { id: current.id, name: current.name };
    });
    response.status(201).json({ token, device });
  });
  router.use(async (request, response, next) => {
    const header = request.get('authorization');
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
      fail(401, 'BROWSER_SESSION_REQUIRED', '확장 연결이 필요합니다.');
    response.locals.browserHash = digest(header.slice(7));
    next();
  });
  router.post('/sync', async (_request, response) => {
    response.json(
      await transaction(pool, async (client) => {
        const current = await validBrowser(client, response.locals.browserHash, 'token_hash');
        await client.query(
          'UPDATE classroom_browser_connections SET last_seen_at=statement_timestamp() WHERE id=$1',
          [current.id],
        );
        const blocking = await blockingSnapshot(client, current.class_id);
        const focus = await client.query<{ voluntary_focus: boolean }>(
          'SELECT voluntary_focus FROM classes WHERE id=$1',
          [current.class_id],
        );
        return { materials: [], focusMode: focus.rows[0].voluntary_focus, blocking };
      }),
    );
  });
  router.post('/disconnect', async (_request, response) => {
    await transaction(pool, async (client) => {
      const current = await validBrowser(client, response.locals.browserHash, 'token_hash');
      await client.query(
        'UPDATE classroom_browser_connections SET token_hash=NULL,revoked_at=statement_timestamp() WHERE id=$1',
        [current.id],
      );
      await client.query(
        `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
        VALUES($1,$2,'participant',$3,'browser.disconnected','success')`,
        [randomUUID(), current.class_id, current.participant_id],
      );
    });
    response.sendStatus(204);
  });
  router.use((_request, _response) => fail(404, 'NOT_FOUND', '요청한 학생 확장 API가 없습니다.'));
  return router;
}
