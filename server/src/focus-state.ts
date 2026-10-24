import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ClassroomFocusView } from '@clario/shared';

export async function focusSnapshot(
  client: PoolClient,
  classroom: string,
): Promise<ClassroomFocusView> {
  const result = await client.query<{
    enabled: boolean;
    version: number;
    updated_at: Date;
    observed_at: Date;
    session_id: string | null;
    started_at: Date | null;
  }>(
    `SELECT (c.voluntary_focus AND s.id IS NOT NULL AND c.closed_at IS NULL AND c.archived_at IS NULL) AS enabled,
      c.focus_version AS version,c.focus_updated_at AS updated_at,statement_timestamp() AS observed_at,
      s.id AS session_id,s.started_at FROM classes c
      LEFT JOIN classroom_sessions s ON s.class_id=c.id AND s.ended_at IS NULL
      WHERE c.id=$1`,
    [classroom],
  );
  const row = result.rows[0];
  return {
    enabled: row.enabled,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    observedAt: row.observed_at.toISOString(),
    lesson:
      row.session_id && row.started_at
        ? { id: row.session_id, startedAt: row.started_at.toISOString() }
        : null,
  };
}
export async function auditFocus(
  client: PoolClient,
  classroom: string,
  teacher: string,
  enabled: boolean,
) {
  const action = enabled ? 'focus.started' : 'focus.ended';
  await client.query(
    `INSERT INTO audit_logs(school_id,actor_id,action,target_id,result)
     VALUES((SELECT school_id FROM classes WHERE id=$1),$2,$3,$1,'success')`,
    [classroom, teacher, action],
  );
  await client.query(
    `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,teacher_id,action,result)
     VALUES($1,$2,'teacher',$3,$4,'success')`,
    [randomUUID(), classroom, teacher, action],
  );
}
// Call with the classroom lock, including automatic lesson/classroom shutdown.
export async function resetFocus(client: PoolClient, classroom: string, teacher: string) {
  const changed = await client.query(
    'UPDATE classes SET voluntary_focus=false WHERE id=$1 AND voluntary_focus RETURNING id',
    [classroom],
  );
  if (changed.rowCount) await auditFocus(client, classroom, teacher, false);
}
