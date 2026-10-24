import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = await readFile(
  new URL('../../apps/device-extension/worker.js', import.meta.url),
  'utf8',
);

function worker(storage = {}) {
  const fetchMock = vi.fn();
  let listener;
  let startup;
  let alarm;
  let rules = [];
  const chrome = {
    declarativeNetRequest: {
      getSessionRules: vi.fn(async () => structuredClone(rules)),
      updateSessionRules: vi.fn(async ({ removeRuleIds, addRules = [] }) => {
        rules = rules
          .filter((r) => !removeRuleIds.includes(r.id))
          .concat(structuredClone(addRules));
      }),
    },
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
      onAlarm: {
        addListener: (callback) => {
          alarm = callback;
        },
      },
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
  return { storage, chrome, send, fetchMock, json, startup, listener, alarm };
}

describe('managed-device extension worker boundary', () => {
  it('requests explicit network blocking permission but no capture, history or content scripts', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../apps/device-extension/manifest.json', import.meta.url), 'utf8'),
    );
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('120');
    expect(manifest.permissions).toEqual(['storage', 'alarms', 'declarativeNetRequest']);
    expect(manifest.optional_permissions ?? []).toEqual([]);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions).toEqual([
      'https://*/*',
      'http://127.0.0.1/*',
      'http://localhost/*',
    ]);
    expect(manifest.content_scripts ?? []).toEqual([]);
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.background).toEqual({ service_worker: 'worker.js', type: 'module' });
  });
  it('restores persisted pairing on simulated browser startup without granting a student identity', async () => {
    const first = worker();
    await first.send({ type: 'pair', origin: 'https://api.school.example', code: 'A'.repeat(32) });
    const restarted = worker(structuredClone(first.storage));
    restarted.startup();
    const state = await restarted.send({ type: 'sync' });
    expect(state.ok).toBe(true);
    expect(state.device).toEqual({ id: 'device', name: 'School device' });
    expect(restarted.chrome.alarms.create).toHaveBeenCalledWith('sync', { periodInMinutes: 0.5 });
    expect(
      restarted.fetchMock.mock.calls.every(
        ([url, options]) =>
          url === 'https://api.school.example/api/device/sync' &&
          options.credentials === 'omit' &&
          options.redirect === 'error' &&
          options.body === '{}' &&
          options.headers.Authorization === `Bearer ${first.storage.connection.token}`,
      ),
    ).toBe(true);
    expect(state).not.toHaveProperty('csrfToken');
    expect(state).not.toHaveProperty('participant');
    expect(JSON.stringify(state)).not.toContain(first.storage.connection.token);
    expect(restarted.chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('reconstructs focus after a simulated delayed alarm instead of trusting cached state', async () => {
    const { storage, send, alarm, fetchMock, json, chrome } = worker({
      connection: { origin: 'https://api.school.example', token: 't'.repeat(43) },
      focusMode: true,
      materials: [{ id: 'old' }],
      syncStatus: { connected: true, checkedAt: '2000-01-01T00:00:00.000Z' },
    });
    alarm({ name: 'unrelated' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new Error('Network unavailable after wake'));
    expect((await send({ type: 'sync' })).ok).toBe(false);
    expect(storage.focusMode).toBeNull();
    expect(storage.materials).toEqual([]);
    expect(storage.syncStatus.connected).toBe(false);
    expect(storage.connection).toBeTruthy();
    fetchMock.mockResolvedValue(json({ materials: [], focusMode: false }));
    alarm({ name: 'sync' });
    expect((await send({ type: 'sync' })).focusMode).toBe(false);
    expect(storage.syncStatus.connected).toBe(true);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('forgets revoked credentials on simulated restart and will not silently pair again', async () => {
    const { storage, startup, send, fetchMock, json, chrome } = worker({
      connection: { origin: 'https://api.school.example', token: 't'.repeat(43) },
      materials: [{ id: 'old' }],
      focusMode: true,
    });
    fetchMock.mockResolvedValue(json({ error: { message: 'Revoked' } }, 401));
    startup();
    expect((await send({ type: 'sync' })).ok).toBe(false);
    expect(storage.connection).toBeUndefined();
    expect(storage.materials).toEqual([]);
    expect(storage.focusMode).toBeNull();
    expect(chrome.alarms.clear).toHaveBeenCalledWith('sync');
    const requests = fetchMock.mock.calls.length;
    expect((await send({ type: 'sync' })).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });
  it('rejects capture, recording and control messages without network or tab side effects', async () => {
    const { send, fetchMock, storage, chrome } = worker();
    for (const type of [
      'capture',
      'screen',
      'record',
      'startRecording',
      'stopRecording',
      'blockSite',
    ]) {
      const result = await send({ type });
      expect(result).toEqual({ ok: false, error: '지원하지 않는 요청입니다.' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(storage).toEqual({});
  });
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
  it('applies only server-approved domain session rules, replaces them and clears on transient failure', async () => {
    const { storage, send, fetchMock, json, chrome } = worker({
      connection: { origin: 'https://api.school.example', token: 't'.repeat(43), kind: 'browser' },
    });
    const policy = {
      domains: ['example.com'],
      lessonId: 'lesson',
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 59000).toISOString(),
    };
    fetchMock.mockResolvedValue(json({ materials: [], focusMode: false, blocking: policy }));
    expect((await send({ type: 'sync' })).ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.school.example/api/browser-device/sync');
    expect((await chrome.declarativeNetRequest.getSessionRules())[0]).toEqual({
      id: 71000,
      priority: 1,
      action: { type: 'block' },
      condition: { requestDomains: ['example.com'], resourceTypes: ['main_frame', 'sub_frame'] },
    });
    expect(chrome.alarms.create).toHaveBeenCalledWith('blocking-expiry', {
      when: Date.parse(policy.expiresAt),
    });
    fetchMock.mockRejectedValue(new Error('Disconnected'));
    expect((await send({ type: 'sync' })).ok).toBe(false);
    expect(await chrome.declarativeNetRequest.getSessionRules()).toEqual([]);
    expect(storage.blocking).toBeNull();
  });
  it('rejects invalid, expired or self-blocking policies instead of retaining prior rules', async () => {
    const { send, fetchMock, json, chrome } = worker({
      connection: { origin: 'https://api.school.example', token: 't'.repeat(43) },
    });
    for (const domains of [
      ['school.example'],
      ['127.0.0.1'],
      ['https://example.com'],
      ['*.example.com'],
    ]) {
      fetchMock.mockResolvedValue(
        json({
          materials: [],
          blocking: {
            domains,
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 59000).toISOString(),
          },
        }),
      );
      expect((await send({ type: 'sync' })).ok).toBe(false);
      expect(await chrome.declarativeNetRequest.getSessionRules()).toEqual([]);
    }
    fetchMock.mockResolvedValue(
      json({
        materials: [],
        blocking: {
          domains: ['example.com'],
          observedAt: '2000-01-01T00:00:00Z',
          expiresAt: '2000-01-01T00:01:00Z',
        },
      }),
    );
    expect((await send({ type: 'sync' })).ok).toBe(false);
  });
  it('expires session rules and clears them locally even if remote disconnect fails', async () => {
    const { send, storage, fetchMock, json, chrome, alarm } = worker({
      connection: { origin: 'https://api.school.example', token: 't'.repeat(43) },
    });
    fetchMock.mockResolvedValue(
      json({
        materials: [],
        blocking: {
          domains: ['example.com'],
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 59000).toISOString(),
        },
      }),
    );
    await send({ type: 'sync' });
    storage.blocking.expiresAt = '2000-01-01T00:00:00Z';
    alarm({ name: 'blocking-expiry' });
    await send({ type: 'status' });
    expect(await chrome.declarativeNetRequest.getSessionRules()).toEqual([]);
    await send({ type: 'sync' });
    fetchMock.mockRejectedValue(new Error('offline'));
    expect((await send({ type: 'disconnect' })).ok).toBe(false);
    expect(await chrome.declarativeNetRequest.getSessionRules()).toEqual([]);
    expect(storage.connection).toBeUndefined();
  });
  it('pairs a student browser through the separate credential namespace', async () => {
    const { send, fetchMock, storage } = worker();
    expect(
      (
        await send({
          type: 'pairStudent',
          origin: 'https://api.school.example',
          code: 'A'.repeat(32),
        })
      ).ok,
    ).toBe(true);
    expect(storage.connection.kind).toBe('browser');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.school.example/api/browser-device/pair');
  });
  it('clears only its reserved rule IDs on browser startup, preserving unrelated session rules', async () => {
    const { chrome, send, startup } = worker();
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [],
      addRules: [{ id: 71000 }, { id: 42 }],
    });
    startup();
    await vi.waitFor(async () =>
      expect(await chrome.declarativeNetRequest.getSessionRules()).toEqual([{ id: 42 }]),
    );
    expect((await send({ type: 'status' })).blocking).toBeNull();
  });
  it('reports failed rule cleanup explicitly and marks the connection unknown rather than successful', async () => {
    const { chrome, storage, send, fetchMock } = worker({
      connection: { origin: 'https://api.school.example', token: 't'.repeat(43) },
    });
    fetchMock.mockRejectedValue(new Error('network offline'));
    chrome.declarativeNetRequest.getSessionRules.mockRejectedValue(new Error('DNR unavailable'));
    expect((await send({ type: 'sync' })).ok).toBe(false);
    expect(storage.syncStatus.connected).toBe(false);
    expect(storage.syncStatus.error).toContain('차단 규칙 해제를 확인하지 못했습니다');
  });
});
