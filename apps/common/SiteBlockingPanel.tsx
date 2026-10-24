import { useEffect, useRef, useState } from 'react';
import { errorMessage, RequestError } from './web-api.js';
type Api = <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
type Snapshot = {
  configuredDomains: string[];
  domains?: string[];
  active?: boolean;
  lessonId?: string | null;
  extensionLastSeenAt?: string | null;
};
export function SiteBlockingPanel({
  classroomId,
  token,
  api,
  csrfToken,
  closed = false,
  onInvalid,
}: {
  classroomId?: string;
  token?: string;
  api?: Api;
  csrfToken?: string;
  closed?: boolean;
  onInvalid?: (message: string) => void;
}) {
  const [opened, setOpened] = useState(false),
    [view, setView] = useState<Snapshot | null>(null);
  const [domains, setDomains] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);
  const revision = useRef(0),
    teacher = Boolean(classroomId && token && api);
  useEffect(
    () => () => {
      revision.current++;
    },
    [classroomId, token, csrfToken],
  );
  async function perform(action: 'read' | 'save' | 'code') {
    if (busy) return;
    const version = ++revision.current;
    setBusy(true);
    setError('');
    setIssued(null);
    try {
      if (teacher) {
        const path = `/identity/classrooms/${classroomId}/blocking`;
        if (action === 'save')
          await api!(path, token, 'PATCH', { domains: domains.split(/\s+/).filter(Boolean) });
        const value = await api!<Snapshot>(path, token);
        if (version !== revision.current) return;
        if (
          !Array.isArray(value.configuredDomains) ||
          !value.configuredDomains.every((d) => typeof d === 'string')
        )
          throw new Error('사이트 차단 목록 응답이 올바르지 않습니다.');
        setView(value);
        setDomains(value.configuredDomains.join('\n'));
        setOpened(true);
      } else {
        const response = await fetch(
          `/api/student/${action === 'code' ? 'browser-code' : 'blocking'}`,
          {
            method: action === 'code' ? 'POST' : 'GET',
            credentials: 'same-origin',
            signal: AbortSignal.timeout(5000),
            headers:
              action === 'code'
                ? { 'Content-Type': 'application/json', 'X-Student-CSRF': csrfToken ?? '' }
                : {},
            body: action === 'code' ? '{}' : undefined,
            cache: 'no-store',
          },
        );
        const value = await response.json();
        if (!response.ok)
          throw new RequestError(value.error?.message ?? '확장 연결 요청 실패', response.status);
        if (version !== revision.current) return;
        if (action === 'code') {
          if (typeof value.code !== 'string' || typeof value.expiresAt !== 'string')
            throw new Error('확장 코드 응답이 올바르지 않습니다.');
          setIssued(value);
        } else {
          if (!Array.isArray(value.configuredDomains) || !Array.isArray(value.domains))
            throw new Error('사이트 차단 응답이 올바르지 않습니다.');
          setView(value);
          setOpened(true);
        }
      }
    } catch (cause) {
      if (version !== revision.current) return;
      setView(null);
      setError(errorMessage(cause));
      if (cause instanceof RequestError && [401, 403].includes(cause.status))
        onInvalid?.(errorMessage(cause));
    } finally {
      if (version === revision.current) setBusy(false);
    }
  }
  return (
    <section aria-label={teacher ? '수업 사이트 차단 관리' : '내 브라우저 사이트 차단'}>
      <h3>수업 사이트 차단</h3>
      <p>
        설치·연결된 Chrome 확장에서 지정 도메인과 하위 도메인의 새 페이지/프레임 요청만 차단합니다.
        일반 웹·다른 브라우저·앱·이미 열린 내용은 통제하지 않습니다.
      </p>
      <p>
        확장은 약 30초마다 확인하며 확인 실패 또는 최대 60초 정책 만료 시 해제합니다. 절전/브라우저
        일정에 따라 적용·해제가 지연될 수 있습니다. 강제 설치·삭제 방지는 학교 관리자 정책이 별도로
        필요합니다.
      </p>
      <button disabled={busy} onClick={() => void perform('read')}>
        {opened ? '차단 정책 다시 확인' : '사이트 차단 설정 열기'}
      </button>
      {error && <p role="alert">{error}</p>}
      {opened && view && (
        <>
          <p>
            서버 정책:{' '}
            {(teacher ? view.active : Boolean(view.lessonId))
              ? '활성 수업에 적용 대상'
              : '수업 없음 · 차단 비적용'}{' '}
            · 실제 적용 여부는 확장 팝업에서 확인하세요.
          </p>
          {!teacher && (
            <p>
              확장 마지막 서버 연결:{' '}
              {view.extensionLastSeenAt
                ? new Date(view.extensionLastSeenAt).toLocaleString()
                : '확인된 연결 없음'}{' '}
              · 이것만으로 차단 성공을 뜻하지 않습니다.
            </p>
          )}
          {teacher ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void perform('save');
              }}
            >
              <label>
                차단 도메인 (한 줄에 하나)
                <textarea
                  value={domains}
                  disabled={busy || closed}
                  onChange={(e) => setDomains(e.target.value)}
                />
              </label>
              <p>
                예: example.com · URL/와일드카드/IP 금지 · 최대 50개 · 빈 목록 저장은 차단
                해제입니다.
              </p>
              <button disabled={busy || closed}>차단 도메인 저장</button>
            </form>
          ) : (
            <ul>
              {view.domains?.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {!teacher && (
        <>
          <button disabled={busy} onClick={() => void perform('code')}>
            확장 연결 코드 발급 (기존 확장 연결 철회)
          </button>
          <p>
            교실 초대코드와 다른 5분·일회용 코드입니다. 본인의 승인된 학생 세션을 확장에 연결합니다.
            설치 후 팝업에서 학생 웹 코드 항목을 선택하세요. 다른 사람과 공유하지 마세요.
          </p>
          {issued && (
            <p role="status">
              확장 연결 코드: <code>{issued.code}</code> · 만료{' '}
              {new Date(issued.expiresAt).toLocaleTimeString()}
            </p>
          )}
        </>
      )}
    </section>
  );
}
