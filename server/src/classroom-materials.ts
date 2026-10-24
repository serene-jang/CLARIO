import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Pool, PoolClient } from 'pg';
import { fail, id, text, transaction } from './api-core.js';
import { manager } from './classroom-management.js';
import { materialUrl } from './material-url.js';
import { readStudentSession } from './student-sessions.js';

const authorizedAudience = (alias: string, participantParameter: string) =>
  `(${alias}.audience='all' OR EXISTS(
    SELECT 1 FROM classroom_material_recipients target
    WHERE target.material_id=${alias}.id AND target.participant_id=${participantParameter}))`;

function pageNumber(value: unknown) {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,5}$/.test(value))
    fail(400, 'INVALID_INPUT', '올바른 자료 페이지가 필요합니다.');
  return Number(value);
}
function emptyBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
    fail(400, 'INVALID_INPUT', '추가 입력 없이 다시 요청해 주세요.');
}
async function materialAudit(
  client: PoolClient,
  classroom: string,
  teacher: string,
  material: string,
  action: string,
) {
  await client.query(
    `INSERT INTO audit_logs(school_id,actor_id,action,target_id,result)
     VALUES((SELECT school_id FROM classes WHERE id=$4),$1,$2,$3,'success')`,
    [teacher, action, material, classroom],
  );
  await client.query(
    `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,teacher_id,action,result)
     VALUES($1,$2,'teacher',$3,$4,'success')`,
    [randomUUID(), classroom, teacher, action],
  );
}
async function materials(
  client: PoolClient,
  classroom: string,
  page: number,
  participant?: string,
) {
  const total = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM class_materials m WHERE class_id=$1
      AND expires_at>statement_timestamp()
      AND ($2::uuid IS NULL OR ${authorizedAudience('m', '$2')})`,
    [classroom, participant ?? null],
  );
  const rows = participant
    ? await client.query(
        `SELECT m.id,m.title,m.created_at AS "createdAt",m.expires_at AS "expiresAt",
       r.received_at AS "receivedAt",r.opened_at AS "openedAt"
       FROM class_materials m LEFT JOIN classroom_material_receipts r
       ON r.material_id=m.id AND r.participant_id=$4
       WHERE m.class_id=$1 AND m.expires_at>statement_timestamp() AND ${authorizedAudience('m', '$4')}
       ORDER BY m.created_at DESC,m.id DESC LIMIT $2 OFFSET $3`,
        [classroom, 50, (page - 1) * 50, participant],
      )
    : await client.query(
        `SELECT m.id,m.title,m.url,m.created_at AS "createdAt",m.expires_at AS "expiresAt",
       NULL AS "receivedAt",NULL AS "openedAt",m.audience,
       (SELECT count(*)::int FROM classroom_material_recipients target
         WHERE target.material_id=m.id) AS "recipientCount",
       (SELECT count(*)::int FROM classroom_material_receipts r JOIN classroom_participants p
         ON p.id=r.participant_id AND p.status='approved'
         WHERE r.material_id=m.id AND r.received_at IS NOT NULL) AS "receivedCount",
       (SELECT count(*)::int FROM classroom_material_receipts r JOIN classroom_participants p
         ON p.id=r.participant_id AND p.status='approved'
         WHERE r.material_id=m.id AND r.opened_at IS NOT NULL) AS "openedCount"
       FROM class_materials m WHERE m.class_id=$1 AND m.expires_at>statement_timestamp()
       ORDER BY m.created_at DESC,m.id DESC LIMIT $2 OFFSET $3`,
        [classroom, 50, (page - 1) * 50],
      );
  return {
    materials: rows.rows,
    total: total.rows[0].total,
    page,
    pageSize: 50,
    observedAt: (
      await client.query<{ at: Date }>('SELECT statement_timestamp() AS at')
    ).rows[0].at.toISOString(),
  };
}
export function materialManagementRouter(pool: Pool) {
  const router = express.Router();
  router.get('/classrooms/:classroomId/materials', async (request, response) => {
    const classroom = id(request.params.classroomId),
      page = pageNumber(request.query.page);
    response.json(
      await transaction(pool, async (client) => {
        await manager(client, response.locals.identityTokenHash, classroom, false);
        return materials(client, classroom, page);
      }),
    );
  });
  router.post('/classrooms/:classroomId/materials', async (request, response) => {
    const classroom = id(request.params.classroomId);
    if (
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body) ||
      Object.keys(request.body).some((k) => !['title', 'url', 'participantIds'].includes(k))
    )
      fail(400, 'INVALID_INPUT', '자료 제목과 HTTPS 주소가 필요합니다.');
    const title = text(request.body.title, 100),
      url = materialUrl(request.body.url),
      material = randomUUID();
    const targets: unknown = request.body.participantIds;
    let participantIds: string[] | null = null;
    if (targets !== undefined) {
      if (!Array.isArray(targets) || targets.length < 1 || targets.length > 100)
        fail(400, 'INVALID_INPUT', '선택 학생은 1~100명이어야 합니다.');
      participantIds = targets.map((target) => id(target));
      if (new Set(participantIds).size !== participantIds.length)
        fail(400, 'INVALID_INPUT', '선택 학생이 중복되었습니다.');
    }
    await transaction(pool, async (client) => {
      const teacher = await manager(client, response.locals.identityTokenHash, classroom, true);
      if (participantIds) {
        const eligible = await client.query(
          `SELECT id FROM classroom_participants WHERE class_id=$1
           AND id=ANY($2::uuid[]) AND status='approved' FOR UPDATE`,
          [classroom, participantIds],
        );
        if (eligible.rowCount !== participantIds.length)
          fail(
            409,
            'RECIPIENTS_CHANGED',
            '이 교실의 승인 학생만 선택할 수 있습니다. 학생 목록을 다시 확인해 주세요.',
          );
      }
      await client.query(
        `INSERT INTO class_materials(id,class_id,title,url,created_at,expires_at,audience)
         VALUES($1,$2,$3,$4,statement_timestamp(),statement_timestamp()+interval '7 days',$5)`,
        [material, classroom, title, url, participantIds ? 'selected' : 'all'],
      );
      if (participantIds) {
        await client.query(
          `INSERT INTO classroom_material_recipients(material_id,class_id,participant_id)
           SELECT $1,$2,unnest($3::uuid[])`,
          [material, classroom, participantIds],
        );
      } else {
        await client.query(
          `INSERT INTO material_deliveries(material_id,device_id)
         SELECT $1,d.id FROM registered_devices d JOIN users u ON u.id=d.student_id
         WHERE d.class_id=$2 AND u.active AND u.role='student'`,
          [material, classroom],
        );
      }
      await materialAudit(client, classroom, teacher, material, 'material.sent');
    });
    response.status(201).json({ id: material });
  });
  router.delete('/classrooms/:classroomId/materials/:materialId', async (request, response) => {
    const classroom = id(request.params.classroomId),
      material = id(request.params.materialId);
    await transaction(pool, async (client) => {
      const teacher = await manager(client, response.locals.identityTokenHash, classroom, false);
      const result = await client.query(
        'DELETE FROM class_materials WHERE id=$1 AND class_id=$2 RETURNING id',
        [material, classroom],
      );
      if (!result.rowCount) fail(404, 'NOT_FOUND', '삭제할 수 있는 자료가 없습니다.');
      await materialAudit(client, classroom, teacher, material, 'material.deleted');
    });
    response.sendStatus(204);
  });
  return router;
}
async function student(client: PoolClient, token: string) {
  const current = await readStudentSession(client, token);
  if (current.view.state !== 'participant' || !current.row.participant_id)
    fail(403, 'APPROVAL_REQUIRED', '교사의 참여 승인이 필요합니다.');
  return {
    classroom: current.row.class_id,
    participant: current.row.participant_id,
    expiresAt: current.view.expiresAt,
  };
}
export async function studentMaterials(client: PoolClient, token: string, page: unknown) {
  const current = await student(client, token);
  return {
    ...(await materials(client, current.classroom, pageNumber(page), current.participant)),
    expiresAt: current.expiresAt,
  };
}
export async function studentMaterialReceipt(client: PoolClient, token: string, body: unknown) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => k !== 'materialIds') ||
    !('materialIds' in body) ||
    !Array.isArray(body.materialIds) ||
    body.materialIds.length < 1 ||
    body.materialIds.length > 50
  )
    fail(400, 'INVALID_INPUT', '수신 자료 식별자는 1~50개가 필요합니다.');
  const ids = [...new Set(body.materialIds.map((value) => id(value)))],
    current = await student(client, token);
  const found = await client.query(
    `SELECT id FROM class_materials m WHERE class_id=$1 AND id=ANY($2::uuid[])
     AND expires_at>statement_timestamp() AND ${authorizedAudience('m', '$3')} FOR UPDATE`,
    [current.classroom, ids, current.participant],
  );
  if (found.rowCount !== ids.length)
    fail(404, 'NOT_FOUND', '유효한 교실 자료가 아닙니다. 목록을 다시 확인해 주세요.');
  const receipts = await client.query(
    `INSERT INTO classroom_material_receipts(material_id,class_id,participant_id,received_at)
     SELECT unnest($1::uuid[]),$2,$3,statement_timestamp()
     ON CONFLICT(material_id,participant_id) DO UPDATE
       SET received_at=COALESCE(classroom_material_receipts.received_at,EXCLUDED.received_at)
     RETURNING material_id AS id,received_at AS "receivedAt"`,
    [ids, current.classroom, current.participant],
  );
  return { receipts: receipts.rows };
}
export async function studentMaterialAction(
  client: PoolClient,
  token: string,
  materialId: unknown,
  action: string,
  body: unknown,
) {
  emptyBody(body);
  if (action !== 'open') fail(404, 'NOT_FOUND', '지원하지 않는 자료 작업입니다.');
  const current = await student(client, token),
    material = id(materialId);
  const found = await client.query<{ url: string; title: string; expires_at: Date }>(
    `SELECT url,title,expires_at FROM class_materials m
     WHERE id=$1 AND class_id=$2 AND expires_at>statement_timestamp()
       AND ${authorizedAudience('m', '$3')} FOR UPDATE`,
    [material, current.classroom, current.participant],
  );
  if (!found.rows[0])
    fail(404, 'NOT_FOUND', '유효한 교실 자료가 없습니다. 목록을 다시 확인해 주세요.');
  const url = materialUrl(found.rows[0].url);
  await client.query(
    `INSERT INTO classroom_material_receipts(material_id,class_id,participant_id,opened_at)
     VALUES($1,$2,$3,statement_timestamp())
     ON CONFLICT(material_id,participant_id) DO UPDATE SET
       opened_at=COALESCE(classroom_material_receipts.opened_at,EXCLUDED.opened_at)`,
    [material, current.classroom, current.participant],
  );
  return { url, title: found.rows[0].title, expiresAt: found.rows[0].expires_at.toISOString() };
}
