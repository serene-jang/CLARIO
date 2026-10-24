import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudentSessionView, StudentJoinInput } from '@clario/shared';
import { studentSessionRequest } from './student-api.js';
import { errorMessage, RequestError } from './web-api.js';
import './school.css';
import StudentLesson from './StudentLesson.js';
import StudentMaterials from './StudentMaterials.js';
import FocusPanel from './FocusPanel.js';
import FutureCapabilities from './FutureCapabilities.js';

const statusLabels = {
  pending: '교사 승인 대기 중',
  approved: '교사가 승인했습니다. 수업 연결을 확인해 주세요.',
  rejected: '참여가 거절되었습니다. 교사에게 확인해 주세요.',
  cancelled: '참여 신청이 종료되었습니다.',
} as const;

export default function StudentWorkspace({ onDemo }: { onDemo?: () => void }) {
  const [session, setSession] = useState<StudentSessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [studentNumber, setStudentNumber] = useState('');
  const [recovery, setRecovery] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const lessonInvalid = useCallback((message: string) => {
    generation.current++;
    inFlight.current = false;
    setBusy(false);
    setSession({ state: 'none', joinAvailable: false });
    setError(message);
    setCode('');
    setName('');
    setStudentNumber('');
  }, []);
  const lessonExpiry = useCallback((expiresAt: string) => {
    setSession((current) =>
      current?.state === 'participant' ? { ...current, expiresAt } : current,
    );
  }, []);

  const perform = useCallback(
    async (
      action: 'read' | 'activate' | 'end' | 'join',
      csrfToken?: string,
      input?: StudentJoinInput,
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const version = ++generation.current;
      setBusy(true);
      setError('');
      try {
        const next = await studentSessionRequest(action, csrfToken, input);
        if (generation.current !== version) return;
        setSession(next);
        if (next.state === 'none' || action === 'join') {
          setCode('');
          setName('');
          setStudentNumber('');
          setRecovery(false);
        }
      } catch (cause) {
        if (generation.current !== version) return;
        if (cause instanceof RequestError && cause.status === 401) {
          setSession({ state: 'none', joinAvailable: false });
          setCode('');
          setName('');
          setStudentNumber('');
        }
        setError(errorMessage(cause));
      } finally {
        if (generation.current === version) {
          inFlight.current = false;
          setBusy(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void perform('read');
    return () => {
      generation.current++;
      inFlight.current = false;
    };
  }, [perform]);

  useEffect(() => {
    if (!session || session.state === 'none') return;
    const timer = window.setTimeout(
      () => {
        generation.current++;
        inFlight.current = false;
        setBusy(false);
        setSession({ state: 'none', joinAvailable: false });
        setCode('');
        setName('');
        setStudentNumber('');
        setError(
          '참여 자격 확인 시간이 지났습니다. 다시 확인하거나 교사에게 복구를 요청해 주세요.',
        );
      },
      Math.max(0, Date.parse(session.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [session]);

  const privateSession = session && session.state !== 'none' ? session : null;
  return (
    <main className="page-shell">
      <header className="topbar">
        <span className="brand">CLARIO</span>
        <span>학생 공간</span>
      </header>
      <section className="welcome-panel school-workspace" aria-labelledby="student-title">
        <h1 id="student-title">{privateSession ? '내 참여 상태' : '초대코드로 교실 참여하기'}</h1>
        <p>
          학생은 로그인이나 계정 생성 없이 참여합니다. 교사가 확인하고 승인해야 수업에 연결됩니다.
        </p>
        {onDemo && (
          <div className="message" role="note">
            실제 참여 신청은 교실 서버 연결이 필요합니다. 서버 없이 예시 화면을 둘러볼 수 있습니다.
            <button type="button" disabled={busy} onClick={onDemo}>
              서버 없이 학생 데모 보기
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="message error">
            {error}
          </p>
        )}
        {error && privateSession && (
          <p>최신 상태를 확인하지 못했습니다. 아래 정보는 마지막 확인 결과입니다.</p>
        )}
        {busy && <p role="status">참여 상태를 확인하고 있습니다.</p>}
        {session?.state === 'none' && (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform('join', undefined, {
                  code,
                  name,
                  studentNumber,
                  kind: recovery ? 'recovery' : 'join',
                });
              }}
              aria-describedby="join-notice"
            >
              <label>
                초대코드
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value.toUpperCase())}
                  maxLength={12}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  disabled={busy}
                />
              </label>
              <label>
                이름
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                  required
                  disabled={busy}
                />
              </label>
              <label>
                학번
                <input
                  value={studentNumber}
                  onChange={(event) => setStudentNumber(event.target.value)}
                  maxLength={20}
                  inputMode="numeric"
                  autoComplete="off"
                  required
                  disabled={busy}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={recovery}
                  disabled={busy}
                  onChange={(event) => setRecovery(event.target.checked)}
                />
                기존 참여 복구 요청
              </label>
              <button type="submit" disabled={busy || !session.joinAvailable}>
                {recovery ? '복구 신청' : '참여 신청'}
              </button>
            </form>
            <p id="join-notice">
              코드·이름·학번을 서버에 전송해 최대 30분 동안 승인을 기다립니다. 명단에 일치해도
              교사의 승인이 필요합니다. 자격 분실·새 기기·교사 퇴장/차단 후에는 복구를 신청하세요.
              교사 확인 전 기존 참여는 종료되지 않습니다.
            </p>
            {!session.joinAvailable && <p>신청 가능 여부를 다시 확인한 뒤 시도해 주세요.</p>}
            <p>
              이름·학번은 교실 참여 확인에 사용하며 본인 인증 비밀번호가 아닙니다. 다른 학생의
              정보는 볼 수 없습니다.
            </p>
            <p>
              이 기기의 자격을 잃었거나 새 기기를 사용하면 교사에게 참여 복구를 요청해야 합니다.
            </p>
          </>
        )}
        {privateSession && (
          <>
            <p>
              {privateSession.student.name} · 학번 {privateSession.student.studentNumber}
            </p>
            {privateSession.state === 'request' ? (
              <>
                <p role="status">{statusLabels[privateSession.status]}</p>
                {privateSession.status === 'approved' && (
                  <button
                    disabled={busy}
                    onClick={() => void perform('activate', privateSession.csrfToken)}
                  >
                    승인된 수업 연결 확인
                  </button>
                )}
                <p>대기 중에는 교실 자료와 학생 목록에 접근할 수 없습니다.</p>
              </>
            ) : (
              <>
                <h2>{privateSession.classroom.name}</h2>
                <p>
                  참여 자격을 확인했습니다. 교실 자료와 서버가 확인한 수업의 자율 집중 안내를 확인할
                  수 있습니다.
                </p>
                <StudentLesson
                  csrfToken={privateSession.csrfToken}
                  onInvalid={lessonInvalid}
                  onExpiry={lessonExpiry}
                />
                <StudentMaterials
                  key={privateSession.classroom.id}
                  csrfToken={privateSession.csrfToken}
                  onInvalid={lessonInvalid}
                  onExpiry={lessonExpiry}
                />
                <FutureCapabilities />
                <FocusPanel
                  key={`focus-${privateSession.classroom.id}`}
                  role="student"
                  csrfToken={privateSession.csrfToken}
                  onInvalid={lessonInvalid}
                  onExpiry={lessonExpiry}
                />
              </>
            )}
            <p>
              공유 기기에서는 사용 후 반드시 참여를 종료하세요. 이 브라우저는 한 번에 한 교실만
              참여합니다.
            </p>
            <button disabled={busy} onClick={() => void perform('end', privateSession.csrfToken)}>
              참여 종료 · 이 기기 정보 지우기
            </button>
          </>
        )}
        <button disabled={busy} onClick={() => void perform('read')}>
          다시 확인
        </button>
      </section>
    </main>
  );
}
