import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { StudentJoinRequestStatus, StudentSessionView } from '@clario/shared';
import { digest, fail } from './api-core.js';
import { identityClassroomAccess } from './classroom-management.js';

export const studentCsrfToken = (token: string) =>
  createHmac('sha256', token).update('clario-student-csrf-v1').digest('base64url');

interface StudentCredential {
  token: string;
  expiresAt: Date;
}

async function lockClass(client: PoolClient, classId: string) {
  const result = await client.query(
    'SELECT id FROM classes WHERE id=$1 AND archived_at IS NULL AND closed_at IS NULL FOR UPDATE',
    [classId],
  );
  if (!result.rowCount)
    fail(
      401,
      'STUDENT_SESSION_EXPIRED',
      '참여 자격이 만료되었거나 종료되었습니다. 교사에게 복구를 요청해 주세요.',
    );
}

// Trusted transaction helpers: join/approval services authorize the request first.
export async function issuePendingStudentCredential(
  client: PoolClient,
  requestId: string,
): Promise<StudentCredential> {
  const request = await client.query<{ class_id: string }>(
    "SELECT class_id FROM classroom_join_requests WHERE id=$1 AND status='pending' AND expires_at>statement_timestamp()",
    [requestId],
  );
  if (!request.rows[0]) fail(409, 'REQUEST_UNAVAILABLE', '참여 신청을 확인할 수 없습니다.');
  await lockClass(client, request.rows[0].class_id);
  const active = await client.query(
    `SELECT 1 FROM student_participation_sessions WHERE request_id=$1
     AND revoked_at IS NULL AND expires_at>statement_timestamp() AND idle_expires_at>statement_timestamp()`,
    [requestId],
  );
  if (active.rowCount) fail(409, 'REQUEST_CREDENTIAL_EXISTS', '이미 발급된 신청 자격이 있습니다.');
  await client.query(
    'UPDATE student_participation_sessions SET revoked_at=statement_timestamp() WHERE request_id=$1 AND revoked_at IS NULL',
    [requestId],
  );
  const token = randomBytes(32).toString('base64url');
  const inserted = await client.query<{ expires_at: Date }>(
    `INSERT INTO student_participation_sessions
     (token_hash,class_id,request_id,scope,issued_at,last_seen_at,expires_at,idle_expires_at)
     SELECT $1,class_id,id,'pending',statement_timestamp(),statement_timestamp(),
       LEAST(expires_at,statement_timestamp()+interval '30 minutes'),
       LEAST(expires_at,statement_timestamp()+interval '30 minutes')
     FROM classroom_join_requests WHERE id=$2 AND status='pending' AND expires_at>statement_timestamp()
     RETURNING expires_at`,
    [digest(token), requestId],
  );
  if (!inserted.rows[0]) fail(409, 'REQUEST_UNAVAILABLE', '참여 신청을 확인할 수 없습니다.');
  return { token, expiresAt: inserted.rows[0].expires_at };
}

