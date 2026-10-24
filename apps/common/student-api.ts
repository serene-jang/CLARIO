import type { StudentSessionView, StudentJoinInput } from '@clario/shared';
import { RequestError } from './web-api.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isSession(value: unknown): value is StudentSessionView {
  if (!object(value)) return false;
  if (value.state === 'none') return typeof value.joinAvailable === 'boolean';
  if (
    !object(value.student) ||
    typeof value.student.name !== 'string' ||
    typeof value.student.studentNumber !== 'string' ||
    typeof value.csrfToken !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt))
  )
    return false;
  if (value.state === 'request')
    return ['pending', 'approved', 'rejected', 'cancelled'].includes(String(value.status));
  return (
    value.state === 'participant' &&
    object(value.classroom) &&
    typeof value.classroom.id === 'string' &&
    typeof value.classroom.name === 'string'
  );
}

export async function studentSessionRequest(
  action: 'read' | 'activate' | 'end' | 'join',
  csrfToken?: string,
  input?: StudentJoinInput,
): Promise<StudentSessionView> {
  const read = action === 'read';
  const response = await fetch(
    action === 'join' ? '/api/student/join' : `/api/student/session${read ? '' : `/${action}`}`,
    {
      method: read ? 'GET' : 'POST',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15000),
      headers: read
        ? {}
        : {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-Student-CSRF': csrfToken } : {}),
          },
      ...(read ? {} : { body: JSON.stringify(input ?? {}) }),
    },
  ).catch(() => {
    throw new RequestError(
      '서버에 연결할 수 없습니다. 네트워크와 같은 사이트 API 설정을 확인해 주세요.',
      0,
    );
  });
  if (response.status === 204 && action === 'end') return { state: 'none', joinAvailable: true };
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new RequestError(
      '학생 API에 연결되지 않았습니다. 같은 사이트 API 설정을 확인해 주세요.',
      response.status,
    );
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    const message =
      object(data) && object(data.error) && typeof data.error.message === 'string'
        ? data.error.message
        : '학생 요청 처리에 실패했습니다.';
    throw new RequestError(message, response.status);
  }
  if (!isSession(data)) throw new Error('학생 참여 응답 형식이 올바르지 않습니다.');
  return data;
}
