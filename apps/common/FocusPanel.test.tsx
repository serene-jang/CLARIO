import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FocusPanel from './FocusPanel.js';
import { RequestError } from './web-api.js';
const now = new Date().toISOString();
const snapshot = {
  enabled: false,
  version: 0,
  updatedAt: now,
  observedAt: now,
  lesson: { id: 'lesson', startedAt: now },
};
const studentView = { ...snapshot, expiresAt: new Date(Date.now() + 3600000).toISOString() };
const teacher = { role: 'teacher' as const, classroomId: 'class', token: 'teacher', closed: false };
const student = () => ({
  role: 'student' as const,
  csrfToken: 'csrf',
  onInvalid: vi.fn(),
  onExpiry: vi.fn(),
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('voluntary focus notice', () => {
  it('sends only the current lesson/version, waits for server confirmation and forbids changes without a lesson', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, enabled: true, version: 1 });
    const rendered = render(createElement(FocusPanel, { ...teacher, api }));
    await screen.findByText('현재 서버 확인 결과: 자율 집중 안내 꺼짐');
    fireEvent.click(screen.getByRole('button', { name: '자율 집중 안내 켜기' }));
    await screen.findByText('현재 서버 확인 결과: 자율 집중 안내 켜짐');
    expect(api.mock.calls[1]).toEqual([
      '/identity/classrooms/class/focus',
      'teacher',
      'PATCH',
      { enabled: true, sessionId: 'lesson', expectedVersion: 0 },
    ]);
    api.mockResolvedValue({ ...snapshot, lesson: null });
    rendered.rerender(createElement(FocusPanel, { ...teacher, classroomId: 'next', api }));
    await screen.findByText('진행 중인 수업이 없어 자율 집중 안내가 꺼져 있습니다.');
    expect(screen.getByRole('button', { name: '자율 집중 안내 켜기' })).toHaveProperty(
      'disabled',
      true,
    );
  });
  it('polls teacher state every five seconds and requires refresh after a conflicting mutation', async () => {
    vi.useFakeTimers();
    const api = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, enabled: true, version: 1 })
      .mockRejectedValueOnce(new RequestError('Changed remotely', 409))
      .mockResolvedValue({ ...snapshot, version: 2 });
    render(createElement(FocusPanel, { ...teacher, api }));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText('현재 서버 확인 결과: 자율 집중 안내 켜짐')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '자율 집중 안내 끄기' }));
    await act(async () => {});
    expect(screen.getByText(/집중 안내 확인 불가/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '자율 집중 안내 끄기' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '집중 안내 다시 확인' }));
    await act(async () => {});
    expect(screen.getByText('현재 서버 확인 결과: 자율 집중 안내 꺼짐')).toBeTruthy();
  });
  it('clears teacher scope on authority loss and ignores late previous classroom replies', async () => {
    let old: (value: unknown) => void = () => {};
    const api = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            old = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...snapshot, enabled: true, version: 3 })
      .mockRejectedValue(new RequestError('Denied', 404));
    const rendered = render(createElement(FocusPanel, { ...teacher, api }));
    rendered.rerender(createElement(FocusPanel, { ...teacher, classroomId: 'next', api }));
    await act(async () => {
      old(snapshot);
    });
    expect(screen.getByText('현재 서버 확인 결과: 자율 집중 안내 켜짐')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '집중 안내 다시 확인' }));
    await screen.findByText('Denied');
    expect(screen.queryByText(/버전 3/)).toBeNull();
  });
  it('uses student cookies without authority fields and receives ten-second latest snapshots with no controls', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => json(studentView));
    vi.stubGlobal('fetch', fetch);
    const callbacks = student();
    render(createElement(StrictMode, null, createElement(FocusPanel, callbacks)));
    await act(async () => {});
    expect(screen.getByText('현재 서버 확인 결과: 자율 집중 안내 꺼짐')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '자율 집중 안내 켜기' })).toBeNull();
    expect(fetch.mock.calls[0]).toEqual([
      '/api/student/focus',
      expect.objectContaining({ credentials: 'same-origin' }),
    ]);
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
    fetch.mockImplementation(async () => json({ ...studentView, enabled: true, version: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText('현재 서버 확인 결과: 자율 집중 안내 켜짐')).toBeTruthy();
    expect(callbacks.onExpiry).toHaveBeenCalledWith(studentView.expiresAt);
    expect(screen.getByText(/학생의 준수 여부를 수집하지 않습니다/)).toBeTruthy();
  });
  it('marks network/old-version responses unknown, resumes with a full snapshot and clears revoked private state', async () => {
    vi.useFakeTimers();
    const callbacks = student();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ ...studentView, enabled: true, version: 2 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json({ ...studentView, version: 1 }))
      .mockResolvedValueOnce(json({ ...studentView, version: 3, lesson: null }))
      .mockResolvedValueOnce(json({ error: { message: 'Revoked' } }, 401));
    vi.stubGlobal('fetch', fetch);
    render(createElement(FocusPanel, callbacks));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText('마지막 확인 결과: 자율 집중 안내 켜짐')).toBeTruthy();
    expect(screen.queryByText('현재 서버 확인 결과: 자율 집중 안내 켜짐')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText('최신 집중 안내 응답을 확인할 수 없습니다.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '내 집중 안내 다시 확인' }));
    await act(async () => {});
    expect(screen.getByText('진행 중인 수업이 없어 자율 집중 안내가 꺼져 있습니다.')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(callbacks.onInvalid).toHaveBeenCalledWith('Revoked');
    expect(screen.queryByText(/버전 3/)).toBeNull();
    const count = fetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  it('expires freshness during a hanging read and refuses malformed responses instead of claiming off', async () => {
    vi.useFakeTimers();
    const api = vi
      .fn()
      .mockResolvedValueOnce({ ...snapshot, enabled: true, version: 1 })
      .mockImplementationOnce(() => new Promise(() => {}));
    const rendered = render(createElement(FocusPanel, { ...teacher, api }));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11000);
    });
    expect(screen.getByText('마지막 확인 결과: 자율 집중 안내 켜짐')).toBeTruthy();
    rendered.unmount();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ enabled: false })),
    );
    render(createElement(FocusPanel, student()));
    await act(async () => {});
    expect(screen.getByText('최신 집중 안내 응답을 확인할 수 없습니다.')).toBeTruthy();
    expect(screen.queryByText('현재 서버 확인 결과: 자율 집중 안내 꺼짐')).toBeNull();
  });
});
