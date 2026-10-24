import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, open, unlink, stat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve, relative } from 'node:path';
import express from 'express';
import type { Pool, PoolClient } from 'pg';
import { manager } from './classroom-management.js';
import { ApiError, fail, id, text, transaction } from './api-core.js';
import { readStudentSession } from './student-sessions.js';

export const documentLimit = 10 * 1024 * 1024;
export class DocumentStore {
  private constructor(private root: string) {}
  static async open(root: string) {
    if (!isAbsolute(root))
      throw new Error('CLARIO_DOCUMENTS_DIR must be an absolute private directory.');
    const repo = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
    const outside = (path: string) => {
      const child = relative(repo, path);
      return (
        Boolean(child) &&
        (child === '..' ||
          child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
          isAbsolute(child))
      );
    };
    if (!outside(resolve(root)))
      throw new Error('Document storage must be outside the repository and all public web roots.');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await realpath(root);
    if (!outside(directory))
      throw new Error('Document storage must be outside the repository and all public web roots.');
    if (!(await stat(directory)).isDirectory())
      throw new Error('Private document directory is unavailable.');
    return new DocumentStore(directory);
  }
  async put(key: string, data: Buffer) {
    await writeFile(join(this.root, `${id(key)}.pdf`), data, { flag: 'wx', mode: 0o600 });
  }
  async read(key: string) {
    const file = await open(join(this.root, `${id(key)}.pdf`), 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 12 || info.size > documentLimit)
        throw new Error('Stored document size is invalid.');
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
  async remove(key: string) {
    try {
      await unlink(join(this.root, `${id(key)}.pdf`));
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error;
    }
  }
}
export async function documentList(client: PoolClient, classroom: string, teacher = false) {
  const result = await client.query(
    `SELECT id,title,bytes,status,created_at AS "createdAt" FROM classroom_documents
     WHERE class_id=$1 AND ($2 OR status='available') ORDER BY created_at DESC,id LIMIT 100`,
    [classroom, teacher],
  );
  return result.rows;
}
async function documentAudit(
  client: PoolClient,
  classroom: string,
  kind: 'teacher' | 'participant',
  actor: string,
  action: string,
  document: string,
) {
  await client.query(
    `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,teacher_id,participant_id,action,result,target_id)
     VALUES($1,$2,$3,$4,$5,$6,'success',$7)`,
    [
      randomUUID(),
      classroom,
      kind,
      kind === 'teacher' ? actor : null,
      kind === 'participant' ? actor : null,
      action,
      document,
    ],
  );
}
export function documentHeaders(response: express.Response, document: string) {
  response.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="CLARIO-${document}.pdf"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  });
}
export function documentRouter(pool: Pool, store?: DocumentStore) {
  const router = express.Router();
  const base = '/classrooms/:classroomId/documents';
  router.get(base, async (request, response) => {
    response.json(
      await transaction(pool, async (client) => {
        const classroom = id(request.params.classroomId);
        await manager(client, response.locals.identityTokenHash, classroom, false);
        return { enabled: Boolean(store), documents: await documentList(client, classroom, true) };
      }),
    );
  });
  router.post(
    base,
    async (request, response, next) => {
      await transaction(pool, (client) =>
        manager(client, response.locals.identityTokenHash, id(request.params.classroomId), true),
      );
      if (!store) fail(503, 'DOCUMENT_STORAGE_DISABLED', '비공개 문서 저장소 설정이 필요합니다.');
      if (!request.is('application/pdf'))
        fail(415, 'PDF_REQUIRED', 'PDF 파일만 업로드할 수 있습니다.');
      next();
    },
    express.raw({ type: 'application/pdf', limit: documentLimit }),
    async (request, response) => {
      const classroom = id(request.params.classroomId),
        title = text(request.query.title, 100),
        document = randomUUID();
      const data: unknown = request.body;
      if (
        !Buffer.isBuffer(data) ||
        data.length < 12 ||
        !data
          .subarray(0, 8)
          .toString('ascii')
          .match(/^%PDF-(?:1\.[0-9]|2\.0)/) ||
        !data.subarray(-1024).toString('ascii').includes('%%EOF')
      )
        fail(400, 'INVALID_PDF', 'PDF 헤더와 종료 표식을 확인할 수 없습니다.');
      await transaction(pool, async (client) => {
        const teacher = await manager(client, response.locals.identityTokenHash, classroom, true);
        const count = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM classroom_documents WHERE class_id=$1',
          [classroom],
        );
        if (count.rows[0].count >= 100)
          fail(409, 'DOCUMENT_CAPACITY', '교실당 문서는 최대 100개입니다. 기존 자료를 삭제하세요.');
        await client.query(
          `INSERT INTO classroom_documents(id,class_id,title,bytes,status,created_by)
        VALUES($1,$2,$3,$4,'uploading',$5)`,
          [document, classroom, title, data.length, teacher],
        );
        await documentAudit(
          client,
          classroom,
          'teacher',
          teacher,
          'document.upload_requested',
          document,
        );
      });
      try {
        await transaction(pool, async (client) => {
          const teacher = await manager(client, response.locals.identityTokenHash, classroom, true);
          const pending = await client.query(
            "SELECT id FROM classroom_documents WHERE id=$1 AND status='uploading'",
            [document],
          );
          if (!pending.rowCount)
            fail(409, 'DOCUMENT_CHANGED', '업로드가 취소되었거나 변경되었습니다.');
          await store!.put(document, data);
          const updated = await client.query(
            "UPDATE classroom_documents SET status='available' WHERE id=$1 AND status='uploading' RETURNING id",
            [document],
          );
          if (!updated.rowCount)
            fail(409, 'DOCUMENT_CHANGED', '업로드가 취소되었거나 변경되었습니다.');
          await documentAudit(client, classroom, 'teacher', teacher, 'document.uploaded', document);
        });
      } catch (cause) {
        console.error('document_upload_failed');
        await pool.query(
          "UPDATE classroom_documents SET status='failed' WHERE id=$1 AND status='uploading'",
          [document],
        );
        throw cause;
      }
      response.status(201).json({ id: document });
    },
  );
  router.get(`${base}/:documentId/download`, async (request, response) => {
    if (!store) fail(503, 'DOCUMENT_STORAGE_DISABLED', '문서 저장소가 비활성입니다.');
    const document = id(request.params.documentId),
      classroom = id(request.params.classroomId);
    const data = await transaction(pool, async (client) => {
      const teacher = await manager(client, response.locals.identityTokenHash, classroom, false);
      const found = await client.query(
        "SELECT id FROM classroom_documents WHERE id=$1 AND class_id=$2 AND status='available'",
        [document, classroom],
      );
      if (!found.rowCount) fail(404, 'NOT_FOUND', '사용 가능한 문서가 없습니다.');
      const bytes = await store.read(document);
      await documentAudit(client, classroom, 'teacher', teacher, 'document.downloaded', document);
      return bytes;
    });
    documentHeaders(response, document);
    response.send(data);
  });
  router.delete(`${base}/:documentId`, async (request, response) => {
    if (!store) fail(503, 'DOCUMENT_STORAGE_DISABLED', '문서 저장소가 비활성입니다.');
    const classroom = id(request.params.classroomId),
      document = id(request.params.documentId);
    await transaction(pool, async (client) => {
      const teacher = await manager(client, response.locals.identityTokenHash, classroom, false);
      const found = await client.query(
        "UPDATE classroom_documents SET status='deleting' WHERE id=$1 AND class_id=$2 RETURNING id",
        [document, classroom],
      );
      if (!found.rowCount) fail(404, 'NOT_FOUND', '삭제할 문서가 없습니다.');
      await documentAudit(
        client,
        classroom,
        'teacher',
        teacher,
        'document.delete_requested',
        document,
      );
    });
    await transaction(pool, async (client) => {
      const teacher = await manager(client, response.locals.identityTokenHash, classroom, false);
      const pending = await client.query(
        "SELECT id FROM classroom_documents WHERE id=$1 AND class_id=$2 AND status='deleting'",
        [document, classroom],
      );
      if (!pending.rowCount) return;
      try {
        await store.remove(document);
      } catch (cause) {
        console.error('document_delete_failed_retry_required');
        throw cause;
      }
      await client.query(
        "DELETE FROM classroom_documents WHERE id=$1 AND class_id=$2 AND status='deleting'",
        [document, classroom],
      );
      await documentAudit(client, classroom, 'teacher', teacher, 'document.deleted', document);
    });
    response.sendStatus(204);
  });
  router.use(
    (
      error: unknown,
      _request: express.Request,
      _response: express.Response,
      next: express.NextFunction,
    ) => {
      if (
        error &&
        typeof error === 'object' &&
        'type' in error &&
        error.type === 'entity.too.large'
      ) {
        next(new ApiError(413, 'DOCUMENT_TOO_LARGE', 'PDF 파일은 최대 10 MiB입니다.'));
        return;
      }
      next(error);
    },
  );
  return router;
}
export async function studentDocuments(client: PoolClient, token: string) {
  const session = await readStudentSession(client, token);
  if (session.view.state !== 'participant')
    fail(403, 'APPROVAL_REQUIRED', '교사 승인이 필요합니다.');
  return { session, documents: await documentList(client, session.row.class_id) };
}
export async function studentDocumentDownload(
  client: PoolClient,
  token: string,
  document: string,
  store: DocumentStore,
) {
  const { session } = await studentDocuments(client, token);
  const found = await client.query(
    "SELECT id FROM classroom_documents WHERE id=$1 AND class_id=$2 AND status='available'",
    [document, session.row.class_id],
  );
  if (!found.rowCount) fail(404, 'NOT_FOUND', '본인 교실의 사용 가능한 문서가 없습니다.');
  const data = await store.read(document);
  await documentAudit(
    client,
    session.row.class_id,
    'participant',
    session.row.participant_id!,
    'document.downloaded',
    document,
  );
  return data;
}
