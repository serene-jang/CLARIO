import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudentSyntheticMedia, TeacherSyntheticMedia } from './SyntheticMedia.js';
import { RequestError } from './web-api.js';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('local synthetic media UI boundaries', () => {
  it('does not auto-record or request any media until explicitly opened and reports disabled media', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ enabled: false, synthetic: true }));
    vi.stubGlobal('fetch', fetch);
    render(createElement(StudentSyntheticMedia, { csrfToken: 'csrf', onInvalid: vi.fn() }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '합성 미디어 시험 확인' }));
    await screen.findByText(/로컬 서버 시험 설정이 필요/);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect(screen.queryByRole('button', { name: '합성 화면 공유·녹화 시작' })).toBeNull();
  });
  it('reports unsupported encoding before asking the server to create a run', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ enabled: true, synthetic: true, runs: [] }));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(createElement(StudentSyntheticMedia, { csrfToken: 'csrf', onInvalid: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: '합성 미디어 시험 확인' }));
    fireEvent.click(await screen.findByRole('button', { name: '합성 화면 공유·녹화 시작' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('지원하지 않습니다');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('clears private scope on student authorization loss rather than displaying recording success', async () => {
    const onInvalid = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { message: '참여 권한 철회' } }, 401)),
    );
    render(createElement(StudentSyntheticMedia, { csrfToken: 'csrf', onInvalid }));
    fireEvent.click(screen.getByRole('button', { name: '합성 미디어 시험 확인' }));
    await screen.findByRole('alert');
    expect(onInvalid).toHaveBeenCalledWith('참여 권한 철회');
    expect(screen.queryByText('시험 메모리 저장 완료')).toBeNull();
  });
  it('distinguishes unrecorded targets, hides frames at four seconds and clears stale data on server failure', async () => {
    vi.useFakeTimers();
    const started = new Date().toISOString();
    const view = {
      enabled: true,
      synthetic: true,
      targets: [
        { id: 'one', name: 'Test One', studentNumber: '001' },
        { id: 'two', name: 'Test Two', studentNumber: '002' },
      ],
      runs: [
        {
          id: 'run',
          participantId: 'one',
          lessonId: 'lesson',
          startedAt: started,
          status: 'recording',
          frameAt: started,
          frame: 'cG5n',
          bytes: 0,
          synthetic: true,
        },
      ],
    };
    const api = vi.fn().mockResolvedValue(view);
    render(createElement(TeacherSyntheticMedia, { classroomId: 'class', token: 'token', api }));
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '교사 합성 미디어 시험 열기' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('img', { name: '001 합성 프레임 확대' }));
    expect(screen.getByRole('region', { name: '확대된 합성 화면' })).toBeTruthy();
    expect(screen.getByText('대기 · 합성 시험 시작 안 함')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByRole('img')).toBeNull();
    api.mockRejectedValue(new RequestError('권한 철회', 404));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('alert').textContent).toContain('현재 화면 확인 불가');
    expect(screen.queryByText('Test One · 학번 001')).toBeNull();
  });
  it('fetches authenticated WebM blobs without token URLs and revokes playback after permission loss', async () => {
    vi.useFakeTimers();
    const createURL = vi.fn().mockReturnValue('blob:synthetic-only'),
      revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = createURL;
        static override revokeObjectURL = revoke;
      },
    );
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/webm' } }),
      );
    vi.stubGlobal('fetch', fetch);
    const api = vi.fn().mockResolvedValue({
      enabled: true,
      synthetic: true,
      targets: [{ id: 'one', name: 'Test One', studentNumber: '001' }],
      runs: [{ id: 'run', participantId: 'one', status: 'ready', synthetic: true }],
    });
    render(
      createElement(TeacherSyntheticMedia, { classroomId: 'class', token: 'private-token', api }),
    );
    fireEvent.click(screen.getByRole('button', { name: '교사 합성 미디어 시험 열기' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '합성 녹화 재생 001' }));
    await act(async () => {});
    expect(fetch.mock.calls[0]).toEqual([
      '/api/identity/classrooms/class/synthetic-media/run/video',
      expect.objectContaining({
        headers: { Authorization: 'Bearer private-token' },
        credentials: 'omit',
      }),
    ]);
    expect(screen.getByLabelText('합성 녹화 재생').getAttribute('src')).toBe('blob:synthetic-only');
    api.mockRejectedValue(new RequestError('수업 종료', 409));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(revoke).toHaveBeenCalledWith('blob:synthetic-only');
    expect(screen.queryByLabelText('합성 녹화 재생')).toBeNull();
  });
  it('discards a late video response after authority was lost', async () => {
    vi.useFakeTimers();
    const createURL = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = createURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    let resolveVideo: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveVideo = resolve;
          }),
      ),
    );
    const api = vi.fn().mockResolvedValue({
      enabled: true,
      synthetic: true,
      targets: [{ id: 'one', name: 'Test One', studentNumber: '001' }],
      runs: [{ id: 'run', participantId: 'one', status: 'ready', synthetic: true }],
    });
    render(createElement(TeacherSyntheticMedia, { classroomId: 'class', token: 'teacher', api }));
    fireEvent.click(screen.getByRole('button', { name: '교사 합성 미디어 시험 열기' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '합성 녹화 재생 001' }));
    api.mockRejectedValue(new RequestError('권한 철회', 404));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      resolveVideo(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/webm' } }),
      );
    });
    expect(createURL).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('합성 녹화 재생')).toBeNull();
  });
  it('keeps a decoder error visible even when later state polling succeeds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = vi.fn().mockReturnValue('blob:test');
        static override revokeObjectURL = vi.fn();
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': 'video/webm' },
        }),
      ),
    );
    const api = vi.fn().mockResolvedValue({
      enabled: true,
      synthetic: true,
      targets: [{ id: 'one', name: 'Test One', studentNumber: '001' }],
      runs: [{ id: 'run', participantId: 'one', status: 'ready', synthetic: true }],
    });
    render(createElement(TeacherSyntheticMedia, { classroomId: 'class', token: 'teacher', api }));
    fireEvent.click(screen.getByRole('button', { name: '교사 합성 미디어 시험 열기' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '합성 녹화 재생 001' }));
    await act(async () => {});
    fireEvent.error(screen.getByLabelText('합성 녹화 재생'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByRole('alert').textContent).toContain('디코딩·재생 실패');
    expect(screen.queryByLabelText('합성 녹화 재생')).toBeNull();
  });
});
