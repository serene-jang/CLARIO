import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import type { Pool, PoolClient } from 'pg';
import {
  classroomPolicy,
  normalizeStudentInformation,
  type ClassroomRosterEntry,
  type ManagedClassroom,
  type IssuedClassroomInvitation,
} from '@clario/shared';
import { digest, fail, id, text, transaction } from './api-core.js';
import { resetFocus } from './focus-state.js';

// Shared by the identity list and management authorization; stale legacy mirrors grant nothing.
export const identityClassroomAccess = `
 SELECT c.id,c.name,
   CASE WHEN (u.role='school_admin' AND u.school_id=c.school_id)
     THEN 'manager' ELSE m.role END AS role
 FROM classes c JOIN users u ON u.id=$1
 LEFT JOIN classroom_memberships m ON m.class_id=c.id AND m.user_id=u.id
 WHERE u.active AND (
   (u.role='school_admin' AND u.school_id=c.school_id) OR
   (m.status='approved' AND (
     m.source='direct' OR
     (m.source='legacy_teacher' AND u.role='teacher'
       AND c.teacher_id=u.id AND c.school_id=u.school_id) OR
     (m.source='legacy_student' AND u.role='student' AND c.school_id=u.school_id
       AND EXISTS (SELECT 1 FROM class_members old WHERE old.class_id=c.id AND old.student_id=u.id))
   ))
 )`;

async function activeUser(client: PoolClient, tokenHash: string) {
  const result = await client.query<{ id: string }>(
    `SELECT u.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>statement_timestamp() AND u.active`,
    [tokenHash],
  );
  if (!result.rows[0]) fail(401, 'SESSION_EXPIRED', '로그인이 만료되었습니다.');
  return result.rows[0].id;
}

export async function manager(
  client: PoolClient,
  tokenHash: string,
  classroom: string,
  open: boolean,
) {
  const locked = await client.query<{ closed_at: Date | null; archived_at: Date | null }>(
    'SELECT closed_at,archived_at FROM classes WHERE id=$1 FOR UPDATE',
    [classroom],
  );
  const user = await activeUser(client, tokenHash);
  const access = await client.query(
    `SELECT 1 FROM (${identityClassroomAccess}) access WHERE id=$2 AND role='manager'`,
    [user, classroom],
  );
  if (!access.rowCount || !locked.rows[0])
    fail(404, 'NOT_FOUND', '관리할 수 있는 교실이 없습니다.');
  if (open && (locked.rows[0].closed_at || locked.rows[0].archived_at)) {
    fail(409, 'CLASSROOM_CLOSED', '종료되거나 보관된 교실은 변경할 수 없습니다.');
  }
  return user;
}

export async function audit(
  client: PoolClient,
  classroom: string,
  teacher: string,
  action: string,
) {
  await client.query(
    `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,teacher_id,action,result)
     VALUES($1,$2,'teacher',$3,$4,'success')`,
    [randomUUID(), classroom, teacher, action],
  );
}

export function generateInvitationCode() {
  // The 32-symbol alphabet makes each byte's low five bits unbiased.
  return Array.from(
    randomBytes(classroomPolicy.invitationLength),
    (byte) => classroomPolicy.invitationAlphabet[byte & 31],
  ).join('');
}

