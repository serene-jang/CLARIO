import { useEffect, useRef, useState } from 'react';
import type { SyntheticMediaRun, SyntheticMediaView } from '@clario/shared';
import { errorMessage, RequestError } from './web-api.js';

type Api = <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
const labels = {
  recording: '합성 녹화 중',
  uploading: '업로드 중',
  ready: '시험 메모리 저장 완료',
  failed: '실패 · 재생 불가',
};
function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('합성 영상 인코딩에 실패했습니다.'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result.split(',')[1])
        : reject(new Error('인코딩 결과가 없습니다.'));
    reader.readAsDataURL(blob);
  });
}
async function studentRequest<T>(csrf: string, action = '', body?: object): Promise<T> {
  const response = await fetch(`/api/student/synthetic-media${action ? `/${action}` : ''}`, {
    method: action ? 'POST' : 'GET',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(5000),
    headers: action ? { 'Content-Type': 'application/json', 'X-Student-CSRF': csrf } : {},
    body: action ? JSON.stringify(body ?? {}) : undefined,
  });
  const result = await response.json();
  if (!response.ok)
    throw new RequestError(result.error?.message ?? '합성 시험 요청 실패', response.status);
  return result as T;
}
const notice =
  '합성 화면 전용 로컬 시험입니다. 실제 화면·카메라·마이크를 수집하지 않습니다. 운영 녹화 기능이 아닙니다. 시험 종료·권한 철회 시 서버 메모리와 재생 화면을 삭제합니다.';

