import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Pool, PoolClient } from 'pg';
import { audit, manager } from './classroom-management.js';
import { fail, id, transaction } from './api-core.js';
import { readStudentSession } from './student-sessions.js';

const maxBytes = 8 * 1024 * 1024;
type Run = {
  id: string;
  classroom: string;
  participant: string;
  lesson: string;
  generation: number;
  credential: string;
  startedAt: number;
  lastFrame: number;
  sequence: number;
  frame?: string;
  chunks: Buffer[];
  bytes: number;
  status: 'recording' | 'uploading' | 'ready' | 'failed';
};
function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail(400, 'INVALID_INPUT', '시험 요청 형식을 확인하세요.');
  return value as Record<string, unknown>;
}
function bytes(value: unknown, maximum: number) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    fail(400, 'INVALID_MEDIA', '합성 시험 데이터 형식이나 크기를 확인하세요.');
  const result = Buffer.from(value, 'base64');
  if (result.length > maximum) fail(413, 'MEDIA_TOO_LARGE', '시험 데이터 한도를 초과했습니다.');
  return result;
}
async function lesson(client: PoolClient, classroom: string) {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM classroom_sessions WHERE class_id=$1 AND ended_at IS NULL',
    [classroom],
  );
  if (!result.rows[0])
    fail(409, 'LESSON_REQUIRED', '진행 중인 수업이 있어야 합성 시험을 할 수 있습니다.');
  return result.rows[0].id;
}