// The caller owns the classroom row lock (or has just inserted the classroom).
export async function issueClassroomInvitation(
  client: PoolClient,
  classroom: string,
  teacher: string,
  generate: () => string = generateInvitationCode,
): Promise<IssuedClassroomInvitation> {
  await client.query(
    'UPDATE classroom_invitations SET revoked_at=statement_timestamp() WHERE class_id=$1 AND revoked_at IS NULL',
    [classroom],
  );
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generate();
    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO classroom_invitations(id,class_id,code_hash,issued_by,created_at,expires_at)
       VALUES($1,$2,$3,$4,statement_timestamp(),statement_timestamp()+interval '24 hours')
       ON CONFLICT(code_hash) DO NOTHING RETURNING id,expires_at`,
      [randomUUID(), classroom, digest(code), teacher],
    );
    if (inserted.rows[0])
      return {
        id: inserted.rows[0].id,
        code,
        expiresAt: inserted.rows[0].expires_at.toISOString(),
      };
  }
  fail(503, 'INVITATION_UNAVAILABLE', '초대코드 발급에 실패했습니다. 잠시 후 다시 시도해 주세요.');
}

async function detail(client: PoolClient, classroom: string): Promise<ManagedClassroom> {
  const result = await client.query<{
    id: string;
    name: string;
    capacity: number;
    closed_at: Date | null;
    archived_at: Date | null;
  }>('SELECT id,name,capacity,closed_at,archived_at FROM classes WHERE id=$1', [classroom]);
  const row = result.rows[0];
  const invitation = await client.query<{
    id: string;
    expires_at: Date;
    revoked_at: Date | null;
    active: boolean;
  }>(
    `SELECT id,expires_at,revoked_at,expires_at>statement_timestamp() AS active
     FROM classroom_invitations WHERE class_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [classroom],
  );
  const code = invitation.rows[0];
  const roster = await client.query<ClassroomRosterEntry>(
    'SELECT id,name,student_number AS "studentNumber" FROM classroom_roster_entries WHERE class_id=$1 ORDER BY student_number,id',
    [classroom],
  );
  return {
    id: row.id,
    name: row.name,
    capacity: row.capacity,
    approvalRequired: true,
    closedAt: row.closed_at?.toISOString() ?? null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    invitation: {
      id: code?.id ?? null,
      expiresAt: code?.expires_at.toISOString() ?? null,
      status: !code ? 'none' : code.revoked_at ? 'revoked' : code.active ? 'active' : 'expired',
    },
    roster: roster.rows,
  };
}

function settings(body: unknown, create: boolean) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    fail(400, 'INVALID_INPUT', '교실 설정이 필요합니다.');
  if (Object.keys(body).some((key) => !['name', 'capacity'].includes(key))) {
    fail(400, 'INVALID_INPUT', '교실 이름과 정원만 변경할 수 있습니다. 교사 승인은 필수입니다.');
  }
  const name = 'name' in body ? text(body.name, 100) : undefined;
  const capacity =
    'capacity' in body ? body.capacity : create ? classroomPolicy.defaultCapacity : undefined;
  if (
    (create && name === undefined) ||
    (name === undefined && capacity === undefined) ||
    (capacity !== undefined &&
      (typeof capacity !== 'number' ||
        !Number.isInteger(capacity) ||
        capacity < 1 ||
        capacity > classroomPolicy.maximumCapacity))
  ) {
    fail(400, 'INVALID_INPUT', '교실 이름과 1~100명의 정수를 입력해 주세요.');
  }
  return { name, capacity };
}
function studentInformation(body: unknown) {
  if (!body || typeof body !== 'object' || !('name' in body) || !('studentNumber' in body)) {
    fail(400, 'INVALID_INPUT', '이름과 학번을 입력해 주세요.');
  }
  const result = normalizeStudentInformation({
    name: body.name,
    studentNumber: body.studentNumber,
  });
  if (!result.ok) fail(400, 'INVALID_INPUT', result.error);
  return result.value;
}

