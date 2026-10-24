import { useEffect, useRef, useState } from 'react';
import {
  deleteDashboardRecording,
  downloadDashboardRecording,
  listDashboardRecordings,
  startDashboardRecording,
  type DashboardRecording,
  type DashboardRecordingResult,
  type DashboardRecordingSession,
} from './dashboard-recordings.js';
import { errorMessage } from './web-api.js';

function formatDuration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

export default function DashboardRecordingPanel({
  classroomId,
  classroomName,
  lessonActive,
}: {
  classroomId: string;
  classroomName: string;
  lessonActive: boolean;
}) {
  const [recordings, setRecordings] = useState<DashboardRecording[]>([]);
  const [selected, setSelected] = useState<DashboardRecording | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unsaved, setUnsaved] = useState<DashboardRecording | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const session = useRef<DashboardRecordingSession | null>(null);
  const capture = useRef<AbortController | null>(null);
  const lessonActiveRef = useRef(lessonActive);
  lessonActiveRef.current = lessonActive;
  const mounted = useRef(true);

  async function refresh() {
    try {
      const all = await listDashboardRecordings();
      if (mounted.current) setRecordings(all.filter((item) => item.classroomId === classroomId));
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    }
  }

  function handleResult(result: DashboardRecordingResult) {
    if (!mounted.current) return;
    session.current = null;
    setRecording(false);
    setBusy(false);
    if (result.stored) {
      setNotice(
        `${result.recording.complete ? '녹화 저장 완료' : '시간·용량 한도 도달 · 일부 녹화 저장'} · 이 브라우저에만 보관됩니다.`,
      );
      void refresh();
    } else {
      setUnsaved(result.recording);
      setError(
        `브라우저 보관소 저장 실패: ${result.storageError ?? '원인을 확인할 수 없습니다.'} 지금 파일을 다운로드하세요.`,
      );
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      capture.current?.abort();
      const current = session.current;
      if (current) void current.stop();
    };
  }, []);

  useEffect(() => {
    if (!selected) {
      setVideoUrl('');
      return;
    }
    const url = URL.createObjectURL(selected.blob);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selected]);

  useEffect(() => {
    if (!recording) return;
    const warnBeforeClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeClose);
    return () => window.removeEventListener('beforeunload', warnBeforeClose);
  }, [recording]);

  useEffect(() => {
    if (!lessonActive) {
      capture.current?.abort();
      if (session.current) void session.current.stop();
    }
  }, [lessonActive]);

  async function begin() {
    if (!lessonActive) return;
    setError('');
    setNotice('');
    setBusy(true);
    const controller = new AbortController();
    capture.current = controller;
    try {
      const next = await startDashboardRecording(classroomId, classroomName, controller.signal);
      if (controller.signal.aborted || !lessonActiveRef.current) {
        await next.stop();
        return;
      }
      session.current = next;
      setRecording(true);
      setBusy(false);
      void next.completed.then(handleResult);
    } catch (cause) {
      if (mounted.current && lessonActiveRef.current) setError(errorMessage(cause));
      if (mounted.current) setBusy(false);
    } finally {
      if (capture.current === controller) capture.current = null;
    }
  }

  async function end() {
    if (!session.current || busy) return;
    setBusy(true);
    setError('');
    await session.current.stop();
  }

  async function remove(item: DashboardRecording) {
    if (!window.confirm('이 브라우저에 저장된 녹화를 영구 삭제할까요?')) return;
    setBusy(true);
    setError('');
    try {
      await deleteDashboardRecording(item.id);
      if (selected?.id === item.id) setSelected(null);
      setNotice('녹화를 이 브라우저에서 삭제했습니다.');
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="교사 대시보드 녹화">
      <h3>교사 대시보드 녹화</h3>
      <p>
        교사가 시작을 누르고 브라우저에서 CLARIO 탭을 선택해야 녹화됩니다. 마이크·시스템 오디오는
        수집하지 않으며, 학생 기기 화면을 캡처하거나 전송하지 않습니다.
      </p>
      {!lessonActive && <p role="status">진행 중인 수업이 있어야 녹화를 시작할 수 있습니다.</p>}
      <p>
        녹화 파일은 이 브라우저의 IndexedDB에만 보관됩니다. 다른 기기와 공유되지 않으며, 브라우저
        데이터 삭제·저장 공간 부족·기기 고장 시 파일을 잃을 수 있습니다. 보관 정책과 필요한 안내를
        확인한 뒤 시작하세요. 이 저장소는 CLARIO가 제공하는 저장 암호화가 없으며 Google Drive
        업로드도 아직 사용할 수 없습니다.
      </p>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {recording ? (
        <>
          <p role="status">녹화 중 · {classroomName} · 이 탭의 화면만 기록됩니다.</p>
          <button disabled={busy} onClick={() => void end()}>
            {busy ? '녹화를 마무리하는 중…' : '녹화 중지 및 저장'}
          </button>
        </>
      ) : (
        <button disabled={busy || !lessonActive} onClick={() => void begin()}>
          {busy ? '브라우저 권한을 기다리는 중…' : '대시보드 녹화 시작'}
        </button>
      )}
      {unsaved && (
        <button
          onClick={() => {
            downloadDashboardRecording(unsaved);
            setUnsaved(null);
          }}
        >
          저장 실패한 녹화 파일 지금 다운로드
        </button>
      )}
      <h4>이 브라우저의 녹화 목록</h4>
      {recordings.length === 0 ? (
        <p>저장된 녹화가 없습니다.</p>
      ) : (
        <ul className="workspace-list">
          {recordings.map((item) => (
            <li key={item.id}>
              <div>
                <strong>
                  {item.classroomName} · {new Date(item.startedAt).toLocaleString()}
                </strong>
                <p>
                  {formatDuration(item.durationMs)} · {(item.size / (1024 * 1024)).toFixed(1)} MiB
                  {item.complete ? '' : ' · 일부 녹화'}
                </p>
              </div>
              <button disabled={busy} onClick={() => setSelected(item)}>
                재생
              </button>
              <button disabled={busy} onClick={() => downloadDashboardRecording(item)}>
                다운로드
              </button>
              <button disabled={busy} onClick={() => void remove(item)}>
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && videoUrl && (
        <div>
          <h4>{selected.classroomName} 녹화 재생</h4>
          <video controls playsInline src={videoUrl} style={{ maxWidth: '100%' }} />
          <button onClick={() => setSelected(null)}>재생 닫기</button>
        </div>
      )}
    </section>
  );
}
