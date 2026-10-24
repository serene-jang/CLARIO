import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeacherRequests from './TeacherRequests.js';
import { RequestError } from './web-api.js';
const item = {
  id: 'request',
  kind: 'recovery',
  status: 'pending',
  name: 'Synthetic',
  studentNumber: '001',
  rosterMatch: 'match',
  existingStatus: 'approved',
  expired: false,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1800000).toISOString(),
};
afterEach(cleanup);
describe('teacher request review', () => {
  it('searches and sorts the loaded request page and invalidates it after a participant moderation change', async () => {
    const api = vi.fn().mockResolvedValue({
      requests: [item, { ...item, id: 'two', name: 'Other', studentNumber: '002', kind: 'join' }],
    });
    const view = render(
      createElement(TeacherRequests, {
        classroomId: 'class',
        closed: false,
        token: 'token',
        api,
        revision: 0,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '신청 목록 다시 확인' }));
    await screen.findByText('Synthetic · 학번 001');
    fireEvent.change(screen.getByLabelText('참여 신청 검색'), { target: { value: '002' } });
    expect(screen.queryByText('Synthetic · 학번 001')).toBeNull();
    expect(screen.getByText('Other · 학번 002')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('참여 신청 정렬'), { target: { value: 'name' } });
    view.rerender(
      createElement(TeacherRequests, {
        classroomId: 'class',
        closed: false,
        token: 'token',
        api,
        revision: 1,
      }),
    );
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Other · 학번 002')).toBeTruthy();
  });
  it('removes private list and confirmation when current classroom permission is denied', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ requests: [item] })
      .mockRejectedValueOnce(new RequestError('권한 없음', 404));
    render(
      createElement(TeacherRequests, { classroomId: 'class', closed: false, token: 'token', api }),
    );
    fireEvent.click(screen.getByRole('button', { name: '신청 목록 다시 확인' }));
    await screen.findByText('Synthetic · 학번 001');
    fireEvent.click(screen.getByRole('button', { name: '복구 승인 001' }));
    fireEvent.click(screen.getByRole('button', { name: '신청 목록 다시 확인' }));
    expect((await screen.findByRole('alert')).textContent).toContain('권한 없음');
    expect(screen.queryByText('Synthetic · 학번 001')).toBeNull();
    expect(screen.queryByRole('group', { name: '학생 승인 확인' })).toBeNull();
  });
  it('requires explicit recovery confirmation and uses the server response after approval', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ requests: [item] })
      .mockResolvedValueOnce({ requests: [{ ...item, status: 'approved' }] });
    render(
      createElement(TeacherRequests, { classroomId: 'class', closed: false, token: 'token', api }),
    );
    fireEvent.click(screen.getByRole('button', { name: '신청 목록 다시 확인' }));
    expect(await screen.findByText('Synthetic · 학번 001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '복구 승인 001' }));
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '본인을 확인했으며 이전 자격과 연결 종료에 동의합니다',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '확인하고 승인' }));
    expect(await screen.findByText(/승인됨 · 만료/)).toBeTruthy();
    expect(api.mock.calls[1]).toEqual([
      '/identity/classrooms/class/requests/request/approve',
      'token',
      'POST',
      { confirmRecovery: true },
    ]);
  });
  it('keeps prior data with explicit error and never shows fake approval', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ requests: [{ ...item, kind: 'join', existingStatus: null }] })
      .mockRejectedValueOnce(new Error('정원 초과'));
    render(
      createElement(TeacherRequests, { classroomId: 'class', closed: false, token: 'token', api }),
    );
    fireEvent.click(screen.getByRole('button', { name: '신청 목록 다시 확인' }));
    await screen.findByText('Synthetic · 학번 001');
    fireEvent.click(screen.getByRole('button', { name: '참여 승인 001' }));
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '본인을 확인했으며 이전 자격과 연결 종료에 동의합니다',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '확인하고 승인' }));
    expect((await screen.findByRole('alert')).textContent).toContain('정원 초과');
    expect(screen.queryByText(/승인됨 · 만료/)).toBeNull();
  });
});
