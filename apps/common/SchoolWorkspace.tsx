import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { CurrentUser, UserRole } from '@clario/shared';
import './school.css';
import DeviceRegistry from './DeviceRegistry.js';

interface Classroom {
  id: string;
  name: string;
}
interface Member {
  id: string;
  email: string;
  name: string;
}
interface Account extends Member {
  role: UserRole;
  active: boolean;
  hasLoggedIn: boolean;
}
interface Login {
  token: string;
  user: CurrentUser;
  expiresAt: string;
}
interface GoogleApi {
  accounts: {
    id: {
      initialize(options: {
        client_id: string;
        nonce: string;
        auto_select: boolean;
        callback: (result: { credential: string }) => void;
      }): void;
      renderButton(element: HTMLElement, options: { type: string; text: string }): void;
      disableAutoSelect(): void;
      cancel(): void;
    };
  };
}
declare global {
  interface Window {
    google?: GoogleApi;
  }
}

let googleScript: Promise<GoogleApi> | undefined;
function loadGoogle() {
  if (window.google) return Promise.resolve(window.google);
  if (!googleScript) {
    googleScript = new Promise<GoogleApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      const timeout = window.setTimeout(() => {
        script.remove();
        reject(new Error('Google 로그인 연결 시간이 초과되었습니다.'));
      }, 15000);
      script.onload = () => {
        window.clearTimeout(timeout);
        if (window.google) resolve(window.google);
        else reject(new Error('Google 로그인 도구를 불러오지 못했습니다.'));
      };
      script.onerror = () => {
        window.clearTimeout(timeout);
        script.remove();
        reject(new Error('Google 로그인 연결에 실패했습니다. 네트워크를 확인해 주세요.'));
      };
      document.head.append(script);
    }).catch((cause: unknown) => {
      googleScript = undefined;
      throw cause;
    });
  }
  return googleScript;
}

class RequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '요청 처리에 실패했습니다.';

