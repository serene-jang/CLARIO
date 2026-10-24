import express from 'express';
import { accessRouter, apiErrors, type AccessOptions } from './access.js';
import { webHosting } from './web-hosting.js';
import { databaseVersion } from './database.js';

export function createApp(
  access?: AccessOptions,
  operations?: {
    web?: { teacher: string; student: string };
  },
) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });
  app.get('/ready', async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!access) {
      response.status(503).json({ status: 'not_ready', code: 'AUTH_NOT_CONFIGURED' });
      return;
    }
    try {
      const query = {
        text: 'SELECT version FROM schema_migrations WHERE version=$1',
        values: [databaseVersion],
        query_timeout: 3000,
      };
      const ready = Boolean((await access.pool.query(query)).rowCount);
      response
        .status(ready ? 200 : 503)
        .json(ready ? { status: 'ready' } : { status: 'not_ready', code: 'MIGRATION_REQUIRED' });
    } catch {
      console.error('readiness_database_failed');
      response.status(503).json({ status: 'not_ready', code: 'DATABASE_UNAVAILABLE' });
    }
  });

  if (access) {
    app.use('/api', accessRouter(access));
  } else {
    app.use('/api', (_request, response) => {
      response.status(503).json({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message:
            'CLARIO 계정 서버의 데이터베이스 설정이 아직 완료되지 않았습니다. 학교 API는 필요하지 않습니다.',
        },
      });
    });
  }
  app.use('/api', (_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: '요청한 API가 없습니다.' } });
  });
  if (operations?.web) app.use(webHosting(operations.web));
  app.use(apiErrors);

  return app;
}
