import { useEffect, useRef, useState } from 'react';
import { errorMessage, RequestError } from './web-api.js';

export function ScreenRecordingPanel({ onInvalid }: { onInvalid: (message: string) => void }) {
  const [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const version = useRef(0);
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  async function check() {
    const current = ++version.current;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/student/screen-media', {
        credentials: 'same-origin',
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });
      const data: unknown = await response.json();
      if (!response.ok)
        throw new RequestError('실제 화면 녹화 권한을 확인할 수 없습니다.', response.status);
      if (
        !data ||
        typeof data !== 'object' ||
        !('enabled' in data) ||
        data.enabled !== false ||
        !('reason' in data) ||
        data.reason !== 'POLICY_NOT_CONFIGURED'
      )
        throw new Error('승인된 녹화 정책·저장소 계약이 없습니다. 화면 선택을 시작하지 않습니다.');
      if (current === version.current) {
        setOpened(true);
        setMessage(
          '보관 정책·저장소·열람/삭제 권한 미설정으로 서버가 실제 화면 수집을 차단했습니다.',
        );
      }
    } catch (cause) {
      if (current !== version.current) return;
      setError(errorMessage(cause));
      if (cause instanceof RequestError && [401, 403, 404].includes(cause.status))
        onInvalid(errorMessage(cause));
    } finally {
      if (current === version.current) setBusy(false);
    }
  }
  return (
    <section aria-label="실제 화면 녹화">
      <h3>실제 화면 공유·녹화</h3>
      <p>
        학생이 버튼을 누르고 브라우저에서 화면을 선택·허용해야 녹화할 수 있습니다. 참여 승인은 녹화
        허가가 아닙니다.
      </p>
      <p>
        현재 비활성입니다. 화면 선택·녹화 코드는 준비했지만 서버의 승인 정책과 영구 저장·삭제 연동은
        아직 없습니다. 합성 시험과 별개입니다.
      </p>
      <button disabled={busy} onClick={() => void check()}>
        {opened ? '실제 녹화 정책 다시 확인' : '실제 녹화 정책 확인'}
      </button>
      <button disabled>화면 선택·공유·녹화 시작 (정책 승인 대기)</button>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
