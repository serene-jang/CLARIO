import express, { type ErrorRequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { validateSchool, type SchoolBootstrap } from './bootstrap.js';

export interface LocalSetup extends SchoolBootstrap {
  googleClientId: string;
}

export function validateSetup(body: unknown): LocalSetup {
  if (!body || typeof body !== 'object') throw new Error('설정 입력값을 확인하세요.');
  const data = body as Record<string, unknown>;
  const { schoolName, domain, email, adminName, googleClientId: clientId } = data;
  if (
    typeof schoolName !== 'string' ||
    typeof domain !== 'string' ||
    typeof email !== 'string' ||
    typeof adminName !== 'string' ||
    typeof clientId !== 'string'
  ) {
    throw new Error('모든 필수 항목을 입력하세요.');
  }
  const googleClientId = clientId.trim();
  if (
    googleClientId.length > 300 ||
    !/^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(googleClientId)
  ) {
    throw new Error(
      'Google 웹 애플리케이션의 클라이언트 ID를 입력하세요. Client secret은 필요 없습니다.',
    );
  }
  return {
    ...validateSchool({ schoolName, domain, email, adminName }),
    googleClientId,
  };
}

export function createSetupApp(options: {
  origin: string;
  token: string;
  assets: string;
  apply: (input: LocalSetup) => Promise<void>;
}) {
  const app = express();
  let applying = false;
  let completed = false;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    if (
      req.headers.host !== new URL(options.origin).host ||
      !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    ) {
      res.status(403).json({ error: '이 PC의 로컬 설정 주소에서만 접근할 수 있습니다.' });
      return;
    }
    next();
  });
  app.use('/apply', (req, res, next) => {
    const supplied = Buffer.from(req.get('X-Setup-Token') ?? '');
    const expected = Buffer.from(options.token);
    if (
      req.get('origin') !== options.origin ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.status(403).json({ error: '설정 터미널에 표시된 전체 주소로 다시 접속하세요.' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.post('/apply', async (req, res) => {
    if (completed || applying) {
      res
        .status(409)
        .json({ error: completed ? '이미 설정을 완료했습니다.' : '설정 적용 중입니다.' });
      return;
    }
    let input: LocalSetup;
    try {
      input = validateSetup(req.body);
    } catch (error) {
      res
        .status(400)
        .json({ error: error instanceof Error ? error.message : '입력값 오류입니다.' });
      return;
    }
    applying = true;
    try {
      await options.apply(input);
      completed = true;
      res.json({ ok: true });
    } catch (error) {
      console.error('local_setup_failed', error instanceof Error ? error.name : 'UnknownError');
      res.status(500).json({
        error:
          error instanceof Error ? error.message : '설정에 실패했습니다. 로컬 터미널을 확인하세요.',
      });
    } finally {
      applying = false;
    }
  });
  app.use(express.static(options.assets, { index: 'index.html' }));
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => {
    console.error('local_setup_request_rejected');
    res.status(400).json({ error: '올바른 JSON 입력이 아니거나 요청 크기가 너무 큽니다.' });
  };
  app.use(errors);
  return app;
}
