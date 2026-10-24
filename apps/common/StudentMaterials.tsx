import { useEffect, useRef, useState } from 'react';
import type { MaterialList } from '@clario/shared';
import { isMaterialList, studentMaterialRequest } from './material-api.js';
import { errorMessage, RequestError } from './web-api.js';

export default function StudentMaterials({
  csrfToken,
  onInvalid,
  onExpiry,
}: {
  csrfToken: string;
  onInvalid: (message: string) => void;
  onExpiry: (expiresAt: string) => void;
}) {
  const [view, setView] = useState<MaterialList | null>(null),
    [page, setPage] = useState(1);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(true);
  const [verified, setVerified] = useState<{ id: string; url: string } | null>(null);
  const version = useRef(0),
    inFlight = useRef(false),
    lastSuccess = useRef(0),
    read = useRef(() => {});
  async function perform(material?: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++version.current;
    setBusy(true);
    setError('');
    setNotice('');
    setVerified(null);
    let verifiedUrl: string | undefined;
    try {
      if (material) {
        const opened = await studentMaterialRequest(`/${material}/open`, csrfToken, {});
        if (current !== version.current) return;
        if (
          !opened ||
          typeof opened !== 'object' ||
          !('url' in opened) ||
          typeof opened.url !== 'string'
        )
          throw new Error('자료 열기 응답이 올바르지 않습니다.');
        const url = new URL(opened.url);
        if (url.protocol !== 'https:' || url.username || url.password)
          throw new Error('허용되지 않은 자료 주소입니다.');
        verifiedUrl = url.href;
      }
      const next = await studentMaterialRequest(`?page=${page}`, csrfToken);
      if (current !== version.current) return;
      if (
        !isMaterialList(next) ||
        typeof next.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(next.expiresAt))
      )
        throw new Error('학생 자료 목록 응답이 올바르지 않습니다.');
      onExpiry(next.expiresAt);
      const unseen = next.materials.filter((m) => !m.receivedAt).map((m) => m.id);
      // Acknowledge only after the authorized list has actually reached this client.
      if (unseen.length) {
        const receipt = await studentMaterialRequest('/received', csrfToken, {
          materialIds: unseen,
        });
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          !('receipts' in receipt) ||
          !Array.isArray(receipt.receipts) ||
          receipt.receipts.length !== unseen.length ||
          !receipt.receipts.every(
            (r) =>
              r &&
              typeof r === 'object' &&
              typeof r.id === 'string' &&
              unseen.includes(r.id) &&
              typeof r.receivedAt === 'string' &&
              Number.isFinite(Date.parse(r.receivedAt)),
          )
        )
          throw new Error('자료 수신 확인 응답이 올바르지 않습니다.');
      }
      if (current !== version.current) return;
      if (material && verifiedUrl) {
        if (!next.materials.some((m) => m.id === material))
          throw new Error('자료 목록이 변경되었습니다. 현재 페이지에서 자료를 다시 확인해 주세요.');
        setVerified({ id: material, url: verifiedUrl });
        setNotice(
          '열기 권한을 확인했습니다. 5초 안에 외부 자료로 이동을 선택하세요. 외부 사이트의 로딩·읽기 완료는 확인하지 않습니다.',
        );
      }
      if (
        !material &&
        view &&
        (view.total !== next.total ||
          view.materials.map((m) => m.id).join() !== next.materials.map((m) => m.id).join())
      )
        setNotice('교실 자료 목록이 변경되었습니다. 현재 목록을 확인해 주세요.');
      setView(next);
      setStale(false);
      lastSuccess.current = Date.now();
    } catch (cause) {
      if (current !== version.current) return;
      setVerified(null);
      setStale(true);
      setError(errorMessage(cause));
      if (cause instanceof RequestError && [401, 403].includes(cause.status)) {
        setView(null);
        onInvalid(cause.message);
      }
    } finally {
      if (current === version.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  read.current = () => void perform();
  useEffect(() => {
    if (!verified) return;
    const timer = window.setTimeout(() => setVerified(null), 5000);
    return () => window.clearTimeout(timer);
  }, [verified]);
  useEffect(() => {
    version.current++;
    inFlight.current = false;
    lastSuccess.current = 0;
    setView(null);
    setStale(true);
    setVerified(null);
    read.current();
    const timer = window.setInterval(() => read.current(), 10000);
    const freshness = window.setInterval(() => {
      if (lastSuccess.current && Date.now() - lastSuccess.current >= 15000) {
        setStale(true);
        setVerified(null);
      }
    }, 1000);
    const resume = () => {
      if (document.visibilityState === 'visible') {
        setVerified(null);
        setStale(true);
        read.current();
      }
    };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      version.current++;
      window.clearInterval(timer);
      window.clearInterval(freshness);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [csrfToken, page, onInvalid, onExpiry]);
  return (
    <section className="material-panel" aria-label="내 교실 자료">
      <h3>교실 수업 자료</h3>
      <p>
        10초마다 유효한 자료를 확인합니다. 목록 수신과 열기 요청은 읽기 완료가 아닙니다. 외부
        사이트의 안전성이나 별도 접근 권한을 보장하지 않습니다.
      </p>
      <p>
        목록 수신·열기 요청 시각을 서버에 기록하며 교사는 현재 승인 학생의 수신·열기 요청 수를
        확인합니다.
      </p>
      {busy && <p role="status">교실 자료를 확인하고 있습니다.</p>}
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {stale && (
        <p role="status">자료 서버 확인 불가 · 아래는 마지막 확인 결과이며 열 수 없습니다.</p>
      )}
      <button disabled={busy} onClick={() => void perform()}>
        내 자료 다시 확인
      </button>
      {view && (
        <>
          <p>
            서버 확인 {new Date(view.observedAt).toLocaleString()} · 유효 자료 {view.total}개
          </p>
          {!view.materials.length && <p>이 페이지에 유효한 수업 자료가 없습니다.</p>}
          <ul className="workspace-list">
            {view.materials.map((m) => (
              <li key={m.id}>
                <strong>{m.title}</strong>
                <p>
                  접근 만료 {new Date(m.expiresAt).toLocaleString()} ·{' '}
                  {m.openedAt ? '열기 요청 기록 있음' : '아직 열기 요청 없음'}
                </p>
                <button
                  aria-label={`자료 열기 ${m.title}`}
                  disabled={busy || stale || Date.parse(m.expiresAt) <= Date.now()}
                  onClick={() => void perform(m.id)}
                >
                  자료 열기
                </button>
                {!busy &&
                  !stale &&
                  verified?.id === m.id &&
                  Date.parse(m.expiresAt) > Date.now() && (
                    <a href={verified.url} target="_blank" rel="noopener noreferrer">
                      외부 자료로 이동
                    </a>
                  )}
              </li>
            ))}
          </ul>
          <p>자료 {page}페이지</p>
          <button disabled={busy || page <= 1} onClick={() => setPage((p) => p - 1)}>
            이전 내 자료 페이지
          </button>
          <button
            disabled={busy || page * view.pageSize >= view.total}
            onClick={() => setPage((p) => p + 1)}
          >
            다음 내 자료 페이지
          </button>
        </>
      )}
    </section>
  );
}
