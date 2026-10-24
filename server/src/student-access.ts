import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type ErrorRequestHandler } from 'express';
import type { AccessOptions } from './access.js';
import { ApiError, fail, id, transaction } from './api-core.js';
import {
  documentHeaders,
  studentDocuments,
  studentDocumentDownload,
} from './classroom-documents.js';
import { issueBrowserCode, studentBlocking } from './site-blocking.js';
import {
  endStudentSession,
  issueApprovedStudentCredential,
  readStudentSession,
  studentCsrfToken,
} from './student-sessions.js';
import {
  browserIdentifier,
  consumeJoinBudget,
  createStudentJoin,
  joinRateSecret,
  parseJoinInput,
} from './student-join.js';
import { studentHeartbeat, studentLesson } from './lesson-presence.js';
import { studentFocus } from './classroom-focus.js';
import {
  studentMaterials,
  studentMaterialAction,
  studentMaterialReceipt,
} from './classroom-materials.js';

function cookieToken(request: Request, name: string) {
  const values = (request.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0])) {
    fail(
      401,
      'STUDENT_COOKIE_INVALID',
      '참여 자격을 확인할 수 없습니다. 교사에게 복구를 요청해 주세요.',
    );
  }
  return values[0];
}

export function studentRouter({ pool, origins, syntheticMedia, documents }: AccessOptions) {
  const router = express.Router();
  router.use((request, response, next) => {
    const origin = request.get('origin');
    const fetchSite = request.get('sec-fetch-site');
    const expected = origins
      .map((value) => new URL(value))
      .find((url) => url.host === request.get('host'));
    if (
      !expected ||
      (request.method !== 'GET' && !origin) ||
      (origin ? origin !== expected.origin : fetchSite !== 'same-origin') ||
      (fetchSite && fetchSite !== 'same-origin')
    ) {
      fail(
        403,
        'STUDENT_SAME_ORIGIN_REQUIRED',
        '학생 참여는 같은 사이트의 API 연결이 필요합니다. 교사에게 서버 설정 확인을 요청해 주세요.',
      );
    }
    const local =
      expected.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(expected.hostname) &&
      process.env.NODE_ENV !== 'production';
    if (expected.protocol !== 'https:' && !local) {
      fail(403, 'STUDENT_HTTPS_REQUIRED', '학생 참여에는 HTTPS 연결이 필요합니다.');
    }
    response.locals.studentCookie = local ? 'clario-student-dev' : '__Host-clario-student';
    response.locals.studentCookieSecure = !local;
    next();
  });
  const setCookie = (response: Response, token?: string, expiresAt?: Date) => {
    const name: string = response.locals.studentCookie;
    response.cookie(name, token ?? '', {
      path: '/',
      httpOnly: true,
      secure: response.locals.studentCookieSecure === true,
      sameSite: 'strict',
      ...(expiresAt ? { expires: expiresAt } : { maxAge: 0 }),
    });
  };
  const csrf = (request: Request, token: string | undefined) => {
    if (!request.is('application/json'))
      fail(415, 'STUDENT_JSON_REQUIRED', 'JSON 요청 형식이 필요합니다.');
    if (!token) return;
    const received = request.get('x-student-csrf') ?? '';
    const expected = studentCsrfToken(token);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(received) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(expected))
    ) {
      fail(
        403,
        'STUDENT_CSRF_DENIED',
        '요청을 확인할 수 없습니다. 참여 상태를 다시 확인해 주세요.',
      );
    }
  };
  const browserCookie = async (request: Request, response: Response) => {
    const secret = await joinRateSecret(pool);
    const name = response.locals.studentCookieSecure
      ? '__Host-clario-browser'
      : 'clario-browser-dev';
    const values = (request.get('cookie') ?? '')
      .split(';')
      .map((p) => p.trim())
      .filter((p) => p.startsWith(`${name}=`));
    const old = values.length === 1 ? values[0].slice(name.length + 1) : undefined;
    const browser = browserIdentifier(secret, old);
    if (browser !== old)
      response.cookie(name, browser, {
        path: '/',
        httpOnly: true,
        secure: response.locals.studentCookieSecure === true,
        sameSite: 'strict',
      });
    return { secret, browser };
  };
  router.post('/join', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    csrf(request, token);
    const { secret, browser } = await browserCookie(request, response);
    const rawCode =
      typeof request.body?.code === 'string'
        ? request.body.code.trim().toUpperCase().slice(0, 128)
        : '';
    // Express does not trust forwarding headers; proxy deployment must not enable arbitrary trust.
    const retry = await consumeJoinBudget(
      pool,
      secret,
      browser,
      request.socket.remoteAddress ?? 'unknown',
      rawCode,
    );
    if (retry) {
      response.set('Retry-After', String(retry));
      fail(
        429,
        'JOIN_RATE_LIMITED',
        `신청 요청이 많습니다. ${retry}초 후 다시 시도해 주세요. 공유 네트워크라면 교사에게 확인해 주세요.`,
      );
    }
    const input = parseJoinInput(request.body);
    if (token) {
      await transaction(pool, (client) => readStudentSession(client, token));
      fail(409, 'STUDENT_SESSION_EXISTS', '이 브라우저의 기존 참여를 먼저 종료해 주세요.');
    }
    const result = await transaction(pool, async (client) => {
      const credential = await createStudentJoin(client, input);
      return { credential, view: (await readStudentSession(client, credential.token)).view };
    });
    setCookie(response, result.credential.token, result.credential.expiresAt);
    response.status(201).json(result.view);
  });
  router.get('/session', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    if (!token) {
      await browserCookie(request, response);
      response.json({ state: 'none', joinAvailable: true });
      return;
    }
    const result = await transaction(pool, (client) => readStudentSession(client, token));
    response.json(result.view);
  });
  router.post('/session/activate', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    csrf(request, token);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '참여 신청 확인이 필요합니다.');
    const result = await transaction(pool, async (client) => {
      const current = await readStudentSession(client, token);
      if (current.row.scope !== 'pending' || !current.row.request_id) {
        fail(409, 'STUDENT_ALREADY_ACTIVE', '이미 참여 중입니다. 참여 상태를 다시 확인해 주세요.');
      }
      const credential = await issueApprovedStudentCredential(client, current.row.request_id);
      const session = await readStudentSession(client, credential.token);
      return { credential, view: session.view };
    });
    setCookie(response, result.credential.token, result.credential.expiresAt);
    response.json(result.view);
  });
  router.post('/session/end', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    csrf(request, token);
    if (token) await transaction(pool, (client) => endStudentSession(client, token));
    setCookie(response);
    response.sendStatus(204);
  });
  router.get('/materials', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    response.json(
      await transaction(pool, (client) => studentMaterials(client, token, request.query.page)),
    );
  });
  router.post('/materials/received', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    csrf(request, token);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    response.json(
      await transaction(pool, (client) => studentMaterialReceipt(client, token, request.body)),
    );
  });
  router.post('/materials/:materialId/:action', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    csrf(request, token);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    response.json(
      await transaction(pool, (client) =>
        studentMaterialAction(
          client,
          token,
          request.params.materialId,
          request.params.action,
          request.body,
        ),
      ),
    );
  });
  router.get('/focus', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    response.json(await transaction(pool, (client) => studentFocus(client, token)));
  });
  router.get('/lesson', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    response.json(await transaction(pool, (client) => studentLesson(client, token)));
  });
  router.post('/lesson/:action', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    csrf(request, token);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    if (!['heartbeat', 'disconnect'].includes(request.params.action))
      fail(404, 'NOT_FOUND', '지원하지 않는 연결 작업입니다.');
    response.json(
      await transaction(pool, (client) =>
        studentHeartbeat(client, token, request.body, request.params.action === 'disconnect'),
      ),
    );
  });
  router.get('/documents', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    const result = await transaction(pool, (client) => studentDocuments(client, token));
    response.json({ enabled: Boolean(documents), documents: result.documents });
  });
  router.get('/documents/:documentId/download', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    if (!documents) fail(503, 'DOCUMENT_STORAGE_DISABLED', '문서 저장소가 비활성입니다.');
    const document = id(request.params.documentId);
    const data = await transaction(pool, (client) =>
      studentDocumentDownload(client, token, document, documents),
    );
    documentHeaders(response, document);
    response.send(data);
  });
  router.get('/blocking', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    response.json(await transaction(pool, (client) => studentBlocking(client, token)));
  });
  router.post('/browser-code', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    csrf(request, token);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    response.status(201).json(await transaction(pool, (client) => issueBrowserCode(client, token)));
  });
  router.get('/screen-media', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    await transaction(pool, async (client) => {
      const current = await readStudentSession(client, token);
      if (current.view.state !== 'participant')
        fail(403, 'APPROVAL_REQUIRED', '교사 승인이 필요합니다.');
    });
    response.json({ enabled: false, reason: 'POLICY_NOT_CONFIGURED', persistentStorage: false });
  });
  router.post('/screen-media/:action', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    csrf(request, token);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    await transaction(pool, async (client) => {
      const current = await readStudentSession(client, token);
      if (current.view.state !== 'participant')
        fail(403, 'APPROVAL_REQUIRED', '교사 승인이 필요합니다.');
      await client.query(
        `INSERT INTO classroom_participation_audit(id,class_id,actor_kind,participant_id,action,result)
         VALUES($1,$2,'participant',$3,'screen_media.policy_denied','denied')`,
        [randomUUID(), current.row.class_id, current.row.participant_id],
      );
    });
    fail(
      403,
      'SCREEN_MEDIA_POLICY_REQUIRED',
      '승인된 보관 정책·저장소·열람/삭제 권한 설정 전에는 실제 화면을 수집할 수 없습니다.',
    );
  });
  router.get('/synthetic-media', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    if (!syntheticMedia) {
      await transaction(pool, (client) => readStudentSession(client, token));
      response.json({ enabled: false, synthetic: true });
      return;
    }
    response.json(await syntheticMedia.student(token, 'read'));
  });
  router.post('/synthetic-media/:action', async (request, response) => {
    const token = cookieToken(request, response.locals.studentCookie);
    csrf(request, token);
    if (!token) fail(401, 'STUDENT_SESSION_REQUIRED', '학생 참여 자격이 필요합니다.');
    if (!syntheticMedia) fail(403, 'SYNTHETIC_MEDIA_DISABLED', '합성 미디어 시험은 비활성입니다.');
    response.json(await syntheticMedia.student(token, request.params.action, request.body));
  });
  router.use((_request, _response) => fail(404, 'NOT_FOUND', '요청한 학생 API가 없습니다.'));
  const errors: ErrorRequestHandler = (error: unknown, request, response, next) => {
    // A losing activation in another tab must not erase the newly rotated cookie.
    if (error instanceof ApiError && error.status === 401 && request.path !== '/session/activate')
      setCookie(response);
    next(error);
  };
  router.use(errors);
  return router;
}
