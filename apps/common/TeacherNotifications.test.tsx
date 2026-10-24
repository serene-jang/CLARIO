import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TeacherNotifications from './TeacherNotifications.js';
import { RequestError } from './web-api.js';

const props = { classroomId: 'class', token: 'teacher', closed: false };
const actual = {
  id: 'real',
  action: 'student.join_requested',
  kind: 'actual',
  createdAt: new Date().toISOString(),
};
const test = {
  id: 'test',
  action: 'notification.test.screen_difference',
  kind: 'test',
  createdAt: new Date().toISOString(),
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('distinguishes real processing from teacher-created test events and reads back server state', async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce({ notifications: [actual] })
    .mockResolvedValueOnce({ test: true })
    .mockResolvedValueOnce({ notifications: [test, actual] });
  render(<TeacherNotifications {...props} api={api} />);
  expect(await screen.findByText('실제 처리 기록')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '화면 비교 테스트 이벤트 생성' }));
  expect(await screen.findByText('테스트 · 실제 감지 아님')).toBeTruthy();
  expect(screen.getByText(/실제 화면을 비교하지 않았습니다/)).toBeTruthy();
  expect(api.mock.calls[1]).toEqual([
    '/identity/classrooms/class/notifications/test',
    'teacher',
    'POST',
    { event: 'screen_difference' },
  ]);
  expect(api.mock.calls[2][0]).toBe('/identity/classrooms/class/notifications');
});

it('keeps empty/loading/error states explicit and removes private data on authority loss', async () => {
  const api = vi
    .fn()
    .mockResolvedValueOnce({ notifications: [] })
    .mockResolvedValueOnce({ notifications: [actual] })
    .mockRejectedValueOnce(new RequestError('권한 없음', 404));
  render(<TeacherNotifications {...props} api={api} />);
  expect(screen.getByText('교사 알림을 확인하고 있습니다.')).toBeTruthy();
  expect(await screen.findByText('아직 교사 알림이 없습니다.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '알림 다시 확인' }));
  await screen.findByText('실제 처리 기록');
  fireEvent.click(screen.getByRole('button', { name: '알림 다시 확인' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '권한 없음');
  expect(screen.queryByText('실제 처리 기록')).toBeNull();
  expect(
    screen.getByRole('button', { name: '입력 감지 테스트 이벤트 생성' }).closest('fieldset'),
  ).toHaveProperty('disabled', true);
});

it('polls server updates and preserves failures as stale rather than successful monitoring', async () => {
  vi.useFakeTimers();
  const api = vi
    .fn()
    .mockResolvedValueOnce({ notifications: [actual] })
    .mockRejectedValue(new Error('네트워크 연결 실패'));
  render(<TeacherNotifications {...props} api={api} />);
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByRole('alert').textContent).toContain('네트워크 연결 실패');
  expect(screen.getByText(/알림 서버 확인 불가/)).toBeTruthy();
  expect(screen.getByText('실제 처리 기록')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: '화면 비교 테스트 이벤트 생성' }).closest('fieldset'),
  ).toHaveProperty('disabled', true);
});
