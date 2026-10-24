import { useEffect, useState } from 'react';
import { presencePolicy, type StudentLessonView } from '@clario/shared';
import { errorMessage, RequestError } from './web-api.js';
function isView(value: unknown): value is StudentLessonView {
  if (
    !value ||
    typeof value !== 'object' ||
    !('observedAt' in value) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !('expiresAt' in value) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !('lesson' in value)
  )
    return false;
  return (
    value.lesson === null ||
    (typeof value.lesson === 'object' &&
      value.lesson !== null &&
      'id' in value.lesson &&
      typeof value.lesson.id === 'string' &&
      'startedAt' in value.lesson &&
      typeof value.lesson.startedAt === 'string')
  );
}
async function requestLesson(csrf: string, body?: object): Promise<StudentLessonView> {
  const response = await fetch(`/api/student/lesson${body ? '/heartbeat' : ''}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(presencePolicy.requestTimeoutMs),
    headers: body ? { 'Content-Type': 'application/json', 'X-Student-CSRF': csrf } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch(() => {
    throw new RequestError('중앙 서버에 연결할 수 없습니다.', 0);
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const message =
      value &&
      typeof value === 'object' &&
      'error' in value &&
      value.error &&
      typeof value.error === 'object' &&
      'message' in value.error &&
      typeof value.error.message === 'string'
        ? value.error.message
        : '수업 연결을 확인할 수 없습니다.';
    throw new RequestError(message, response.status);
  }
  if (!isView(value)) throw new Error('수업 연결 응답을 확인할 수 없습니다.');
  return value;
}
export default function StudentLesson({
  csrfToken,
  onInvalid,
  onExpiry,
}: {
  csrfToken: string;
  onInvalid: (message: string) => void;
  onExpiry: (expiresAt: string) => void;
}) {
  const [view, setView] = useState<StudentLessonView | null>(null),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    let stopped = false,
      inFlight = false,
      connectionId = crypto.randomUUID(),
      sessionId: string | null = null,
      sequence = 0;
    let lastSuccess = 0;
    setView(null);
    setError('');
    setConfirmed(false);
    async function sync() {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        let next = await requestLesson(csrfToken);
        if (stopped) return;
        if (next.lesson) {
          if (next.lesson.id !== sessionId) {
            sessionId = next.lesson.id;
            connectionId = crypto.randomUUID();
            sequence = 0;
          }
          next = await requestLesson(csrfToken, { sessionId, connectionId, sequence: ++sequence });
          if (stopped) return;
        } else {
          sessionId = null;
          sequence = 0;
        }
        setView(next);
        setError('');
        setConfirmed(true);
        lastSuccess = Date.now();
        onExpiry(next.expiresAt);
      } catch (cause) {
        if (stopped) return;
        setConfirmed(false);
        setError(errorMessage(cause));
        if (cause instanceof RequestError && cause.status === 401) {
          setView(null);
          stopped = true;
          onInvalid(cause.message);
        } else if (cause instanceof RequestError && cause.status === 409) {
          sessionId = null;
          connectionId = crypto.randomUUID();
          sequence = 0;
          setView(null);
        }
      } finally {
        inFlight = false;
      }
    }
    void sync();
    const timer = window.setInterval(() => void sync(), presencePolicy.heartbeatMs);
    const freshness = window.setInterval(() => {
      if (
        lastSuccess &&
        Date.now() - lastSuccess >= presencePolicy.heartbeatMs + presencePolicy.requestTimeoutMs
      )
        setConfirmed(false);
    }, 1000);
    const resume = () => {
      connectionId = crypto.randomUUID();
      sessionId = null;
      sequence = 0;
      void sync();
    };
    window.addEventListener('pageshow', resume);
    window.addEventListener('online', resume);
    const visible = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(freshness);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [csrfToken, onInvalid, onExpiry]);
  return (
    <section aria-label="내 수업 연결">
      <h3>내 수업 연결</h3>
      {!confirmed ? (
        <p role="status">서버 상태 확인 불가 · 연결 중이거나 재연결을 시도하고 있습니다.</p>
      ) : view?.lesson ? (
        <p role="status">수업 연결 확인됨 · 10초마다 중앙 서버에 연결을 확인합니다.</p>
      ) : (
        <p role="status">진행 중인 수업이 없습니다. 참여 승인은 유지됩니다.</p>
      )}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {view && (
        <p>
          {confirmed ? '서버 확인' : '마지막 확인 결과'}:{' '}
          {new Date(view.observedAt).toLocaleString()}
        </p>
      )}
      <p>
        수업 연결 상태와 마지막 확인 시각을 교사에게 전송합니다. 화면·열린 사이트·영상은 수집하지
        않습니다. 탭이 절전되거나 네트워크가 끊기면 실제 확인 시각에 따라 재연결/오프라인으로 보일
        수 있습니다.
      </p>
    </section>
  );
}
