import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DocumentsPanel } from './DocumentsPanel.js';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const document = {
  id: 'document',
  title: 'Lesson PDF',
  bytes: 500,
  status: 'available',
  createdAt: new Date().toISOString(),
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('uploads PDF bytes only after opening configured storage, using teacher bearer and correct API origin', async () => {
  const fetch = vi.fn().mockResolvedValue(json({ enabled: true, documents: [] }));
  vi.stubGlobal('fetch', fetch);
  render(
    createElement(DocumentsPanel, {
      classroomId: 'class',
      token: 'teacher',
      apiBase: 'https://api.example.com',
    }),
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'PDF 문서 열기' }));
  await screen.findByRole('button', { name: 'PDF 업로드·공유' });
  fireEvent.change(screen.getByLabelText('PDF 제목'), { target: { value: 'Lesson PDF' } });
  const file = new File(['%PDF-1.7\n%%EOF'], 'lesson.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText('PDF 파일'), { target: { files: [file] } });
  fetch
    .mockResolvedValueOnce(json({ id: 'document' }, 201))
    .mockResolvedValueOnce(json({ enabled: true, documents: [document] }));
  fireEvent.submit(screen.getByRole('button', { name: 'PDF 업로드·공유' }).closest('form')!);
  await screen.findByText('PDF를 등록했습니다.');
  expect(fetch.mock.calls[1]).toEqual([
    'https://api.example.com/api/identity/classrooms/class/documents?title=Lesson%20PDF',
    expect.objectContaining({
      method: 'POST',
      body: file,
      credentials: 'omit',
      headers: { Authorization: 'Bearer teacher', 'Content-Type': 'application/pdf' },
    }),
  ]);
});
it('keeps disabled storage and failed deletion distinct from successful upload/deletion', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json({ enabled: false, documents: [] }));
  vi.stubGlobal('fetch', fetch);
  render(createElement(DocumentsPanel, { classroomId: 'class', token: 'teacher' }));
  fireEvent.click(screen.getByRole('button', { name: 'PDF 문서 열기' }));
  await screen.findByText(/비공개 문서 저장소가 설정되지/);
  expect(screen.queryByLabelText('PDF 파일')).toBeNull();
  fetch.mockResolvedValueOnce(
    json({ enabled: true, documents: [{ ...document, status: 'deleting' }] }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'PDF 목록 다시 확인' }));
  await screen.findByText(/삭제 대기/);
  expect(screen.queryByRole('button', { name: 'PDF 다운로드 Lesson PDF' })).toBeNull();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fetch.mockResolvedValueOnce(json({ error: { message: 'Disk failure' } }, 500));
  fireEvent.click(screen.getByRole('button', { name: 'PDF 삭제 Lesson PDF' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('PDF 원본 삭제를 확인했습니다.')).toBeNull();
});
it('uses same-origin student cookies, has no upload controls and clears private records after revocation', async () => {
  const invalid = vi.fn(),
    fetch = vi.fn().mockResolvedValueOnce(json({ enabled: true, documents: [document] }));
  vi.stubGlobal('fetch', fetch);
  render(createElement(DocumentsPanel, { onInvalid: invalid }));
  fireEvent.click(screen.getByRole('button', { name: 'PDF 문서 열기' }));
  await screen.findByText('Lesson PDF');
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' });
  expect(screen.queryByLabelText('PDF 파일')).toBeNull();
  fetch.mockResolvedValueOnce(json({ error: { message: 'Revoked' } }, 401));
  fireEvent.click(screen.getByRole('button', { name: 'PDF 목록 다시 확인' }));
  await screen.findByRole('alert');
  expect(invalid).toHaveBeenCalled();
  expect(screen.queryByText('Lesson PDF')).toBeNull();
});