export async function stopClassroom(
  client: PoolClient,
  classroom: string,
  user: string,
  archive: boolean,
) {
  await resetFocus(client, classroom, user);
  await client.query(
    `UPDATE classes SET closed_at=COALESCE(closed_at,statement_timestamp()),
     archived_at=CASE WHEN $2 THEN COALESCE(archived_at,statement_timestamp()) ELSE archived_at END,
     voluntary_focus=false WHERE id=$1`,
    [classroom, archive],
  );
  await client.query(
    'UPDATE classroom_invitations SET revoked_at=statement_timestamp() WHERE class_id=$1 AND revoked_at IS NULL',
    [classroom],
  );
  await client.query(
    `UPDATE classroom_join_requests SET status='cancelled',resolved_at=statement_timestamp()
     WHERE class_id=$1 AND status='pending'`,
    [classroom],
  );
  await client.query(
    'UPDATE student_participation_sessions SET revoked_at=statement_timestamp() WHERE class_id=$1 AND revoked_at IS NULL',
    [classroom],
  );
  await client.query(
    `UPDATE classroom_participant_connections SET disconnected_at=statement_timestamp()
     WHERE class_id=$1 AND disconnected_at IS NULL`,
    [classroom],
  );
  await client.query(
    'UPDATE classroom_participant_attendance SET left_at=statement_timestamp() WHERE class_id=$1 AND left_at IS NULL',
    [classroom],
  );
  await client.query(
    'UPDATE classroom_connections SET disconnected_at=statement_timestamp() WHERE class_id=$1 AND disconnected_at IS NULL',
    [classroom],
  );
  await client.query(
    'UPDATE classroom_session_members SET left_at=statement_timestamp() WHERE class_id=$1 AND left_at IS NULL',
    [classroom],
  );
  await client.query(
    `UPDATE classroom_sessions SET ended_at=statement_timestamp(),ended_by=$2
     WHERE class_id=$1 AND ended_at IS NULL`,
    [classroom, user],
  );
  await client.query(
    `DELETE FROM device_pairings p USING registered_devices d
     WHERE p.device_id=d.id AND d.class_id=$1`,
    [classroom],
  );
  await client.query(
    `UPDATE registered_devices SET credential_hash=NULL,credential_expires_at=NULL,last_seen_at=NULL
     WHERE class_id=$1`,
    [classroom],
  );
}

