import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { fail } from './api-core.js';

const parameters = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const dummyHash = `scrypt$${'0'.repeat(32)}$${'0'.repeat(64)}`;
let active = 0;

export function passwordInput(value: unknown) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    fail(400, 'INVALID_PASSWORD', '비밀번호는 12~128자로 입력해 주세요.');
  }
  return value;
}

async function derive(password: string, salt: string) {
  if (active >= 4) fail(429, 'AUTH_BUSY', '로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, parameters, (error, key) =>
        error ? reject(error) : resolve(key),
      );
    });
  } finally {
    active--;
  }
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(passwordInput(password), salt);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function matchesPassword(password: string, encoded: string | null) {
  const value = encoded ?? dummyHash;
  if (!/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(value)) {
    throw new Error('Unsupported stored password hash.');
  }
  const [, salt, expected] = value.split('$');
  const actual = await derive(passwordInput(password), salt);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && encoded !== null;
}
