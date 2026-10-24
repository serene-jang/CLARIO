import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ManagedStudentParticipant, ParticipantListResponse } from '@clario/shared';
import { audit, manager } from './classroom-management.js';
import { fail, id, transaction } from './api-core.js';
import { disconnectStudent } from './student-sessions.js';

const sorts = {
  name: 'p.name',
  studentNumber: 'p.student_number',
  status: 'p.status',
  approvedAt: 'p.approved_at',
} as const;

function queryOptions(query: Record<string, unknown>) {
  if (
    Object.keys(query).some(
      (key) => !['search', 'status', 'sort', 'direction', 'page'].includes(key),
    )
  ) {
    fail(400, 'INVALID_INPUT', '지원하지 않는 학생 목록 조건입니다.');
  }
  const {
    search = '',
    status = 'all',
    sort = 'studentNumber',
    direction = 'asc',
    page = '1',
  } = query;
  if (
    typeof search !== 'string' ||
    Array.from(search.normalize('NFC').trim()).length > 100 ||
    typeof status !== 'string' ||
    !['all', 'approved', 'left', 'removed', 'blocked'].includes(status) ||
    typeof sort !== 'string' ||
    !Object.hasOwn(sorts, sort) ||
    (direction !== 'asc' && direction !== 'desc') ||
    typeof page !== 'string' ||
    !/^[1-9][0-9]{0,5}$/.test(page)
  ) {
    fail(400, 'INVALID_INPUT', '검색어·참여 상태·정렬·페이지를 확인해 주세요.');
  }
  return {
    search: search.normalize('NFC').trim(),
    status,
    sort: sort as keyof typeof sorts,
    direction,
    page: Number(page),
  };
}
const participantProjection = `
 SELECT p.id,p.class_id AS "classroomId",p.name,p.student_number AS "studentNumber",p.status,
   p.credential_generation AS "credentialGeneration",p.approved_at AS "approvedAt",
   p.updated_at AS "updatedAt",'unavailable' AS "connectionState",
   (SELECT requested_at FROM participant_erasure_requests WHERE participant_id=p.id) AS "erasureRequestedAt",
   CASE WHEN NOT EXISTS(SELECT 1 FROM classroom_roster_entries WHERE class_id=p.class_id) THEN 'not_configured'
     WHEN roster.id IS NULL THEN 'not_found' WHEN roster.name=p.name THEN 'match' ELSE 'number_only' END AS "rosterMatch"
 FROM classroom_participants p LEFT JOIN classroom_roster_entries roster
   ON roster.class_id=p.class_id AND roster.student_number=p.student_number`;

async function participant(client: PoolClient, classroom: string, participantId: string) {
  const found = await client.query<ManagedStudentParticipant>(
    `${participantProjection} WHERE p.class_id=$1 AND p.id=$2`,
    [classroom, participantId],
  );
  if (!found.rows[0]) fail(404, 'NOT_FOUND', '해당 교실의 참여 학생을 찾을 수 없습니다.');
  return found.rows[0];
}

