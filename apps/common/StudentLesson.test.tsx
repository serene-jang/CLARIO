import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StudentLesson from './StudentLesson.js';
const view = {
  lesson: { id: '11111111-1111-4111-8111-111111111111', startedAt: new Date().toISOString() },
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('student actual lesson connection', () => {
  it('does not create a connection before a lesson exists and changes its connection id for a new lesson', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ ...view, lesson: null }))
      .mockResolvedValueOnce(json(view))
      .mockResolvedValueOnce(json(view))
      .mockResolvedValueOnce(
        json({ ...view, lesson: { ...view.lesson, id: '22222222-2222-4222-8222-222222222222' } }),
      )
      .mockResolvedValueOnce(
        json({ ...view, lesson: { ...view.lesson, id: '22222222-2222-4222-8222-222222222222' } }),
      );
    vi.stubGlobal('fetch', fetch);
    render(
      createElement(StudentLesson, { csrfToken: 'csrf', onInvalid: vi.fn(), onExpiry: vi.fn() }),
    );
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/진행 중인 수업이 없습니다/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    const first = JSON.parse(fetch.mock.calls[2][1].body);
    expect(first.sequence).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    const next = JSON.parse(fetch.mock.calls[4][1].body);
    expect(next.sequence).toBe(1);
    expect(next.connectionId).not.toBe(first.connectionId);
    expect(next.sessionId).not.toBe(first.sessionId);
  });
  it('discovers then heartbeats with per-tab identifier and increasing sequence without exposing other students', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => json(view));
    vi.stubGlobal('fetch', fetch);
    render(
      createElement(StudentLesson, { csrfToken: 'csrf', onInvalid: vi.fn(), onExpiry: vi.fn() }),
    );
    await act(async () => {});
    expect(screen.getByText(/수업 연결 확인됨/)).toBeTruthy();
    expect(fetch.mock.calls[1][0]).toBe('/api/student/lesson/heartbeat');
    const first = JSON.parse(fetch.mock.calls[1][1].body);
    expect(first).toMatchObject({ sessionId: view.lesson.id, sequence: 1 });
    expect(fetch.mock.calls[1][1]).toMatchObject({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Student-CSRF': 'csrf' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    const next = JSON.parse(fetch.mock.calls[3][1].body);
    expect(next).toMatchObject({ connectionId: first.connectionId, sequence: 2 });
    expect(JSON.stringify(next)).not.toMatch(/participantId|studentNumber|name/);
  });
  it('shows unknown on network failure and clears the lesson on cookie revocation', async () => {
    vi.useFakeTimers();
    const invalid = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(view))
      .mockResolvedValueOnce(json(view))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json({ error: { message: '자격 철회' } }, 401));
    vi.stubGlobal('fetch', fetch);
    render(
      createElement(StudentLesson, { csrfToken: 'csrf', onInvalid: invalid, onExpiry: vi.fn() }),
    );
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText(/서버 상태 확인 불가/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(invalid).toHaveBeenCalledWith('자격 철회');
    expect(screen.queryByText(/수업 연결 확인됨/)).toBeNull();
  });
});
