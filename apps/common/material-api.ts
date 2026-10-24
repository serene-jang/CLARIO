import type { MaterialList } from '@clario/shared';
import { RequestError } from './web-api.js';

export function isMaterialList(value: unknown): value is MaterialList {
  if (
    !value ||
    typeof value !== 'object' ||
    !('materials' in value) ||
    !Array.isArray(value.materials) ||
    !('total' in value) ||
    !Number.isInteger(value.total) ||
    !('page' in value) ||
    !Number.isInteger(value.page) ||
    !('pageSize' in value) ||
    value.pageSize !== 50 ||
    !('observedAt' in value) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    return false;
  return value.materials.every(
    (m) =>
      m &&
      typeof m === 'object' &&
      typeof m.id === 'string' &&
      typeof m.title === 'string' &&
      typeof m.createdAt === 'string' &&
      Number.isFinite(Date.parse(m.createdAt)) &&
      typeof m.expiresAt === 'string' &&
      Number.isFinite(Date.parse(m.expiresAt)) &&
      (m.receivedAt === null || typeof m.receivedAt === 'string') &&
      (m.openedAt === null || typeof m.openedAt === 'string'),
  );
}
export async function studentMaterialRequest(
  path: string,
  csrfToken: string,
  body?: object,
): Promise<unknown> {
  const response = await fetch(`/api/student/materials${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(5000),
    headers: body ? { 'Content-Type': 'application/json', 'X-Student-CSRF': csrfToken } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => {
    throw new RequestError('자료 서버에 연결할 수 없습니다.', 0);
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message =
      data &&
      typeof data === 'object' &&
      'error' in data &&
      data.error &&
      typeof data.error === 'object' &&
      'message' in data.error &&
      typeof data.error.message === 'string'
        ? data.error.message
        : '자료 요청을 처리할 수 없습니다.';
    throw new RequestError(message, response.status);
  }
  return data;
}