export function participantManagementRouter(pool: Pool) {
  const router = express.Router();
  router.get('/:classroomId/participants', async (request, response) => {
    const classroom = id(request.params.classroomId),
      options = queryOptions(request.query);
    response.json(
      await transaction(pool, async (client): Promise<ParticipantListResponse> => {
        const user = await manager(client, response.locals.identityTokenHash, classroom, false);
        const filter = `p.class_id=$1 AND ($2='all' OR p.status=$2)
        AND ($3='' OR strpos(lower(p.name),lower($3))>0 OR strpos(p.student_number,$3)>0)`;
        const values = [classroom, options.status, options.search];
        const count = await client.query<{ count: string }>(
          `SELECT count(*) FROM classroom_participants p WHERE ${filter}`,
          values,
        );
        const result = await client.query<ManagedStudentParticipant>(
          `${participantProjection} WHERE ${filter}
         ORDER BY ${sorts[options.sort]} ${options.direction === 'desc' ? 'DESC' : 'ASC'},p.id ASC LIMIT 50 OFFSET $4`,
          [...values, (options.page - 1) * 50],
        );
        await audit(client, classroom, user, 'classroom.participants_viewed');
        return {
          participants: result.rows,
          total: Number(count.rows[0].count),
          page: options.page,
          pageSize: 50,
        };
      }),
    );
  });
  router.post('/:classroomId/participants/:participantId/:action', async (request, response) => {
    const classroom = id(request.params.classroomId),
      participantId = id(request.params.participantId),
      action = request.params.action;
    if (action !== 'remove' && action !== 'block' && action !== 'request-erasure')
      fail(404, 'NOT_FOUND', '지원하지 않는 학생 관리 작업입니다.');
    const body: unknown = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !('confirm' in body) ||
      body.confirm !== true ||
      !('expectedGeneration' in body) ||
      typeof body.expectedGeneration !== 'number' ||
      !Number.isSafeInteger(body.expectedGeneration) ||
      body.expectedGeneration < 1 ||
      Object.keys(body).some((key) => !['confirm', 'expectedGeneration'].includes(key))
    ) {
      fail(400, 'INVALID_INPUT', '학생과 접근 철회 내용을 확인하고 최신 목록에서 요청해 주세요.');
    }
    response.json(
      await transaction(pool, async (client) => {
        const user = await manager(
          client,
          response.locals.identityTokenHash,
          classroom,
          action !== 'request-erasure',
        );
        const current = await participant(client, classroom, participantId);
        if (current.credentialGeneration !== body.expectedGeneration)
          fail(
            409,
            'PARTICIPANT_CHANGED',
            '학생 상태가 변경되었습니다. 목록을 다시 확인해 주세요.',
          );
        const status = action === 'remove' ? 'removed' : 'blocked';
        if (action === 'request-erasure' && !current.erasureRequestedAt) {
          await client.query(
            `INSERT INTO participant_erasure_requests(id,class_id,participant_id,requested_by)
             VALUES($1,$2,$3,$4)`,
            [randomUUID(), classroom, participantId, user],
          );
          await audit(client, classroom, user, 'privacy.erasure_requested');
          await client.query(
            `INSERT INTO audit_logs(actor_id,action,target_id,result)
             VALUES($1,'privacy.erasure_requested',$2,'success')`,
            [user, participantId],
          );
        }
        if (current.status === 'blocked' && status === 'removed')
          fail(
            409,
            'RECOVERY_REQUIRED',
            '차단된 학생은 명시적 복구 승인으로만 다시 참여할 수 있습니다.',
          );
        if (
          current.status !== status ||
          (action === 'request-erasure' && !current.erasureRequestedAt)
        ) {
          await client.query(
            `UPDATE classroom_participants SET status=$2,credential_generation=credential_generation+1,
          updated_at=statement_timestamp() WHERE id=$1`,
            [participantId, status],
          );
          // Pre-existing recovery approvals/requests cannot undo a later teacher revocation.
          await client.query(
            `UPDATE classroom_join_requests SET status='cancelled',resolved_at=statement_timestamp(),resolved_by=$3
          WHERE class_id=$1 AND student_number=$2 AND status IN ('pending','approved')`,
            [classroom, current.studentNumber, user],
          );
          await client.query(
            `UPDATE student_participation_sessions SET revoked_at=statement_timestamp()
          WHERE class_id=$1 AND revoked_at IS NULL AND (participant_id=$2 OR request_id IN
            (SELECT id FROM classroom_join_requests WHERE class_id=$1 AND student_number=$3))`,
            [classroom, participantId, current.studentNumber],
          );
          await disconnectStudent(client, participantId);
          const actionName =
            status === 'blocked'
              ? 'classroom.participant_blocked'
              : 'classroom.participant_removed';
          await audit(client, classroom, user, actionName);
          await client.query(
            `INSERT INTO audit_logs(actor_id,action,target_id,result) VALUES($1,$2,$3,'success')`,
            [user, actionName, participantId],
          );
        }
        return { participant: await participant(client, classroom, participantId) };
      }),
    );
  });
  return router;
}