/** Disposable loopback experiment only; never a production media store. */
export class SyntheticMedia {
  private runs = new Map<string, Run>();
  private timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    // Keep the queue usable; the caller still receives the original rejection.
    this.queue = next.catch(() => {});
    return next;
  }
  constructor(
    private pool: Pool,
    origins: string[],
  ) {
    if (
      process.env.NODE_ENV === 'production' ||
      !origins.length ||
      origins.some((origin) => {
        const url = new URL(origin);
        return url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname);
      })
    )
      throw new Error('Synthetic media requires non-production loopback HTTP origins only.');
    this.timer = setInterval(
      () =>
        void this.sweep().catch(() => console.error('synthetic_media_background_cleanup_failed')),
      2000,
    );
    this.timer.unref();
  }
  close() {
    this.disposed = true;
    clearInterval(this.timer);
    this.runs.clear();
  }
  private erase(run: Run) {
    this.runs.delete(run.id);
  }
  async sweep() {
    return this.locked(() => this.sweepCore());
  }
  private async valid(client: Pool | PoolClient, run: Run) {
    const result = await client.query(
      `SELECT 1 FROM classroom_participants p JOIN classes c ON c.id=p.class_id
       JOIN classroom_sessions l ON l.class_id=c.id AND l.id=$3
       JOIN student_participation_sessions s ON s.participant_id=p.id AND s.token_hash=$5
       WHERE p.id=$1 AND p.class_id=$2 AND p.status='approved' AND p.credential_generation=$4
       AND s.generation=$4 AND c.closed_at IS NULL AND c.archived_at IS NULL AND l.ended_at IS NULL
       AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
       AND s.idle_expires_at>statement_timestamp()`,
      [run.participant, run.classroom, run.lesson, run.generation, run.credential],
    );
    return Boolean(result.rowCount);
  }
  private async sweepCore() {
    try {
      for (const run of this.runs.values()) {
        const valid = await this.valid(this.pool, run);
        if (this.runs.get(run.id) !== run) continue;
        if (!valid) {
          await this.pool.query(
            `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
             VALUES($1,$2,'participant',$3,'synthetic_media.deleted','success')`,
            [randomUUID(), run.classroom, run.participant],
          );
          this.erase(run);
        } else if (
          (run.status === 'recording' &&
            (Date.now() - run.lastFrame > 10000 || Date.now() - run.startedAt > 65000)) ||
          (run.status === 'uploading' && Date.now() - run.lastFrame > 120000)
        ) {
          await this.pool.query(
            `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
             VALUES($1,$2,'participant',$3,'synthetic_media.failed','failure')`,
            [randomUUID(), run.classroom, run.participant],
          );
          run.status = 'failed';
          run.frame = undefined;
          run.chunks = [];
          run.bytes = 0;
        }
      }
    } catch (error) {
      this.runs.clear();
      console.error('synthetic_media_cleanup_failed_memory_cleared');
      throw error;
    }
  }
  private view(run: Run) {
    return {
      id: run.id,
      participantId: run.participant,
      lessonId: run.lesson,
      startedAt: new Date(run.startedAt).toISOString(),
      status: run.status,
      frameAt: run.frame ? new Date(run.lastFrame).toISOString() : null,
      frame: run.status === 'recording' && Date.now() - run.lastFrame < 4000 ? run.frame : null,
      bytes: run.bytes,
      synthetic: true,
    };
  }
  async student(token: string, action: string, input?: unknown) {
    return this.locked(async () => {
      if (this.disposed) fail(503, 'SYNTHETIC_MEDIA_CLOSED', '합성 시험 서버가 종료되었습니다.');
      await this.sweepCore();
      const effect = await transaction(this.pool, async (client) => {
        const current = await readStudentSession(client, token);
        if (current.view.state !== 'participant')
          fail(403, 'APPROVAL_REQUIRED', '교사 승인이 필요합니다.');
        const classroom = current.row.class_id,
          participant = current.row.participant_id!;
        const currentLesson = await lesson(client, classroom);
        const own = [...this.runs.values()].filter((r) => r.participant === participant);
        if (action === 'read')
          return () => ({ enabled: true, synthetic: true, runs: own.map((r) => this.view(r)) });
        if (action === 'start') {
          const data = body(input, ['confirmSynthetic']);
          if (data.confirmSynthetic !== true)
            fail(400, 'CONFIRM_REQUIRED', '실제 화면이 아닌 합성 시험임을 확인하세요.');
          if (own.length) fail(409, 'MEDIA_EXISTS', '기존 시험을 삭제한 뒤 새로 시작하세요.');
          if (this.runs.size >= 4)
            fail(429, 'MEDIA_CAPACITY', '로컬 시험은 최대 4개입니다. 기존 시험을 삭제하세요.');
          const run: Run = {
            id: randomUUID(),
            classroom,
            participant,
            lesson: currentLesson,
            generation: current.row.generation!,
            credential: current.row.token_hash,
            startedAt: Date.now(),
            lastFrame: Date.now(),
            sequence: 0,
            chunks: [],
            bytes: 0,
            status: 'recording',
          };
          await client.query(
            `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
           VALUES($1,$2,'participant',$3,'synthetic_media.started','success')`,
            [randomUUID(), classroom, participant],
          );
          return () => {
            this.runs.set(run.id, run);
            return this.view(run);
          };
        }
        const data = body(input, ['id', 'sequence', 'data', 'bytes', 'chunks']);
        const run = this.runs.get(id(data.id));
        if (
          !run ||
          run.participant !== participant ||
          run.classroom !== classroom ||
          run.lesson !== currentLesson ||
          run.generation !== current.row.generation
        )
          fail(404, 'NOT_FOUND', '본인의 현재 합성 시험을 찾을 수 없습니다.');
        if (action === 'delete') {
          await client.query(
            `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
           VALUES($1,$2,'participant',$3,'synthetic_media.deleted','success')`,
            [randomUUID(), classroom, participant],
          );
          return () => {
            this.erase(run);
            return { deleted: true };
          };
        }
        if (action === 'frame') {
          if (run.status !== 'recording' || Date.now() - run.startedAt > 65000)
            fail(409, 'MEDIA_STOPPED', '합성 송신이 중단되었거나 시험 시간이 끝났습니다.');
          const frame = bytes(data.data, 32768);
          if (frame.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
            fail(400, 'INVALID_MEDIA', 'PNG 합성 프레임만 허용합니다.');
          if (!Number.isSafeInteger(data.sequence) || Number(data.sequence) <= run.sequence)
            fail(409, 'FRAME_ORDER', '오래된 합성 프레임입니다.');
          return () => {
            run.frame = frame.toString('base64');
            run.sequence = Number(data.sequence);
            run.lastFrame = Date.now();
            return { accepted: true };
          };
        }
        if (action === 'stop') {
          if (run.status !== 'recording') fail(409, 'MEDIA_STOPPED', '이미 중단된 시험입니다.');
          await client.query(
            `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
           VALUES($1,$2,'participant',$3,'synthetic_media.stopped','success')`,
            [randomUUID(), classroom, participant],
          );
          return () => {
            run.status = 'uploading';
            run.frame = undefined;
            run.lastFrame = Date.now();
            return this.view(run);
          };
        }
        if (action === 'fail') {
          await client.query(
            `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
           VALUES($1,$2,'participant',$3,'synthetic_media.failed','failure')`,
            [randomUUID(), classroom, participant],
          );
          return () => {
            run.status = 'failed';
            run.frame = undefined;
            run.chunks = [];
            run.bytes = 0;
            return this.view(run);
          };
        }
        if (action === 'chunk') {
          if (run.status !== 'uploading')
            fail(409, 'MEDIA_NOT_UPLOADING', '업로드 중인 시험이 아닙니다.');
          const chunk = bytes(data.data, 32768);
          if (data.sequence !== run.chunks.length)
            fail(409, 'CHUNK_ORDER', '업로드 순서를 확인하세요.');
          if (run.bytes + chunk.length > maxBytes)
            fail(413, 'MEDIA_TOO_LARGE', '시험 녹화는 최대 8 MiB입니다.');
          return () => {
            run.chunks.push(chunk);
            run.bytes += chunk.length;
            run.lastFrame = Date.now();
            return { accepted: true };
          };
        }
        if (action === 'complete') {
          if (
            run.status !== 'uploading' ||
            !run.bytes ||
            data.bytes !== run.bytes ||
            data.chunks !== run.chunks.length ||
            run.chunks[0].subarray(0, 4).toString('hex') !== '1a45dfa3'
          )
            fail(409, 'INVALID_RECORDING', '완성된 WebM 시험 영상을 확인할 수 없습니다.');
          await client.query(
            `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
           VALUES($1,$2,'participant',$3,'synthetic_media.uploaded','success')`,
            [randomUUID(), classroom, participant],
          );
          return () => {
            run.status = 'ready';
            return this.view(run);
          };
        }
        fail(404, 'NOT_FOUND', '지원하지 않는 합성 시험 작업입니다.');
      });
      if (this.disposed) fail(503, 'SYNTHETIC_MEDIA_CLOSED', '합성 시험 서버가 종료되었습니다.');
      return effect();
    });
  }
  teacherRouter() {
    const router = express.Router();
    router.get('/:classroomId/synthetic-media', async (request, response) => {
      response.json(
        await this.locked(async () => {
          await this.sweepCore();
          return transaction(this.pool, async (client) => {
            const classroom = id(request.params.classroomId);
            await manager(client, response.locals.identityTokenHash, classroom, true);
            const current = await lesson(client, classroom);
            const targets = await client.query<{ id: string; name: string; studentNumber: string }>(
              `SELECT id,name,student_number AS "studentNumber" FROM classroom_participants
           WHERE class_id=$1 AND status='approved' ORDER BY student_number,id`,
              [classroom],
            );
            const runs = [];
            for (const run of this.runs.values()) {
              if (
                run.classroom === classroom &&
                run.lesson === current &&
                (await this.valid(client, run))
              )
                runs.push(this.view(run));
            }
            return {
              enabled: true,
              synthetic: true,
              lessonId: current,
              observedAt: new Date().toISOString(),
              targets: targets.rows,
              runs,
            };
          });
        }),
      );
    });
    router.get('/:classroomId/synthetic-media/:runId/video', async (request, response) => {
      const video = await this.locked(async () => {
        await this.sweepCore();
        return transaction(this.pool, async (client) => {
          const classroom = id(request.params.classroomId);
          const teacher = await manager(client, response.locals.identityTokenHash, classroom, true);
          const current = await lesson(client, classroom);
          const run = this.runs.get(id(request.params.runId));
          if (
            !run ||
            run.classroom !== classroom ||
            run.lesson !== current ||
            run.status !== 'ready' ||
            !(await this.valid(client, run))
          )
            fail(404, 'NOT_FOUND', '재생 가능한 현재 합성 녹화가 없습니다.');
          await audit(client, classroom, teacher, 'synthetic_media.video_viewed');
          await client.query(
            `INSERT INTO audit_logs(actor_id,action,target_id,result)
          VALUES($1,'synthetic_media.video_viewed',$2,'success')`,
            [teacher, run.id],
          );
          return Buffer.concat(run.chunks, run.bytes);
        });
      });
      response.set({
        'Content-Type': 'video/webm',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      response.send(video);
    });
    return router;
  }
}
