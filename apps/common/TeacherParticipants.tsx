import { useEffect, useRef, useState } from 'react';
import type { ManagedStudentParticipant, ParticipantListResponse } from '@clario/shared';
import { errorMessage, RequestError } from './web-api.js';
import { rosterLabels } from './TeacherRequests.js';

type Api = <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
const statuses = {
  approved: '참여 승인됨',
  left: '자진 종료',
  removed: '퇴장됨',
  blocked: '차단됨',
};
const initialQuery = {
  search: '',
  status: 'all',
  sort: 'studentNumber',
  direction: 'asc',
  page: 1,
};
export default function TeacherParticipants({
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
  const [result, setResult] = useState<ParticipantListResponse | null>(null);
  const [query, setQuery] = useState(initialQuery),
    [applied, setApplied] = useState(initialQuery);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<{
    participant: ManagedStudentParticipant;
    action: 'remove' | 'block' | 'request-erasure';
  } | null>(null);
  const [checked, setChecked] = useState(false);
  const generation = useRef(0),
    inFlight = useRef(false);
  const read = useRef(() => {});
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setResult(null);
    setConfirmation(null);
    setChecked(false);
    setBusy(false);
    setError('');
    setNotice('');
    setQuery(initialQuery);
    setApplied(initialQuery);
    return () => {
      generation.current++;
    };
  }, [classroomId, token, revision, closed]);
  const base = `/identity/classrooms/${classroomId}/participants`;
  const listPath = (options: typeof initialQuery) =>
    `${base}?${new URLSearchParams({ ...options, page: String(options.page) })}`;
  async function perform(
    options: typeof initialQuery,
    moderation = confirmation,
    automatic = false,
  ) {
    if (inFlight.current) return;
    options = { ...options, search: options.search.normalize('NFC').trim() };
    inFlight.current = true;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    if (!automatic) onRequest?.();
    let saved = false;
    try {
      if (moderation) {
        await api<{ participant: ManagedStudentParticipant }>(
          `${base}/${moderation.participant.id}/${moderation.action}`,
          token,
          'POST',
          {
            confirm: true,
            expectedGeneration: moderation.participant.credentialGeneration,
          },
        );
        if (version !== generation.current) return;
        saved = true;
        setConfirmation(null);
        setChecked(false);
        onChanged?.();
        setNotice(
          moderation.action === 'request-erasure'
            ? '삭제 요청을 접수하고 접근을 철회했습니다. 정책 승인 대기이며 원본·백업 삭제 완료가 아닙니다.'
            : '서버에서 학생 관리 작업을 완료했습니다. 기존 자격과 연결이 종료되었습니다.',
        );
      }
      const next = await api<ParticipantListResponse>(listPath(options), token);
      if (version !== generation.current) return;
      // A filtered last page may disappear when a student leaves that status.
      if (next.page > 1 && next.participants.length === 0) {
        const first = { ...options, page: 1 };
        const reset = await api<ParticipantListResponse>(listPath(first), token);
        if (version !== generation.current) return;
        setResult(reset);
        setApplied(first);
      } else {
        setResult(next);
        setApplied(options);
      }
      setConfirmation(null);
      setChecked(false);
    } catch (cause) {
      if (version !== generation.current) return;
      if (cause instanceof RequestError && [401, 403, 404].includes(cause.status)) {
        setResult(null);
        setConfirmation(null);
        setChecked(false);
      } else if (cause instanceof RequestError && cause.status === 409) {
        setConfirmation(null);
        setChecked(false);
      }
      setError(
        `${saved ? '학생 관리 작업은 저장되었으나 목록 재확인에 실패했습니다. ' : ''}${errorMessage(cause)}`,
      );
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  read.current = () => {
    if (!confirmation) void perform(applied, null, true);
  };
  useEffect(() => {
    void perform(initialQuery, null, true);
    const timer = window.setInterval(() => read.current(), 5000);
    return () => window.clearInterval(timer);
  }, [classroomId, token, revision, closed]);
  return (
    <section aria-label="참여 학생 관리">
      <h3>참여 학생 관리</h3>
      <p>
        실제 참여 기록입니다. 선택 명단·참여 신청과 구분합니다. 이 목록은 참여 상태이며 실제 연결은
        별도 수업 현황에서 확인합니다. 승인됨은 온라인을 뜻하지 않습니다.
      </p>
      <p>
        퇴장·차단은 기존 자격과 연결 및 대기 신청을 종료합니다. 다시 참여하려면 새 복구 신청과
        교사의 명시적 확인이 필요합니다. 차단은 동일인 영구 판별을 보장하지 않습니다.
      </p>
      <button disabled={busy} onClick={() => void perform(applied, null)}>
        학생 목록 다시 확인
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform({ ...query, page: 1 }, null);
        }}
      >
        <label>
          참여 학생 검색
          <input
            value={query.search}
            maxLength={200}
            disabled={busy}
            placeholder="이름 또는 학번"
            onChange={(e) => setQuery({ ...query, search: e.target.value })}
          />
        </label>
        <label>
          참여 학생 상태
          <select
            value={query.status}
            disabled={busy}
            onChange={(e) => setQuery({ ...query, status: e.target.value })}
          >
            <option value="all">모든 참여 상태</option>
            {Object.entries(statuses).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          참여 학생 정렬
          <select
            value={query.sort}
            disabled={busy}
            onChange={(e) => setQuery({ ...query, sort: e.target.value })}
          >
            <option value="studentNumber">학번</option>
            <option value="name">이름</option>
            <option value="status">참여 상태</option>
            <option value="approvedAt">승인 시각</option>
          </select>
        </label>
        <label>
          참여 학생 정렬 방향
          <select
            value={query.direction}
            disabled={busy}
            onChange={(e) => setQuery({ ...query, direction: e.target.value })}
          >
            <option value="asc">오름차순</option>
            <option value="desc">내림차순</option>
          </select>
        </label>
        <button disabled={busy}>학생 검색 적용</button>
      </form>
      {busy && <p role="status">참여 학생을 확인하고 있습니다.</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {error && result && <p>최신 상태를 확인하지 못했습니다. 마지막 확인 결과입니다.</p>}
      {result && (
        <>
          <p>
            확인된 검색어: {applied.search || '전체'} · 상태:{' '}
            {applied.status === 'all' ? '전체' : statuses[applied.status as keyof typeof statuses]}{' '}
            · {result.total}명 · {result.page}페이지 (페이지당 {result.pageSize}명, 학번은 선행 0을
            보존한 문자열 순서)
          </p>
          {result.participants.length === 0 && <p>조건에 맞는 참여 학생이 없습니다.</p>}
          <ul className="workspace-list">
            {result.participants.map((p) => (
              <li key={p.id}>
                <div>
                  <strong>
                    {p.name} · 학번 {p.studentNumber}
                  </strong>
                  <p>{statuses[p.status]}</p>
                  {p.erasureRequestedAt && (
                    <p>개인정보 삭제 요청 · 정책 승인 대기 · 접근 철회됨 · 원본·백업 미삭제</p>
                  )}
                  <p>
                    {rosterLabels[p.rosterMatch]} · 승인 {new Date(p.approvedAt).toLocaleString()} ·
                    변경 {new Date(p.updatedAt).toLocaleString()}
                  </p>
                  <p>실제 연결·마지막 확인 시각은 별도 수업 현황에서 확인하세요.</p>
                </div>
                {!closed && p.status !== 'blocked' && (
                  <button
                    disabled={busy || Boolean(error)}
                    onClick={() => {
                      setConfirmation({ participant: p, action: 'remove' });
                      setChecked(false);
                    }}
                    aria-label={`학생 퇴장 ${p.studentNumber}`}
                  >
                    퇴장
                  </button>
                )}
                {!p.erasureRequestedAt && (
                  <button
                    disabled={busy || Boolean(error)}
                    aria-label={`학생 삭제 요청 ${p.studentNumber}`}
                    onClick={() => {
                      setConfirmation({ participant: p, action: 'request-erasure' });
                      setChecked(false);
                    }}
                  >
                    개인정보 삭제 요청
                  </button>
                )}
                {!closed && p.status !== 'blocked' && (
                  <button
                    disabled={busy || Boolean(error)}
                    onClick={() => {
                      setConfirmation({ participant: p, action: 'block' });
                      setChecked(false);
                    }}
                    aria-label={`학생 차단 ${p.studentNumber}`}
                  >
                    차단
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            disabled={busy || result.page <= 1}
            onClick={() => void perform({ ...applied, page: result.page - 1 }, null)}
          >
            이전 학생 페이지
          </button>
          <button
            disabled={busy || result.page * result.pageSize >= result.total}
            onClick={() => void perform({ ...applied, page: result.page + 1 }, null)}
          >
            다음 학생 페이지
          </button>
        </>
      )}
      {confirmation && (!closed || confirmation.action === 'request-erasure') && (
        <div role="group" aria-label="학생 관리 확인">
          <p>
            {confirmation.participant.name} · 학번 {confirmation.participant.studentNumber} 학생을{' '}
            {confirmation.action === 'request-erasure'
              ? '삭제 요청 대상으로 접수'
              : confirmation.action === 'block'
                ? '차단'
                : '퇴장'}
            합니다. 기존 자격·연결과 대기 중인 신청이 종료됩니다.{' '}
            {confirmation.action === 'request-erasure'
              ? '정책 승인 전에는 복구가 차단됩니다. 실제 개인정보·감사·백업 삭제는 수행하지 않습니다. 요청 철회·실제 삭제 기능은 아직 제공하지 않으므로 학교 담당자와 먼저 확인하세요.'
              : '재참여에는 새 복구 신청과 교사 확인이 필요합니다.'}
          </p>
          <label>
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={(e) => setChecked(e.target.checked)}
            />
            대상 학생과 기존 자격·연결 종료를 확인했습니다
          </label>
          <button
            disabled={busy || !checked || Boolean(error)}
            onClick={() => void perform(applied)}
          >
            확인하고{' '}
            {confirmation.action === 'request-erasure'
              ? '삭제 요청 접수'
              : confirmation.action === 'block'
                ? '차단'
                : '퇴장'}
          </button>
          <button disabled={busy} onClick={() => setConfirmation(null)}>
            학생 관리 취소
          </button>
        </div>
      )}
    </section>
  );
}
