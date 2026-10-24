import { useEffect, useRef, useState } from 'react';
import type {
  ClassroomManagementResponse,
  IdentityClassroom,
  IssuedClassroomInvitation,
  ManagedClassroom,
} from '@clario/shared';
import { errorMessage } from './web-api.js';
import TeacherRequests from './TeacherRequests.js';
import TeacherParticipants from './TeacherParticipants.js';
import TeacherLesson from './TeacherLesson.js';
import TeacherMaterials from './TeacherMaterials.js';
import FocusPanel from './FocusPanel.js';
import TeacherNotifications from './TeacherNotifications.js';
import FutureCapabilities from './FutureCapabilities.js';
import DashboardRecordingPanel from './DashboardRecordingPanel.js';

type IdentityApi = <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
const invitationLabels = { none: '발급 없음', active: '유효', expired: '만료', revoked: '폐기' };

export default function TeacherClassrooms({
  token,
  api,
  classrooms,
  canCreate,
  loading,
  onChanged,
}: {
  token: string;
  api: IdentityApi;
  classrooms: IdentityClassroom[];
  canCreate: boolean;
  loading: boolean;
  onChanged: () => void;
  apiBase?: string;
}) {
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('40');
  const [selected, setSelected] = useState<ManagedClassroom | null>(null);
  const [lessonActive, setLessonActive] = useState(false);
  const [issued, setIssued] = useState<IssuedClassroomInvitation | null>(null);
  const [editName, setEditName] = useState('');
  const [editCapacity, setEditCapacity] = useState('40');
  const [studentName, setStudentName] = useState('');
  const [studentNumber, setStudentNumber] = useState('');
  const [entryId, setEntryId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<
    'close' | 'archive' | 'rotate' | 'revoke' | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [participantRevision, setParticipantRevision] = useState(0),
    [requestRevision, setRequestRevision] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (!selected || selected.invitation.status !== 'active' || !selected.invitation.expiresAt)
      return;
    const timer = window.setTimeout(
      () => {
        setIssued(null);
        setSelected((current) =>
          current?.id === selected.id
            ? { ...current, invitation: { ...current.invitation, status: 'expired' } }
            : current,
        );
      },
      Math.max(0, Date.parse(selected.invitation.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [selected]);

  async function perform(path: string, method = 'GET', body?: object, changed = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    setIssued(null);
    try {
      const result = await api<ClassroomManagementResponse>(path, token, method, body);
      if (version !== generation.current) return;
      setSelected(result.classroom);
      setEditName(result.classroom.name);
      setEditCapacity(String(result.classroom.capacity));
      setIssued(result.invitation ?? null);
      setConfirmation(null);
      setEntryId(null);
      setStudentName('');
      setStudentNumber('');
      setParticipantRevision((v) => v + 1);
      setRequestRevision((v) => v + 1);
      if (changed) {
        setNotice('서버에 저장했습니다.');
        onChanged();
      }
      return true;
    } catch (cause) {
      if (version === generation.current) setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      if (version === generation.current) setBusy(false);
    }
  }
  const base = selected ? `/identity/classrooms/${selected.id}` : '';
  const closed = Boolean(selected?.closedAt || selected?.archivedAt);
  return (
    <section aria-label="교실 관리">
      <p>
        학생 신청·교사 승인/복구와 수업 연결을 관리합니다. 수업 현황은 5초마다 확인합니다. 명단
        일치만으로 학생을 승인하지 않습니다.
      </p>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {error && selected && (
        <p>
          변경 결과를 확인하지 못했습니다. 아래는 마지막으로 확인한 정보입니다. 다시 확인 후
          재시도하세요.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">교실 요청을 처리하고 있습니다.</p>}
      {canCreate && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform(
              '/identity/classrooms',
              'POST',
              { name, capacity: Number(capacity) },
              true,
            ).then((success) => {
              if (success) setName('');
            });
          }}
        >
          <label>
            새 교실 이름
            <input
              required
              maxLength={100}
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            새 교실 정원
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              required
              value={capacity}
              disabled={busy}
              onChange={(event) => setCapacity(event.target.value)}
            />
          </label>
          <button disabled={busy} type="submit">
            교실 만들기
          </button>
        </form>
      )}
      {classrooms.length > 0 && (
        <ul className="workspace-list">
          {classrooms.map((classroom) => (
            <li key={classroom.id}>
              <span>
                {classroom.name}
                {classroom.archivedAt ? ' · 보관' : classroom.closedAt ? ' · 종료' : ''}
              </span>
              <span>{classroom.role === 'manager' ? '교실 관리자' : '학생으로 참여'}</span>
              {classroom.role === 'manager' && (
                <button
                  disabled={busy || loading}
                  onClick={() => {
                    setLessonActive(false);
                    setSelected(null);
                    setConfirmation(null);
                    void perform(`/identity/classrooms/${classroom.id}`);
                  }}
                >
                  {classroom.name} 관리 열기
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <section className="workspace-card" aria-label="선택한 교실 설정">
          <h2>{selected.name}</h2>
          {closed && (
            <p role="status">
              {selected.archivedAt ? '보관된 교실' : '종료된 교실'}입니다. 신규 참여와 기존 학생
              자격이 차단됩니다. 학생 기록 삭제를 뜻하지 않습니다.
            </p>
          )}
          <p>
            학생 참여는 교사 승인 필수 · 선택 명단 {selected.roster.length}명 · 정원{' '}
            {selected.capacity}명
          </p>
          <TeacherRequests
            key={selected.id}
            classroomId={selected.id}
            closed={closed}
            token={token}
            api={api}
            onRequest={() => setIssued(null)}
            onChanged={() => setParticipantRevision((v) => v + 1)}
            revision={requestRevision}
          />
          <TeacherLesson
            key={`lesson-${selected.id}`}
            classroomId={selected.id}
            closed={closed}
            token={token}
            api={api}
            onLessonStateChange={setLessonActive}
            onChanged={() => {
              void perform(base);
            }}
          />
          <DashboardRecordingPanel
            key={`recording-${selected.id}`}
            classroomId={selected.id}
            classroomName={selected.name}
            lessonActive={lessonActive && !closed}
          />
          <TeacherMaterials
            key={`materials-${selected.id}`}
            classroomId={selected.id}
            closed={closed}
            token={token}
            api={api}
          />
          <FocusPanel
            key={`focus-${selected.id}`}
            role="teacher"
            classroomId={selected.id}
            closed={closed}
            token={token}
            api={api}
          />
          <TeacherNotifications
            key={`notifications-${selected.id}`}
            classroomId={selected.id}
            token={token}
            api={api}
            closed={closed}
          />
          <FutureCapabilities />
          <TeacherParticipants
            key={`participants-${selected.id}`}
            classroomId={selected.id}
            closed={closed}
            token={token}
            api={api}
            onRequest={() => setIssued(null)}
            onChanged={() => setRequestRevision((v) => v + 1)}
            revision={participantRevision}
          />
          <button disabled={busy} onClick={() => void perform(base)}>
            교실 설정 다시 확인
          </button>
          <button
            disabled={busy}
            onClick={() => {
              generation.current++;
              setLessonActive(false);
              setSelected(null);
              setIssued(null);
              setError('');
              setNotice('');
              setConfirmation(null);
            }}
          >
            관리 닫기 · 코드 숨기기
          </button>
          <h3>교실 초대코드</h3>
          <p>
            코드 상태: {invitationLabels[selected.invitation.status]}
            {selected.invitation.expiresAt &&
              ` · 만료 ${new Date(selected.invitation.expiresAt).toLocaleString()}`}
          </p>
          {issued && (
            <div className="message">
              <p>
                이번에 발급한 코드: <strong>{issued.code}</strong>
              </p>
              <p>
                원문은 이 응답에서만 확인할 수 있습니다. 다시 조회할 수 없으며 분실하면
                재발급하세요.
              </p>
              <button disabled={busy} onClick={() => setIssued(null)}>
                코드 숨기기
              </button>
            </div>
          )}
          {!closed && (
            <>
              <button
                disabled={busy}
                onClick={() => {
                  setIssued(null);
                  setConfirmation('rotate');
                }}
              >
                코드 재발급
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setIssued(null);
                  setConfirmation('revoke');
                }}
              >
                코드 폐기
              </button>
              <p>
                재발급·폐기는 신규 신청만 막습니다. 이미 접수한 신청과 승인 관계를 취소하지
                않습니다.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(
                    base,
                    'PATCH',
                    { name: editName, capacity: Number(editCapacity) },
                    true,
                  );
                }}
              >
                <label>
                  교실 이름
                  <input
                    required
                    maxLength={100}
                    value={editName}
                    disabled={busy}
                    onChange={(event) => setEditName(event.target.value)}
                  />
                </label>
                <label>
                  교실 정원
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    required
                    value={editCapacity}
                    disabled={busy}
                    onChange={(event) => setEditCapacity(event.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy}>
                  교실 설정 저장
                </button>
              </form>
            </>
          )}
          <h3>선택 학급 명단</h3>
          <p>
            명단은 승인 시 참고할 정보입니다. 본인 인증·자동 승인·실제 참여 학생 목록이 아닙니다.
            파일 가져오기는 아직 제공하지 않습니다.
          </p>
          {selected.roster.length === 0 && <p>등록된 명단이 없습니다.</p>}
          <ul className="workspace-list">
            {selected.roster.map((entry) => (
              <li key={entry.id}>
                <span>
                  {entry.name} · {entry.studentNumber}
                </span>
                {!closed && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setIssued(null);
                        setEntryId(entry.id);
                        setStudentName(entry.name);
                        setStudentNumber(entry.studentNumber);
                      }}
                    >
                      명단 수정 · {entry.studentNumber}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(`${base}/roster/${entry.id}`, 'DELETE', undefined, true)
                      }
                    >
                      명단 삭제 · {entry.studentNumber}
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {!closed && (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(
                    `${base}/roster${entryId ? `/${entryId}` : ''}`,
                    entryId ? 'PATCH' : 'POST',
                    { name: studentName, studentNumber },
                    true,
                  );
                }}
              >
                <label>
                  명단 학생 이름
                  <input
                    required
                    value={studentName}
                    disabled={busy}
                    autoComplete="off"
                    onChange={(event) => setStudentName(event.target.value)}
                  />
                </label>
                <label>
                  명단 학번
                  <input
                    required
                    inputMode="numeric"
                    maxLength={20}
                    pattern="[0-9]{1,20}"
                    value={studentNumber}
                    disabled={busy}
                    autoComplete="off"
                    onChange={(event) => setStudentNumber(event.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy}>
                  {entryId ? '명단 수정 저장' : '명단 추가'}
                </button>
                {entryId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEntryId(null);
                      setStudentName('');
                      setStudentNumber('');
                    }}
                  >
                    명단 수정 취소
                  </button>
                )}
              </form>
              <button
                disabled={busy}
                onClick={() => {
                  setIssued(null);
                  setConfirmation('close');
                }}
              >
                교실 종료
              </button>
            </>
          )}
          {!selected.archivedAt && (
            <button
              disabled={busy}
              onClick={() => {
                setIssued(null);
                setConfirmation('archive');
              }}
            >
              교실 보관
            </button>
          )}
          {confirmation && (
            <div role="group" aria-label="교실 작업 확인">
              <p>
                {confirmation === 'close' || confirmation === 'archive'
                  ? '현재 다시 열기 기능은 제공하지 않습니다. 코드·대기 신청·학생 자격과 연결을 종료하고 기록은 보존합니다.'
                  : '기존 초대코드는 사용할 수 없게 됩니다. 이미 접수된 신청과 승인 학생은 유지합니다.'}
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(
                    confirmation === 'rotate' || confirmation === 'revoke'
                      ? `${base}/invitations`
                      : `${base}/${confirmation}`,
                    confirmation === 'revoke' ? 'DELETE' : 'POST',
                    confirmation === 'revoke' ? undefined : {},
                    true,
                  )
                }
              >
                확인하고 실행
              </button>
              <button disabled={busy} onClick={() => setConfirmation(null)}>
                취소
              </button>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
