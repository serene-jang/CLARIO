import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Pool, PoolClient } from 'pg';
import {
  presencePolicy,
  type ClassroomLesson,
  type ClassroomPresence,
  type TeacherLessonView,
  type StudentLessonView,
} from '@clario/shared';
import { digest, fail, id, transaction } from './api-core.js';
import { audit, manager } from './classroom-management.js';
import { readStudentSession } from './student-sessions.js';
import { resetFocus } from './focus-state.js';

async function currentLesson(
  client: PoolClient,
  classroom: string,
): Promise<ClassroomLesson | null> {
  const result = await client.query<ClassroomLesson>(
    `SELECT id,started_at AS "startedAt"
    FROM classroom_sessions WHERE class_id=$1 AND ended_at IS NULL`,
    [classroom],
  );
  return result.rows[0] ?? null;
}
async function teacherSnapshot(client: PoolClient, classroom: string): Promise<TeacherLessonView> {
  const lesson = await currentLesson(client, classroom);
  const {
    rows: [clock],
  } = await client.query<{ now: Date }>('SELECT statement_timestamp() AS now');
  const students = lesson
    ? (
        await client.query<ClassroomPresence>(
          `
    SELECT p.id,p.name,p.student_number AS "studentNumber",last.last_seen_at AS "lastSeenAt",
      CASE WHEN live.last_seen_at > $3::timestamptz-($4*interval '1 millisecond') THEN 'online'
        WHEN live.last_seen_at IS NOT NULL THEN 'reconnecting' ELSE 'offline' END AS state
    FROM classroom_participants p
    LEFT JOIN LATERAL (
      SELECT max(c.last_seen_at) AS last_seen_at FROM classroom_participant_connections c
      WHERE c.session_id=$2 AND c.participant_id=p.id
    ) last ON true
    LEFT JOIN LATERAL (
      SELECT max(c.last_seen_at) AS last_seen_at FROM classroom_participant_connections c
      WHERE c.session_id=$2 AND c.participant_id=p.id AND c.disconnected_at IS NULL
        AND c.credential_generation=p.credential_generation AND c.lease_expires_at>$3
        AND EXISTS(SELECT 1 FROM student_participation_sessions s WHERE s.participant_id=p.id
          AND s.scope='participant' AND s.generation=p.credential_generation AND s.revoked_at IS NULL
          AND s.expires_at>$3 AND s.idle_expires_at>$3)
    ) live ON true
    WHERE p.class_id=$1 AND p.status='approved' ORDER BY p.student_number,p.id`,
          [classroom, lesson.id, clock.now, presencePolicy.freshMs],
        )
      ).rows
    : [];
  const counts = { online: 0, reconnecting: 0, offline: 0 };
  for (const student of students) counts[student.state]++;
  return { lesson, students, counts, observedAt: clock.now.toISOString() };
}
export function lessonManagementRouter(pool: Pool) {
  const router = express.Router();
  router.get('/:classroomId/lesson', async (request, response) => {
    const classroom = id(request.params.classroomId);
    response.json(
      await transaction(pool, async (client) => {
        await manager(client, response.locals.identityTokenHash, classroom, false);
        return teacherSnapshot(client, classroom);
      }),
    );
  });
  router.post('/:classroomId/lesson/:action', async (request, response) => {
    const classroom = id(request.params.classroomId),
      action = request.params.action;
    if (action !== 'start' && action !== 'end')
      fail(404, 'NOT_FOUND', '지원하지 않는 수업 작업입니다.');
    const body: unknown = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      fail(400, 'INVALID_INPUT', '수업 요청을 확인해 주세요.');
    if (action === 'start' && Object.keys(body).length)
      fail(400, 'INVALID_INPUT', '수업 시작 요청에 추가 정보는 허용하지 않습니다.');
    const sessionId =
      action === 'end' ? id('sessionId' in body ? body.sessionId : undefined) : null;
    if (
      action === 'end' &&
      (!('confirm' in body) ||
        body.confirm !== true ||
        Object.keys(body).some((k) => !['sessionId', 'confirm'].includes(k)))
    ) {
      fail(400, 'INVALID_INPUT', '종료할 수업을 확인해 주세요.');
    }
    response.json(
      await transaction(pool, async (client) => {
        const user = await manager(client, response.locals.identityTokenHash, classroom, true);
        const current = await currentLesson(client, classroom);
        if (action === 'start') {
          if (!current) {
            await resetFocus(client, classroom, user);
            const startedId = randomUUID();
            await client.query(
              'INSERT INTO classroom_sessions(id,class_id,started_by,started_at) VALUES($1,$2,$3,statement_timestamp())',
              [startedId, classroom, user],
            );
            await audit(client, classroom, user, 'classroom.lesson_started');
            await client.query(
              "INSERT INTO audit_logs(actor_id,action,target_id,result) VALUES($1,'classroom.lesson_started',$2,'success')",
              [user, startedId],
            );
          }
        } else {
          // The session identifier prevents a late end from stopping a newer lesson.
          if (current && current.id !== sessionId)
            fail(409, 'LESSON_CHANGED', '수업이 변경되었습니다. 다시 확인해 주세요.');
          const owned = await client.query(
            'SELECT 1 FROM classroom_sessions WHERE id=$1 AND class_id=$2',
            [sessionId, classroom],
          );
          if (!owned.rowCount) fail(404, 'NOT_FOUND', '해당 교실 수업이 없습니다.');
          if (current) {
            await client.query(
              'UPDATE classroom_sessions SET ended_at=statement_timestamp(),ended_by=$2 WHERE id=$1',
              [sessionId, user],
            );
            await resetFocus(client, classroom, user);
            await client.query(
              'UPDATE classroom_invitations SET revoked_at=statement_timestamp() WHERE class_id=$1 AND revoked_at IS NULL',
              [classroom],
            );
            await client.query(
              `UPDATE classroom_join_requests SET status='cancelled',resolved_at=statement_timestamp(),resolved_by=$2
            WHERE class_id=$1 AND status IN ('pending','approved')`,
              [classroom, user],
            );
            await client.query(
              `UPDATE student_participation_sessions SET revoked_at=statement_timestamp()
            WHERE class_id=$1 AND scope='pending' AND revoked_at IS NULL`,
              [classroom],
            );
            await client.query(
              `UPDATE classroom_participant_connections SET disconnected_at=statement_timestamp()
            WHERE session_id=$1 AND disconnected_at IS NULL`,
              [sessionId],
            );
            await client.query(
              `UPDATE classroom_participant_attendance SET left_at=statement_timestamp()
            WHERE session_id=$1 AND left_at IS NULL`,
              [sessionId],
            );
            await client.query(
              `UPDATE classroom_connections SET disconnected_at=statement_timestamp()
            WHERE session_id=$1 AND disconnected_at IS NULL`,
              [sessionId],
            );
            await client.query(
              `UPDATE classroom_session_members SET left_at=statement_timestamp()
            WHERE session_id=$1 AND left_at IS NULL`,
              [sessionId],
            );
            await audit(client, classroom, user, 'classroom.lesson_ended');
            await client.query(
              "INSERT INTO audit_logs(actor_id,action,target_id,result) VALUES($1,'classroom.lesson_ended',$2,'success')",
              [user, sessionId],
            );
          }
        }
        return teacherSnapshot(client, classroom);
      }),
    );
  });
  return router;
}

