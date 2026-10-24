import { useEffect, useRef, useState } from 'react';
import { errorMessage, RequestError } from './web-api.js';

type Api = <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
interface Notification {
  id: string;
  action: string;
  kind: 'test' | 'actual';
  createdAt: string;
}
const labels: Record<string, string> = {
  'student.join_requested': '새 학생 참여·복구 신청이 접수되었습니다.',
  'classroom.request_approved': '학생 참여를 승인했습니다.',
  'classroom.request_rejected': '학생 참여 신청을 거절했습니다.',
  'classroom.recovery_approved': '학생 참여 복구를 승인했습니다.',
  'material.sent': '수업 자료를 배포했습니다.',
  'material.deleted': '수업 자료를 삭제했습니다.',
  'focus.started': '자율 집중 안내를 활성화했습니다.',
  'focus.ended': '자율 집중 안내를 해제했습니다.',
  'notification.test.screen_difference':
    '화면 비교 알림 모양을 시험했습니다. 실제 화면을 비교하지 않았습니다.',
  'notification.test.input_activity':
    '입력 감지 알림 모양을 시험했습니다. 실제 입력을 감지하지 않았습니다.',
};
export default function TeacherNotifications({
  classroomId,
  token,
  api,
  closed,
}: {
  classroomId: string;
  token: string;
  api: Api;
  closed: boolean;
}) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(true);
  const [notice, setNotice] = useState('');
  const generation = useRef(0),
    inFlight = useRef(false),
    read = useRef(() => {});
  const lastSuccess = useRef(0);
  const base = `/identity/classrooms/${classroomId}/notifications`;
  async function perform(event?: 'screen_difference' | 'input_activity') {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    let saved = false;
    try {
      if (event) {
        await api(`${base}/test`, token, 'POST', { event });
        saved = true;
      }
      const result = await api<{ notifications: Notification[] }>(base, token);
      if (current !== generation.current) return;
      if (
        !Array.isArray(result.notifications) ||
        !result.notifications.every(
          (item) =>
            typeof item.id === 'string' &&
            Object.hasOwn(labels, item.action) &&
            ['test', 'actual'].includes(item.kind) &&
            Number.isFinite(Date.parse(item.createdAt)),
        )
      )
        throw new Error('교사 알림 응답을 확인할 수 없습니다.');
      setItems(result.notifications);
      setStale(false);
      lastSuccess.current = Date.now();
      if (event)
        setNotice('테스트 이벤트를 서버에 저장했습니다. 실제 학생 활동은 감지하지 않았습니다.');
    } catch (cause) {
      if (current !== generation.current) return;
      setError(
        `${saved ? '테스트 이벤트는 저장되었지만 재조회에 실패했습니다. ' : ''}${errorMessage(cause)}`,
      );
      setStale(true);
      if (cause instanceof RequestError && [401, 403, 404].includes(cause.status)) setItems(null);
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
    setItems(null);
    setStale(true);
    lastSuccess.current = 0;
    read.current();
    const timer = window.setInterval(() => read.current(), 5000);
    const freshness = window.setInterval(() => {
      if (lastSuccess.current && Date.now() - lastSuccess.current >= 10000) setStale(true);
    }, 1000);
    return () => {
      generation.current++;
      window.clearInterval(timer);
      window.clearInterval(freshness);
    };
  }, [classroomId, token, closed]);
  return (
    <section className="teacher-notifications" aria-label="교사 전용 알림">
      <h3>교사 전용 알림</h3>
      <p>
        실제 서비스 처리 기록과 교사가 만든 테스트 이벤트를 구분합니다. 최근 50건을 5초마다
        확인합니다. 화면 비교·키보드/마우스 입력 감지는 미구현이며 학생 활동을 수집하지 않습니다.
      </p>
      {busy && <p role="status">교사 알림을 확인하고 있습니다.</p>}
      {stale && <p role="status">알림 서버 확인 불가 · 마지막 확인 결과입니다.</p>}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button disabled={busy} onClick={() => void perform()}>
        알림 다시 확인
      </button>
      <fieldset disabled={busy || closed || stale}>
        <legend>테스트 전용 · 실제 감지 아님</legend>
        <button onClick={() => void perform('screen_difference')}>
          화면 비교 테스트 이벤트 생성
        </button>
        <button onClick={() => void perform('input_activity')}>입력 감지 테스트 이벤트 생성</button>
      </fieldset>
      {items?.length === 0 && <p>아직 교사 알림이 없습니다.</p>}
      <ul className="workspace-list">
        {items?.map((item) => (
          <li key={item.id}>
            <strong className={item.kind === 'test' ? 'test-badge' : 'actual-badge'}>
              {item.kind === 'test' ? '테스트 · 실제 감지 아님' : '실제 처리 기록'}
            </strong>
            <span>{labels[item.action]}</span>
            <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}
