import { useEffect, useRef, useState } from 'react';
import { presencePolicy, type TeacherLessonView } from '@clario/shared';
import { errorMessage, RequestError } from './web-api.js';
type Api = <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
const states = { online: '온라인', reconnecting: '재연결 중', offline: '오프라인' };
export default function TeacherLesson({
  classroomId,
  closed,
  token,
  api,
  onChanged,
  onLessonStateChange,
}: {
  classroomId: string;
  closed: boolean;
  token: string;
  api: Api;
  onChanged?: () => void;
  onLessonStateChange?: (active: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<TeacherLessonView | null>(null),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [checked, setChecked] = useState(false);
  const [stale, setStale] = useState(true);
  const generation = useRef(0),
    inFlight = useRef(false),
    receivedAt = useRef(0);
  const performRef = useRef<() => void>(() => {});
  async function perform(action?: 'start' | 'end') {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    let saved = false;
    try {
      const next = await api<TeacherLessonView>(
        `/identity/classrooms/${classroomId}/lesson${action ? `/${action}` : ''}`,
        token,
        action ? 'POST' : 'GET',
        action === 'end'
          ? { sessionId: snapshot?.lesson?.id, confirm: true }
          : action
            ? {}
            : undefined,
      );
      if (version !== generation.current) return;
      if (
        !next ||
        !Array.isArray(next.students) ||
        !next.counts ||
        typeof next.observedAt !== 'string' ||
        !(next.lesson === null || (next.lesson && typeof next.lesson.id === 'string'))
      )
        throw new Error('수업 현황 응답을 확인할 수 없습니다.');
      setSnapshot(next);
      onLessonStateChange?.(next.lesson !== null);
      receivedAt.current = Date.now();
      setStale(false);
      if (action || snapshot?.lesson?.id !== next.lesson?.id) {
        setConfirm(false);
        setChecked(false);
      }
      if (action) {
        saved = true;
        onChanged?.();
      }
    } catch (cause) {
      if (version !== generation.current) return;
      setStale(true);
      if (cause instanceof RequestError && [401, 403, 404].includes(cause.status)) {
        setSnapshot(null);
        onLessonStateChange?.(false);
        setConfirm(false);
        setChecked(false);
      }
      setError(`${saved ? '수업 변경은 저장되었습니다. ' : ''}${errorMessage(cause)}`);
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  performRef.current = () => void perform();
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    receivedAt.current = 0;
    setSnapshot(null);
    setError('');
    setStale(true);
    setConfirm(false);
    setChecked(false);
    performRef.current();
    const timer = window.setInterval(() => performRef.current(), presencePolicy.teacherPollMs);
    const freshness = window.setInterval(() => {
      if (
        receivedAt.current &&
        Date.now() - receivedAt.current >=
          presencePolicy.teacherPollMs + presencePolicy.requestTimeoutMs
      )
        setStale(true);
    }, 1000);
    const resume = () => {
      if (document.visibilityState === 'visible') {
        if (
          Date.now() - receivedAt.current >=
          presencePolicy.teacherPollMs + presencePolicy.requestTimeoutMs
        )
          setStale(true);
        performRef.current();
      }
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      window.clearInterval(freshness);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [classroomId, token, closed]);
  return (
    <section aria-label="수업 현황">
      <h3>수업·실제 연결 현황</h3>
      <p>
        학생 10초 확인 · 교사 5초 조회. 20초 미만 온라인, 20~45초 재연결 중, 45초 이상
        오프라인입니다. 승인·신청과 실제 접속은 다릅니다. 여러 탭도 한 학생으로 집계합니다.
      </p>
      {stale && (
        <p role="status">서버 상태 확인 불가 · 학생 전체가 오프라인이라는 뜻은 아닙니다.</p>
      )}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {snapshot && stale && <p>아래는 마지막 확인 결과입니다. 현재 접속 상태로 해석하지 마세요.</p>}
      <button disabled={busy} onClick={() => void perform()}>
        수업 현황 다시 확인
      </button>
      {!closed && snapshot && !snapshot.lesson && (
        <button disabled={busy || stale} onClick={() => void perform('start')}>
          수업 시작
        </button>
      )}
      {snapshot?.lesson ? (
        <>
          <p>
            수업 시작 {new Date(snapshot.lesson.startedAt).toLocaleString()} · 서버 확인{' '}
            {new Date(snapshot.observedAt).toLocaleString()}
          </p>
          <p>
            {stale ? '마지막 결과' : '현재 확인 결과'}: 온라인 {snapshot.counts.online}명 · 재연결
            중 {snapshot.counts.reconnecting}명 · 오프라인 {snapshot.counts.offline}명
          </p>
          {!closed && (
            <button
              disabled={busy || stale}
              onClick={() => {
                setConfirm(true);
                setChecked(false);
              }}
            >
              수업 종료 준비
            </button>
          )}
          <ul className="workspace-list">
            {snapshot.students.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>
                    {s.name} · 학번 {s.studentNumber}
                  </strong>
                  <p>
                    {stale ? '상태 확인 불가 (마지막 결과: ' : ''}
                    {states[s.state]}
                    {stale ? ')' : ''}
                  </p>
                  <p>
                    마지막 서버 확인:{' '}
                    {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '아직 연결 기록 없음'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        snapshot && (
          <p>
            진행 중인 수업이 없습니다. 승인된 학생도 수업 시작과 실제 연결 전에는 온라인이 아닙니다.
          </p>
        )
      )}
      {confirm && snapshot?.lesson && !closed && (
        <div role="group" aria-label="수업 종료 확인">
          <p>
            현재 수업과 연결을 종료하고 초대코드·대기 신청을 폐기하며 집중 안내를 해제합니다. 승인된
            학생 기록과 유효 참여 자격은 유지합니다.
          </p>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            현재 수업 종료와 초대코드·대기 신청 폐기를 확인했습니다
          </label>
          <button disabled={busy || stale || !checked} onClick={() => void perform('end')}>
            확인하고 수업 종료
          </button>
          <button disabled={busy} onClick={() => setConfirm(false)}>
            수업 종료 취소
          </button>
        </div>
      )}
    </section>
  );
}
