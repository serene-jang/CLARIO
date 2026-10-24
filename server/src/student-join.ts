import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Pool, PoolClient } from 'pg';
import {
  classroomPolicy,
  normalizeStudentInformation,
  type StudentJoinInput,
  type StudentJoinReview,
} from '@clario/shared';
import { digest, fail, id, transaction } from './api-core.js';
import { audit, manager } from './classroom-management.js';
import { disconnectStudent, issuePendingStudentCredential } from './student-sessions.js';

export async function joinRateSecret(pool: Pool) {
  const result = await pool.query<{ secret: string }>(
    'SELECT secret FROM student_join_rate_secret WHERE singleton',
  );
  if (!result.rows[0]) throw new Error('Student join rate secret is missing. Run migrations.');
  return result.rows[0].secret;
}
const mac = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('hex');

export function browserIdentifier(secret: string, raw: string | undefined) {
  if (raw && /^[A-Za-z0-9_-]{43}\.[0-9a-f]{64}$/.test(raw)) {
    const [value, signature] = raw.split('.');
    if (timingSafeEqual(Buffer.from(signature), Buffer.from(mac(secret, `browser:${value}`))))
      return raw;
  }
  const value = randomBytes(32).toString('base64url');
  return `${value}.${mac(secret, `browser:${value}`)}`;
}

// This transaction commits rejected attempts too; a later join rollback cannot reset the budget.
export async function consumeJoinBudget(
  pool: Pool,
  secret: string,
  browser: string,
  ip: string,
  code: string,
) {
  return transaction(pool, async (client) => {
    const keys = [
      {
        key: mac(secret, `browser-budget:${browser}`),
        maximum: classroomPolicy.joinAttemptsPerBrowser,
      },
      { key: mac(secret, `ip-budget:${ip}`), maximum: classroomPolicy.joinAttemptsPerIp },
      { key: mac(secret, `code-budget:${code}`), maximum: classroomPolicy.joinAttemptsPerCode },
    ].sort((a, b) => a.key.localeCompare(b.key));
    for (const item of keys)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [item.key]);
    await client.query(
      "DELETE FROM student_join_rate_events WHERE attempted_at<=statement_timestamp()-interval '15 minutes'",
    );
    let retry = 0;
    for (const item of keys) {
      const result = await client.query<{ count: string; retry: number }>(
        `SELECT count(*) AS count,COALESCE(ceil(EXTRACT(EPOCH FROM
          min(attempted_at)+interval '15 minutes'-statement_timestamp())),0)::integer AS retry
         FROM student_join_rate_events WHERE key_hash=$1 AND attempted_at>statement_timestamp()-interval '15 minutes'`,
        [item.key],
      );
      if (Number(result.rows[0].count) >= item.maximum)
        retry = Math.max(retry, result.rows[0].retry, 1);
    }
    if (!retry)
      for (const item of keys)
        await client.query('INSERT INTO student_join_rate_events(key_hash) VALUES($1)', [item.key]);
    return retry;
  });
}

export function parseJoinInput(body: unknown): StudentJoinInput {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !('code' in body) ||
    !('name' in body) ||
    !('studentNumber' in body) ||
    !('kind' in body) ||
    Object.keys(body).some((key) => !['code', 'name', 'studentNumber', 'kind'].includes(key))
  ) {
    fail(400, 'INVALID_INPUT', '초대코드·이름·학번과 신청 종류를 확인해 주세요.');
  }
  const info = normalizeStudentInformation({ name: body.name, studentNumber: body.studentNumber });
  if (!info.ok) fail(400, 'INVALID_INPUT', info.error);
  if (
    typeof body.code !== 'string' ||
    !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(body.code.trim().toUpperCase()) ||
    (body.kind !== 'join' && body.kind !== 'recovery')
  ) {
    fail(400, 'INVALID_INPUT', '12자리 초대코드와 신청 종류를 확인해 주세요.');
  }
  return { ...info.value, code: body.code.trim().toUpperCase(), kind: body.kind };
}

