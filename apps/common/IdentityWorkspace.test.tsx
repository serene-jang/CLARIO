import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IdentityWorkspace from './IdentityWorkspace.js';

const fetchMock = vi.fn<typeof fetch>();
let callback: ((value: { credential: string }) => void) | undefined;
const token = 'i'.repeat(43);
const user = { id: 'identity-id', name: 'New student', email: 'new@gmail.com' };
const session = {
  token,
  user,
  capabilities: { canCreateClassroom: true },
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  window.google = {
    accounts: {
      id: {
        initialize: (options) => {
          callback = options.callback;
        },
        renderButton: (element) => {
          const button = document.createElement('button');
          button.textContent = 'Google test login';
          button.onclick = () => callback?.({ credential: 'test-credential' });
          element.append(button);
        },
        cancel: vi.fn(),
        disableAutoSelect: vi.fn(),
      },
    },
  };
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/config'))
      return json({ googleClientId: 'test-client', emailPassword: true });
    if (url.endsWith('/auth/challenge'))
      return json({ challengeId: 'test-challenge', nonce: 'test-nonce' });
    if (url.endsWith('/identity/auth/google')) return json(session);
    if (url.endsWith('/identity/me')) return json({ user, capabilities: session.capabilities });
    if (url.split('?')[0].endsWith('/identity/classrooms')) return json({ classrooms: [] });
    if (url.endsWith('/identity/logout')) return new Response(null, { status: 204 });
    throw new Error('Unexpected request: ' + url);
  });
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete window.google;
  callback = undefined;
});

async function login() {
  fireEvent.change(screen.getByLabelText('표시 이름'), { target: { value: 'New student' } });
  fireEvent.click(await screen.findByText('Google test login'));
}

