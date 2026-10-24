import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DashboardRecordingPanel from './DashboardRecordingPanel.js';

const { start } = vi.hoisted(() => ({
  start: vi.fn(),
}));
vi.mock('./dashboard-recordings.js', () => ({
  deleteDashboardRecording: vi.fn(),
  downloadDashboardRecording: vi.fn(),
  listDashboardRecordings: vi.fn().mockResolvedValue([]),
  startDashboardRecording: start,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('does not allow recording outside an active lesson', () => {
  render(
    createElement(DashboardRecordingPanel, {
      classroomId: 'class-1',
      classroomName: '과학',
      lessonActive: false,
    }),
  );

  expect(screen.getByRole('button', { name: '대시보드 녹화 시작' })).toHaveProperty(
    'disabled',
    true,
  );
  expect(start).not.toHaveBeenCalled();
});

it('requires an explicit teacher action, shows active status and stops to save', async () => {
  let finish: (value: { recording: object; stored: boolean }) => void = () => {};
  const completed = new Promise<{ recording: object; stored: boolean }>((resolve) => {
    finish = resolve;
  });
  start.mockResolvedValue({
    completed,
    stop: vi.fn().mockImplementation(async () => {
      const result = { recording: { complete: true }, stored: true };
      finish(result);
      return result;
    }),
  });
  render(
    createElement(DashboardRecordingPanel, {
      classroomId: 'class-1',
      classroomName: '과학',
      lessonActive: true,
    }),
  );

  expect(screen.getByText(/학생 기기 화면을 캡처하거나 전송하지 않습니다/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '대시보드 녹화 시작' }));
  await screen.findByText('녹화 중 · 과학 · 이 탭의 화면만 기록됩니다.');
  expect(start).toHaveBeenCalledWith('class-1', '과학', expect.any(AbortSignal));
  const closeEvent = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closeEvent);
  expect(closeEvent.defaultPrevented).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: '녹화 중지 및 저장' }));
  await screen.findByRole('status');
  expect(await screen.findByText(/녹화 저장 완료/)).toBeTruthy();
});
