import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDashboardRecording } from './dashboard-recordings.js';

const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('./dashboard-recording-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dashboard-recording-store.js')>();
  return { ...actual, saveDashboardRecording: save };
});

class FakeRecorder {
  static latest: FakeRecorder;
  static isTypeSupported = vi.fn(() => true);
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    FakeRecorder.latest = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['last']) });
      this.onstop?.();
    });
  }
}

function setup(displaySurface = 'browser') {
  const track = {
    readyState: 'live',
    onended: null as (() => void) | null,
    stop: vi.fn(),
    getSettings: () => ({ displaySurface }),
  };
  const stream = {
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    getTracks: () => [track],
    removeTrack: vi.fn(),
  };
  const getDisplayMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  save.mockReset().mockResolvedValue(undefined);
  return { track, stream, getDisplayMedia };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('teacher dashboard tab recording', () => {
  it('captures only the browser tab, excludes audio, stores one WebM and returns it for playback', async () => {
    const { getDisplayMedia, track } = setup();
    const session = await startDashboardRecording('class-1', '과학', new AbortController().signal);
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: true,
      audio: false,
      preferCurrentTab: true,
    });
    expect(FakeRecorder.latest.options.mimeType).toBe('video/webm;codecs=vp8');
    FakeRecorder.latest.ondataavailable?.({ data: new Blob(['first']) });

    const result = await session.stop();

    expect(result.stored).toBe(true);
    expect(result.recording.classroomId).toBe('class-1');
    expect(result.recording.complete).toBe(true);
    expect(result.recording.blob.type).toBe('video/webm;codecs=vp8');
    expect(result.recording.blob.size).toBe('firstlast'.length);
    expect(save).toHaveBeenCalledWith(result.recording);
    expect(track.stop).toHaveBeenCalled();
  });

  it('rejects whole-screen or other-window capture and stops the selected stream', async () => {
    const { track } = setup('monitor');

    await expect(
      startDashboardRecording('class-1', '과학', new AbortController().signal),
    ).rejects.toThrow('CLARIO 브라우저 탭을 선택');

    expect(track.stop).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('returns the completed blob to the UI when browser storage is unavailable', async () => {
    setup();
    save.mockRejectedValue(new DOMException('Quota exceeded', 'QuotaExceededError'));
    const session = await startDashboardRecording('class-1', '과학', new AbortController().signal);

    const result = await session.stop();

    expect(result.stored).toBe(false);
    expect(result.recording.blob.size).toBeGreaterThan(0);
    expect(result.storageError).toContain('Quota exceeded');
  });

  it('stops a screen stream granted after the lesson was canceled', async () => {
    const { track, stream, getDisplayMedia } = setup();
    let grant: (value: typeof stream) => void = () => {};
    getDisplayMedia.mockImplementation(() => new Promise((resolve) => (grant = resolve)));
    const controller = new AbortController();
    const starting = startDashboardRecording('class-1', '과학', controller.signal);
    controller.abort();
    grant(stream);

    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    expect(track.stop).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