export function StudentSyntheticMedia({
  csrfToken,
  onInvalid,
}: {
  csrfToken: string;
  onInvalid: (message: string) => void;
}) {
  const [opened, setOpened] = useState(false),
    [enabled, setEnabled] = useState(false);
  const [run, setRun] = useState<SyntheticMediaRun | null>(null),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [recording, setRecording] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    recorder = useRef<MediaRecorder | null>(null);
  const cleanup = useRef<() => void>(() => {}),
    epoch = useRef(0),
    runId = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      cleanup.current();
      if (runId.current)
        void fetch('/api/student/synthetic-media/delete', {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/json', 'X-Student-CSRF': csrfToken },
          body: JSON.stringify({ id: runId.current }),
        })
          .then((response) => {
            if (!response.ok) console.error('synthetic_media_unmount_cleanup_denied');
          })
          .catch(() => console.error('synthetic_media_unmount_cleanup_network_failed'));
    };
  }, [csrfToken]);
  const problem = (cause: unknown) => {
    if (!mounted.current) return;
    setError(errorMessage(cause));
    if (cause instanceof RequestError && [401, 403, 404].includes(cause.status)) {
      cleanup.current();
      epoch.current++;
      setRun(null);
      setRecording(false);
      onInvalid(errorMessage(cause));
    }
  };
  useEffect(() => {
    if (!opened || !enabled || busy) return;
    let active = true,
      inFlight = false;
    const poll = setInterval(
      () =>
        void (async () => {
          if (inFlight) return;
          inFlight = true;
          try {
            const result = await studentRequest<SyntheticMediaView>(csrfToken);
            if (!active) return;
            const current = result.runs?.[0] ?? null;
            if (!current || current.status === 'failed') {
              cleanup.current();
              epoch.current++;
              setRecording(false);
            }
            runId.current = current?.id ?? null;
            setRun(current);
          } catch (cause) {
            if (active) {
              cleanup.current();
              epoch.current++;
              setRecording(false);
              setRun(null);
              problem(cause);
            }
          } finally {
            inFlight = false;
          }
        })(),
      2000,
    );
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [opened, enabled, busy, csrfToken]);
  async function open() {
    setBusy(true);
    setError('');
    try {
      const result = await studentRequest<SyntheticMediaView>(csrfToken);
      if (!mounted.current) return;
      setEnabled(result.enabled);
      setOpened(true);
      runId.current = result.runs?.[0]?.id ?? null;
      setRun(result.runs?.[0] ?? null);
    } catch (cause) {
      problem(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function start() {
    if (!canvas.current || busy || recording) return;
    setBusy(true);
    setError('');
    const version = ++epoch.current;
    let created: SyntheticMediaRun | undefined;
    try {
      const element = canvas.current,
        context = element.getContext('2d');
      if (
        !context ||
        !element.captureStream ||
        typeof MediaRecorder === 'undefined' ||
        !MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      )
        throw new Error('이 브라우저는 합성 canvas/WebM 녹화 시험을 지원하지 않습니다.');
      created = await studentRequest<SyntheticMediaRun>(csrfToken, 'start', {
        confirmSynthetic: true,
      });
      if (version !== epoch.current || !mounted.current)
        throw new Error('합성 시험 화면이 종료되었습니다.');
      const current = created;
      runId.current = current.id;
      setRun(current);
      const stream = element.captureStream(5),
        media = new MediaRecorder(stream, {
          mimeType: 'video/webm;codecs=vp8',
          videoBitsPerSecond: 250000,
        });
      const chunks: Blob[] = [];
      let size = 0,
        sequence = 0,
        sending = false,
        failed = false;
      let frameWork: Promise<void> = Promise.resolve();
      const started = Date.now();
      let drawTimer: ReturnType<typeof setInterval>, frameTimer: ReturnType<typeof setInterval>;
      let endTimer: ReturnType<typeof setTimeout>;
      const stopTracks = () => {
        clearInterval(drawTimer);
        clearInterval(frameTimer);
        clearTimeout(endTimer);
        stream.getTracks().forEach((track) => track.stop());
      };
      cleanup.current = () => {
        media.onstop = null;
        media.ondataavailable = null;
        media.onerror = null;
        if (media.state !== 'inactive') media.stop();
        stopTracks();
        chunks.length = 0;
        recorder.current = null;
      };
      const draw = () => {
        const seconds = (Date.now() - started) / 1000;
        context.fillStyle = '#102a43';
        context.fillRect(0, 0, 480, 270);
        context.fillStyle = '#ffffff';
        context.font = '20px sans-serif';
        context.fillText('CLARIO SYNTHETIC TEST ONLY', 18, 45);
        context.fillText(`Generated animation ${seconds.toFixed(1)}s`, 18, 80);
        context.fillStyle = '#38bdf8';
        context.fillRect(20 + ((seconds * 35) % 360), 130, 70, 70);
      };
      const failedUpload = async (cause: unknown) => {
        if (failed) return;
        failed = true;
        stopTracks();
        if (media.state !== 'inactive') media.stop();
        problem(cause);
        try {
          await studentRequest(csrfToken, 'fail', { id: current.id });
        } catch (failure) {
          problem(
            new Error(`${errorMessage(cause)} · 실패 상태 보고도 실패: ${errorMessage(failure)}`),
          );
        }
      };
      media.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          size += event.data.size;
        }
        if (size > 8 * 1024 * 1024)
          void failedUpload(new Error('합성 녹화가 8 MiB 한도를 초과했습니다.'));
      };
      media.onerror = () => void failedUpload(new Error('브라우저 합성 녹화에 실패했습니다.'));
      media.onstop = () =>
        void (async () => {
          stopTracks();
          recorder.current = null;
          if (version !== epoch.current || !mounted.current) {
            chunks.length = 0;
            return;
          }
          setRecording(false);
          setBusy(true);
          try {
            await frameWork;
            if (failed) {
              setRun({ ...current, status: 'failed', frame: null });
              return;
            }
            const blob = new Blob(chunks, { type: 'video/webm' });
            chunks.length = 0;
            if (!blob.size || blob.size > 8 * 1024 * 1024)
              throw new Error('유효한 크기의 합성 영상이 없습니다.');
            setRun(await studentRequest<SyntheticMediaRun>(csrfToken, 'stop', { id: current.id }));
            let count = 0;
            for (let offset = 0; offset < blob.size; offset += 32768) {
              if (version !== epoch.current || !mounted.current) return;
              await studentRequest(csrfToken, 'chunk', {
                id: current.id,
                sequence: count++,
                data: await base64(blob.slice(offset, offset + 32768)),
              });
            }
            const ready = await studentRequest<SyntheticMediaRun>(csrfToken, 'complete', {
              id: current.id,
              bytes: blob.size,
              chunks: count,
            });
            if (version === epoch.current && mounted.current) setRun(ready);
          } catch (cause) {
            await failedUpload(cause);
            if (mounted.current) setRun({ ...current, status: 'failed', frame: null });
          } finally {
            if (mounted.current) setBusy(false);
          }
        })();
      draw();
      drawTimer = setInterval(draw, 200);
      frameTimer = setInterval(() => {
        if (sending || media.state !== 'recording' || failed) return;
        frameWork = (async () => {
          sending = true;
          try {
            const png = await new Promise<Blob>((resolve, reject) =>
              element.toBlob(
                (b) => (b ? resolve(b) : reject(new Error('합성 프레임 생성 실패'))),
                'image/png',
              ),
            );
            if (version !== epoch.current) return;
            await studentRequest(csrfToken, 'frame', {
              id: current.id,
              sequence: ++sequence,
              data: await base64(png),
            });
          } catch (cause) {
            await failedUpload(cause);
          } finally {
            sending = false;
          }
        })();
      }, 1000);
      endTimer = setTimeout(() => {
        if (media.state === 'recording') media.stop();
      }, 60000);
      recorder.current = media;
      media.start(1000);
      setRecording(true);
    } catch (cause) {
      cleanup.current();
      problem(cause);
      if (created) {
        try {
          await studentRequest(csrfToken, 'delete', { id: created.id });
          if (mounted.current) {
            setRun(null);
            runId.current = null;
          }
        } catch (failure) {
          problem(new Error(`${errorMessage(cause)} · 시험 정리 실패: ${errorMessage(failure)}`));
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function erase() {
    const target = run?.id ?? runId.current;
    if (!target) return;
    epoch.current++;
    cleanup.current();
    setRecording(false);
    setBusy(true);
    setError('');
    try {
      await studentRequest(csrfToken, 'delete', { id: target });
      if (mounted.current) {
        setRun(null);
        runId.current = null;
      }
    } catch (cause) {
      problem(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section aria-label="합성 화면 녹화 시험">
      <h3>합성 화면 공유·녹화 시험</h3>
      <p>{notice}</p>
      {!opened && (
        <button disabled={busy} onClick={() => void open()}>
          합성 미디어 시험 확인
        </button>
      )}
      {opened && !enabled && (
        <p>비활성 · 로컬 서버 시험 설정이 필요합니다. 실제 화면 확인·녹화는 미지원입니다.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {opened && enabled && (
        <>
          <p>
            직접 생성한 애니메이션만 녹화합니다. 최대 60초·8 MiB, 4명 이내의 로컬 기능 시험이며 보관
            정책이 아닙니다.
          </p>
          <canvas
            ref={canvas}
            width={480}
            height={270}
            style={{ maxWidth: '100%' }}
            aria-label="실제 화면이 아닌 합성 애니메이션"
          />
          <p role="status">
            {recording
              ? '합성 공유·녹화 중 · 실제 화면은 수집하지 않음'
              : run
                ? labels[run.status]
                : '시작 대기 · 자동 녹화하지 않음'}
          </p>
          <button disabled={busy || recording} onClick={() => void open()}>
            합성 상태 다시 확인
          </button>
          {!run && !runId.current && (
            <button disabled={busy} onClick={() => void start()}>
              합성 화면 공유·녹화 시작
            </button>
          )}
          {recording && (
            <button onClick={() => recorder.current?.stop()}>합성 녹화 중단·업로드</button>
          )}
          {(run || runId.current) && (
            <button disabled={busy} onClick={() => void erase()}>
              시험 종료·합성 영상 삭제
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function TeacherSyntheticMedia({
  classroomId,
  token,
  api,
}: {
  classroomId: string;
  token: string;
  api: Api;
}) {
  const [opened, setOpened] = useState(false),
    [view, setView] = useState<SyntheticMediaView | null>(null);
  const [error, setError] = useState(''),
    [now, setNow] = useState(Date.now());
  const [readError, setReadError] = useState('');
  const [selected, setSelected] = useState<string | null>(null),
    [video, setVideo] = useState<string | null>(null);
  const url = useRef<string | null>(null),
    version = useRef(0),
    loading = useRef(false);
  const clearVideo = () => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setVideo(null);
  };
  useEffect(() => {
    let active = true,
      inFlight = false;
    version.current++;
    setView(null);
    setSelected(null);
    clearVideo();
    setError('');
    setReadError('');
    async function read() {
      if (!opened || inFlight) return;
      inFlight = true;
      try {
        const result = await api<SyntheticMediaView>(
          `/identity/classrooms/${classroomId}/synthetic-media`,
          token,
        );
        if (!active) return;
        setView(result);
        setReadError('');
      } catch (cause) {
        if (active) {
          version.current++;
          setView(null);
          clearVideo();
          setReadError(errorMessage(cause));
        }
      } finally {
        inFlight = false;
      }
    }
    void read();
    const poll = setInterval(() => void read(), 2000),
      clock = setInterval(() => setNow(Date.now()), 500);
    return () => {
      active = false;
      version.current++;
      clearInterval(poll);
      clearInterval(clock);
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
      loading.current = false;
    };
  }, [opened, classroomId, token, api]);
  useEffect(() => {
    if (selected && !view?.runs?.some((r) => r.id === selected)) {
      version.current++;
      setSelected(null);
      clearVideo();
    } else if (video && !view?.runs?.some((r) => r.id === selected && r.status === 'ready'))
      clearVideo();
  }, [view, selected, video]);
  async function play(run: SyntheticMediaRun) {
    if (loading.current) return;
    loading.current = true;
    const generation = ++version.current;
    clearVideo();
    setError('');
    setSelected(run.id);
    try {
      const response = await fetch(
        `/api/identity/classrooms/${classroomId}/synthetic-media/${run.id}/video`,
        {
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'omit',
          signal: AbortSignal.timeout(5000),
          cache: 'no-store',
        },
      );
      if (!response.ok)
        throw new RequestError(
          '합성 녹화 재생 권한 또는 현재 저장 상태를 확인할 수 없습니다.',
          response.status,
        );
      const blob = await response.blob();
      if (generation !== version.current) return;
      if (!blob.size || blob.type !== 'video/webm')
        throw new Error('합성 녹화 응답 형식이 올바르지 않습니다.');
      url.current = URL.createObjectURL(blob);
      setVideo(url.current);
    } catch (cause) {
      if (generation === version.current) {
        clearVideo();
        setError(errorMessage(cause));
      }
    } finally {
      loading.current = false;
    }
  }
  const active = view?.runs?.find((r) => r.id === selected);
  const fresh = (run: SyntheticMediaRun) =>
    run.status === 'recording' && run.frame && run.frameAt && now - Date.parse(run.frameAt) < 4000;
  return (
    <section aria-label="교사 합성 화면 시험">
      <h3>합성 화면 확인·녹화 재생 시험</h3>
      <p>{notice}</p>
      {!opened && <button onClick={() => setOpened(true)}>교사 합성 미디어 시험 열기</button>}
      {error && <p role="alert">{error} · 현재 화면 확인 불가</p>}
      {readError && <p role="alert">{readError} · 현재 화면 확인 불가</p>}
      {view && !view.enabled && <p>비활성 · 실제 화면 확인·녹화는 미지원입니다.</p>}
      {view?.enabled && (
        <>
          <p>
            합성 프레임은 약 2초마다 확인하며 4초 이상 오래되면 숨깁니다. 실제 학생 화면이 아닙니다.
          </p>
          <p>
            서버 확인{' '}
            {view.observedAt ? new Date(view.observedAt).toLocaleString() : '확인 시각 없음'} · 합성
            녹화 중 {view.runs?.filter((r) => r.status === 'recording').length ?? 0}명 · 실패{' '}
            {view.runs?.filter((r) => r.status === 'failed').length ?? 0}명 · 저장 완료{' '}
            {view.runs?.filter((r) => r.status === 'ready').length ?? 0}명
          </p>
          {!view.targets?.length && <p>현재 승인된 합성 시험 대상이 없습니다.</p>}
          <ul>
            {view.targets?.map((target) => {
              const run = view.runs?.find((r) => r.participantId === target.id);
              return (
                <li key={target.id}>
                  <strong>
                    {target.name} · 학번 {target.studentNumber}
                  </strong>
                  <p>{run ? labels[run.status] : '대기 · 합성 시험 시작 안 함'}</p>
                  {run && fresh(run) ? (
                    <button
                      onClick={() => {
                        version.current++;
                        clearVideo();
                        setSelected(run.id);
                      }}
                    >
                      <img
                        alt={`${target.studentNumber} 합성 프레임 확대`}
                        width={240}
                        src={`data:image/png;base64,${run.frame}`}
                      />
                    </button>
                  ) : (
                    <p>현재 공유되는 합성 프레임 없음 · 오래된 화면 표시 안 함</p>
                  )}
                  {run && fresh(run) && (
                    <p>합성 프레임 서버 수신 {new Date(run.frameAt!).toLocaleString()}</p>
                  )}
                  {run?.status === 'ready' && (
                    <button onClick={() => void play(run)}>
                      합성 녹화 재생 {target.studentNumber}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {active && fresh(active) && !video && (
            <div role="region" aria-label="확대된 합성 화면">
              <img
                style={{ maxWidth: '100%' }}
                width={720}
                alt="확대된 합성 시험 프레임"
                src={`data:image/png;base64,${active.frame}`}
              />
              <button onClick={() => setSelected(null)}>전체 합성 목록으로</button>
            </div>
          )}
          {video && (
            <div>
              <p>합성 시험 녹화 · 실제 학생 화면 아님</p>
              <video
                aria-label="합성 녹화 재생"
                controls
                src={video}
                style={{ maxWidth: '100%' }}
                onError={() => {
                  clearVideo();
                  setError('합성 영상 디코딩·재생 실패');
                }}
              />
              <button
                onClick={() => {
                  version.current++;
                  clearVideo();
                  setSelected(null);
                }}
              >
                합성 녹화 닫기
              </button>
            </div>
          )}
        </>
      )}
      {opened && (
        <button
          onClick={() => {
            version.current++;
            setOpened(false);
            setView(null);
            setSelected(null);
            clearVideo();
          }}
        >
          교사 합성 시험 닫기
        </button>
      )}
    </section>
  );
}
