import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeacherLesson from './TeacherLesson.js';
import { RequestError } from './web-api.js';
const snapshot = {
  lesson: { id: 'lesson', startedAt: new Date().toISOString() },
  observedAt: new Date().toISOString(),
  students: [
    {
      id: 'p',
      name: 'Student',
      studentNumber: '001',
      state: 'online',
      lastSeenAt: new Date().toISOString(),
    },
  ],
  counts: { online: 1, reconnecting: 0, offline: 0 },
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('teacher live lesson', () => {
  it('keeps an explicit end confirmation through background snapshots of the same lesson', async () => {
    vi.useFakeTimers();
    const api = vi.fn().mockResolvedValue(snapshot);
    render(createElement(TeacherLesson, { classroomId: 'class', closed: false, token: 't', api }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '수업 종료 준비' }));
    fireEvent.click(
      screen.getByLabelText('현재 수업 종료와 초대코드·대기 신청 폐기를 확인했습니다'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('button', { name: '확인하고 수업 종료' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('polls current data every five seconds and labels a server failure unknown instead of offline', async () => {
    vi.useFakeTimers();
    const api = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error('네트워크 실패'));
    render(createElement(TeacherLesson, { classroomId: 'class', closed: false, token: 't', api }));
    await act(async () => {});
    expect(screen.getByText('Student · 학번 001')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('alert').textContent).toContain('네트워크 실패');
    expect(screen.getByText(/서버 상태 확인 불가/)).toBeTruthy();
    expect(screen.getByText(/마지막 확인 결과/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '수업 종료 준비' })).toHaveProperty('disabled', true);
  });
  it('requires explicit session end and clears private data when current authority is lost', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new RequestError('권한 없음', 404));
    render(createElement(TeacherLesson, { classroomId: 'class', closed: false, token: 't', api }));
    await screen.findByText('Student · 학번 001');
    fireEvent.click(screen.getByRole('button', { name: '수업 종료 준비' }));
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByLabelText('현재 수업 종료와 초대코드·대기 신청 폐기를 확인했습니다'),
    );
    fireEvent.click(screen.getByRole('button', { name: '확인하고 수업 종료' }));
    expect((await screen.findByRole('alert')).textContent).toContain('권한 없음');
    expect(screen.queryByText('Student · 학번 001')).toBeNull();
    expect(screen.queryByRole('group', { name: '수업 종료 확인' })).toBeNull();
    expect(api.mock.calls[1]).toEqual([
      '/identity/classrooms/class/lesson/end',
      't',
      'POST',
      { sessionId: 'lesson', confirm: true },
    ]);
  });
});
