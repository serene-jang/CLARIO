import { useCallback, useEffect, useRef, useState } from 'react';
import type { IdentityClassroom, IdentitySession, IdentityUser } from '@clario/shared';
import { loadGoogle } from './google-login.js';
import { errorMessage, requestJson, RequestError } from './web-api.js';
import './school.css';
import TeacherClassrooms from './TeacherClassrooms.js';

export default function IdentityWorkspace({
  audience,
  apiBase,
  onLegacy,
  onDemo,
  allowGoogle = true,
}: {
  audience: 'teacher' | 'student';
  apiBase: string;
  onLegacy?: () => void;
  onDemo?: () => void;
  allowGoogle?: boolean;
}) {
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailMode, setEmailMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [classrooms, setClassrooms] = useState<IdentityClassroom[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const googleButton = useRef<HTMLDivElement>(null);
  const nameRef = useRef(displayName);
  nameRef.current = displayName;
  const current = useRef(session);
  current.current = session;
  const generation = useRef(0);
  const inFlight = useRef(false);

  const clearSession = useCallback(() => {
    generation.current++;
    current.current = null;
    setSession(null);
    setClassrooms([]);
    setListState('loading');
  }, []);
  const api = useCallback(
    async <T,>(path: string, token?: string, method = 'GET', body?: object) => {
      try {
        return await requestJson<T>(apiBase, path, token, method, body);
      } catch (cause) {
        if (
          cause instanceof RequestError &&
          cause.status === 401 &&
          token &&
          current.current?.token === token
        ) {
          clearSession();
          setError(errorMessage(cause));
        }
        throw cause;
      }
    },
    [apiBase, clearSession],
  );

  useEffect(() => {
    if (session) return;
    let cancelled = false;
    const version = ++generation.current;
    setPreparing(true);
    setEmailEnabled(false);
    setGoogleAvailable(false);
    async function prepare() {
      const config = await api<{ googleClientId: string; emailPassword: boolean }>('/auth/config');
      if (cancelled) return;
      setEmailEnabled(config.emailPassword === true);
      setGoogleAvailable(allowGoogle && Boolean(config.googleClientId));
      if (!allowGoogle || !config.googleClientId) return;
      const challenge = await api<{ challengeId: string; nonce: string }>(
        '/auth/challenge',
        undefined,
        'POST',
        {},
      );
      const google = await loadGoogle();
      if (cancelled || !googleButton.current) return;
      google.accounts.id.initialize({
        client_id: config.googleClientId,
        nonce: challenge.nonce,
        auto_select: false,
        callback: ({ credential }) => {
          if (cancelled || version !== generation.current || inFlight.current) return;
          if (!nameRef.current.trim()) {
            setError('표시 이름을 입력해 주세요.');
            return;
          }
          inFlight.current = true;
          setBusy(true);
          setError('');
          void api<IdentitySession>('/identity/auth/google', undefined, 'POST', {
            credential,
            challengeId: challenge.challengeId,
            displayName: nameRef.current,
          })
            .then((result) => {
              if (!cancelled && version === generation.current) {
                setBusy(false);
                setSession(result);
              }
            })
            .catch((cause: unknown) => {
              if (!cancelled && version === generation.current) {
                setError(errorMessage(cause));
                setBusy(false);
                setAttempt((value) => value + 1);
              }
            })
            .finally(() => {
              inFlight.current = false;
            });
        },
      });
      googleButton.current.replaceChildren();
      google.accounts.id.renderButton(googleButton.current, {
        type: 'standard',
        text: 'signin_with',
      });
    }
    void prepare()
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setPreparing(false);
      });
    return () => {
      cancelled = true;
      window.google?.accounts.id.cancel();
    };
  }, [api, attempt, session, allowGoogle]);

  const refresh = useCallback(
    async (login: IdentitySession) => {
      const version = generation.current;
      setListState('loading');
      setClassrooms([]);
      try {
        await api<{ user: IdentityUser }>('/identity/me', login.token);
        const data = await api<{ classrooms: IdentityClassroom[] }>(
          `/identity/classrooms${audience === 'teacher' ? '?includeInactive=true' : ''}`,
          login.token,
        );
        if (current.current?.token !== login.token || version !== generation.current) return;
        setClassrooms(data.classrooms);
        setListState('ready');
      } catch (cause) {
        if (version === generation.current) {
          setError(errorMessage(cause));
          setListState('error');
        }
      }
    },
    [api, audience],
  );

  useEffect(() => {
    if (!session) return;
    void refresh(session);
    const delay = Math.max(0, new Date(session.expiresAt).getTime() - Date.now());
    const timeout = window.setTimeout(() => {
      clearSession();
      setError('로그인이 만료되었습니다. 다시 로그인해 주세요.');
    }, delay);
    return () => window.clearTimeout(timeout);
  }, [clearSession, refresh, session]);

  async function logout() {
    if (!session || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/identity/logout', session.token, 'POST', {});
      window.google?.accounts.id.disableAutoSelect();
      clearSession();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function emailLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !emailEnabled) return;
    if (emailMode === 'register' && password !== passwordConfirmation) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    inFlight.current = true;
    const version = generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await api<IdentitySession>(
        `/identity/auth/email/${emailMode}`,
        undefined,
        'POST',
        {
          email,
          password,
          ...(emailMode === 'register' ? { displayName } : {}),
        },
      );
      if (version === generation.current) setSession(result);
    } catch (cause) {
      if (version === generation.current) setError(errorMessage(cause));
    } finally {
      setPassword('');
      setPasswordConfirmation('');
      setBusy(false);
      inFlight.current = false;
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <span className="brand">CLARIO</span>
        <span>{audience === 'teacher' ? '교사 공간' : '학생 공간'}</span>
      </header>
      <section className="welcome-panel school-workspace" aria-labelledby="identity-title">
        <h1 id="identity-title">{session ? '내 교실' : 'CLARIO 가입·로그인'}</h1>
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        {!session ? (
          <>
            <p>
              누구나 {allowGoogle ? 'Google 계정 또는 ' : ''}이메일·비밀번호로 가입할 수 있습니다.
              학교 API 연동, 학교 이메일이나 관리자 사전 승인은 필요하지 않습니다.
            </p>
            {onDemo && (
              <div className="message" role="note">
                서버·Google 로그인 설정 없이 둘러보려면 데모를 이용하세요. 데모는 예시 화면이며
                계정, 교실, 학생 데이터를 만들거나 저장하지 않습니다.
                <button type="button" disabled={busy} onClick={onDemo}>
                  로그인 없이 데모 체험
                </button>
              </div>
            )}
            <label>
              표시 이름
              <input
                maxLength={100}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                disabled={busy}
                autoComplete="name"
              />
            </label>
            <p>
              가입할 때 표시 이름을 저장합니다. 계정 가입은 학교 소속이나 교사 자격을 증명하지
              않습니다. 본인이 만든 교실만 관리할 수 있습니다.
            </p>
            <section aria-label="이메일 계정">
              <button
                type="button"
                disabled={busy}
                aria-pressed={emailMode === 'login'}
                onClick={() => {
                  setEmailMode('login');
                  setError('');
                  setPassword('');
                  setPasswordConfirmation('');
                }}
              >
                이메일 로그인
              </button>
              <button
                type="button"
                disabled={busy}
                aria-pressed={emailMode === 'register'}
                onClick={() => {
                  setEmailMode('register');
                  setError('');
                  setPassword('');
                  setPasswordConfirmation('');
                }}
              >
                이메일 회원가입
              </button>
              <form onSubmit={(event) => void emailLogin(event)}>
                <label>
                  이메일
                  <input
                    type="email"
                    autoComplete="username"
                    maxLength={254}
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  비밀번호
                  <input
                    type="password"
                    autoComplete={emailMode === 'register' ? 'new-password' : 'current-password'}
                    minLength={12}
                    maxLength={128}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={busy}
                  />
                </label>
                {emailMode === 'register' && (
                  <label>
                    비밀번호 확인
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={128}
                      required
                      value={passwordConfirmation}
                      onChange={(event) => setPasswordConfirmation(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                )}
                <p>
                  비밀번호는 12~128자입니다. 이메일 인증·비밀번호 재설정은 아직 제공하지 않습니다.
                  Google 계정과 이메일 계정은 자동 연결되지 않습니다.
                </p>
                <button
                  type="submit"
                  disabled={
                    busy || !emailEnabled || (emailMode === 'register' && !displayName.trim())
                  }
                >
                  {emailMode === 'register' ? '계정 만들기' : '이메일로 로그인'}
                </button>
              </form>
            </section>
            {preparing && <p role="status">로그인 설정을 확인하고 있습니다.</p>}
            <div ref={googleButton} aria-label="Google 로그인" aria-busy={busy} />
            {!preparing && !googleAvailable && emailEnabled && (
              <p>
                {allowGoogle
                  ? 'Google 로그인은 준비 중입니다.'
                  : '이번 MVP는 외부 로그인 없이 동작합니다.'}{' '}
                이메일로 바로 가입·로그인할 수 있습니다.
              </p>
            )}
            {busy && <p role="status">계정 요청을 처리하고 있습니다.</p>}
            <button
              disabled={busy || preparing}
              onClick={() => {
                setError('');
                setAttempt((value) => value + 1);
              }}
            >
              로그인 다시 준비
            </button>
            {onLegacy && (
              <button disabled={busy} onClick={onLegacy}>
                기존 작업공간 로그인·계정 연결
              </button>
            )}
          </>
        ) : (
          <>
            <p>
              {session.user.name} · <span>{session.user.email}</span>
            </p>
            <button disabled={busy} onClick={() => void logout()}>
              로그아웃
            </button>
            <button
              disabled={busy || listState === 'loading'}
              onClick={() => {
                setError('');
                void refresh(session);
              }}
            >
              새로 확인
            </button>
            {listState === 'loading' && <p role="status">교실 정보를 확인하고 있습니다.</p>}
            {listState === 'error' && <p>교실 정보를 확인할 수 없습니다. 다시 시도해 주세요.</p>}
            {listState === 'ready' && classrooms.length === 0 && <p>참여한 교실이 없습니다.</p>}
            {audience !== 'teacher' && listState === 'ready' && (
              <ul className="workspace-list">
                {classrooms.map((classroom) => (
                  <li key={classroom.id}>
                    <span>{classroom.name}</span>
                    <span>{classroom.role === 'manager' ? '교실 관리자' : '학생으로 참여'}</span>
                  </li>
                ))}
              </ul>
            )}
            {audience === 'teacher' ? (
              <TeacherClassrooms
                apiBase={apiBase}
                key={session.token}
                token={session.token}
                api={api}
                classrooms={classrooms}
                canCreate={session.capabilities.canCreateClassroom}
                loading={listState === 'loading'}
                onChanged={() => void refresh(session)}
              />
            ) : (
              <p className="capability-note">
                교실 생성과 초대코드 참여는 다음 단계에서 제공됩니다. 학생 기본 앱은 별도의 무로그인
                참여 화면을 사용합니다.
              </p>
            )}
            {audience !== 'teacher' && session.capabilities.canCreateClassroom && (
              <p>
                교실 생성 기능이 제공되면 본인 교실을 만들 수 있습니다. 현재 교실 관리 권한을 받은
                것은 아닙니다.
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