export async function createStudentJoin(client: PoolClient, input: StudentJoinInput) {
  const found = await client.query<{ class_id: string }>(
    'SELECT class_id FROM classroom_invitations WHERE code_hash=$1',
    [digest(input.code)],
  );
  const classroom = found.rows[0]?.class_id;
  if (!classroom)
    fail(
      400,
      'INVITATION_UNAVAILABLE',
      '유효한 초대코드를 확인할 수 없습니다. 교사에게 확인해 주세요.',
    );
  await client.query('SELECT id FROM classes WHERE id=$1 FOR UPDATE', [classroom]);
  const invitation = await client.query<{ id: string }>(
    `SELECT i.id FROM classroom_invitations i JOIN classes c ON c.id=i.class_id
     WHERE i.code_hash=$1 AND i.revoked_at IS NULL AND i.expires_at>statement_timestamp()
       AND c.closed_at IS NULL AND c.archived_at IS NULL AND c.approval_required`,
    [digest(input.code)],
  );
  if (!invitation.rows[0])
    fail(
      400,
      'INVITATION_UNAVAILABLE',
      '유효한 초대코드를 확인할 수 없습니다. 교사에게 확인해 주세요.',
    );
  const count = await client.query<{ count: string }>(
    "SELECT count(*) FROM classroom_join_requests WHERE class_id=$1 AND status='pending' AND expires_at>statement_timestamp()",
    [classroom],
  );
  if (Number(count.rows[0].count) >= classroomPolicy.maximumPendingRequests)
    fail(
      429,
      'JOIN_QUEUE_FULL',
      '교실의 승인 대기가 가득 찼습니다. 교사에게 확인 후 다시 신청해 주세요.',
    );
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM classroom_participants WHERE class_id=$1 AND student_number=$2',
    [classroom, input.studentNumber],
  );
  const participant = input.kind === 'recovery' ? existing.rows[0]?.id : undefined;
  if (
    existing.rows[0] &&
    (
      await client.query('SELECT id FROM participant_erasure_requests WHERE participant_id=$1', [
        existing.rows[0].id,
      ])
    ).rowCount
  )
    fail(
      400,
      'INVITATION_UNAVAILABLE',
      '유효한 초대코드를 확인할 수 없습니다. 교사에게 확인해 주세요.',
    );
  const request = randomUUID();
  await client.query(
    `INSERT INTO classroom_join_requests(id,class_id,invitation_id,kind,participant_id,name,student_number,created_at,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,statement_timestamp(),statement_timestamp()+interval '30 minutes')`,
    [
      request,
      classroom,
      invitation.rows[0].id,
      participant ? 'recovery' : 'join',
      participant ?? null,
      input.name,
      input.studentNumber,
    ],
  );
  const credential = await issuePendingStudentCredential(client, request);
  await client.query(
    `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,request_id,action,result)
    VALUES($1,$2,'request',$3,'student.join_requested','success')`,
    [randomUUID(), classroom, request],
  );
  return credential;
}

async function requests(client: PoolClient, classroom: string) {
  const result = await client.query<StudentJoinReview>(
    `SELECT r.id,r.name,r.student_number AS "studentNumber",r.kind,r.status,
       r.created_at AS "createdAt",r.expires_at AS "expiresAt",r.expires_at<=statement_timestamp() AS expired,
       p.status AS "existingStatus",
       CASE WHEN NOT EXISTS(SELECT 1 FROM classroom_roster_entries WHERE class_id=r.class_id) THEN 'not_configured'
         WHEN roster.id IS NULL THEN 'not_found' WHEN roster.name=r.name THEN 'match' ELSE 'number_only' END AS "rosterMatch"
     FROM classroom_join_requests r
     LEFT JOIN classroom_participants p ON p.class_id=r.class_id AND p.student_number=r.student_number
     LEFT JOIN classroom_roster_entries roster ON roster.class_id=r.class_id AND roster.student_number=r.student_number
     WHERE r.class_id=$1 AND r.expires_at>statement_timestamp()
     ORDER BY (r.status='pending') DESC,r.created_at DESC,r.id LIMIT 200`,
    [classroom],
  );
  return result.rows;
}

