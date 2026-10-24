import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeacherMaterials from './TeacherMaterials.js';
import { RequestError } from './web-api.js';
const snapshot = {
  materials: [
    {
      id: 'material',
      title: 'Lesson link',
      url: 'https://example.test/lesson',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      receivedAt: null,
      openedAt: null,
      receivedCount: 1,
      openedCount: 0,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
  observedAt: new Date().toISOString(),
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const props = { classroomId: 'class', closed: false, token: 'teacher' };
describe('teacher materials', () => {
  it('selects approved students from the server and sends only their identifiers', async () => {
    const api = vi.fn().mockImplementation(async (path: string) =>
      path.includes('/participants')
        ? {
            participants: [{ id: 'student-1', name: 'First', studentNumber: '001' }],
            total: 1,
            pageSize: 50,
          }
        : snapshot,
    );
    render(<TeacherMaterials {...props} api={api} />);
    await screen.findByText('Lesson link');
    fireEvent.change(screen.getByLabelText('배포 대상'), { target: { value: 'selected' } });
    expect(await screen.findByLabelText('First · 학번 001')).toBeTruthy();
    expect(screen.getByRole('button', { name: '자료 등록' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText('First · 학번 001'));
    fireEvent.change(screen.getByLabelText('자료 제목'), { target: { value: 'Only selected' } });
    fireEvent.change(screen.getByLabelText('HTTPS 자료 주소'), {
      target: { value: 'https://example.test/selected' },
    });
    fireEvent.click(screen.getByRole('button', { name: '자료 등록' }));
    await screen.findByText('자료를 등록했습니다.');
    expect(api.mock.calls.find((call) => call[2] === 'POST')).toEqual([
      '/identity/classrooms/class/materials',
      'teacher',
      'POST',
      {
        title: 'Only selected',
        url: 'https://example.test/selected',
        participantIds: ['student-1'],
      },
    ]);
  });
  it('blocks selected delivery when recipient loading fails and never falls back to everyone', async () => {
    const api = vi.fn().mockImplementation(async (path: string) => {
      if (path.includes('/participants')) throw new Error('대상 조회 실패');
      return snapshot;
    });
    render(<TeacherMaterials {...props} api={api} />);
    await screen.findByText('Lesson link');
    fireEvent.change(screen.getByLabelText('배포 대상'), { target: { value: 'selected' } });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '대상 조회 실패');
    expect(screen.getByRole('button', { name: '자료 등록' })).toHaveProperty('disabled', true);
    expect(api.mock.calls.some((call) => call[2] === 'POST')).toBe(false);
  });
  it('registers HTTPS links, re-reads actual saved state and requires explicit delete confirmation', async () => {
    const api = vi.fn().mockResolvedValue(snapshot);
    render(createElement(TeacherMaterials, { ...props, api }));
    await screen.findByText('Lesson link');
    fireEvent.change(screen.getByLabelText('자료 제목'), { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText('HTTPS 자료 주소'), {
      target: { value: 'https://example.test/new' },
    });
    fireEvent.submit(screen.getByRole('button', { name: '자료 등록' }).closest('form')!);
    await screen.findByText('자료를 등록했습니다.');
    expect(api.mock.calls[1]).toEqual([
      '/identity/classrooms/class/materials',
      'teacher',
      'POST',
      { title: 'New', url: 'https://example.test/new' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '자료 삭제 준비 Lesson link' }));
    expect(api.mock.calls.filter((c) => c[2] === 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '확인하고 자료 삭제' }));
    await screen.findByText('자료를 삭제했습니다.');
    expect(api.mock.calls.some((c) => c[0].endsWith('/material') && c[2] === 'DELETE')).toBe(true);
  });
  it('polls receipts without treating them as reading and disables stale mutations on failure', async () => {
    vi.useFakeTimers();
    const api = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValue(new Error('Network unavailable'));
    render(createElement(TeacherMaterials, { ...props, api }));
    await act(async () => {});
    expect(screen.getByText(/목록 수신 1명 · 열기 요청 0명/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole('alert').textContent).toContain('Network unavailable');
    expect(screen.getByText(/자료 서버 확인 불가/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '자료 등록' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '자료 삭제 준비 Lesson link' })).toHaveProperty(
      'disabled',
      true,
    );
  });
  it('keeps already-saved changes explicit when readback fails and clears data on authority loss', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ id: 'new' })
      .mockRejectedValueOnce(new Error('Readback failed'))
      .mockRejectedValueOnce(new RequestError('Permission lost', 404));
    render(createElement(TeacherMaterials, { ...props, api }));
    await screen.findByText('Lesson link');
    fireEvent.submit(screen.getByRole('button', { name: '자료 등록' }).closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toContain('변경은 저장되었지만');
    fireEvent.click(screen.getByRole('button', { name: '자료 목록 다시 확인' }));
    await screen.findByText('Permission lost');
    expect(screen.queryByText('Lesson link')).toBeNull();
  });
  it('paginates and prevents an old classroom response from replacing a new classroom', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    const api = vi
      .fn()
      .mockResolvedValueOnce({ ...snapshot, total: 51 })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue({ ...snapshot, materials: [], total: 0, page: 2 });
    const rendered = render(createElement(TeacherMaterials, { ...props, api }));
    await screen.findByText('Lesson link');
    fireEvent.click(screen.getByRole('button', { name: '다음 자료 페이지' }));
    rendered.rerender(createElement(TeacherMaterials, { ...props, classroomId: 'other', api }));
    await act(async () => {
      resolveOld(snapshot);
    });
    expect(screen.queryByText('Lesson link')).toBeNull();
    expect(
      api.mock.calls.some((c) => c[0].startsWith('/identity/classrooms/other/materials')),
    ).toBe(true);
  });
});
