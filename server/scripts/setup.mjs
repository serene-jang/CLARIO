import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { createSetupApp } from '../src/setup-app.ts';
import { bootstrapSchool } from '../src/bootstrap.ts';
import { connectDatabase, migrate } from '../src/database.ts';
import { startLocalDatabase } from './local-database.mjs';
import { readEnvironment, saveSetupEnvironment } from '../src/setup-environment.ts';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Local setup must not run in production.');
}
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const origin = 'http://127.0.0.1:5180';
const token = randomBytes(32).toString('base64url');
const envPath = resolve('.env');
const origins = 'http://127.0.0.1:5173,http://127.0.0.1:5174';
let database;

const app = createSetupApp({
  origin,
  token,
  assets: resolve('setup'),
  apply: async (input) => {
    const previous = await readEnvironment(envPath);
    const current = parse(previous);
    if (
      (current.PORT && current.PORT !== '4000') ||
      (current.APP_ORIGINS && current.APP_ORIGINS !== origins)
    ) {
      throw new Error(
        '기존 포트/허용 주소 설정이 있습니다. 기존 server/.env를 검토한 뒤 진행하세요.',
      );
    }
    if (current.DATABASE_URL) {
      let local;
      try {
        local = parse(await readFile(resolve('.local-postgres', 'connection.env'), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!local || current.DATABASE_URL !== local.DATABASE_URL) {
        throw new Error('기존 DB 연결 설정을 덮어쓰지 않습니다. 로컬 개발 DB 설정인지 확인하세요.');
      }
    }
    if (!database) {
      try {
        database = await startLocalDatabase();
      } catch {
        throw new Error(
          '로컬 DB를 시작하지 못했습니다. 터미널 오류와 55432 포트 사용 여부를 확인하세요.',
        );
      }
    }
    const connection = parse(await readFile(resolve('.local-postgres', 'connection.env'), 'utf8'));
    const pool = connectDatabase(connection.DATABASE_URL);
    try {
      await migrate(pool);
      await bootstrapSchool(pool, input, true);
    } catch (error) {
      console.error('local_setup_database_failed', error.code ?? error.name);
      throw new Error(
        'DB 적용에 실패했습니다. 기존 학교 정보와 입력값이 같은지, DB 연결이 정상인지 확인하세요. 기존 계정은 덮어쓰지 않습니다.',
      );
    } finally {
      await pool.end();
    }
    const values = {
      DATABASE_URL: connection.DATABASE_URL,
      GOOGLE_CLIENT_ID: input.googleClientId,
      APP_ORIGINS: origins,
      PORT: '4000',
    };
    try {
      await saveSetupEnvironment(envPath, previous, values);
    } catch {
      throw new Error(
        '학교 DB 등록은 완료했지만 설정 파일 저장에 실패했습니다. 파일 권한을 확인하고 같은 정보로 다시 적용하세요.',
      );
    }
  },
});
const server = app.listen(5180, '127.0.0.1', () => {
  console.log(`CLARIO local setup: ${origin}/#${token}`);
  console.log('Keep this terminal open while using the local database. Do not share this URL.');
});
server.on('error', (error) => {
  console.error('Local setup could not start:', error.code);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(async () => {
      if (database) await database.stop();
      process.exitCode = 0;
    });
  });
}
