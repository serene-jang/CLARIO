import { afterEach, describe, expect, it, vi } from 'vitest';
import { startScreenRecording } from './screen-recording.js';

class Recorder {
  static supported = true;
  static latest: Recorder;
  static isTypeSupported() {
    return this.supported;
  }
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Recorder.latest = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['frame']) });
      this.onstop?.();
    });
  }
  chunk(value = 'chunk') {
    this.ondataavailable?.({ data: new Blob([value]) });
  }
}
function setup() {
  const track = { readyState: 'live', onended: null as (() => void) | null, stop: vi.fn() };
  const audio = { stop: vi.fn() };
  const stream = {
    getVideoTracks: () => [track],
    getAudioTracks: () => [audio],
    getTracks: () => [track],
    removeTrack: vi.fn(),
  };
  const getDisplayMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  vi.stubGlobal('MediaRecorder', Recorder);
  Recorder.supported = true;
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    maxDurationMs: 60000,
    maxBytes: 1024,
    onChunk: vi.fn().mockResolvedValue(undefined),
    onComplete: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
  };
  return { track, audio, stream, getDisplayMedia, options, controller };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('consent-driven screen recording engine (mock media only)', () => {
  it('requests the browser picker without audio and completes only after ordered chunks are accepted', async () => {
    const { getDisplayMedia, track, audio, stream, options } = setup();
    const session = await startScreenRecording(options);
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(audio.stop).toHaveBeenCalled();
    expect(stream.removeTrack).toHaveBeenCalledWith(audio);
    Recorder.latest.chunk('first');
    Recorder.latest.chunk('second');
    await session.stop();
    expect(options.onChunk.mock.calls.map((call) => call[1])).toEqual([0, 1, 2]);
    expect(options.onComplete).toHaveBeenCalledWith(
      { bytes: 16, chunks: 3 },
      expect.any(AbortSignal),
    );
    expect(track.stop).toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
  });
  it('does not create a recording after permission rejection and rejects insecure/unsupported environments', async () => {
    const { getDisplayMedia, options } = setup();
    getDisplayMedia.mockRejectedValue(new DOMException('User denied', 'NotAllowedError'));
    await expect(startScreenRecording(options)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(options.onChunk).not.toHaveBeenCalled();
    vi.stubGlobal('isSecureContext', false);
    getDisplayMedia.mockClear();
    await expect(startScreenRecording(options)).rejects.toThrow('지원하지 않습니다');
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });
  it('ends recording when the student uses the browser sharing-stop control', async () => {
    const { track, options } = setup();
    const session = await startScreenRecording(options);
    track.onended?.();
    await session.stop();
    expect(options.onComplete).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });
  it('fails closed on upload rejection and never reports a complete recording', async () => {
    const { track, options } = setup();
    options.onChunk.mockRejectedValue(new Error('Upload denied'));
    const session = await startScreenRecording(options);
    await expect(session.stop()).rejects.toThrow('Upload denied');
    expect(options.onError).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
    expect(options.onComplete).not.toHaveBeenCalled();
  });
  it('discards without completing and aborts in-flight media transport', async () => {
    const { track, options } = setup();
    const session = await startScreenRecording(options);
    Recorder.latest.chunk();
    session.discard();
    await session.stop();
    expect(options.onComplete).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });
  it('enforces explicit policy limits, stops on encoder failure and clears source tracks', async () => {
    const { track, getDisplayMedia, options } = setup();
    await expect(startScreenRecording({ ...options, maxDurationMs: 0 })).rejects.toThrow('승인한');
    expect(getDisplayMedia).not.toHaveBeenCalled();
    const session = await startScreenRecording(options);
    Recorder.latest.onerror?.();
    await expect(session.stop()).rejects.toThrow('인코딩');
    expect(track.stop).toHaveBeenCalled();
    expect(options.onComplete).not.toHaveBeenCalled();
  });
  it('stops at the approved duration and rejects excess bytes without uploading them', async () => {
    vi.useFakeTimers();
    const { options } = setup();
    const session = await startScreenRecording({ ...options, maxDurationMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await session.stop();
    expect(options.onComplete).toHaveBeenCalled();
    options.onChunk.mockClear();
    options.onComplete.mockClear();
    const next = await startScreenRecording({ ...options, maxBytes: 2 });
    Recorder.latest.chunk('too big');
    await vi.advanceTimersByTimeAsync(0);
    await expect(next.stop()).rejects.toThrow('한도');
    expect(options.onChunk).not.toHaveBeenCalled();
    expect(options.onComplete).not.toHaveBeenCalled();
  });
  it('releases a newly selected screen if authorization was lost while the picker was open', async () => {
    const { getDisplayMedia, stream, track, controller, options } = setup();
    let allow: (value: typeof stream) => void = () => {};
    getDisplayMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          allow = resolve;
        }),
    );
    const opening = startScreenRecording(options);
    controller.abort();
    allow(stream);
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(track.stop).toHaveBeenCalled();
    expect(options.onChunk).not.toHaveBeenCalled();
  });
  it('aborts active capture on authority loss and fails a stalled upload rather than completing it', async () => {
    const { controller, track, options } = setup();
    const session = await startScreenRecording(options);
    controller.abort();
    await expect(session.stop()).rejects.toThrow('권한이 종료');
    expect(track.stop).toHaveBeenCalled();
    expect(options.onComplete).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const next = setup();
    next.options.onChunk.mockImplementation(() => new Promise(() => {}));
    const recording = await startScreenRecording(next.options);
    const stopped = recording.stop();
    const assertion = expect(stopped).rejects.toThrow('응답 시간이 초과');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(next.options.onComplete).not.toHaveBeenCalled();
  });
  it('keeps authorization cancellation active while final recording bytes are uploading', async () => {
    const { controller, options } = setup();
    options.onChunk.mockImplementation(() => new Promise(() => {}));
    const session = await startScreenRecording(options);
    const stopped = session.stop();
    const assertion = expect(stopped).rejects.toThrow('권한이 종료');
    await Promise.resolve();
    await Promise.resolve();
    expect(options.onChunk).toHaveBeenCalledTimes(1);
    controller.abort();
    await assertion;
    expect(options.onComplete).not.toHaveBeenCalled();
    expect(options.onChunk.mock.calls[0][2].aborted).toBe(true);
  });
});