export async function issueApprovedStudentCredential(
  client: PoolClient,
  requestId: string,
): Promise<StudentCredential> {
  const found = await client.query<{ class_id: string }>(
    'SELECT class_id FROM classroom_join_requests WHERE id=$1',
    [requestId],
  );
  if (!found.rows[0]) fail(403, 'APPROVAL_REQUIRED', '교사의 참여 승인이 필요합니다.');
  const classroom = found.rows[0].class_id;
  await lockClass(client, classroom);
  const request = await client.query<{ participant_id: string; resolved_by: string }>(
    `SELECT r.participant_id,r.resolved_by FROM classroom_join_requests r
     JOIN classroom_participants p ON p.id=r.participant_id AND p.class_id=r.class_id
     JOIN users u ON u.id=r.resolved_by
     WHERE r.id=$1 AND r.status='approved' AND r.expires_at>statement_timestamp()
       AND p.status='approved' AND u.active
       AND EXISTS (SELECT 1 FROM student_participation_sessions s
         WHERE s.request_id=r.id AND s.scope='pending' AND s.revoked_at IS NULL
           AND s.expires_at>statement_timestamp() AND s.idle_expires_at>statement_timestamp())`,
    [requestId],
  );
  const participant = request.rows[0]?.participant_id;
  if (!participant)
    fail(403, 'APPROVAL_REQUIRED', '교사의 참여 승인이 필요하거나 신청이 만료되었습니다.');
  const permission = await client.query(
    `SELECT 1 FROM (${identityClassroomAccess}) access WHERE id=$2 AND role='manager'`,
    [request.rows[0].resolved_by, classroom],
  );
  if (!permission.rowCount)
    fail(403, 'APPROVAL_REQUIRED', '교사 권한이 변경되었습니다. 교사에게 다시 확인해 주세요.');
  await client.query(
    `UPDATE student_participation_sessions SET revoked_at=statement_timestamp()
     WHERE class_id=$1 AND revoked_at IS NULL AND (participant_id=$2 OR request_id=$3)`,
    [classroom, participant, requestId],
  );
  const updated = await client.query<{ credential_generation: number }>(
    `UPDATE classroom_participants SET credential_generation=credential_generation+1,updated_at=statement_timestamp()
     WHERE id=$1 RETURNING credential_generation`,
    [participant],
  );
  await disconnectStudent(client, participant);
  const token = randomBytes(32).toString('base64url');
  const inserted = await client.query<{ expires_at: Date }>(
    `INSERT INTO student_participation_sessions
     (token_hash,class_id,participant_id,scope,generation,issued_at,last_seen_at,expires_at,idle_expires_at)
     VALUES ($1,$2,$3,'participant',$4,statement_timestamp(),statement_timestamp(),
       statement_timestamp()+interval '12 hours',statement_timestamp()+interval '2 hours')
     RETURNING expires_at`,
    [digest(token), classroom, participant, updated.rows[0].credential_generation],
  );
  await client.query(
    `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,request_id,action,result)
     VALUES ($1,$2,'request',$3,'student.credential_rotated','success')`,
    [randomUUID(), classroom, requestId],
  );
  return { token, expiresAt: inserted.rows[0].expires_at };
}

export async function disconnectStudent(client: PoolClient, participant: string) {
  await client.query(
    `UPDATE classroom_participant_connections SET disconnected_at=statement_timestamp()
     WHERE participant_id=$1 AND disconnected_at IS NULL`,
    [participant],
  );
  await client.query(
    `UPDATE classroom_participant_attendance SET left_at=statement_timestamp()
     WHERE participant_id=$1 AND left_at IS NULL`,
    [participant],
  );
}

interface SessionRow {
  token_hash: string;
  class_id: string;
  request_id: string | null;
  participant_id: string | null;
  scope: 'pending' | 'participant';
  expires_at: Date;
  idle_expires_at: Date;
  generation: number | null;
  request_status: StudentJoinRequestStatus | null;
  student_name: string;
  student_number: string;
  classroom_name: string;
}

