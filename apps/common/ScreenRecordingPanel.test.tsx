import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScreenRecordingPanel } from './ScreenRecordingPanel.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('never opens the picker or enables recording before server policy approval', async () => {
  const getDisplayMedia = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          enabled: false,
          reason: 'POLICY_NOT_CONFIGURED',
          persistentStorage: false,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
  render(createElement(ScreenRecordingPanel, { onInvalid: vi.fn() }));
  const button = screen.getByRole('button', { name: '화면 선택·공유·녹화 시작 (정책 승인 대기)' });
  expect(button).toHaveProperty('disabled', true);
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('button', { name: '실제 녹화 정책 확인' }));
  await screen.findByRole('status');
  expect(getDisplayMedia).not.toHaveBeenCalled();
  expect(button).toHaveProperty('disabled', true);
});
it('does not accept an unimplemented enabled response as authorization', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ enabled: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
  render(createElement(ScreenRecordingPanel, { onInvalid: vi.fn() }));
  fireEvent.click(screen.getByRole('button', { name: '실제 녹화 정책 확인' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('계약이 없습니다');
  expect(
    screen.getByRole('button', { name: '화면 선택·공유·녹화 시작 (정책 승인 대기)' }),
  ).toHaveProperty('disabled', true);
});
