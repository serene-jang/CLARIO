import { useEffect, useRef, useState } from 'react';
import type {
  ManagedClassroomMaterial,
  MaterialList,
  ManagedStudentParticipant,
  ParticipantListResponse,
} from '@clario/shared';
import { isMaterialList } from './material-api.js';
import { errorMessage, RequestError } from './web-api.js';
type Api = <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
export default function TeacherMaterials({
  classroomId,
  closed,
  token,
  api,
}: {
  classroomId: string;
  closed: boolean;
  token: string;
  api: Api;
}) {
  const [view, setView] = useState<MaterialList<ManagedClassroomMaterial> | null>(null);
  const [title, setTitle] = useState(''),
    [url, setUrl] = useState(''),
    [page, setPage] = useState(1);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(true),
    [deleting, setDeleting] = useState<string | null>(null);
  const [audience, setAudience] = useState<'all' | 'selected'>('all');
  const [recipients, setRecipients] = useState<ManagedStudentParticipant[]>([]);
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([]);
  const [recipientsLoading, setRecipientsLoading] = useState(false);
  const [recipientsError, setRecipientsError] = useState('');
  const [recipientRevision, setRecipientRevision] = useState(0);
  const version = useRef(0),
    inFlight = useRef(false),
    lastSuccess = useRef(0),
    read = useRef(() => {});
  const base = `/identity/classrooms/${classroomId}/materials`;
  async function perform(action?: 'add' | 'delete') {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++version.current;
    setBusy(true);
    setError('');
    setNotice('');
    let saved = false;
    try {
      if (action) {
        await api(
          action === 'add' ? base : `${base}/${deleting}`,
          token,
          action === 'add' ? 'POST' : 'DELETE',
          action === 'add'
            ? {
                title,
                url,
                ...(audience === 'selected' ? { participantIds: selectedRecipients } : {}),
              }
            : undefined,
        );
        if (current !== version.current) return;
        saved = true;
        setDeleting(null);
        if (action === 'add') {
          setTitle('');
          setUrl('');
          setSelectedRecipients([]);
        }
      }
      const next = await api<MaterialList<ManagedClassroomMaterial>>(`${base}?page=${page}`, token);
      if (current !== version.current) return;
      if (
        !isMaterialList(next) ||
        !next.materials.every(
          (m) =>
            typeof m.url === 'string' &&
            Number.isInteger(m.receivedCount) &&
            Number.isInteger(m.openedCount),
        )
      )
        throw new Error('교실 자료 응답을 확인할 수 없습니다.');
      setView(next);
      setStale(false);
      lastSuccess.current = Date.now();
      if (saved) setNotice(action === 'add' ? '자료를 등록했습니다.' : '자료를 삭제했습니다.');
    } catch (cause) {
      if (current !== version.current) return;
      setStale(true);
      setDeleting(null);
      if (cause instanceof RequestError && [401, 403, 404].includes(cause.status)) setView(null);
      setError(
        `${saved ? '변경은 저장되었지만 목록 재확인에 실패했습니다. ' : ''}${errorMessage(cause)}`,
      );
    } finally {
      if (current === version.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  read.current = () => void perform();
  useEffect(() => {
    version.current++;
    inFlight.current = false;
    lastSuccess.current = 0;
    setView(null);
    setStale(true);
    setDeleting(null);
    setError('');
    setNotice('');
    read.current();
    const timer = window.setInterval(() => read.current(), 5000);
    const freshness = window.setInterval(() => {
      if (lastSuccess.current && Date.now() - lastSuccess.current >= 10000) setStale(true);
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
      version.current++;
      window.clearInterval(timer);
      window.clearInterval(freshness);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [classroomId, token, page, closed]);
  useEffect(() => {
    setTitle('');
    setUrl('');
    setPage(1);
    setAudience('all');
    setSelectedRecipients([]);
  }, [classroomId, token]);
  useEffect(() => {
    let cancelled = false;
    setRecipients([]);
    setSelectedRecipients([]);
    setRecipientsError('');
    if (audience !== 'selected') return;
    setRecipientsLoading(true);
    async function load() {
      const first = await api<ParticipantListResponse>(
        `/identity/classrooms/${classroomId}/participants?status=approved&page=1`,
        token,
      );
      const second =
        first.total > first.pageSize
          ? await api<ParticipantListResponse>(
              `/identity/classrooms/${classroomId}/participants?status=approved&page=2`,
              token,
            )
          : null;
      if (!cancelled) setRecipients([...first.participants, ...(second?.participants ?? [])]);
    }
    void load()
      .catch((cause: unknown) => {
        if (!cancelled) setRecipientsError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setRecipientsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [audience, classroomId, token, api, recipientRevision]);
  return (
    <section className="material-panel" aria-label="교실 자료 관리">
      <h3>수업 자료 공유</h3>
      <p>
        이 목록은 HTTPS 링크입니다. 학급 전체 또는 선택한 승인 학생에게 배포하며 등록 후 7일간 접근
        가능합니다. 전체 배포는 이후 승인 학생도 볼 수 있습니다. 수신은 학생 웹 목록 수신 확인,
        열기는 요청 기록입니다. 읽기 완료나 외부 페이지 로딩을 뜻하지 않습니다.
      </p>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {stale && <p role="status">자료 서버 확인 불가 · 아래 자료는 마지막 확인 결과입니다.</p>}
      {busy && <p role="status">자료를 처리하고 있습니다.</p>}
      <button disabled={busy} onClick={() => void perform()}>
        자료 목록 다시 확인
      </button>
      {!closed && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform('add');
          }}
        >
          <label>
            자료 제목
            <input
              value={title}
              maxLength={100}
              required
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            HTTPS 자료 주소
            <input
              value={url}
              type="url"
              maxLength={2048}
              required
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label>
            배포 대상
            <select
              value={audience}
              disabled={busy}
              onChange={(e) => setAudience(e.target.value === 'selected' ? 'selected' : 'all')}
            >
              <option value="all">학급 전체</option>
              <option value="selected">선택한 학생</option>
            </select>
          </label>
          {audience === 'selected' && (
            <fieldset className="recipient-list" aria-label="자료 받을 학생 선택">
              <legend>현재 승인 학생 · 선택 {selectedRecipients.length}명</legend>
              {recipientsLoading && <p role="status">배포 대상 학생을 불러오고 있습니다.</p>}
              {recipientsError && <p role="alert">{recipientsError}</p>}
              {!recipientsLoading && !recipientsError && !recipients.length && (
                <p>배포할 승인 학생이 없습니다.</p>
              )}
              <button
                type="button"
                disabled={busy || recipientsLoading}
                onClick={() => setRecipientRevision((v) => v + 1)}
              >
                배포 대상 다시 확인
              </button>
              {recipients.map((student) => (
                <label key={student.id}>
                  <input
                    type="checkbox"
                    checked={selectedRecipients.includes(student.id)}
                    disabled={busy || recipientsLoading}
                    onChange={(e) =>
                      setSelectedRecipients((previous) =>
                        e.target.checked
                          ? [...previous, student.id]
                          : previous.filter((value) => value !== student.id),
                      )
                    }
                  />
                  {student.name} · 학번 {student.studentNumber}
                </label>
              ))}
            </fieldset>
          )}
          <button
            type="submit"
            disabled={
              busy ||
              stale ||
              (audience === 'selected' &&
                (recipientsLoading || Boolean(recipientsError) || !selectedRecipients.length))
            }
          >
            자료 등록
          </button>
        </form>
      )}
      {view && (
        <>
          <p>
            서버 확인 {new Date(view.observedAt).toLocaleString()} · 유효 자료 {view.total}개
          </p>
          {!view.materials.length && <p>이 페이지에 유효한 자료가 없습니다.</p>}
          <ul className="workspace-list">
            {view.materials.map((m) => (
              <li key={m.id}>
                <strong>{m.title}</strong>
                <p className="material-url">{m.url}</p>
                <p>
                  배포 대상:{' '}
                  {m.audience === 'selected' ? `선택 학생 ${m.recipientCount}명` : '학급 전체'}
                </p>
                <p>
                  접근 만료 {new Date(m.expiresAt).toLocaleString()} · 현재 승인 학생의 목록 수신{' '}
                  {m.receivedCount}명 · 열기 요청 {m.openedCount}명
                </p>
                <button
                  disabled={busy || stale}
                  aria-label={`자료 삭제 준비 ${m.title}`}
                  onClick={() => setDeleting(m.id)}
                >
                  자료 삭제 준비
                </button>
              </li>
            ))}
          </ul>
          <p>자료 {page}페이지</p>
          <button disabled={busy || page <= 1} onClick={() => setPage((p) => p - 1)}>
            이전 자료 페이지
          </button>
          <button
            disabled={busy || page * view.pageSize >= view.total}
            onClick={() => setPage((p) => p + 1)}
          >
            다음 자료 페이지
          </button>
        </>
      )}
      {deleting && (
        <fieldset aria-label="자료 삭제 확인">
          <p>
            이 자료와 기기 전달·학생 수신 기록을 삭제합니다. 이미 열린 외부 사이트나 복사된 주소를
            회수할 수는 없습니다.
          </p>
          <button disabled={busy || stale} onClick={() => void perform('delete')}>
            확인하고 자료 삭제
          </button>
          <button disabled={busy} onClick={() => setDeleting(null)}>
            자료 삭제 취소
          </button>
        </fieldset>
      )}
    </section>
  );
}
