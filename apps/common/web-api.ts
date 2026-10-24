import { presencePolicy } from '@clario/shared';
export class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '요청 처리에 실패했습니다.';

export async function requestJson<T>(
  apiBase: string,
  path: string,
  token?: string,
  method = 'GET',
  body?: object,
): Promise<T> {
  if (apiBase) {
    const url = new URL(apiBase);
    if (
      url.origin !== apiBase ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
    )
      throw new Error('API 주소 설정이 올바르지 않습니다.');
  }
  const response = await fetch(`${apiBase}/api${path}`, {
    method,
    credentials: 'omit',
    signal: AbortSignal.timeout(
      /^\/identity\/classrooms\/[^/]+\/(?:lesson|materials|focus|synthetic-media)(?:[/?]|$)/.test(
        path,
      )
        ? presencePolicy.requestTimeoutMs
        : 15000,
    ),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new RequestError('서버에 연결할 수 없습니다. 네트워크와 API 주소를 확인해 주세요.', 0);
  });
  if (response.status === 204) return undefined as T;
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error('CLARIO 계정 서버에 연결되지 않았습니다. 서비스 서버 연결을 확인해 주세요.');
  }
  const data = await response.json();
  if (!response.ok) {
    throw new RequestError(data.error?.message ?? '요청 처리에 실패했습니다.', response.status);
  }
  return data as T;
}
