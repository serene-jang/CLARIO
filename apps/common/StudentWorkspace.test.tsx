import { createElement, StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudentWorkspace from './StudentWorkspace.js';
vi.mock('./StudentMaterials.js', () => ({ default: () => null }));
vi.mock('./FocusPanel.js', () => ({ default: () => null }));

const fetchMock = vi.fn<typeof fetch>();
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const approved = {
  state: 'participant',
  classroom: { id: 'a', name: 'My classroom' },
  student: { name: '학생', studentNumber: '001' },
  csrfToken: 'csrf',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
let lessonExpiresAt = approved.expiresAt;
beforeEach(() => {
  lessonExpiresAt = approved.expiresAt;
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input).includes('/api/student/lesson')
      ? Promise.resolve(
          json({
            lesson: null,
            observedAt: new Date().toISOString(),
            expiresAt: lessonExpiresAt,
          }),
        )
      : fetchMock(input, init),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('account-free student workspace', () => {
  it('offers a student demo without bypassing or fabricating the real server session', async () => {
    const onDemo = vi.fn();
    fetchMock.mockResolvedValue(json({ state: 'none', joinAvailable: false }));
    render(createElement(StudentWorkspace, { onDemo }));
    fireEvent.click(await screen.findByRole('button', { name: '서버 없이 학생 데모 보기' }));
    expect(onDemo).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(screen.queryByText('예시 승인 후 화면 보기')).toBeNull();
  });
  it('restores correctly when React StrictMode replays mount effects', async () => {
    fetchMock.mockImplementation(async () => json({ state: 'none', joinAvailable: true }));
    render(createElement(StrictMode, null, createElement(StudentWorkspace)));
    expect(await screen.findByLabelText('초대코드')).toBeTruthy();
    expect(screen.getByRole('button', { name: '참여 신청' })).toHaveProperty('disabled', false);
  });
  it('shows code/name/student-number without Google or accounts and enables server-confirmed join', async () => {
    fetchMock.mockResolvedValue(json({ state: 'none', joinAvailable: true }));
    render(createElement(StudentWorkspace));
    expect(await screen.findByLabelText('초대코드')).toBeTruthy();
    expect(screen.getByLabelText('이름')).toBeTruthy();
    expect(screen.getByLabelText('학번')).toBeTruthy();
    expect(screen.queryByLabelText('이메일')).toBeNull();
    expect(screen.queryByText('Google 로그인')).toBeNull();
    expect(screen.getByRole('button', { name: '참여 신청' })).toHaveProperty('disabled', false);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/student/session'))).toBe(
      true,
    );
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('same-origin');
  });
  it('submits code/name/string student number without credentials and shows only own pending state', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ state: 'none', joinAvailable: true }))
      .mockResolvedValueOnce(
        json(
          {
            state: 'request',
            status: 'pending',
            student: approved.student,
            csrfToken: 'pending',
            expiresAt: approved.expiresAt,
          },
          201,
        ),
      );
    render(createElement(StudentWorkspace));
    fireEvent.change(await screen.findByLabelText('초대코드'), {
      target: { value: 'ABCDEFGHJKLM' },
    });
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '학생' } });
    fireEvent.change(screen.getByLabelText('학번'), { target: { value: '001' } });
    fireEvent.submit(screen.getByRole('button', { name: '참여 신청' }).closest('form')!);
    expect(await screen.findByText('교사 승인 대기 중')).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/student/join');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      code: 'ABCDEFGHJKLM',
      name: '학생',
      studentNumber: '001',
      kind: 'join',
    });
    expect(screen.queryByLabelText('초대코드')).toBeNull();
  });
  it('explicitly requests recovery and keeps input after a rate-limit error', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ state: 'none', joinAvailable: true }))
      .mockResolvedValueOnce(json({ error: { message: '100초 후 다시 시도해 주세요.' } }, 429));
    render(createElement(StudentWorkspace));
    fireEvent.change(await screen.findByLabelText('초대코드'), {
      target: { value: 'ABCDEFGHJKLM' },
    });
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: '학생' } });
    fireEvent.change(screen.getByLabelText('학번'), { target: { value: '001' } });
    fireEvent.click(screen.getByLabelText('기존 참여 복구 요청'));
    fireEvent.submit(screen.getByRole('button', { name: '복구 신청' }).closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toContain('100초');
    expect(screen.getByLabelText('학번')).toHaveProperty('value', '001');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).kind).toBe('recovery');
  });
  it('restores only own participation and ends it via cookie + CSRF without exposing a token', async () => {
    fetchMock
      .mockResolvedValueOnce(json(approved))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(createElement(StudentWorkspace));
    expect(await screen.findByText('My classroom')).toBeTruthy();
    expect(screen.getByText(/001/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '참여 종료 · 이 기기 정보 지우기' }));
    expect(await screen.findByLabelText('초대코드')).toBeTruthy();
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Student-CSRF': 'csrf', 'Content-Type': 'application/json' },
    });
    expect(screen.queryByText('My classroom')).toBeNull();
  });
  it('displays server errors without silently presenting an empty or successful result', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: '서버 설정이 필요합니다.' } }, 503));
    render(createElement(StudentWorkspace));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '서버 설정이 필요합니다.',
    );
    expect(screen.queryByLabelText('초대코드')).toBeNull();
    expect(screen.getByRole('button', { name: '다시 확인' })).toBeTruthy();
  });
  it('keeps failed logout visible and private state available for retry', async () => {
    fetchMock
      .mockResolvedValueOnce(json(approved))
      .mockResolvedValueOnce(json({ error: { message: '종료에 실패했습니다.' } }, 500));
    render(createElement(StudentWorkspace));
    await screen.findByText('My classroom');
    fireEvent.click(screen.getByRole('button', { name: '참여 종료 · 이 기기 정보 지우기' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '종료에 실패했습니다.');
    expect(screen.getByText('My classroom')).toBeTruthy();
  });
  it('shows revoked credentials as an explicit recovery requirement rather than Google login', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: '참여 자격이 만료되었습니다.' } }, 401));
    render(createElement(StudentWorkspace));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '참여 자격이 만료되었습니다.',
    );
    expect(screen.getByText(/교사에게.*복구/)).toBeTruthy();
    expect(screen.queryByText('Google 로그인')).toBeNull();
  });
  it('activates an approved request only through its CSRF protected endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          state: 'request',
          status: 'approved',
          student: approved.student,
          csrfToken: 'pending-csrf',
          expiresAt: approved.expiresAt,
        }),
      )
      .mockResolvedValueOnce(json(approved));
    render(createElement(StudentWorkspace));
    fireEvent.click(await screen.findByRole('button', { name: '승인된 수업 연결 확인' }));
    expect(await screen.findByText('My classroom')).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/student/session/activate');
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ 'X-Student-CSRF': 'pending-csrf' });
  });
  it('clears private data at the server expiry without silently renewing a credential', async () => {
    vi.useFakeTimers();
    lessonExpiresAt = new Date(Date.now() + 1000).toISOString();
    fetchMock.mockResolvedValueOnce(
      json({ ...approved, expiresAt: new Date(Date.now() + 1000).toISOString() }),
    );
    render(createElement(StudentWorkspace));
    await act(async () => {});
    expect(screen.getByText('My classroom')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(1001);
    });
    expect(screen.queryByText('My classroom')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('복구');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects an unexpected success-shaped API response instead of inventing participation', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'participant', student: approved.student }));
    render(createElement(StudentWorkspace));
    expect((await screen.findByRole('alert')).textContent).toContain('응답 형식');
    expect(screen.queryByLabelText('초대코드')).toBeNull();
  });
});
