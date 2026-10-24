import express from 'express';
import type { Pool } from 'pg';
import { fail, id, transaction } from './api-core.js';
import { audit, manager } from './classroom-management.js';

const actualActions = [
  'student.join_requested',
  'classroom.request_approved',
  'classroom.request_rejected',
  'classroom.recovery_approved',
  'material.sent',
  'material.deleted',
  'focus.started',
  'focus.ended',
];
const testActions = ['notification.test.screen_difference', 'notification.test.input_activity'];

export function notificationRouter(pool: Pool) {
  const router = express.Router();
  router.get('/:classroomId/notifications', async (request, response) => {
    const classroom = id(request.params.classroomId);
    const result = await transaction(pool, async (client) => {
      await manager(client, response.locals.identityTokenHash, classroom, false);
      const notifications = await client.query(
        `SELECT id,action,created_at AS "createdAt",
          CASE WHEN action=ANY($3::text[]) THEN 'test' ELSE 'actual' END AS kind
         FROM classroom_participation_audit
         WHERE class_id=$1 AND result='success' AND action=ANY($2::text[])
         ORDER BY created_at DESC,id DESC LIMIT 50`,
        [classroom, [...actualActions, ...testActions], testActions],
      );
      return { notifications: notifications.rows };
    });
    response.json(result);
  });
  router.post('/:classroomId/notifications/test', async (request, response) => {
    const classroom = id(request.params.classroomId);
    const body: unknown = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('event' in body) ||
      !['screen_difference', 'input_activity'].includes(String(body.event))
    )
      fail(400, 'INVALID_INPUT', '지원하는 테스트 이벤트만 생성할 수 있습니다.');
    await transaction(pool, async (client) => {
      const user = await manager(client, response.locals.identityTokenHash, classroom, true);
      const budget = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM classroom_participation_audit
         WHERE class_id=$1 AND action=ANY($2::text[]) AND created_at>now()-interval '1 minute'`,
        [classroom, testActions],
      );
      if (budget.rows[0].count >= 10)
        fail(429, 'TEST_EVENT_LIMIT', '테스트 이벤트는 교실당 1분에 10개까지 생성할 수 있습니다.');
      await audit(client, classroom, user, `notification.test.${String(body.event)}`);
    });
    response.status(201).json({ test: true });
  });
  return router;
}
