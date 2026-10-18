import express from 'express';
import { accessRouter, apiErrors, type AccessOptions } from './access.js';

export function createApp(access?: AccessOptions) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  if (access) {
    app.use('/api', accessRouter(access));
  } else {
    app.use('/api', (_request, response) => {
      response.status(503).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: '학교 로그인 설정이 아직 완료되지 않았습니다.',
        },
      });
    });
  }
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: '요청한 API가 없습니다.' } });
  });
  app.use(apiErrors);

  return app;
}
