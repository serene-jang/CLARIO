import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const id = (value: unknown) =>
  typeof value === 'string' && uuidPattern.test(value)
    ? value
    : fail(400, 'INVALID_INPUT', '올바른 식별자가 필요합니다.');
export const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : fail(400, 'INVALID_INPUT', `1~${max}자의 값을 입력해 주세요.`);
export const emailAddress = (value: unknown) => {
  const email = text(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail(400, 'INVALID_INPUT', '올바른 이메일 주소를 입력해 주세요.');
  }
  return email;
};

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