export function studentReviewRouter(pool: Pool) {
  const router = express.Router();
  router.get('/:classroomId/requests', async (request, response) => {
    const classroom = id(request.params.classroomId);
    response.json(
      await transaction(pool, async (client) => {
        const user = await manager(client, response.locals.identityTokenHash, classroom, false);
        await audit(client, classroom, user, 'classroom.requests_viewed');
        return { requests: await requests(client, classroom) };
      }),
    );
  });
  router.post('/:classroomId/requests/:requestId/:action', async (request, response) => {
    const classroom = id(request.params.classroomId),
      requestId = id(request.params.requestId),
      action = request.params.action;
    if (!['approve', 'reject'].includes(action))
      fail(404, 'NOT_FOUND', '요청한 승인 작업이 없습니다.');
    if (
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body) ||
      Object.keys(request.body).some((key) => key !== 'confirmRecovery') ||
      ('confirmRecovery' in request.body && typeof request.body.confirmRecovery !== 'boolean')
    )
      fail(400, 'INVALID_INPUT', '승인 확인 형식이 올바르지 않습니다.');
    response.json(
      await transaction(pool, async (client) => {
        const user = await manager(client, response.locals.identityTokenHash, classroom, true);
        const found = await client.query<{
          kind: string;
          name: string;
          student_number: string;
          participant_id: string | null;
          status: string;
          expired: boolean;
          credential_active: boolean;
        }>(
          `SELECT r.*,r.expires_at<=statement_timestamp() AS expired,EXISTS(
           SELECT 1 FROM student_participation_sessions s WHERE s.request_id=r.id AND s.revoked_at IS NULL
             AND s.expires_at>statement_timestamp() AND s.idle_expires_at>statement_timestamp()) AS credential_active
         FROM classroom_join_requests r WHERE r.id=$1 AND r.class_id=$2`,
          [requestId, classroom],
        );
        const row = found.rows[0];
        if (!row) fail(404, 'NOT_FOUND', '교실 신청을 찾을 수 없습니다.');
        if (row.status !== 'pending' || row.expired || !row.credential_active)
          fail(
            409,
            'REQUEST_UNAVAILABLE',
            '신청이 만료되었거나 이미 처리되었습니다. 다시 확인해 주세요.',
          );
        if (action === 'reject') {
          await client.query(
            "UPDATE classroom_join_requests SET status='rejected',resolved_by=$2,resolved_at=statement_timestamp() WHERE id=$1",
            [requestId, user],
          );
        } else {
          const current = await client.query<{ id: string; status: string }>(
            'SELECT id,status FROM classroom_participants WHERE class_id=$1 AND student_number=$2',
            [classroom, row.student_number],
          );
          const participant = current.rows[0];
          if (
            participant &&
            (
              await client.query(
                'SELECT id FROM participant_erasure_requests WHERE participant_id=$1',
                [participant.id],
              )
            ).rowCount
          )
            fail(409, 'PRIVACY_HOLD', '삭제 요청이 정책 승인 대기 중인 학생은 복구할 수 없습니다.');
          if (participant && row.kind !== 'recovery' && participant.status !== 'left')
            fail(
              409,
              'RECOVERY_REQUIRED',
              '기존 참여가 있습니다. 학생이 복구 신청을 하고 교사가 본인을 확인해야 합니다.',
            );
          if (row.kind === 'recovery' && request.body.confirmRecovery !== true)
            fail(
              409,
              'RECOVERY_CONFIRMATION_REQUIRED',
              '복구 대상 본인을 확인한 뒤 기존 자격 종료를 명시적으로 확인해 주세요.',
            );
          const count = await client.query<{ capacity: number; occupied: string }>(
            `SELECT capacity,(SELECT count(*) FROM class_members WHERE class_id=$1)+
           (SELECT count(*) FROM classroom_participants WHERE class_id=$1 AND status='approved') AS occupied FROM classes WHERE id=$1`,
            [classroom],
          );
          if (
            participant?.status !== 'approved' &&
            Number(count.rows[0].occupied) >= count.rows[0].capacity
          )
            fail(409, 'CAPACITY_EXCEEDED', '교실 정원이 가득 찼습니다.');
          const participantId = participant?.id ?? randomUUID();
          if (participant) {
            await client.query(
              `UPDATE classroom_participants SET name=$2,status='approved',approved_by=$3,
            approved_at=statement_timestamp(),updated_at=statement_timestamp(),credential_generation=credential_generation+1 WHERE id=$1`,
              [participantId, row.name, user],
            );
            await client.query(
              'UPDATE student_participation_sessions SET revoked_at=statement_timestamp() WHERE participant_id=$1 AND revoked_at IS NULL',
              [participantId],
            );
            await disconnectStudent(client, participantId);
          } else {
            await client.query(
              `INSERT INTO classroom_participants(id,class_id,name,student_number,approved_by,approved_at)
            VALUES($1,$2,$3,$4,$5,statement_timestamp())`,
              [participantId, classroom, row.name, row.student_number, user],
            );
          }
          // A previous approved-but-unclaimed request must not steal a later recovery credential.
          await client.query(
            `UPDATE classroom_join_requests SET status='cancelled',resolved_at=statement_timestamp()
          WHERE class_id=$1 AND participant_id=$2 AND status='approved' AND id<>$3`,
            [classroom, participantId, requestId],
          );
          await client.query(
            `UPDATE classroom_join_requests SET status='approved',participant_id=$2,resolved_by=$3,
          resolved_at=statement_timestamp() WHERE id=$1`,
            [requestId, participantId, user],
          );
        }
        await audit(
          client,
          classroom,
          user,
          action === 'reject'
            ? 'classroom.request_rejected'
            : row.kind === 'recovery'
              ? 'classroom.recovery_approved'
              : 'classroom.request_approved',
        );
        return { requests: await requests(client, classroom) };
      }),
    );
  });
  return router;
}