export async function readStudentSession(
  client: PoolClient,
  token: string,
): Promise<{ view: StudentSessionView; row: SessionRow }> {
  const hash = digest(token);
  const existing = await client.query<{ class_id: string }>(
    'SELECT class_id FROM student_participation_sessions WHERE token_hash=$1',
    [hash],
  );
  if (!existing.rows[0])
    fail(
      401,
      'STUDENT_SESSION_EXPIRED',
      '참여 자격이 만료되었습니다. 교사에게 복구를 요청해 주세요.',
    );
  await lockClass(client, existing.rows[0].class_id);
  const result = await client.query<SessionRow>(
    `SELECT s.*,r.status AS request_status,c.name AS classroom_name,
       CASE WHEN s.scope='pending' THEN r.name ELSE p.name END AS student_name,
       CASE WHEN s.scope='pending' THEN r.student_number ELSE p.student_number END AS student_number
     FROM student_participation_sessions s JOIN classes c ON c.id=s.class_id
     LEFT JOIN classroom_join_requests r ON r.id=s.request_id AND r.class_id=s.class_id
     LEFT JOIN classroom_participants p ON p.id=s.participant_id AND p.class_id=s.class_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
       AND s.idle_expires_at>statement_timestamp() AND (
         (s.scope='pending' AND (r.status IN ('rejected','cancelled') OR r.expires_at>statement_timestamp())) OR
         (s.scope='participant' AND p.status='approved' AND s.generation=p.credential_generation)
       ) FOR UPDATE OF s`,
    [hash],
  );
  const row = result.rows[0];
  if (!row)
    fail(
      401,
      'STUDENT_SESSION_EXPIRED',
      '참여 자격이 만료되었거나 해제되었습니다. 교사에게 복구를 요청해 주세요.',
    );
  if (row.scope === 'participant') {
    const refreshed = await client.query<{ idle_expires_at: Date }>(
      `UPDATE student_participation_sessions SET last_seen_at=statement_timestamp(),
       idle_expires_at=LEAST(expires_at,statement_timestamp()+interval '2 hours')
       WHERE token_hash=$1 RETURNING idle_expires_at`,
      [hash],
    );
    row.idle_expires_at = refreshed.rows[0].idle_expires_at;
  }
  const common = {
    student: { name: row.student_name, studentNumber: row.student_number },
    csrfToken: studentCsrfToken(token),
    expiresAt: new Date(
      Math.min(row.expires_at.getTime(), row.idle_expires_at.getTime()),
    ).toISOString(),
  };
  if (row.scope === 'pending') {
    if (!row.request_status)
      fail(401, 'STUDENT_SESSION_EXPIRED', '참여 신청을 확인할 수 없습니다.');
    return { row, view: { state: 'request', status: row.request_status, ...common } };
  }
  return {
    row,
    view: {
      state: 'participant',
      classroom: { id: row.class_id, name: row.classroom_name },
      ...common,
    },
  };
}

export async function endStudentSession(client: PoolClient, token: string) {
  const result = await client.query<{
    class_id: string;
    participant_id: string | null;
    request_id: string | null;
  }>(
    'SELECT class_id,participant_id,request_id FROM student_participation_sessions WHERE token_hash=$1',
    [digest(token)],
  );
  const row = result.rows[0];
  if (!row) return;
  // Ending remains available after classroom closure/expiry, but only affects this credential's owner.
  await client.query('SELECT id FROM classes WHERE id=$1 FOR UPDATE', [row.class_id]);
  const current = await client.query(
    `SELECT 1 FROM student_participation_sessions s
     LEFT JOIN classroom_participants p ON p.id=s.participant_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL
       AND (s.scope='pending' OR s.generation=p.credential_generation)`,
    [digest(token)],
  );
  if (!current.rowCount) return;
  if (row.participant_id) {
    await client.query(
      `UPDATE classroom_participants SET
       status=CASE WHEN status='approved' THEN 'left' ELSE status END,
       credential_generation=credential_generation+1,updated_at=statement_timestamp() WHERE id=$1`,
      [row.participant_id],
    );
    await client.query(
      'UPDATE student_participation_sessions SET revoked_at=statement_timestamp() WHERE participant_id=$1 AND revoked_at IS NULL',
      [row.participant_id],
    );
    await disconnectStudent(client, row.participant_id);
  } else {
    const approved = await client.query<{ participant_id: string }>(
      "SELECT participant_id FROM classroom_join_requests WHERE id=$1 AND status='approved'",
      [row.request_id],
    );
    if (approved.rows[0]) {
      await client.query(
        `UPDATE classroom_participants SET status='left',
        credential_generation=credential_generation+1,updated_at=statement_timestamp()
        WHERE id=$1 AND status='approved'`,
        [approved.rows[0].participant_id],
      );
    }
    await client.query(
      `UPDATE classroom_join_requests SET status='cancelled',resolved_at=statement_timestamp()
       WHERE id=$1 AND status IN ('pending','approved')`,
      [row.request_id],
    );
    await client.query(
      'UPDATE student_participation_sessions SET revoked_at=statement_timestamp() WHERE token_hash=$1 AND revoked_at IS NULL',
      [digest(token)],
    );
  }
  await client.query(
    `INSERT INTO classroom_participation_audit
     (id,class_id,actor_kind,participant_id,request_id,action,result)
     VALUES ($1,$2,$3,$4,$5,'student.session_ended','success')`,
    [
      randomUUID(),
      row.class_id,
      row.participant_id ? 'participant' : 'request',
      row.participant_id,
      row.request_id,
    ],
  );
}