export default function SchoolWorkspace({
  audience,
  apiBase,
}: {
  audience: 'teacher' | 'student';
  apiBase: string;
}) {
  const [login, setLogin] = useState<Login | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [school, setSchool] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [signupMode, setSignupMode] = useState(false);
  const workspaceNameRef = useRef(workspaceName);
  const ownerNameRef = useRef(ownerName);
  const signupModeRef = useRef(signupMode);
  workspaceNameRef.current = workspaceName;
  ownerNameRef.current = ownerName;
  signupModeRef.current = signupMode;
  const [classes, setClasses] = useState<Classroom[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<Classroom | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [dataState, setDataState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [memberState, setMemberState] = useState<'loading' | 'ready' | 'error'>('loading');
  const googleButton = useRef<HTMLDivElement>(null);
  const selectionVersion = useRef(0);
  const loginVersion = useRef(0);
  const currentLogin = useRef<Login | null>(null);
  currentLogin.current = login;

  const api = useCallback(
    async <T,>(path: string, token?: string, method = 'GET', body?: object): Promise<T> => {
      if (apiBase) {
        const url = new URL(apiBase);
        if (
          url.origin !== apiBase ||
          (url.protocol !== 'https:' &&
            !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
        )
          throw new Error('API 주소 설정이 올바르지 않습니다.');
      }
      const response = await fetch(`${apiBase}/api${path}`, {
        method,
        credentials: 'omit',
        signal: AbortSignal.timeout(15000),
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }).catch(() => {
        throw new RequestError(
          '서버에 연결할 수 없습니다. 네트워크와 API 주소를 확인해 주세요.',
          0,
        );
      });
      if (response.status === 204) return undefined as T;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        throw new Error('학교 API에 연결되지 않았습니다. API 주소와 서버 설정을 확인해 주세요.');
      }
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401 && token && currentLogin.current?.token === token) {
          loginVersion.current++;
          setLogin(null);
          setClasses([]);
          setAccounts([]);
          setMembers([]);
          setSelected(null);
        }
        throw new RequestError(data.error?.message ?? '요청 처리에 실패했습니다.', response.status);
      }
      return data as T;
    },
    [apiBase],
  );

  useEffect(() => {
    if (login) return;
    let cancelled = false;
    const version = ++loginVersion.current;
    setPreparing(true);
    async function prepare() {
      const config = await api<{ googleClientId: string }>('/auth/config');
      if (!config.googleClientId) throw new Error('Google 로그인 설정이 없습니다.');
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
          if (cancelled || loginVersion.current !== version) return;
          const creatingWorkspace = signupModeRef.current && audience === 'teacher';
          if (
            creatingWorkspace &&
            (!workspaceNameRef.current.trim() || !ownerNameRef.current.trim())
          ) {
            setError('작업공간 이름과 내 이름을 입력해 주세요.');
            return;
          }
          setBusy(true);
          setError('');
          void api<Login>(
            creatingWorkspace ? '/auth/register' : '/auth/google',
            undefined,
            'POST',
            {
              credential,
              challengeId: challenge.challengeId,
              ...(creatingWorkspace
                ? {
                    workspaceName: workspaceNameRef.current,
                    ownerName: ownerNameRef.current,
                  }
                : {}),
            },
          )
            .then(async (result) => {
              if (cancelled || loginVersion.current !== version) return;
              const allowed =
                audience === 'student'
                  ? result.user.role === 'student'
                  : result.user.role !== 'student';
              if (!allowed) {
                await api('/auth/logout', result.token, 'POST', {});
                throw new Error('이 계정의 역할에 맞는 교사 또는 학생 사이트를 이용해 주세요.');
              }
              setLogin(result);
              setNotice(
                creatingWorkspace
                  ? '작업공간을 만들고 관리자 계정으로 가입했습니다.'
                  : '로그인했습니다.',
              );
            })
            .catch((cause: unknown) => {
              if (!cancelled) {
                setError(errorMessage(cause));
                setAttempt((value) => value + 1);
              }
            })
            .finally(() => {
              if (!cancelled) setBusy(false);
            });
        },
      });
      googleButton.current.replaceChildren();
      google.accounts.id.renderButton(googleButton.current, {
        type: 'standard',
        text: 'continue_with',
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
  }, [api, audience, login, attempt]);

  const refresh = useCallback(
    async (session: Login) => {
      setDataState('loading');
      try {
        const [schoolResult, classResult, accountResult] = await Promise.all([
          api<{ school: { name: string } }>('/school', session.token),
          api<{ classes: Classroom[] }>('/classes', session.token),
          session.user.role === 'school_admin'
            ? api<{ users: Account[] }>('/users', session.token)
            : Promise.resolve({ users: [] }),
        ]);
        if (currentLogin.current?.token !== session.token) return;
        setSchool(schoolResult.school.name);
        setClasses(classResult.classes);
        setAccounts(accountResult.users);
        setDataState('ready');
      } catch (cause) {
        if (currentLogin.current?.token === session.token) {
          setDataState('error');
          setClasses([]);
          setAccounts([]);
          setSelected(null);
          setMembers([]);
        }
        throw cause;
      }
    },
    [api],
  );

  useEffect(() => {
    if (!login) return;
    setBusy(false);
    setError('');
    void refresh(login).catch((cause: unknown) => setError(errorMessage(cause)));
    const timeout = window.setTimeout(
      () => {
        loginVersion.current++;
        setLogin(null);
        setClasses([]);
        setAccounts([]);
        setSelected(null);
        setMembers([]);
        setNotice('');
        setError('로그인이 만료되었습니다. 다시 로그인해 주세요.');
      },
      Math.max(0, Date.parse(login.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [login, refresh]);

  async function run(work: () => Promise<void>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(message);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function submit(
    event: FormEvent<HTMLFormElement>,
    work: (data: FormData, session: Login) => Promise<void>,
    message: string,
  ) {
    event.preventDefault();
    if (!login || busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(async () => {
      await work(data, login);
      form.reset();
      await refresh(login);
    }, message);
  }
  async function selectClass(classroom: Classroom) {
    if (!login) return;
    const version = ++selectionVersion.current;
    const session = login;
    setSelected(classroom);
    setMembers([]);
    setMemberState('loading');
    await run(async () => {
      try {
        const result = await api<{ members: Member[] }>(
          `/classes/${classroom.id}/members`,
          session.token,
        );
        if (version === selectionVersion.current && currentLogin.current?.token === session.token) {
          setMembers(result.members);
          setMemberState('ready');
        }
      } catch (cause) {
        if (version === selectionVersion.current) setMemberState('error');
        throw cause;
      }
    }, '');
  }
  const admin = login?.user.role === 'school_admin';

  return (
    <main className="page-shell">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          aria-label={`CLARIO ${audience === 'teacher' ? '교사' : '학생'} 홈`}
        >
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span>CLARIO</span>
        </a>
        <span className="environment-label">
          {admin ? '작업공간 관리자' : audience === 'teacher' ? '교사 공간' : '학생 공간'}
        </span>
      </header>
      <section className="welcome-panel school-workspace" aria-labelledby="page-title">
        <p className="eyebrow">
          {audience === 'teacher' ? 'TEACHER WORKSPACE' : 'STUDENT WORKSPACE'}
        </p>
        <h1 id="page-title">
          {login ? school || '작업공간 확인 중' : 'CLARIO에 오신 것을 환영합니다'}
        </h1>
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="message" role="status">
            {notice}
          </p>
        )}
        {!login ? (
          <>
            <p className="intro">
              {audience === 'teacher'
                ? 'Google 계정으로 로그인하거나 새 작업공간을 만드세요. 학교 계정이나 학교 관리자 권한은 필요하지 않습니다.'
                : '작업공간 관리자가 등록한 Google 계정으로 로그인하세요. 학교 계정 도메인 일치는 필요하지 않습니다.'}
            </p>
            {audience === 'teacher' && signupMode && (
              <section className="workspace-card" aria-label="새 작업공간 만들기">
                <label>
                  작업공간 이름
                  <input
                    required
                    maxLength={100}
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    placeholder="예: 우리 교실"
                  />
                </label>
                <label>
                  내 이름
                  <input
                    required
                    maxLength={100}
                    value={ownerName}
                    onChange={(event) => setOwnerName(event.target.value)}
                    autoComplete="name"
                  />
                </label>
                <p>
                  작업공간 생성자는 관리자 권한을 가지며, 구성원 초대와 학급 관리를 할 수 있습니다.
                </p>
              </section>
            )}
            {preparing && <p role="status">로그인 설정을 확인하고 있습니다.</p>}
            <div ref={googleButton} aria-label="Google 계정 로그인 또는 가입" aria-busy={busy} />
            <button
              type="button"
              disabled={busy || preparing}
              onClick={() => {
                setError('');
                setAttempt((value) => value + 1);
              }}
            >
              로그인 다시 준비
            </button>
            {audience === 'teacher' && (
              <button
                type="button"
                disabled={
                  busy || preparing || (signupMode && (!workspaceName.trim() || !ownerName.trim()))
                }
                onClick={() => {
                  setError('');
                  setSignupMode((value) => !value);
                }}
              >
                {signupMode ? '기존 작업공간에 로그인' : '처음이신가요? 작업공간 만들기'}
              </button>
            )}
            <p className="capability-note">
              새로고침하거나 창을 닫으면 다시 로그인해야 합니다. 화면 확인·녹화는 아직 제공하지
              않습니다. Google 가입 시 학교 소속이나 신원은 검증되지 않으며, 공용 링크는 초대한
              구성원에게만 공유하세요.
            </p>
          </>
        ) : (
          <>
            <div className="account-line">
              <p>
                {login.user.name} · {login.user.email}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api('/auth/logout', login.token, 'POST', {});
                    window.google?.accounts.id.disableAutoSelect();
                    loginVersion.current++;
                    setLogin(null);
                    setSchool('');
                    setClasses([]);
                    setAccounts([]);
                    setSelected(null);
                    setMembers([]);
                  }, '로그아웃했습니다.')
                }
              >
                로그아웃
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await refresh(login);
                    setSelected(null);
                    setMembers([]);
                  }, '최신 정보를 확인했습니다.')
                }
              >
                새로 확인
              </button>
            </div>
            {dataState === 'loading' && <p role="status">학교·학급 정보를 확인하고 있습니다.</p>}
            {dataState === 'error' && (
              <p>학교·학급 정보를 확인할 수 없습니다. 새로 확인을 눌러 다시 시도해 주세요.</p>
            )}
            {admin && dataState === 'ready' && (
              <section className="workspace-card" aria-labelledby="users-title">
                <h2 id="users-title">작업공간 구성원 관리</h2>
                <p>
                  Google 이메일을 등록해 교사·학생을 초대합니다. 초대 메일은 자동 발송하지 않으므로
                  본인에게 안전하게 전달하세요.
                </p>
                <form
                  onSubmit={(event) =>
                    void submit(
                      event,
                      async (data, session) => {
                        await api('/users', session.token, 'POST', Object.fromEntries(data));
                      },
                      '계정 등록을 승인했습니다.',
                    )
                  }
                >
                  <label>
                    이름
                    <input name="name" required maxLength={100} />
                  </label>
                  <label>
                    Google 이메일
                    <input name="email" type="email" required maxLength={254} />
                  </label>
                  <label>
                    역할
                    <select name="role">
                      <option value="student">학생</option>
                      <option value="teacher">교사</option>
                    </select>
                  </label>
                  <button disabled={busy}>계정 승인</button>
                </form>
                <ul className="workspace-list">
                  {accounts.map((account) => (
                    <li key={account.id}>
                      <span>
                        {account.name} · {account.email} ·{' '}
                        {account.role === 'teacher'
                          ? '교사'
                          : account.role === 'student'
                            ? '학생'
                            : '관리자'}{' '}
                        ·{' '}
                        {account.active
                          ? account.hasLoggedIn
                            ? '로그인 이력 있음'
                            : '첫 로그인 대기'
                          : '이용 중지'}
                      </span>
                      {account.role !== 'school_admin' && (
                        <>
                          <button
                            disabled={busy}
                            type="button"
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `${account.name} 계정의 이용 상태를 변경하고 모든 세션을 종료할까요?`,
                                )
                              )
                                return;
                              void run(async () => {
                                await api(`/users/${account.id}`, login.token, 'PATCH', {
                                  role: account.role,
                                  active: !account.active,
                                });
                                await refresh(login);
                              }, '계정 상태를 변경했습니다.');
                            }}
                          >
                            {account.active ? '이용 중지' : '이용 허용'}
                          </button>
                          <button
                            disabled={busy}
                            type="button"
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `${account.name} 계정의 교사·학생 역할을 변경하고 모든 세션을 종료할까요?`,
                                )
                              )
                                return;
                              void run(async () => {
                                await api(`/users/${account.id}`, login.token, 'PATCH', {
                                  role: account.role === 'teacher' ? 'student' : 'teacher',
                                  active: account.active,
                                });
                                await refresh(login);
                              }, '계정 역할을 변경했습니다.');
                            }}
                          >
                            역할 변경
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {dataState === 'ready' && (
              <section className="workspace-card" aria-labelledby="classes-title">
                <h2 id="classes-title">
                  {audience === 'student' ? '내 학급' : admin ? '학교 학급' : '담당 학급'}
                </h2>
                {login.user.role === 'teacher' && (
                  <form
                    onSubmit={(event) =>
                      void submit(
                        event,
                        async (data, session) => {
                          await api('/classes', session.token, 'POST', { name: data.get('name') });
                        },
                        '학급을 만들었습니다.',
                      )
                    }
                  >
                    <label>
                      새 학급 이름
                      <input name="name" required maxLength={100} />
                    </label>
                    <button disabled={busy}>학급 만들기</button>
                  </form>
                )}
                {classes.length === 0 && (
                  <p>
                    등록된 학급이 없습니다.
                    {audience === 'student' && ' 담당 교사에게 학급 등록을 요청해 주세요.'}
                  </p>
                )}
                <ul className="workspace-list">
                  {classes.map((classroom) => (
                    <li key={classroom.id}>
                      <span>{classroom.name}</span>
                      {audience === 'teacher' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void selectClass(classroom)}
                        >
                          학급 관리
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {selected && audience === 'teacher' && dataState === 'ready' && (
              <section className="workspace-card" aria-labelledby="selected-title">
                <h2 id="selected-title">{selected.name}</h2>
                <form
                  key={selected.id}
                  onSubmit={(event) =>
                    void submit(
                      event,
                      async (data, session) => {
                        await api(`/classes/${selected.id}`, session.token, 'PATCH', {
                          name: data.get('name'),
                        });
                        setSelected({ ...selected, name: String(data.get('name')) });
                      },
                      '학급 이름을 변경했습니다.',
                    )
                  }
                >
                  <label>
                    학급 이름
                    <input name="name" defaultValue={selected.name} maxLength={100} required />
                  </label>
                  <button disabled={busy}>이름 변경</button>
                </form>
                <form
                  onSubmit={(event) =>
                    void submit(
                      event,
                      async (data, session) => {
                        await api(`/classes/${selected.id}/members`, session.token, 'POST', {
                          email: data.get('email'),
                        });
                        const result = await api<{ members: Member[] }>(
                          `/classes/${selected.id}/members`,
                          session.token,
                        );
                        setMembers(result.members);
                      },
                      '학생을 학급에 등록했습니다.',
                    )
                  }
                >
                  <label>
                    승인된 학생 이메일
                    <input name="email" type="email" required maxLength={254} />
                  </label>
                  <button disabled={busy}>학생 등록</button>
                </form>
                <p>
                  기기 연결은 아래 등록 기기의 서버 수신 상태를 확인하세요. 학생 명부만으로는 온라인
                  여부를 알 수 없습니다.
                </p>
                {memberState === 'loading' && <p role="status">등록 학생을 확인하고 있습니다.</p>}
                {memberState === 'error' && (
                  <p>등록 학생을 확인할 수 없습니다. 학급 관리를 다시 눌러 주세요.</p>
                )}
                {memberState === 'ready' && members.length === 0 && (
                  <p>표시할 등록 학생이 없습니다.</p>
                )}
                <ul className="workspace-list">
                  {members.map((member) => (
                    <li key={member.id}>
                      <span>
                        {member.name} · {member.email}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `${member.name} 학생을 이 학급에서 제외하고 해당 기기 등록도 해제할까요?`,
                            )
                          )
                            return;
                          void run(async () => {
                            await api(
                              `/classes/${selected.id}/members/${member.id}`,
                              login.token,
                              'DELETE',
                            );
                            setMembers((current) =>
                              current.filter((item) => item.id !== member.id),
                            );
                          }, '학생을 학급에서 제외했습니다.');
                        }}
                      >
                        등록 해제
                      </button>
                    </li>
                  ))}
                </ul>
                {memberState === 'ready' && (
                  <DeviceRegistry
                    key={`${login.token}:${selected.id}`}
                    classId={selected.id}
                    token={login.token}
                    members={members}
                    api={api}
                  />
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        '학급을 보관하고 기기 명부 등록도 해제할까요? 학급 목록에서 제외됩니다.',
                      )
                    )
                      return;
                    void run(async () => {
                      await api(`/classes/${selected.id}`, login.token, 'DELETE');
                      setSelected(null);
                      setMembers([]);
                      await refresh(login);
                    }, '학급을 보관 처리했습니다.');
                  }}
                >
                  학급 보관
                </button>
              </section>
            )}
          </>
        )}
      </section>
      <footer>CLARIO · 학교 기기 관리 · 화면 확인 및 녹화 미제공</footer>
    </main>
  );
}
