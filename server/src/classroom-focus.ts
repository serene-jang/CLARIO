import express from 'express';
import type { Pool, PoolClient } from 'pg';
import { fail, id, transaction } from './api-core.js';
import { manager } from './classroom-management.js';
import { auditFocus, focusSnapshot } from './focus-state.js';
import { readStudentSession } from './student-sessions.js';

export function focusManagementRouter(pool: Pool) {
  const router = express.Router();
  router.get('/:classroomId/focus', async (request, response) => {
    const classroom = id(request.params.classroomId);
    response.json(
      await transaction(pool, async (client) => {
        await manager(client, response.locals.identityTokenHash, classroom, false);
        return focusSnapshot(client, classroom);
      }),
    );
  });
  router.patch('/:classroomId/focus', async (request, response) => {
    const classroom = id(request.params.classroomId),
      body: unknown = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !['enabled', 'sessionId', 'expectedVersion'].includes(k)) ||
      !('enabled' in body) ||
      typeof body.enabled !== 'boolean' ||
      !('expectedVersion' in body) ||
      typeof body.expectedVersion !== 'number' ||
      !Number.isInteger(body.expectedVersion) ||
      body.expectedVersion < 0 ||
      body.expectedVersion > 2147483647
    )
      fail(400, 'INVALID_INPUT', '수업과 현재 집중 안내 버전을 확인해 주세요.');
    const sessionId = id('sessionId' in body ? body.sessionId : undefined);
    const enabled = body.enabled;
    response.json(
      await transaction(pool, async (client) => {
        const teacher = await manager(client, response.locals.identityTokenHash, classroom, true);
        const current = await focusSnapshot(client, classroom);
        if (current.lesson?.id !== sessionId || current.version !== body.expectedVersion)
          fail(409, 'FOCUS_CHANGED', '수업 또는 집중 안내가 변경되었습니다. 다시 확인해 주세요.');
        const raw = await client.query<{ enabled: boolean }>(
          'SELECT voluntary_focus AS enabled FROM classes WHERE id=$1',
          [classroom],
        );
        if (raw.rows[0].enabled !== enabled) {
          await client.query('UPDATE classes SET voluntary_focus=$2 WHERE id=$1', [
            classroom,
            enabled,
          ]);
          await auditFocus(client, classroom, teacher, enabled);
        }
        return focusSnapshot(client, classroom);
      }),
    );
  });
  return router;
}
export async function studentFocus(client: PoolClient, token: string) {
  const current = await readStudentSession(client, token);
  if (current.view.state !== 'participant')
    fail(403, 'APPROVAL_REQUIRED', '교사의 참여 승인이 필요합니다.');
  return {
    ...(await focusSnapshot(client, current.row.class_id)),
    expiresAt: current.view.expiresAt,
  };
}
