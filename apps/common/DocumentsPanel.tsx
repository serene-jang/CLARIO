import { useEffect, useRef, useState } from 'react';
import { errorMessage, RequestError } from './web-api.js';

type Document = {
  id: string;
  title: string;
  bytes: number;
  status: 'uploading' | 'available' | 'failed' | 'deleting';
  createdAt: string;
};
export function DocumentsPanel({
  classroomId,
  token,
  apiBase = '',
  closed = false,
  onInvalid,
}: {
  classroomId?: string;
  token?: string;
  apiBase?: string;
  closed?: boolean;
  onInvalid?: (message: string) => void;
}) {
  const [opened, setOpened] = useState(false),
    [enabled, setEnabled] = useState(false);
  const [documents, setDocuments] = useState<Document[]>([]),
    [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const version = useRef(0),
    input = useRef<HTMLInputElement>(null);
  const teacher = Boolean(classroomId && token);
  const base = teacher ? `/identity/classrooms/${classroomId}/documents` : '/student/documents';
  useEffect(
    () => () => {
      version.current++;
    },
    [classroomId, token],
  );
  async function request(path: string, options: RequestInit = {}) {
    if (apiBase) {
      const url = new URL(apiBase);
      if (
        url.origin !== apiBase ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
      )
        throw new Error('문서 API 주소가 올바르지 않습니다.');
    }
    const response = await fetch(`${teacher ? apiBase : ''}/api${path}`, {
      ...options,
      credentials: teacher ? 'omit' : 'same-origin',
      signal: AbortSignal.timeout(30000),
      headers: { ...options.headers, ...(teacher ? { Authorization: `Bearer ${token}` } : {}) },
      cache: 'no-store',
    });
    if (!response.ok) {
      const body: unknown = await response.json();
      const detail = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      const message =
        detail &&
        typeof detail === 'object' &&
        'message' in detail &&
        typeof detail.message === 'string'
          ? detail.message
          : '문서 요청 실패';
      throw new RequestError(message, response.status);
    }
    return response;
  }
  async function refresh() {
    const response = await request(base),
      value: unknown = await response.json();
    if (
      !value ||
      typeof value !== 'object' ||
      !('enabled' in value) ||
      typeof value.enabled !== 'boolean' ||
      !('documents' in value) ||
      !Array.isArray(value.documents) ||
      !value.documents.every(
        (d) =>
          d &&
          typeof d === 'object' &&
          typeof d.id === 'string' &&
          typeof d.title === 'string' &&
          Number.isSafeInteger(d.bytes) &&
          ['uploading', 'available', 'failed', 'deleting'].includes(d.status),
      )
    )
      throw new Error('문서 목록 응답 형식을 확인할 수 없습니다.');
    return { enabled: value.enabled, documents: value.documents as Document[] };
  }
  async function perform(action: 'read' | 'upload' | 'download' | 'delete', document?: Document) {
    if (busy) return;
    const current = ++version.current;
    setBusy(true);
    setError('');
    setNotice('');
    let changed = false;
    try {
      if (action === 'upload') {
        if (
          !file ||
          !title.trim() ||
          file.size > 10 * 1024 * 1024 ||
          !file.size ||
          !file.name.toLowerCase().endsWith('.pdf')
        )
          throw new Error('제목과 10 MiB 이하 PDF를 선택하세요.');
        await request(`${base}?title=${encodeURIComponent(title.trim())}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: file,
        });
        changed = true;
      }
      if (action === 'delete') {
        if (
          !document ||
          !window.confirm(
            `"${document.title}" PDF 원본을 서버에서 삭제할까요? 이미 다운로드된 사본은 회수되지 않습니다.`,
          )
        )
          return;
        await request(`${base}/${document.id}`, { method: 'DELETE' });
        changed = true;
      }
      if (action === 'download') {
        if (!document) return;
        const response = await request(`${base}/${document.id}/download`);
        if (!response.headers.get('content-type')?.includes('application/pdf'))
          throw new Error('PDF 다운로드 응답이 아닙니다.');
        const blob = await response.blob();
        if (current !== version.current) return;
        const url = URL.createObjectURL(blob),
          anchor = window.document.createElement('a');
        anchor.href = url;
        anchor.download = `CLARIO-${document.id}.pdf`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('PDF 다운로드를 요청했습니다. 다운로드한 사본은 서버 삭제로 회수되지 않습니다.');
        return;
      }
      const result = await refresh();
      if (current !== version.current) return;
      setOpened(true);
      setEnabled(result.enabled);
      setDocuments(result.documents);
      if (changed) {
        setNotice(action === 'upload' ? 'PDF를 등록했습니다.' : 'PDF 원본 삭제를 확인했습니다.');
        if (action === 'upload') {
          setTitle('');
          setFile(null);
          if (input.current) input.current.value = '';
        }
      }
    } catch (cause) {
      if (current !== version.current) return;
      setDocuments([]);
      setError(`${changed ? '변경 후 목록 재확인 실패 · ' : ''}${errorMessage(cause)}`);
      if (cause instanceof RequestError && [401, 403].includes(cause.status))
        onInvalid?.(errorMessage(cause));
    } finally {
      if (current === version.current) setBusy(false);
    }
  }
  return (
    <section aria-label={teacher ? 'PDF 문서 관리' : '내 PDF 문서'}>
      <h3>PDF 문서 공유</h3>
      <p>
        PDF만·파일당 최대 10 MiB·교실당 100개입니다. 비공개 서버 디스크에서 권한을 확인한 뒤
        다운로드합니다. 악성코드 검사는 제공하지 않으므로 신뢰할 수 있는 PDF만 공유하세요.
      </p>
      <button disabled={busy} onClick={() => void perform('read')}>
        {opened ? 'PDF 목록 다시 확인' : 'PDF 문서 열기'}
      </button>
      {busy && <p role="status">PDF 요청 처리 중</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {opened && !enabled && (
        <p>비공개 문서 저장소가 설정되지 않았습니다. 업로드·다운로드는 비활성입니다.</p>
      )}
      {opened && enabled && (
        <>
          {teacher && !closed && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void perform('upload');
              }}
            >
              <label>
                PDF 제목
                <input
                  required
                  maxLength={100}
                  value={title}
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                PDF 파일
                <input
                  ref={input}
                  type="file"
                  accept=".pdf,application/pdf"
                  required
                  disabled={busy}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <button disabled={busy} type="submit">
                PDF 업로드·공유
              </button>
            </form>
          )}
          {!documents.length && <p>공유된 PDF가 없습니다.</p>}
          <ul>
            {documents.map((d) => (
              <li key={d.id}>
                <strong>{d.title}</strong> · {(d.bytes / 1024).toFixed(1)} KiB ·
                {
                  {
                    uploading: '업로드 미완료 · 삭제 후 재등록 가능',
                    available: '다운로드 가능',
                    failed: '업로드 실패 · 삭제 후 재등록 필요',
                    deleting: '삭제 대기 · 원본 삭제 재시도 필요',
                  }[d.status]
                }
                {d.status === 'available' && (
                  <button disabled={busy} onClick={() => void perform('download', d)}>
                    PDF 다운로드 {d.title}
                  </button>
                )}
                {teacher && (
                  <button disabled={busy} onClick={() => void perform('delete', d)}>
                    PDF 삭제 {d.title}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
