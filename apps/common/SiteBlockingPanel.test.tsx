import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SiteBlockingPanel } from './SiteBlockingPanel.js';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('saves teacher domain lists without claiming actual browser application', async () => {
  const api = vi.fn().mockResolvedValue({ configuredDomains: ['example.com'], active: true });
  render(createElement(SiteBlockingPanel, { classroomId: 'class', token: 'teacher', api }));
  expect(api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '사이트 차단 설정 열기' }));
  await screen.findByLabelText('차단 도메인 (한 줄에 하나)');
  fireEvent.change(screen.getByLabelText('차단 도메인 (한 줄에 하나)'), {
    target: { value: 'example.com\nschool.example' },
  });
  fireEvent.click(screen.getByRole('button', { name: '차단 도메인 저장' }));
  await screen.findByRole('button', { name: '차단 정책 다시 확인' });
  expect(api.mock.calls[1]).toEqual([
    '/identity/classrooms/class/blocking',
    'teacher',
    'PATCH',
    { domains: ['example.com', 'school.example'] },
  ]);
  expect(screen.getByText(/실제 적용 여부는 확장 팝업/)).toBeTruthy();
});
it('issues student extension credentials with CSRF but does not identify a connected browser as a managed physical device', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      json({ code: 'A'.repeat(32), expiresAt: new Date(Date.now() + 300000).toISOString() }),
    );
  vi.stubGlobal('fetch', fetch);
  render(createElement(SiteBlockingPanel, { csrfToken: 'csrf' }));
  fireEvent.click(
    screen.getByRole('button', { name: '확장 연결 코드 발급 (기존 확장 연결 철회)' }),
  );
  await screen.findByText('A'.repeat(32));
  expect(fetch.mock.calls[0]).toEqual([
    '/api/student/browser-code',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: '{}',
      headers: { 'Content-Type': 'application/json', 'X-Student-CSRF': 'csrf' },
    }),
  ]);
  expect(screen.queryByRole('button', { name: '차단 도메인 저장' })).toBeNull();
});
