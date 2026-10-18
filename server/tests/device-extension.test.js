import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = await readFile(
  new URL('../../apps/device-extension/worker.js', import.meta.url),
  'utf8',
);

function worker() {
  const storage = {};
  const fetchMock = vi.fn();
  let listener;
  let startup;
  const chrome = {
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]]),
          ),
        set: async (values) => Object.assign(storage, structuredClone(values)),
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        },
        setAccessLevel: vi.fn(async () => {}),
      },
    },
    alarms: {
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      onAlarm: { addListener: vi.fn() },
    },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    tabs: { create: vi.fn(async () => {}) },
    runtime: {
      id: 'extension',
      getURL: (path) => `chrome-extension://extension/${path}`,
      onInstalled: { addListener: vi.fn() },
      onStartup: {
        addListener: (callback) => {
          startup = callback;
        },
      },
      onMessage: {
        addListener: (callback) => {
          listener = callback;
        },
      },
    },
  };
  vm.runInNewContext(source, { chrome, fetch: fetchMock, URL, AbortSignal, Error, Date, console });
  const send = (message) =>
    new Promise((resolve) =>
      listener(message, { id: 'extension', url: chrome.runtime.getURL('popup.html') }, resolve),
    );
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  fetchMock.mockImplementation(async (url) => {
    if (url.endsWith('/pair'))
      return json({ token: 't'.repeat(43), device: { id: 'device', name: 'School device' } });
    if (url.endsWith('/sync')) return json({ materials: [], focusMode: false });
    return new Response(null, { status: 204 });
  });
  return { storage, chrome, send, fetchMock, json, startup, listener };
}

describe('managed-device extension worker boundary', () => {
  it('pairs once, retains credentials only in trusted storage and does not return tokens to popup', async () => {
    const { send, storage, chrome, fetchMock } = worker();
    const result = await send({
      type: 'pair',
      origin: 'https://api.school.example',
      code: 'A'.repeat(32),
    });
    expect(result.ok).toBe(true);
    expect(storage.connection.token).toHaveLength(43);
    expect(JSON.stringify(result)).not.toContain('t'.repeat(43));
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
    expect(chrome.alarms.create).toHaveBeenCalledWith('sync', { periodInMinutes: 0.5 });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${'t'.repeat(43)}`);
    expect(
      (await send({ type: 'pair', origin: 'https://api.school.example', code: 'A'.repeat(32) })).ok,
    ).toBe(false);
  });
  it('rejects non-HTTPS remote origins and messages from other pages', async () => {
    const { send, fetchMock, listener } = worker();
    expect(
      (await send({ type: 'pair', origin: 'http://remote.example', code: 'A'.repeat(32) })).ok,
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      listener({ type: 'status' }, { id: 'foreign', url: 'https://evil.example' }, vi.fn()),
    ).toBe(false);
  });
  it('acknowledges delivery but only opens a current HTTPS material after explicit popup action', async () => {
    const { storage, send, chrome, fetchMock, json } = worker();
    storage.connection = { origin: 'https://api.school.example', token: 't'.repeat(43) };
    fetchMock.mockImplementation(async (url) =>
      url.endsWith('/sync')
        ? json({
            materials: [
              {
                id: 'material',
                title: 'Lesson',
                url: 'https://example.com/lesson',
                receivedAt: null,
                openedAt: null,
              },
            ],
          })
        : new Response(null, { status: 204 }),
    );
    expect((await send({ type: 'sync' })).ok).toBe(true);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) =>
          url.endsWith('/material/ack') && JSON.parse(options.body).action === 'received',
      ),
    ).toBe(true);
    expect((await send({ type: 'open', id: 'material' })).ok).toBe(true);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/lesson' });
    expect(
      fetchMock.mock.calls.some(([, options]) => JSON.parse(options.body).action === 'opened'),
    ).toBe(true);
    expect((await send({ type: 'open', id: 'expired' })).ok).toBe(false);
  });
  it('clears private material caches and stops reauthentication loops after server revocation', async () => {
    const { storage, send, chrome, fetchMock, json } = worker();
    storage.connection = { origin: 'https://api.school.example', token: 't'.repeat(43) };
    storage.materials = [{ id: 'old' }];
    fetchMock.mockResolvedValue(json({ error: { message: '기기 연결 해제' } }, 401));
    expect((await send({ type: 'sync' })).ok).toBe(false);
    expect(storage.connection).toBeUndefined();
    expect(storage.materials).toEqual([]);
    expect(storage.syncStatus.connected).toBe(false);
    expect(chrome.alarms.clear).toHaveBeenCalledWith('sync');
  });
  it('retries after transient network failure without reporting old materials as current', async () => {
    const { storage, send, fetchMock, json } = worker();
    storage.connection = { origin: 'https://api.school.example', token: 't'.repeat(43) };
    fetchMock.mockRejectedValueOnce(new Error('Network unavailable'));
    expect((await send({ type: 'sync' })).ok).toBe(false);
    expect(storage.connection).toBeTruthy();
    expect(storage.materials).toEqual([]);
    fetchMock.mockResolvedValue(json({ materials: [] }));
    expect((await send({ type: 'sync' })).ok).toBe(true);
    expect(storage.syncStatus.connected).toBe(true);
  });
  it('disconnects on the server before removing stored credentials', async () => {
    const { storage, send, fetchMock, chrome } = worker();
    storage.connection = { origin: 'https://api.school.example', token: 't'.repeat(43) };
    expect((await send({ type: 'disconnect' })).ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.school.example/api/device/disconnect');
    expect(storage.connection).toBeUndefined();
    expect(chrome.alarms.clear).toHaveBeenCalledWith('sync');
  });
  it('exposes voluntary focus status and a badge without changing browser restrictions', async () => {
    const { storage, send, fetchMock, chrome, json } = worker();
    storage.connection = { origin: 'https://api.school.example', token: 't'.repeat(43) };
    fetchMock.mockResolvedValue(json({ materials: [], focusMode: true }));
    const result = await send({ type: 'sync' });
    expect(result.ok).toBe(true);
    expect(result.focusMode).toBe(true);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '집중' });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});
