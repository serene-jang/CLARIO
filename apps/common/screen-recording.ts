export interface ScreenRecordingOptions {
  signal: AbortSignal;
  maxDurationMs: number;
  maxBytes: number;
  onChunk: (chunk: Blob, sequence: number, signal: AbortSignal) => Promise<void>;
  onComplete: (result: { bytes: number; chunks: number }, signal: AbortSignal) => Promise<void>;
  onError: (error: Error) => void;
}

export interface ScreenRecording {
  stream: MediaStream;
  stop: () => Promise<void>;
  discard: () => void;
}

// Call only from a user gesture after a server-issued policy/storage authorization.
// This engine deliberately has no default upload URL or synthetic-media fallback.
export async function startScreenRecording(
  options: ScreenRecordingOptions,
): Promise<ScreenRecording> {
  if (
    !Number.isSafeInteger(options.maxDurationMs) ||
    options.maxDurationMs <= 0 ||
    options.maxDurationMs > 2147483647 ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes <= 0
  )
    throw new Error('서버가 승인한 녹화 시간·용량 한도가 필요합니다.');
  if (
    !globalThis.isSecureContext ||
    !navigator.mediaDevices?.getDisplayMedia ||
    typeof MediaRecorder === 'undefined' ||
    !MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
  )
    throw new Error('이 환경은 화면 선택과 WebM 녹화를 지원하지 않습니다.');

  options.signal.throwIfAborted();
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  let recorder: MediaRecorder;
  try {
    options.signal.throwIfAborted();
    if (!stream.getVideoTracks().some((track) => track.readyState === 'live'))
      throw new Error('허용된 화면 영상 트랙이 없습니다.');
    stream.getAudioTracks().forEach((track) => {
      track.stop();
      stream.removeTrack(track);
    });
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  } catch (cause) {
    stream.getTracks().forEach((track) => track.stop());
    throw cause;
  }
  let bytes = 0,
    chunks = 0,
    pendingBytes = 0,
    disposed = false,
    failed = false;
  let failureError: Error | null = null;
  const controller = new AbortController();
  async function bounded(work: (signal: AbortSignal) => Promise<void>) {
    const timeout = new AbortController();
    const deadline = setTimeout(() => timeout.abort(), 5000);
    const signal = AbortSignal.any([controller.signal, timeout.signal]);
    const aborted = () =>
      rejectWork(new Error('화면 녹화 전송이 중단되었거나 응답 시간이 초과했습니다.'));
    let rejectWork: (error: Error) => void = () => {};
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        rejectWork = reject;
        signal.addEventListener('abort', aborted, { once: true });
        void work(signal).then(resolve, reject);
      });
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', aborted);
    }
  }
  let queue: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const release = () => {
    clearTimeout(timer);
    stream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
  };
  const failure = (cause: unknown) => {
    if (failed || disposed) return;
    failed = true;
    failureError = cause instanceof Error ? cause : new Error('화면 녹화 처리에 실패했습니다.');
    controller.abort();
    options.signal.removeEventListener('abort', onAbort);
    release();
    if (recorder.state !== 'inactive') recorder.stop();
    options.onError(failureError);
  };
  onAbort = () => failure(new Error('수업 또는 화면 녹화 권한이 종료되어 공유를 중단했습니다.'));
  options.signal.addEventListener('abort', onAbort, { once: true });
  recorder.ondataavailable = (event) => {
    if (!event.data.size || disposed || failed) return;
    bytes += event.data.size;
    pendingBytes += event.data.size;
    if (bytes > options.maxBytes || pendingBytes > Math.min(options.maxBytes, 4 * 1024 * 1024)) {
      failure(new Error('승인된 녹화 용량 또는 업로드 대기 한도를 초과했습니다.'));
      return;
    }
    const sequence = chunks++;
    queue = queue
      .then(async () => {
        try {
          if (!disposed && !failed)
            await bounded((signal) => options.onChunk(event.data, sequence, signal));
        } finally {
          pendingBytes -= event.data.size;
        }
      })
      .catch(failure);
  };
  recorder.onerror = () => failure(new Error('브라우저 화면 녹화 인코딩에 실패했습니다.'));
  recorder.onstop = () => {
    release();
    void queue
      .then(async () => {
        if (!disposed && !failed) {
          if (!bytes) throw new Error('저장할 화면 녹화 데이터가 없습니다.');
          await bounded((signal) => options.onComplete({ bytes, chunks }, signal));
        }
      })
      .catch(failure)
      .finally(() => {
        options.signal.removeEventListener('abort', onAbort);
        finish();
      });
  };
  stream.getVideoTracks().forEach((track) => {
    track.onended = () => {
      if (recorder.state !== 'inactive') recorder.stop();
    };
  });
  try {
    recorder.start(1000);
    timer = setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, options.maxDurationMs);
  } catch (cause) {
    disposed = true;
    options.signal.removeEventListener('abort', onAbort);
    release();
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    throw cause;
  }
  return {
    stream,
    stop: async () => {
      if (recorder.state !== 'inactive') recorder.stop();
      await finished;
      if (failureError) throw failureError;
    },
    discard: () => {
      disposed = true;
      controller.abort();
      options.signal.removeEventListener('abort', onAbort);
      release();
      if (recorder.state !== 'inactive') recorder.stop();
    },
  };
}
