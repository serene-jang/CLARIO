import { saveDashboardRecording } from './dashboard-recording-store.js';
export {
  deleteDashboardRecording,
  downloadDashboardRecording,
  listDashboardRecordings,
} from './dashboard-recording-store.js';
export type { DashboardRecording } from './dashboard-recording-store.js';
import type { DashboardRecording } from './dashboard-recording-store.js';

export const maxRecordingBytes = 500 * 1024 * 1024;
export const maxRecordingDurationMs = 2 * 60 * 60 * 1000;

export interface DashboardRecordingResult {
  recording: DashboardRecording;
  stored: boolean;
  storageError?: string;
}

export interface DashboardRecordingSession {
  completed: Promise<DashboardRecordingResult>;
  stop: () => Promise<DashboardRecordingResult>;
}

export async function startDashboardRecording(
  classroomId: string,
  classroomName: string,
  signal: AbortSignal,
): Promise<DashboardRecordingSession> {
  if (
    !globalThis.isSecureContext ||
    !navigator.mediaDevices?.getDisplayMedia ||
    typeof MediaRecorder === 'undefined'
  )
    throw new Error(
      '이 환경은 브라우저 탭 녹화를 지원하지 않습니다. HTTPS 또는 localhost에서 사용하세요.',
    );

  const supportedType = ['video/webm;codecs=vp8', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  if (!supportedType) throw new Error('이 브라우저는 지원되는 WebM 녹화 형식을 제공하지 않습니다.');

  const captureOptions = Object.assign({ video: true, audio: false }, { preferCurrentTab: true });
  const stream = await navigator.mediaDevices.getDisplayMedia(captureOptions);
  if (signal.aborted) {
    stream.getTracks().forEach((track) => track.stop());
    signal.throwIfAborted();
  }
  const videoTracks = stream.getVideoTracks();
  if (
    videoTracks.length !== 1 ||
    videoTracks[0].readyState !== 'live' ||
    videoTracks[0].getSettings().displaySurface !== 'browser'
  ) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('CLARIO 브라우저 탭을 선택해야 합니다. 화면이나 다른 앱은 녹화하지 않습니다.');
  }
  stream.getAudioTracks().forEach((track) => {
    track.stop();
    stream.removeTrack(track);
  });

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: supportedType });
  } catch (cause) {
    stream.getTracks().forEach((track) => track.stop());
    throw cause;
  }

  const chunks: Blob[] = [];
  let bytes = 0;
  let complete = true;
  let stopping = false;
  const startedAt = new Date();
  let stopTimer: number | undefined;
  let resolveCompletion: (result: DashboardRecordingResult) => void = () => {};
  const completed = new Promise<DashboardRecordingResult>((resolve) => {
    resolveCompletion = resolve;
  });

  function stop(partial = false) {
    if (partial) complete = false;
    if (stopping) return;
    stopping = true;
    window.clearTimeout(stopTimer);
    if (recorder.state !== 'inactive') recorder.stop();
  }

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    chunks.push(event.data);
    bytes += event.data.size;
    if (bytes > maxRecordingBytes) stop(true);
  };
  recorder.onerror = () => stop(true);
  recorder.onstop = () => {
    window.clearTimeout(stopTimer);
    stream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    const durationMs = Math.max(0, Date.now() - startedAt.getTime());
    const recording: DashboardRecording = {
      id: crypto.randomUUID(),
      classroomId,
      classroomName,
      startedAt: startedAt.toISOString(),
      durationMs,
      size: chunks.reduce((total, chunk) => total + chunk.size, 0),
      complete,
      blob: new Blob(chunks, { type: supportedType }),
    };
    void saveDashboardRecording(recording).then(
      () => resolveCompletion({ recording, stored: true }),
      (cause: unknown) =>
        resolveCompletion({
          recording,
          stored: false,
          storageError:
            cause && typeof cause === 'object' && 'message' in cause
              ? String(cause.message)
              : '녹화를 브라우저 보관소에 저장하지 못했습니다.',
        }),
    );
  };
  videoTracks[0].onended = () => stop();

  try {
    recorder.start(1000);
    stopTimer = window.setTimeout(() => stop(true), maxRecordingDurationMs);
  } catch (cause) {
    stream.getTracks().forEach((track) => track.stop());
    throw cause;
  }

  return {
    completed,
    stop: async () => {
      stop();
      return completed;
    },
  };
}