export async function studentLesson(client: PoolClient, token: string): Promise<StudentLessonView> {
  const current = await readStudentSession(client, token);
  if (current.view.state !== 'participant' || !current.row.participant_id)
    fail(403, 'APPROVAL_REQUIRED', '교사의 참여 승인이 필요합니다.');
  await presenceBudget(client, current.row.participant_id);
  const clock = await client.query<{ now: Date }>('SELECT statement_timestamp() AS now');
  return {
    lesson: await currentLesson(client, current.row.class_id),
    observedAt: clock.rows[0].now.toISOString(),
    expiresAt: current.view.expiresAt,
  };
}
async function presenceBudget(client: PoolClient, participant: string) {
  const key = digest(`lesson-presence:${participant}`);
  await client.query(
    "DELETE FROM student_join_rate_events WHERE key_hash=$1 AND attempted_at<=statement_timestamp()-interval '1 minute'",
    [key],
  );
  const count = await client.query<{ count: string }>(
    'SELECT count(*) FROM student_join_rate_events WHERE key_hash=$1',
    [key],
  );
  if (Number(count.rows[0].count) >= presencePolicy.requestsPerMinute)
    fail(429, 'PRESENCE_RATE_LIMITED', '연결 요청이 너무 많습니다. 잠시 후 다시 확인해 주세요.');
  await client.query(
    'INSERT INTO student_join_rate_events(key_hash,attempted_at) VALUES($1,statement_timestamp())',
    [key],
  );
}
export async function studentHeartbeat(
  client: PoolClient,
  token: string,
  body: unknown,
  disconnect: boolean,
): Promise<StudentLessonView> {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !['sessionId', 'connectionId', 'sequence'].includes(k)) ||
    !('sequence' in body) ||
    typeof body.sequence !== 'number' ||
    !Number.isSafeInteger(body.sequence) ||
    body.sequence < 1 ||
    body.sequence > 2147483647
  )
    fail(400, 'INVALID_INPUT', '연결 식별자와 순서를 확인해 주세요.');
  const sessionId = id('sessionId' in body ? body.sessionId : undefined),
    connectionId = id('connectionId' in body ? body.connectionId : undefined);
  const { row, view } = await readStudentSession(client, token);
  if (view.state !== 'participant' || !row.participant_id)
    fail(403, 'APPROVAL_REQUIRED', '교사의 참여 승인이 필요합니다.');
  await presenceBudget(client, row.participant_id);
  const lesson = await currentLesson(client, row.class_id);
  if (!lesson || lesson.id !== sessionId)
    fail(409, 'LESSON_CHANGED', '현재 수업이 변경되거나 종료되었습니다.');
  const found = await client.query<{
    participant_id: string;
    session_id: string;
    generation: number;
    disconnected_at: Date | null;
  }>(
    'SELECT participant_id,session_id,generation,disconnected_at FROM classroom_participant_connections WHERE id=$1',
    [connectionId],
  );
  const previous = found.rows[0];
  if (
    previous &&
    (previous.participant_id !== row.participant_id || previous.session_id !== sessionId)
  )
    fail(404, 'NOT_FOUND', '본인 수업 연결이 아닙니다.');
  if (previous) {
    if (body.sequence > previous.generation) {
      if (previous.disconnected_at && !disconnect)
        fail(409, 'CONNECTION_CLOSED', '종료된 연결입니다. 새 연결로 다시 확인해 주세요.');
      await client.query(
        `UPDATE classroom_participant_connections SET generation=$2,
        last_seen_at=CASE WHEN $3 THEN last_seen_at ELSE statement_timestamp() END,
        lease_expires_at=CASE WHEN $3 THEN lease_expires_at ELSE statement_timestamp()+($4*interval '1 millisecond') END,
        disconnected_at=CASE WHEN $3 THEN COALESCE(disconnected_at,statement_timestamp()) ELSE NULL END
        WHERE id=$1`,
        [connectionId, body.sequence, disconnect, presencePolicy.leaseMs],
      );
      if (disconnect && !previous.disconnected_at)
        await client.query(
          `INSERT INTO classroom_participation_audit
        (id,class_id,actor_kind,participant_id,action,result) VALUES($1,$2,'participant',$3,'classroom.lesson_disconnected','success')`,
          [randomUUID(), row.class_id, row.participant_id],
        );
    }
  } else {
    const tabs = await client.query<{ count: string }>(
      `SELECT count(*) FROM classroom_participant_connections
      WHERE participant_id=$1 AND session_id=$2 AND credential_generation=$3 AND disconnected_at IS NULL
        AND lease_expires_at>statement_timestamp()`,
      [row.participant_id, sessionId, row.generation],
    );
    if (!disconnect && Number(tabs.rows[0].count) >= presencePolicy.maximumActiveTabs)
      fail(
        429,
        'TOO_MANY_TABS',
        '열린 수업 탭이 너무 많습니다. 다른 탭을 닫고 잠시 후 다시 연결해 주세요.',
      );
    await client.query(
      `INSERT INTO classroom_participant_attendance(session_id,class_id,participant_id)
      VALUES($1,$2,$3) ON CONFLICT(session_id,participant_id) DO UPDATE SET left_at=NULL`,
      [sessionId, row.class_id, row.participant_id],
    );
    const inserted = await client.query(
      `INSERT INTO classroom_participant_connections(id,session_id,class_id,participant_id,credential_generation,generation,last_seen_at,lease_expires_at,disconnected_at)
      VALUES($1,$2,$3,$4,$5,$6,statement_timestamp(),statement_timestamp()+($7*interval '1 millisecond'),CASE WHEN $8 THEN statement_timestamp() ELSE NULL END)
      ON CONFLICT(id) DO NOTHING`,
      [
        connectionId,
        sessionId,
        row.class_id,
        row.participant_id,
        row.generation,
        body.sequence,
        presencePolicy.leaseMs,
        disconnect,
      ],
    );
    if (!inserted.rowCount)
      fail(409, 'CONNECTION_CHANGED', '연결이 변경되었습니다. 새 연결로 다시 확인해 주세요.');
    await client.query(
      `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
      VALUES($1,$2,'participant',$3,$4,'success')`,
      [
        randomUUID(),
        row.class_id,
        row.participant_id,
        disconnect ? 'classroom.lesson_disconnected' : 'classroom.lesson_connected',
      ],
    );
  }
  if (disconnect)
    await client.query(
      `UPDATE classroom_participant_attendance SET left_at=statement_timestamp()
    WHERE session_id=$1 AND participant_id=$2 AND left_at IS NULL AND NOT EXISTS
      (SELECT 1 FROM classroom_participant_connections WHERE session_id=$1 AND participant_id=$2
       AND disconnected_at IS NULL AND lease_expires_at>statement_timestamp())`,
      [sessionId, row.participant_id],
    );
  const clock = await client.query<{ now: Date }>('SELECT statement_timestamp() AS now');
  return { lesson, observedAt: clock.rows[0].now.toISOString(), expiresAt: view.expiresAt };
}