describe('independent identity UI', () => {
  it('never initializes external Google login when running the email-only MVP', async () => {
    render(<IdentityWorkspace audience="teacher" apiBase="" allowGoogle={false} />);
    expect(await screen.findByText(/이번 MVP는 외부 로그인 없이 동작합니다/)).toBeTruthy();
    expect(screen.queryByText('Google test login')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/challenge'))).toBe(
      false,
    );
    expect(screen.getByRole('button', { name: '이메일로 로그인' })).toHaveProperty(
      'disabled',
      false,
    );
  });
  it('registers with email when Google is unconfigured and uses the real persisted session', async () => {
    const previous = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/auth/config'))
        return json({ googleClientId: '', emailPassword: true });
      if (String(input).endsWith('/identity/auth/email/register')) return json(session, 201);
      return previous(input, options);
    });
    render(<IdentityWorkspace audience="teacher" apiBase="" />);
    fireEvent.click(screen.getByRole('button', { name: '이메일 회원가입' }));
    fireEvent.change(screen.getByLabelText('표시 이름'), {
      target: { value: 'Independent teacher' },
    });
    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'new@gmail.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'A secure password 123' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호 확인'), {
      target: { value: 'A secure password 123' },
    });
    const submit = screen.getByRole('button', { name: '계정 만들기' });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    expect(await screen.findByText('new@gmail.com')).toBeTruthy();
    expect(await screen.findByText('참여한 교실이 없습니다.')).toBeTruthy();
    const sent = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/identity/auth/email/register'),
    );
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
      email: 'new@gmail.com',
      password: 'A secure password 123',
      displayName: 'Independent teacher',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/challenge'))).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/school'))).toBe(false);
  });

  it('does not submit mismatched confirmation and shows server login failures without a fake session', async () => {
    const previous = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).endsWith('/identity/auth/email/login')
        ? json({ error: { message: '이메일 또는 비밀번호가 올바르지 않습니다.' } }, 401)
        : previous(input, options),
    );
    render(<IdentityWorkspace audience="teacher" apiBase="" />);
    await screen.findByText('Google test login');
    fireEvent.click(screen.getByRole('button', { name: '이메일 회원가입' }));
    fireEvent.change(screen.getByLabelText('표시 이름'), { target: { value: 'Teacher' } });
    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'teacher@example.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'A secure password 123' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호 확인'), {
      target: { value: 'A different password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '계정 만들기' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '비밀번호 확인이 일치하지 않습니다.',
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/identity/auth/email/register')),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '이메일 로그인' }));
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'A wrong password 123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '이메일 또는 비밀번호가 올바르지 않습니다.',
    );
    expect(screen.queryByText('내 교실')).toBeNull();
    expect((screen.getByLabelText('비밀번호') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: '이메일로 로그인' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('logs in with email without requiring a display name and clears the session on logout', async () => {
    const previous = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).endsWith('/identity/auth/email/login')
        ? json(session)
        : previous(input, options),
    );
    render(<IdentityWorkspace audience="teacher" apiBase="" />);
    await screen.findByText('Google test login');
    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'new@gmail.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'A secure password 123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }));
    expect(await screen.findByText('new@gmail.com')).toBeTruthy();
    const sent = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/identity/auth/email/login'),
    );
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
      email: 'new@gmail.com',
      password: 'A secure password 123',
    });
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByLabelText('비밀번호')).toHaveProperty('value', '');
    expect(screen.queryByText('내 교실')).toBeNull();
  });

  it('signs in a new student without workspace/password/role fields and does not fake classroom participation', async () => {
    render(createElement(IdentityWorkspace, { audience: 'student', apiBase: '' }));
    await login();
    expect(await screen.findByText('new@gmail.com')).toBeTruthy();
    expect(await screen.findByText('참여한 교실이 없습니다.')).toBeTruthy();
    expect(screen.getByText(/교실 생성과 초대코드 참여는 다음 단계/)).toBeTruthy();
    const sent = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/identity/auth/google'),
    );
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
      credential: 'test-credential',
      challengeId: 'test-challenge',
      displayName: 'New student',
    });
    expect(screen.queryByLabelText('작업공간 이름')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/school'))).toBe(false);
    fireEvent.click(screen.getByText('로그아웃'));
    expect(await screen.findByLabelText('표시 이름')).toBeTruthy();
    expect(screen.queryByText('new@gmail.com')).toBeNull();
  });

  it('uses classroom roles returned by the server rather than the selected app role', async () => {
    const previous = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).split('?')[0].endsWith('/identity/classrooms')
        ? json({ classrooms: [{ id: 'a', name: 'My class', role: 'student' }] })
        : previous(input, options),
    );
    render(createElement(IdentityWorkspace, { audience: 'teacher', apiBase: '' }));
    await login();
    expect(await screen.findByText('My class')).toBeTruthy();
    expect(screen.getByText('학생으로 참여')).toBeTruthy();
    expect(screen.queryByText('교실 관리자')).toBeNull();
  });

  it('shows real configuration and list errors without false empty or successful states', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            message: 'Google 로그인과 데이터베이스 설정이 필요합니다.',
          },
        },
        503,
      ),
    );
    const first = render(createElement(IdentityWorkspace, { audience: 'student', apiBase: '' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Google 로그인과 데이터베이스 설정이 필요합니다.',
    );
    expect(screen.queryByText('Google test login')).toBeNull();
    first.unmount();
  });

  it('offers an explicit local demo after server configuration fails without creating a fake login', async () => {
    const onDemo = vi.fn();
    fetchMock.mockResolvedValue(
      json({ error: { message: 'Google 로그인과 데이터베이스 설정이 필요합니다.' } }, 503),
    );
    render(createElement(IdentityWorkspace, { audience: 'teacher', apiBase: '', onDemo }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Google 로그인과 데이터베이스 설정이 필요합니다.',
    );
    fireEvent.click(screen.getByRole('button', { name: '로그인 없이 데모 체험' }));
    expect(onDemo).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.every(([url]) => !String(url).endsWith('/identity/auth/google')),
    ).toBe(true);
    expect(screen.queryByText('미리보기 사용자')).toBeNull();
  });

  it('clears classroom data when the session expires and on remote revocation', async () => {
    let revoked = false;
    const previous = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      if (String(input).endsWith('/identity/classrooms')) {
        return revoked
          ? json({ error: { message: '세션이 만료되었습니다.' } }, 401)
          : json({ classrooms: [{ id: 'a', name: 'Private class', role: 'student' }] });
      }
      return previous(input, options);
    });
    render(createElement(IdentityWorkspace, { audience: 'student', apiBase: '' }));
    await login();
    expect(await screen.findByText('Private class')).toBeTruthy();
    revoked = true;
    fireEvent.click(screen.getByText('새로 확인'));
    await waitFor(() => expect(screen.queryByText('Private class')).toBeNull());
    expect(await screen.findByLabelText('표시 이름')).toBeTruthy();
  });

  it('keeps a failed logout visible and allows retry rather than claiming revocation', async () => {
    const previous = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) =>
      String(input).endsWith('/identity/logout')
        ? json({ error: { message: '로그아웃 처리에 실패했습니다.' } }, 500)
        : previous(input, options),
    );
    render(createElement(IdentityWorkspace, { audience: 'teacher', apiBase: '' }));
    await login();
    expect(await screen.findByText('new@gmail.com')).toBeTruthy();
    fireEvent.click(screen.getByText('로그아웃'));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '로그아웃 처리에 실패했습니다.',
    );
    expect(screen.getByText('new@gmail.com')).toBeTruthy();
  });
});
