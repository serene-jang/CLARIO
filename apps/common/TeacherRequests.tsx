import { useEffect, useRef, useState } from 'react';
import type { StudentJoinReview } from '@clario/shared';
import { errorMessage, RequestError } from './web-api.js';

type Api = <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
const statuses = {
  pending: '승인 대기',
  approved: '승인됨',
  rejected: '거절됨',
  cancelled: '종료됨',
};
export const rosterLabels = {
  not_configured: '명단 미등록',
  match: '이름·학번 일치',
  number_only: '학번만 일치',
  not_found: '명단 불일치',
};
export default function TeacherRequests({
  classroomId,
  closed,
  token,
  api,
  onRequest,
  onChanged,
  revision = 0,
}: {
  classroomId: string;
  closed: boolean;
  token: string;
  api: Api;
  onRequest?: () => void;
  onChanged?: () => void;
  revision?: number;
}) {
  const [requests, setRequests] = useState<StudentJoinReview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<StudentJoinReview | null>(null);
  const [checked, setChecked] = useState(false);
  const [search, setSearch] = useState(''),
    [sort, setSort] = useState('recent');
  const generation = useRef(0),
    inFlight = useRef(false);
  const read = useRef(() => {});
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setRequests(null);
    setConfirmation(null);
    setChecked(false);
    setBusy(false);
    setError('');
    return () => {
      generation.current++;
    };
  }, [classroomId, token, revision, closed]);
  async function perform(
    item?: StudentJoinReview,
    action?: 'approve' | 'reject',
    automatic = false,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    if (!automatic) onRequest?.();
    try {
      const base = `/identity/classrooms/${classroomId}/requests`;
      const result = await api<{ requests: StudentJoinReview[] }>(
        item ? `${base}/${item.id}/${action}` : base,
        token,
        item ? 'POST' : 'GET',
        item ? { confirmRecovery: checked } : undefined,
      );
      if (version !== generation.current) return;
      setRequests(result.requests);
      setConfirmation(null);
      setChecked(false);
      if (item) onChanged?.();
    } catch (cause) {
      if (version !== generation.current) return;
      if (cause instanceof RequestError && [401, 403, 404].includes(cause.status)) {
        setRequests(null);
        setConfirmation(null);
        setChecked(false);
      }
      setError(errorMessage(cause));
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  read.current = () => {
    if (!confirmation) void perform(undefined, undefined, true);
  };
  useEffect(() => {
    void perform(undefined, undefined, true);
    const timer = window.setInterval(() => read.current(), 5000);
    return () => window.clearInterval(timer);
  }, [classroomId, token, revision, closed]);
  const term = search.normalize('NFC').trim().toLocaleLowerCase();
  const visible = (requests ?? [])
    .filter(
      (item) => item.name.toLocaleLowerCase().includes(term) || item.studentNumber.includes(term),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
        : sort === 'studentNumber'
          ? a.studentNumber.localeCompare(b.studentNumber) || a.id.localeCompare(b.id)
          : Number(a.status !== 'pending') - Number(b.status !== 'pending') ||
            Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
            a.id.localeCompare(b.id),
    );
  return (
    <section aria-label="학생 참여 신청">
      <h3>학생 참여 신청 · 복구</h3>
      <p>
        명단은 참고 정보이며 본인 인증이 아닙니다. 학생을 직접 확인한 뒤 승인하세요. 승인과 온라인
        상태는 다릅니다. 목록은 5초마다 갱신하며 승인 확인 중에는 자동 갱신을 멈춥니다.
      </p>
      <button disabled={busy} onClick={() => void perform()}>
        신청 목록 다시 확인
      </button>
      {busy && <p role="status">신청을 확인하고 있습니다.</p>}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {error && requests && <p>최신 상태를 확인하지 못했습니다. 마지막 확인 결과입니다.</p>}
      {requests?.length === 0 && <p>유효한 신청이 없습니다.</p>}
      {requests && (
        <>
          <p>
            서버에서 확인한 최대 200건의 유효 신청 안에서 검색·정렬합니다. 대기 신청 우선이며 전체
            참여 기록은 참여 학생 관리에서 확인하세요.
          </p>
          <label>
            참여 신청 검색
            <input value={search} maxLength={200} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label>
            참여 신청 정렬
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recent">대기 우선 · 최신 신청</option>
              <option value="name">이름</option>
              <option value="studentNumber">학번</option>
            </select>
          </label>
          {requests.length > 0 && visible.length === 0 && <p>조건에 맞는 신청이 없습니다.</p>}
        </>
      )}
      {requests && (
        <ul className="workspace-list">
          {visible.map((item) => (
            <li key={item.id}>
              <div>
                <strong>
                  {item.name} · 학번 {item.studentNumber}
                </strong>
                <p>
                  {item.kind === 'recovery' ? '복구 신청' : '참여 신청'} ·{' '}
                  {rosterLabels[item.rosterMatch]}
                  {item.existingStatus ? ' · 기존 참여 기록 있음' : ''}
                </p>
                <p>
                  {statuses[item.status]} · 만료 {new Date(item.expiresAt).toLocaleString()}
                </p>
              </div>
              {!closed && item.status === 'pending' && (
                <>
                  <button
                    disabled={busy || Boolean(error)}
                    onClick={() => {
                      setConfirmation(item);
                      setChecked(false);
                    }}
                  >
                    {item.kind === 'recovery' ? '복구' : '참여'} 승인 {item.studentNumber}
                  </button>
                  <button
                    disabled={busy || Boolean(error)}
                    onClick={() => void perform(item, 'reject')}
                  >
                    참여 거절 {item.studentNumber}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmation && !closed && (
        <div role="group" aria-label="학생 승인 확인">
          <p>
            {confirmation.name} · {confirmation.studentNumber} 승인 확인. 복구 승인 시 기존 기기의
            자격·연결을 종료합니다. 코드·명단 일치만으로 본인을 확인할 수 없습니다.
          </p>
          <label>
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={(event) => setChecked(event.target.checked)}
            />
            본인을 확인했으며 이전 자격과 연결 종료에 동의합니다
          </label>
          <button
            disabled={busy || !checked || Boolean(error)}
            onClick={() => void perform(confirmation, 'approve')}
          >
            확인하고 승인
          </button>
          <button disabled={busy} onClick={() => setConfirmation(null)}>
            승인 취소
          </button>
        </div>
      )}
    </section>
  );
}
