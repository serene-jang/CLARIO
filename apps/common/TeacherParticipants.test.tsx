import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TeacherParticipants from './TeacherParticipants.js';
import { RequestError } from './web-api.js';
const participant = {
  id: 'p',
  classroomId: 'class',
  name: 'Synthetic',
  studentNumber: '001',
  status: 'approved',
  credentialGeneration: 2,
  approvedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  rosterMatch: 'match',
  connectionState: 'unavailable',
};
const page = { participants: [participant], total: 51, page: 1, pageSize: 50 };
afterEach(cleanup);
describe('teacher participant administration', () => {
  it('confirms an erasure request even for a closed classroom and labels only policy-pending, not deletion success', async () => {
    const held = {
      ...participant,
      status: 'blocked',
      credentialGeneration: 3,
      erasureRequestedAt: new Date().toISOString(),
    };
    const api = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ participant: held })
      .mockResolvedValueOnce({ ...page, participants: [held], total: 1 });
    render(
      createElement(TeacherParticipants, {
        classroomId: 'class',
        closed: true,
        token: 'token',
        api,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    await screen.findByText('Synthetic · 학번 001');
    fireEvent.click(screen.getByRole('button', { name: '학생 삭제 요청 001' }));
    expect(screen.getByText(/실제 개인정보·감사·백업 삭제는 수행하지 않습니다/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '확인하고 삭제 요청 접수' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByLabelText('대상 학생과 기존 자격·연결 종료를 확인했습니다'));
    fireEvent.click(screen.getByRole('button', { name: '확인하고 삭제 요청 접수' }));
    await screen.findByText('개인정보 삭제 요청 · 정책 승인 대기 · 접근 철회됨 · 원본·백업 미삭제');
    expect(api.mock.calls[1]).toEqual([
      '/identity/classrooms/class/participants/p/request-erasure',
      'token',
      'POST',
      { confirm: true, expectedGeneration: 2 },
    ]);
    expect(screen.queryByRole('button', { name: '학생 삭제 요청 001' })).toBeNull();
    expect(screen.getByText(/정책 승인 대기이며 원본·백업 삭제 완료가 아닙니다/)).toBeTruthy();
  });
  it('reports a saved action separately from a failed readback and blocks actions on stale data', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({
        participant: { ...participant, status: 'removed', credentialGeneration: 3 },
      })
      .mockRejectedValueOnce(new Error('목록 연결 실패'));
    render(
      createElement(TeacherParticipants, {
        classroomId: 'class',
        closed: false,
        token: 'token',
        api,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    await screen.findByText('Synthetic · 학번 001');
    fireEvent.click(screen.getByRole('button', { name: '학생 퇴장 001' }));
    fireEvent.click(screen.getByLabelText('대상 학생과 기존 자격·연결 종료를 확인했습니다'));
    fireEvent.click(screen.getByRole('button', { name: '확인하고 퇴장' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      '학생 관리 작업은 저장되었으나 목록 재확인에 실패했습니다.',
    );
    expect(screen.getByRole('list').textContent).not.toContain('퇴장됨');
    expect(screen.getByText(/마지막 확인 결과/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '학생 차단 001' })).toHaveProperty('disabled', true);
  });
  it('ignores the previous classroom response after switching scope', async () => {
    let resolveOld: (value: unknown) => void = () => {
      throw new Error('Request not started');
    };
    const api = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...page, participants: [], total: 0 });
    const view = render(
      createElement(TeacherParticipants, {
        classroomId: 'old',
        closed: false,
        token: 'token',
        api,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    view.rerender(
      createElement(TeacherParticipants, {
        classroomId: 'new',
        closed: false,
        token: 'token',
        api,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    await screen.findByText('조건에 맞는 참여 학생이 없습니다.');
    await act(async () => {
      resolveOld(page);
    });
    expect(screen.queryByText('Synthetic · 학번 001')).toBeNull();
    expect(api.mock.calls[1][0]).toContain('/classrooms/new/participants');
  });
  it('uses server search/sort/filter pagination and never labels approval as online', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ ...page, participants: [], total: 0 });
    render(
      createElement(TeacherParticipants, {
        classroomId: 'class',
        closed: false,
        token: 'token',
        api,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    await screen.findByText('Synthetic · 학번 001');
    expect(screen.getByText(/실제 연결은 별도 수업 현황에서 확인/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '다음 학생 페이지' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.change(screen.getByLabelText('참여 학생 검색'), { target: { value: '001' } });
    fireEvent.change(screen.getByLabelText('참여 학생 상태'), { target: { value: 'blocked' } });
    fireEvent.change(screen.getByLabelText('참여 학생 정렬'), { target: { value: 'name' } });
    fireEvent.change(screen.getByLabelText('참여 학생 정렬 방향'), { target: { value: 'desc' } });
    fireEvent.submit(screen.getByRole('button', { name: '학생 검색 적용' }).closest('form')!);
    await screen.findByText('조건에 맞는 참여 학생이 없습니다.');
    expect(api.mock.calls[1][0]).toContain(
      'search=001&status=blocked&sort=name&direction=desc&page=1',
    );
  });
  it('requires explicit confirmation, uses expected generation and refreshes only server-confirmed data', async () => {
    const changed = vi.fn();
    const api = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({
        participant: { ...participant, status: 'blocked', credentialGeneration: 3 },
      })
      .mockResolvedValueOnce({
        ...page,
        participants: [{ ...participant, status: 'blocked', credentialGeneration: 3 }],
        total: 1,
      });
    render(
      createElement(TeacherParticipants, {
        classroomId: 'class',
        closed: false,
        token: 'token',
        api,
        onChanged: changed,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    await screen.findByText('Synthetic · 학번 001');
    fireEvent.click(screen.getByRole('button', { name: '학생 차단 001' }));
    expect(api).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '확인하고 차단' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText('대상 학생과 기존 자격·연결 종료를 확인했습니다'));
    fireEvent.click(screen.getByRole('button', { name: '확인하고 차단' }));
    await waitFor(() => expect(screen.getByRole('list').textContent).toContain('차단됨'));
    expect(api.mock.calls[1]).toEqual([
      '/identity/classrooms/class/participants/p/block',
      'token',
      'POST',
      { confirm: true, expectedGeneration: 2 },
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '학생 퇴장 001' })).toBeNull();
  });
  it('clears private data and confirmation on permission loss, but keeps network failures explicit', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error('연결 실패'))
      .mockRejectedValueOnce(new RequestError('권한 없음', 404));
    render(
      createElement(TeacherParticipants, {
        classroomId: 'class',
        closed: false,
        token: 'token',
        api,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    await screen.findByText('Synthetic · 학번 001');
    fireEvent.click(screen.getByRole('button', { name: '학생 퇴장 001' }));
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    expect((await screen.findByRole('alert')).textContent).toContain('연결 실패');
    expect(screen.getByText('Synthetic · 학번 001')).toBeTruthy();
    expect(screen.getByText(/마지막 확인 결과/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('권한 없음'));
    expect(screen.queryByText('Synthetic · 학번 001')).toBeNull();
    expect(screen.queryByRole('group', { name: '학생 관리 확인' })).toBeNull();
  });
  it('does not moderate closed classrooms and invalidates old records after external mutations', async () => {
    const api = vi.fn().mockResolvedValue(page);
    const view = render(
      createElement(TeacherParticipants, {
        classroomId: 'class',
        closed: true,
        token: 'token',
        api,
        revision: 0,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '학생 목록 다시 확인' }));
    await screen.findByText('Synthetic · 학번 001');
    expect(screen.queryByRole('button', { name: '학생 퇴장 001' })).toBeNull();
    view.rerender(
      createElement(TeacherParticipants, {
        classroomId: 'class',
        closed: true,
        token: 'token',
        api,
        revision: 1,
      }),
    );
    await waitFor(() => expect(screen.queryByText('Synthetic · 학번 001')).toBeNull());
  });
});