export function classroomManagementRouter(pool: Pool) {
  const router = express.Router();
  router.post('/', async (request, response) => {
    const input = settings(request.body, true);
    const result = await transaction(pool, async (client) => {
      const user = await activeUser(client, response.locals.identityTokenHash);
      const classroom = randomUUID();
      await client.query('INSERT INTO classes(id,teacher_id,name,capacity) VALUES($1,$2,$3,$4)', [
        classroom,
        user,
        input.name,
        input.capacity,
      ]);
      await client.query(
        `INSERT INTO classroom_memberships(class_id,user_id,role,status,approved_by)
         VALUES($1,$2,'manager','approved',$2)`,
        [classroom, user],
      );
      const invitation = await issueClassroomInvitation(client, classroom, user);
      await audit(client, classroom, user, 'classroom.created');
      await audit(client, classroom, user, 'classroom.invitation_issued');
      return { classroom: await detail(client, classroom), invitation };
    });
    response.status(201).json(result);
  });
  router.get('/:classroomId', async (request, response) => {
    const classroom = id(request.params.classroomId);
    response.json(
      await transaction(pool, async (client) => {
        const user = await manager(client, response.locals.identityTokenHash, classroom, false);
        await audit(client, classroom, user, 'classroom.viewed');
        return { classroom: await detail(client, classroom) };
      }),
    );
  });
  router.patch('/:classroomId', async (request, response) => {
    const classroom = id(request.params.classroomId),
      input = settings(request.body, false);
    response.json(
      await transaction(pool, async (client) => {
        const user = await manager(client, response.locals.identityTokenHash, classroom, true);
        if (input.capacity !== undefined) {
          const count = await client.query<{ count: string }>(
            `SELECT
          (SELECT count(*) FROM class_members WHERE class_id=$1)+
          (SELECT count(*) FROM classroom_participants WHERE class_id=$1 AND status='approved') AS count`,
            [classroom],
          );
          if (Number(count.rows[0].count) > input.capacity)
            fail(409, 'CAPACITY_EXCEEDED', '현재 승인 학생 수보다 정원을 줄일 수 없습니다.');
        }
        await client.query(
          'UPDATE classes SET name=COALESCE($2,name),capacity=COALESCE($3,capacity) WHERE id=$1',
          [classroom, input.name, input.capacity],
        );
        await audit(client, classroom, user, 'classroom.updated');
        return { classroom: await detail(client, classroom) };
      }),
    );
  });
  router.post('/:classroomId/invitations', async (request, response) => {
    const classroom = id(request.params.classroomId);
    response.status(201).json(
      await transaction(pool, async (client) => {
        const user = await manager(client, response.locals.identityTokenHash, classroom, true);
        const invitation = await issueClassroomInvitation(client, classroom, user);
        await audit(client, classroom, user, 'classroom.invitation_issued');
        return { classroom: await detail(client, classroom), invitation };
      }),
    );
  });
  router.delete('/:classroomId/invitations', async (request, response) => {
    const classroom = id(request.params.classroomId);
    response.json(
      await transaction(pool, async (client) => {
        const user = await manager(client, response.locals.identityTokenHash, classroom, true);
        await client.query(
          'UPDATE classroom_invitations SET revoked_at=statement_timestamp() WHERE class_id=$1 AND revoked_at IS NULL',
          [classroom],
        );
        await audit(client, classroom, user, 'classroom.invitation_revoked');
        return { classroom: await detail(client, classroom) };
      }),
    );
  });
  router.get('/:classroomId/roster', async (request, response) => {
    const classroom = id(request.params.classroomId);
    response.json(
      await transaction(pool, async (client) => {
        const user = await manager(client, response.locals.identityTokenHash, classroom, false);
        await audit(client, classroom, user, 'classroom.roster_viewed');
        return { roster: (await detail(client, classroom)).roster };
      }),
    );
  });
  for (const method of ['post', 'patch', 'delete'] as const) {
    router[method](
      `/:classroomId/roster${method === 'post' ? '' : '/:entryId'}`,
      async (request, response) => {
        const classroom = id(request.params.classroomId);
        const entry =
          method === 'post'
            ? randomUUID()
            : id('entryId' in request.params ? request.params.entryId : undefined);
        const input = method === 'delete' ? undefined : studentInformation(request.body);
        const result = await transaction(pool, async (client) => {
          const user = await manager(client, response.locals.identityTokenHash, classroom, true);
          if (input) {
            const duplicate = await client.query(
              'SELECT id FROM classroom_roster_entries WHERE class_id=$1 AND student_number=$2 AND id<>$3',
              [classroom, input.studentNumber, entry],
            );
            if (duplicate.rowCount)
              fail(409, 'ROSTER_DUPLICATE', '이 교실 명단에 이미 등록된 학번입니다.');
          }
          if (method === 'post' && input) {
            await client.query(
              'INSERT INTO classroom_roster_entries(id,class_id,name,student_number) VALUES($1,$2,$3,$4)',
              [entry, classroom, input.name, input.studentNumber],
            );
          } else {
            const changed =
              method === 'delete'
                ? await client.query(
                    'DELETE FROM classroom_roster_entries WHERE id=$1 AND class_id=$2',
                    [entry, classroom],
                  )
                : await client.query(
                    'UPDATE classroom_roster_entries SET name=$3,student_number=$4,updated_at=statement_timestamp() WHERE id=$1 AND class_id=$2',
                    [entry, classroom, input?.name, input?.studentNumber],
                  );
            if (!changed.rowCount) fail(404, 'NOT_FOUND', '명단 항목을 찾을 수 없습니다.');
          }
          await audit(
            client,
            classroom,
            user,
            `classroom.roster_${method === 'post' ? 'added' : method === 'patch' ? 'updated' : 'deleted'}`,
          );
          return { classroom: await detail(client, classroom) };
        });
        response.status(method === 'post' ? 201 : 200).json(result);
      },
    );
  }
  for (const action of ['close', 'archive'] as const) {
    router.post(`/:classroomId/${action}`, async (request, response) => {
      const classroom = id(request.params.classroomId);
      response.json(
        await transaction(pool, async (client) => {
          const user = await manager(client, response.locals.identityTokenHash, classroom, false);
          await stopClassroom(client, classroom, user, action === 'archive');
          await audit(
            client,
            classroom,
            user,
            action === 'archive' ? 'classroom.archived' : 'classroom.closed',
          );
          return { classroom: await detail(client, classroom) };
        }),
      );
    });
  }
  return router;
}
