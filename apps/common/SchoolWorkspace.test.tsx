import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SchoolWorkspace from './SchoolWorkspace.js';

const fetchMock = vi.fn<typeof fetch>();
let googleCallback: ((result: { credential: string }) => void) | undefined;
const token = 'a'.repeat(43);
const student = {
  id: 'student-id',
  schoolId: 'school-id',
  name: 'Test Student',
  email: 'student@school.example',
  role: 'student',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  window.google = {
    accounts: {
      id: {
        initialize: ({ callback }) => {
          googleCallback = callback;
        },
        renderButton: (element) => {
          const button = document.createElement('button');
          button.textContent = 'Test-only Google login';
          button.onclick = () => googleCallback?.({ credential: 'test-only-credential' });
          element.append(button);
        },
        cancel: vi.fn(),
        disableAutoSelect: vi.fn(),
      },
    },
  };
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete window.google;
  googleCallback = undefined;
});

function configured(role = 'student') {
  fetchMock.mockImplementation(async (input, options) => {
    const path = String(input);
    if (path.endsWith('/auth/config')) return json({ googleClientId: 'test-client' });
    if (path.endsWith('/auth/challenge')) return json({ challengeId: 'challenge', nonce: 'nonce' });
    if (path.endsWith('/auth/google'))
      return json({
        token,
        user: { ...student, role },
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    if (path.endsWith('/auth/register'))
      return json(
        {
          token,
          user: { ...student, role: 'school_admin', name: 'Workspace Owner' },
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        201,
      );
    if (path.endsWith('/school')) return json({ school: { name: 'Test School' } });
    if (path.endsWith('/classes') && options?.method === 'GET')
      return json({ classes: [{ id: 'class-id', name: 'Class One' }] });
    if (path.endsWith('/users')) return json({ users: [] });
    if (path.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${path}`);
  });
}

describe('school login UI', () => {
  it('shows an explicit configuration error without a fake login button', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            code: 'AUTH_NOT_CONFIGURED',
            message: '학교 로그인 설정이 아직 완료되지 않았습니다.',
          },
        },
        503,
      ),
    );
    render(createElement(SchoolWorkspace, { audience: 'teacher', apiBase: '' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '학교 로그인 설정이 아직 완료되지 않았습니다.',
    );
    expect(screen.queryByText('Test-only Google login')).toBeNull();
    expect(screen.queryByText('등록된 학급이 없습니다.')).toBeNull();
  });
  it('logs students in, sends bearer authentication, lists only returned classes and logs out', async () => {
    configured();
    render(createElement(SchoolWorkspace, { audience: 'student', apiBase: '' }));
    fireEvent.click(await screen.findByText('Test-only Google login'));
    expect(await screen.findByText('Class One')).toBeTruthy();
    expect(screen.queryByText('학급 관리')).toBeNull();
    expect(screen.queryByText('학교 계정 승인')).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([path, options]) =>
          String(path).endsWith('/classes') &&
          new Headers(options?.headers).get('Authorization') === `Bearer ${token}`,
      ),
    ).toBe(true);
    fireEvent.click(screen.getByText('로그아웃'));
    expect(await screen.findByText('CLARIO에 오신 것을 환영합니다')).toBeTruthy();
    expect(screen.queryByText('Class One')).toBeNull();
  });
  it('rejects student accounts on the teacher UI and revokes the issued session', async () => {
    configured();
    render(createElement(SchoolWorkspace, { audience: 'teacher', apiBase: '' }));
    fireEvent.click(await screen.findByText('Test-only Google login'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('역할에 맞는'));
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/auth/logout'))).toBe(true);
    expect(screen.queryByText('Class One')).toBeNull();
  });
  it('creates a personal Google workspace through the explicit signup flow', async () => {
    configured('school_admin');
    render(createElement(SchoolWorkspace, { audience: 'teacher', apiBase: '' }));
    fireEvent.click(await screen.findByText('처음이신가요? 작업공간 만들기'));
    fireEvent.change(screen.getByLabelText('작업공간 이름'), {
      target: { value: 'My Classroom' },
    });
    fireEvent.change(screen.getByLabelText('내 이름'), { target: { value: 'Owner' } });
    fireEvent.click(screen.getByText('Test-only Google login'));
    expect(await screen.findByText('작업공간 구성원 관리')).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([path, options]) =>
          String(path).endsWith('/auth/register') &&
          options?.method === 'POST' &&
          JSON.stringify(JSON.parse(String(options.body))) ===
            JSON.stringify({
              credential: 'test-only-credential',
              challengeId: 'challenge',
              workspaceName: 'My Classroom',
              ownerName: 'Owner',
            }),
      ),
    ).toBe(true);
  });
  it('does not display a false empty class list when loading fails', async () => {
    configured();
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).endsWith('/classes')
        ? json({ error: { message: 'DB 연결 실패' } }, 500)
        : implementation(input, options),
    );
    render(createElement(SchoolWorkspace, { audience: 'student', apiBase: '' }));
    fireEvent.click(await screen.findByText('Test-only Google login'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'DB 연결 실패');
    expect(screen.queryByText(/등록된 학급이 없습니다/)).toBeNull();
    expect(screen.getByText(/학교·학급 정보를 확인할 수 없습니다/)).toBeTruthy();
  });
  it('clears private class data when a session is revoked', async () => {
    configured();
    render(createElement(SchoolWorkspace, { audience: 'student', apiBase: '' }));
    fireEvent.click(await screen.findByText('Test-only Google login'));
    expect(await screen.findByText('Class One')).toBeTruthy();
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).endsWith('/classes')
        ? json({ error: { message: '로그인이 만료되었습니다.' } }, 401)
        : implementation(input, options),
    );
    fireEvent.click(screen.getByText('새로 확인'));
    expect(await screen.findByText('CLARIO에 오신 것을 환영합니다')).toBeTruthy();
    expect(screen.queryByText('Class One')).toBeNull();
  });
  it('creates teacher classrooms through the API rather than optimistic fake data', async () => {
    configured('teacher');
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).endsWith('/classes') && options?.method === 'POST'
        ? json({ id: 'created-class' }, 201)
        : implementation(input, options),
    );
    render(createElement(SchoolWorkspace, { audience: 'teacher', apiBase: '' }));
    fireEvent.click(await screen.findByText('Test-only Google login'));
    fireEvent.change(await screen.findByLabelText('새 학급 이름'), {
      target: { value: 'New Class' },
    });
    fireEvent.click(screen.getByText('학급 만들기'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('학급을 만들었습니다.'),
    );
    expect(
      fetchMock.mock.calls.some(
        ([path, options]) =>
          String(path).endsWith('/classes') &&
          options?.method === 'POST' &&
          options.body === JSON.stringify({ name: 'New Class' }),
      ),
    ).toBe(true);
  });
  it('opens device registration only after loading the selected class members', async () => {
    configured('teacher');
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/classes/class-id/members')) return json({ members: [student] });
      if (String(input).endsWith('/classes/class-id/devices')) return json({ devices: [] });
      if (String(input).endsWith('/classes/class-id/materials')) return json({ materials: [] });
      if (String(input).endsWith('/classes/class-id/focus')) return json({ enabled: false });
      return implementation(input, options);
    });
    render(createElement(SchoolWorkspace, { audience: 'teacher', apiBase: '' }));
    fireEvent.click(await screen.findByText('Test-only Google login'));
    fireEvent.click(await screen.findByText('학급 관리'));
    expect(await screen.findByLabelText('기기를 사용할 학생')).toBeTruthy();
    expect(await screen.findByText('등록된 기기가 없습니다.')).toBeTruthy();
  });
});
