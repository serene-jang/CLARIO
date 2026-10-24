import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StudentMaterials from './StudentMaterials.js';
const now = new Date().toISOString();
const snapshot = {
  materials: [
    {
      id: 'material',
      title: 'Lesson link',
      createdAt: now,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      receivedAt: null,
      openedAt: null,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
  observedAt: now,
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const props = () => ({ csrfToken: 'csrf', onInvalid: vi.fn(), onExpiry: vi.fn() });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('student materials', () => {
  it('notifies list changes and removes deleted items through ten-second snapshots', async () => {
    vi.useFakeTimers();
    let total = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          ...snapshot,
          materials: total ? snapshot.materials.map((m) => ({ ...m, receivedAt: now })) : [],
          total,
        }),
      ),
    );
    render(createElement(StudentMaterials, props()));
    await act(async () => {});
    expect(screen.getByText('Lesson link')).toBeTruthy();
    total = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.queryByText('Lesson link')).toBeNull();
    expect(
      screen.getByText('교실 자료 목록이 변경되었습니다. 현재 목록을 확인해 주세요.'),
    ).toBeTruthy();
  });
  it('discards an old credential response without acknowledging or displaying its materials', async () => {
    let oldResponse: (response: Response) => void = () => {};
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            oldResponse = resolve;
          }),
      )
      .mockImplementation(async () => json({ ...snapshot, materials: [], total: 0 }));
    vi.stubGlobal('fetch', fetch);
    const callbacks = props();
    const rendered = render(createElement(StudentMaterials, callbacks));
    rendered.rerender(createElement(StudentMaterials, { ...callbacks, csrfToken: 'new-csrf' }));
    await act(async () => {
      oldResponse(json(snapshot));
    });
    expect(screen.queryByText('Lesson link')).toBeNull();
    expect(fetch.mock.calls.some((c) => String(c[0]).endsWith('/received'))).toBe(false);
  });
  it('acknowledges an actually received list and opens through fresh server authorization without claiming reading', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async (path: string) =>
        json(
          path.endsWith('/received')
            ? { receipts: [{ id: 'material', receivedAt: now }] }
            : path.endsWith('/open')
              ? { url: 'https://example.test/lesson' }
              : snapshot,
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const callbacks = props();
    render(createElement(StudentMaterials, callbacks));
    await screen.findByText('Lesson link');
    expect(fetch.mock.calls[1][0]).toBe('/api/student/materials/received');
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Student-CSRF': 'csrf' },
      body: JSON.stringify({ materialIds: ['material'] }),
    });
    fireEvent.click(screen.getByRole('button', { name: '자료 열기 Lesson link' }));
    const external = await screen.findByRole('link', { name: '외부 자료로 이동' });
    expect(external.getAttribute('href')).toBe('https://example.test/lesson');
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(callbacks.onExpiry).toHaveBeenCalledWith(snapshot.expiresAt);
  });
  it('polls new/removed items, marks network failures unknown and clears private data on revocation', async () => {
    vi.useFakeTimers();
    let mode = 'ok';
    const fetch = vi.fn().mockImplementation(async (path: string) => {
      if (mode === 'offline') throw new Error('offline');
      if (mode === 'revoked') return json({ error: { message: 'Credential revoked' } }, 401);
      return json(
        path.endsWith('/received') ? { receipts: [{ id: 'material', receivedAt: now }] } : snapshot,
      );
    });
    vi.stubGlobal('fetch', fetch);
    const callbacks = props();
    render(createElement(StudentMaterials, callbacks));
    await act(async () => {});
    mode = 'offline';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText(/자료 서버 확인 불가/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '자료 열기 Lesson link' })).toHaveProperty(
      'disabled',
      true,
    );
    mode = 'revoked';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(callbacks.onInvalid).toHaveBeenCalledWith('Credential revoked');
    expect(screen.queryByText('Lesson link')).toBeNull();
  });
  it('handles deleted/expired open requests without exposing a URL and refreshes the list', async () => {
    let mode = 'ok';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (path: string) => {
        if (path.endsWith('/open')) {
          mode = 'deleted';
          return json({ error: { message: 'Material deleted' } }, 404);
        }
        return json(
          path.endsWith('/received')
            ? { receipts: [{ id: 'material', receivedAt: now }] }
            : mode === 'deleted'
              ? { ...snapshot, materials: [], total: 0 }
              : snapshot,
        );
      }),
    );
    render(createElement(StudentMaterials, props()));
    await screen.findByText('Lesson link');
    fireEvent.click(screen.getByRole('button', { name: '자료 열기 Lesson link' }));
    await screen.findByText('Material deleted');
    expect(screen.queryByRole('link', { name: '외부 자료로 이동' })).toBeNull();
    expect(screen.getByRole('button', { name: '자료 열기 Lesson link' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '내 자료 다시 확인' }));
    await screen.findByText('이 페이지에 유효한 수업 자료가 없습니다.');
  });
  it('expires the verified external link after five seconds and rejects malformed receipt responses', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async (path: string) =>
      json(
        path.endsWith('/received')
          ? {}
          : path.endsWith('/open')
            ? { url: 'https://example.test/lesson' }
            : {
                ...snapshot,
                materials: snapshot.materials.map((m) => ({ ...m, receivedAt: now })),
              },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    render(createElement(StudentMaterials, props()));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '자료 열기 Lesson link' }));
    await act(async () => {});
    expect(screen.getByRole('link', { name: '외부 자료로 이동' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByRole('link', { name: '외부 자료로 이동' })).toBeNull();
    fetch.mockImplementation(async (path: string) =>
      json(path.endsWith('/received') ? {} : snapshot),
    );
    fireEvent.click(screen.getByRole('button', { name: '내 자료 다시 확인' }));
    await act(async () => {});
    expect(screen.getByText('자료 수신 확인 응답이 올바르지 않습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '자료 열기 Lesson link' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
