import { useEffect, useRef, useState } from 'react';
import { presencePolicy, type ClassroomFocusView } from '@clario/shared';
import { errorMessage, RequestError } from './web-api.js';

type Api = <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
type Props =
  | {
      role: 'teacher';
      classroomId: string;
      token: string;
      closed: boolean;
      api: Api;
    }
  | {
      role: 'student';
      csrfToken: string;
      onInvalid: (message: string) => void;
      onExpiry: (expiresAt: string) => void;
    };
function valid(value: unknown): value is ClassroomFocusView {
  if (
    !value ||
    typeof value !== 'object' ||
    !('enabled' in value) ||
    typeof value.enabled !== 'boolean' ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !Number.isInteger(value.version) ||
    value.version < 0 ||
    !('updatedAt' in value) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !('observedAt' in value) ||
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    !('lesson' in value)
  )
    return false;
  return value.lesson === null
    ? !value.enabled
    : !!value.lesson &&
        typeof value.lesson === 'object' &&
        'id' in value.lesson &&
        typeof value.lesson.id === 'string' &&
        'startedAt' in value.lesson &&
        typeof value.lesson.startedAt === 'string' &&
        Number.isFinite(Date.parse(value.lesson.startedAt));
}
async function studentRead(): Promise<unknown> {
  const response = await fetch('/api/student/focus', {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(presencePolicy.requestTimeoutMs),
  }).catch(() => {
    throw new RequestError('집중 안내 서버에 연결할 수 없습니다.', 0);
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
        : '집중 안내를 확인할 수 없습니다.';
    throw new RequestError(message, response.status);
  }
  return value;
}
export default function FocusPanel(props: Props) {
  const teacher = props.role === 'teacher';
  const scope = teacher ? `${props.classroomId}:${props.token}:${props.closed}` : props.csrfToken;
  const interval = teacher ? presencePolicy.teacherPollMs : presencePolicy.heartbeatMs;
  const [view, setView] = useState<ClassroomFocusView | null>(null),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [stale, setStale] = useState(true);
  const generation = useRef(0),
    inFlight = useRef(false),
    lastSuccess = useRef(0),
    latestVersion = useRef(-1);
  const stopped = useRef(false),
    read = useRef(() => {});
  async function perform(enabled?: boolean) {
    if (inFlight.current || stopped.current) return;
    inFlight.current = true;
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const next: unknown =
        props.role === 'teacher'
          ? await props.api(
              `/identity/classrooms/${props.classroomId}/focus`,
              props.token,
              enabled === undefined ? 'GET' : 'PATCH',
              enabled === undefined
                ? undefined
                : { enabled, sessionId: view?.lesson?.id, expectedVersion: view?.version },
            )
          : await studentRead();
      if (current !== generation.current) return;
      if (!valid(next) || next.version < latestVersion.current)
        throw new Error('최신 집중 안내 응답을 확인할 수 없습니다.');
      if (props.role === 'student') {
        if (
          !('expiresAt' in next) ||
          typeof next.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(next.expiresAt))
        )
          throw new Error('집중 안내 참여 자격 응답을 확인할 수 없습니다.');
        props.onExpiry(next.expiresAt);
      }
      latestVersion.current = next.version;
      setView(next);
      setStale(false);
      lastSuccess.current = Date.now();
    } catch (cause) {
      if (current !== generation.current) return;
      setError(errorMessage(cause));
      setStale(true);
      if (cause instanceof RequestError && [401, 403, 404].includes(cause.status)) {
        setView(null);
        if (props.role === 'student' && [401, 403].includes(cause.status)) {
          stopped.current = true;
          props.onInvalid(cause.message);
        }
      }
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  read.current = () => void perform();
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    stopped.current = false;
    lastSuccess.current = 0;
    latestVersion.current = -1;
    setView(null);
    setError('');
    setStale(true);
    read.current();
    const timer = window.setInterval(() => read.current(), interval);
    const freshness = window.setInterval(() => {
      if (
        lastSuccess.current &&
        Date.now() - lastSuccess.current >= interval + presencePolicy.requestTimeoutMs
      )
        setStale(true);
    }, 1000);
    const resume = () => {
      if (document.visibilityState === 'visible') {
        setStale(true);
        read.current();
      }
    };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      window.clearInterval(freshness);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [scope, interval]);
  return (
    <section aria-label={teacher ? '교실 자율 집중 안내' : '내 자율 집중 안내'}>
      <h3>자율 집중 안내</h3>
      <p>
        수업에 필요한 자료에 집중해 주세요. 이 기능은 안내만 표시하며 사이트·앱 차단, 화면
        제어·녹화·행동 감시를 하지 않습니다. 학생의 준수 여부를 수집하지 않습니다.
      </p>
      {teacher && (
        <p>
          진행 중인 수업에서만 변경할 수 있습니다. 수업·교실 종료 시 해제되며 다음 수업은 꺼짐으로
          시작합니다.
        </p>
      )}
      {busy && <p role="status">집중 안내를 확인하고 있습니다.</p>}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {stale && (
        <p role="status">집중 안내 확인 불가 · 마지막 상태를 현재 적용 상태로 해석하지 마세요.</p>
      )}
      {view && (
        <>
          <p role="status">
            {stale ? '마지막 확인 결과' : '현재 서버 확인 결과'}: 자율 집중 안내{' '}
            {view.enabled ? '켜짐' : '꺼짐'}
          </p>
          {!view.lesson && (
            <p>
              {stale
                ? '마지막 확인 때 진행 중인 수업이 없었습니다.'
                : '진행 중인 수업이 없어 자율 집중 안내가 꺼져 있습니다.'}
            </p>
          )}
          <p>
            서버 확인 {new Date(view.observedAt).toLocaleString()} · 상태 변경{' '}
            {new Date(view.updatedAt).toLocaleString()} · 버전 {view.version}
          </p>
        </>
      )}
      <button disabled={busy || stopped.current} onClick={() => void perform()}>
        {teacher ? '집중 안내 다시 확인' : '내 집중 안내 다시 확인'}
      </button>
      {props.role === 'teacher' && !props.closed && (
        <button
          disabled={busy || stale || !view?.lesson}
          onClick={() => void perform(!view?.enabled)}
        >
          {view?.enabled ? '자율 집중 안내 끄기' : '자율 집중 안내 켜기'}
        </button>
      )}
    </section>
  );
}
