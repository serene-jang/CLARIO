import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeacherClassrooms from './TeacherClassrooms.js';
import type { ManagedClassroom } from '@clario/shared';
vi.mock('./TeacherLesson.js', () => ({ default: () => null }));
vi.mock('./TeacherMaterials.js', () => ({ default: () => null }));
vi.mock('./FocusPanel.js', () => ({ default: () => null }));
vi.mock('./TeacherRequests.js', () => ({ default: () => null }));
vi.mock('./TeacherParticipants.js', () => ({ default: () => null }));
vi.mock('./TeacherNotifications.js', () => ({ default: () => null }));
vi.mock('./DashboardRecordingPanel.js', () => ({ default: () => null }));

const classroom: ManagedClassroom = {
  id: 'class-id',
  name: 'Test classroom',
  capacity: 40,
  approvalRequired: true,
  closedAt: null,
  archivedAt: null,
  invitation: {
    id: 'invite-id',
    status: 'active',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  },
  roster: [],
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('teacher classroom management UI', () => {
  it('creates a classroom, shows the one-time code, and never stores it in browser persistence', async () => {
    const api = vi.fn().mockResolvedValue({
      classroom,
      invitation: {
        id: 'invite-id',
        code: 'ABCDEFGHJKLM',
        expiresAt: classroom.invitation.expiresAt,
      },
    });
    render(
      createElement(TeacherClassrooms, {
        token: 'token',
        api,
        classrooms: [],
        onChanged: vi.fn(),
        canCreate: true,
        loading: false,
      }),
    );
    fireEvent.change(screen.getByLabelText('새 교실 이름'), {
      target: { value: 'Test classroom' },
    });
    fireEvent.click(screen.getByRole('button', { name: '교실 만들기' }));
    expect(await screen.findByText('ABCDEFGHJKLM')).toBeTruthy();
    expect(api.mock.calls[0]).toEqual([
      '/identity/classrooms',
      'token',
      'POST',
      { name: 'Test classroom', capacity: 40 },
    ]);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '코드 숨기기' }));
    expect(screen.queryByText('ABCDEFGHJKLM')).toBeNull();
  });
  it('does not expose management controls for student roles', () => {
    render(
      createElement(TeacherClassrooms, {
        token: 'token',
        api: vi.fn(),
        classrooms: [{ id: 'a', name: 'Read only', role: 'student' }],
        onChanged: vi.fn(),
        canCreate: false,
        loading: false,
      }),
    );
    expect(screen.getByText('Read only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /관리 열기/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '교실 만들기' })).toBeNull();
  });
  it('shows errors instead of issuing a fake code or deleting roster state', async () => {
    const api = vi.fn().mockRejectedValue(new Error('서버 저장 실패'));
    render(
      createElement(TeacherClassrooms, {
        token: 'token',
        api,
        classrooms: [],
        onChanged: vi.fn(),
        canCreate: true,
        loading: false,
      }),
    );
    fireEvent.change(screen.getByLabelText('새 교실 이름'), { target: { value: 'Failed' } });
    fireEvent.click(screen.getByRole('button', { name: '교실 만들기' }));
    expect((await screen.findByRole('alert')).textContent).toContain('서버 저장 실패');
    expect(screen.queryByText('코드 숨기기')).toBeNull();
  });
  it('opens settings and saves roster entries as strings without claiming automatic approval', async () => {
    const withRoster = {
      ...classroom,
      roster: [{ id: 'entry', name: 'Roster student', studentNumber: '001' }],
    };
    const api = vi
      .fn()
      .mockResolvedValueOnce({ classroom })
      .mockResolvedValueOnce({ classroom: withRoster })
      .mockResolvedValueOnce({ classroom });
    render(
      createElement(TeacherClassrooms, {
        token: 'token',
        api,
        classrooms: [{ id: classroom.id, name: classroom.name, role: 'manager' }],
        canCreate: true,
        loading: false,
        onChanged: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test classroom 관리 열기' }));
    await screen.findByLabelText('명단 학생 이름');
    fireEvent.change(screen.getByLabelText('명단 학생 이름'), {
      target: { value: 'Roster student' },
    });
    fireEvent.change(screen.getByLabelText('명단 학번'), { target: { value: '001' } });
    fireEvent.click(screen.getByRole('button', { name: '명단 추가' }));
    expect(await screen.findByText('Roster student · 001')).toBeTruthy();
    expect(api.mock.calls[1]).toEqual([
      '/identity/classrooms/class-id/roster',
      'token',
      'POST',
      { name: 'Roster student', studentNumber: '001' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '명단 삭제 · 001' }));
    expect(await screen.findByText('등록된 명단이 없습니다.')).toBeTruthy();
  });
  it('requires confirmation for rotation and closure, hides the old code, and disables closed-class mutations', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        classroom,
        invitation: {
          id: 'invite-id',
          code: 'ABCDEFGHJKLM',
          expiresAt: classroom.invitation.expiresAt,
        },
      })
      .mockResolvedValueOnce({
        classroom: {
          ...classroom,
          closedAt: new Date().toISOString(),
          invitation: { ...classroom.invitation, status: 'revoked' },
        },
      });
    render(
      createElement(TeacherClassrooms, {
        token: 'token',
        api,
        classrooms: [],
        canCreate: true,
        loading: false,
        onChanged: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByLabelText('새 교실 이름'), {
      target: { value: 'Test classroom' },
    });
    fireEvent.click(screen.getByRole('button', { name: '교실 만들기' }));
    await screen.findByText('ABCDEFGHJKLM');
    fireEvent.click(screen.getByRole('button', { name: '코드 재발급' }));
    expect(screen.queryByText('ABCDEFGHJKLM')).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByRole('button', { name: '교실 종료' }));
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '확인하고 실행' }));
    expect(await screen.findByText(/종료된 교실/)).toBeTruthy();
    expect(api.mock.calls[1][0]).toBe('/identity/classrooms/class-id/close');
    expect(screen.queryByRole('button', { name: '코드 재발급' })).toBeNull();
    expect(screen.queryByLabelText('명단 학생 이름')).toBeNull();
  });
  it('retains a roster on failed deletion and hides plaintext during every request', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        classroom: {
          ...classroom,
          roster: [{ id: 'entry', name: 'Private roster', studentNumber: '001' }],
        },
      })
      .mockRejectedValueOnce(new Error('명단 삭제 실패'));
    render(
      createElement(TeacherClassrooms, {
        token: 'token',
        api,
        classrooms: [{ id: classroom.id, name: classroom.name, role: 'manager' }],
        canCreate: false,
        loading: false,
        onChanged: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test classroom 관리 열기' }));
    fireEvent.click(await screen.findByRole('button', { name: '명단 삭제 · 001' }));
    expect((await screen.findByRole('alert')).textContent).toBe('명단 삭제 실패');
    expect(screen.getByText('Private roster · 001')).toBeTruthy();
    expect(screen.getByText(/마지막으로 확인한 정보/)).toBeTruthy();
  });
  it('hides an expired one-time code and marks it expired rather than live', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    const api = vi.fn().mockResolvedValue({
      classroom: { ...classroom, invitation: { ...classroom.invitation, expiresAt } },
      invitation: { id: 'invite-id', code: 'ABCDEFGHJKLM', expiresAt },
    });
    render(
      createElement(TeacherClassrooms, {
        token: 'token',
        api,
        classrooms: [],
        canCreate: true,
        loading: false,
        onChanged: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByLabelText('새 교실 이름'), {
      target: { value: 'Test classroom' },
    });
    fireEvent.click(screen.getByRole('button', { name: '교실 만들기' }));
    await act(async () => {});
    expect(screen.getByText('ABCDEFGHJKLM')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(1001);
    });
    expect(screen.queryByText('ABCDEFGHJKLM')).toBeNull();
    expect(screen.getByText(/코드 상태: 만료/)).toBeTruthy();
  });
});
