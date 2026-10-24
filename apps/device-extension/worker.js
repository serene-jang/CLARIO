const STATE_KEY = 'connection';
let inFlight;
let ruleQueue = Promise.resolve();
function serializeRules(work) {
  const task = ruleQueue.then(work);
  ruleQueue = task.catch(report);
  return task;
}
async function clearBlocking() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.filter((r) => r.id >= 71000 && r.id < 71050).map((r) => r.id),
    addRules: [],
  });
  await chrome.alarms.clear('blocking-expiry');
  await chrome.storage.local.set({ blocking: null });
}
async function applyBlocking(value, config) {
  await serializeRules(async () => {
    await clearBlocking();
    if (!value) return;
    const expires = Date.parse(value.expiresAt),
      observed = Date.parse(value.observedAt);
    if (
      !Array.isArray(value.domains) ||
      value.domains.length > 50 ||
      !Number.isFinite(expires) ||
      !Number.isFinite(observed) ||
      expires <= Date.now() ||
      expires <= observed ||
      expires - observed > 60000 ||
      expires - Date.now() > 60000
    )
      throw new Error('사이트 차단 정책의 유효 시각이나 목록이 올바르지 않습니다.');
    const host = new URL(config.origin).hostname;
    const domains = value.domains;
    if (
      domains.some(
        (domain) =>
          typeof domain !== 'string' ||
          domain.length > 253 ||
          !domain.includes('.') ||
          !domain
            .split('.')
            .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
          !/[a-z]/.test(domain.split('.').at(-1)) ||
          /(?:^|\.)(?:localhost|local|internal)$/.test(domain) ||
          host === domain ||
          host.endsWith(`.${domain}`),
      )
    )
      throw new Error('잘못된 도메인이나 CLARIO API 차단 정책을 거부했습니다.');
    const addRules = domains.map((domain, index) => ({
      id: 71000 + index,
      priority: 1,
      action: { type: 'block' },
      condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] },
    }));
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [], addRules });
    await chrome.storage.local.set({
      blocking: { domains, expiresAt: value.expiresAt, lessonId: value.lessonId },
    });
    await chrome.alarms.create('blocking-expiry', { when: expires });
    if (expires <= Date.now()) await clearBlocking();
  });
}

function originValue(raw) {
  const url = new URL(raw);
  if (
    url.origin !== raw ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  ) {
    throw new Error('학교에서 안내한 HTTPS API 원본 주소를 입력하세요.');
  }
  return url.origin;
}

async function connection() {
  const data = await chrome.storage.local.get(STATE_KEY);
  return data[STATE_KEY];
}

async function api(config, path, body, authenticated = true) {
  const response = await fetch(
    `${originValue(config.origin)}/api/${config.kind === 'browser' ? 'browser-device' : 'device'}${path}`,
    {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        ...(authenticated ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  if (response.status === 204) return undefined;
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error('학교 기기 API 응답이 아닙니다. 주소를 확인하세요.');
  }
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message ?? '서버 요청에 실패했습니다.');
    error.status = response.status;
    throw error;
  }
  return result;
}

async function sync() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const config = await connection();
    if (!config?.token) throw new Error('최초 연결 코드로 기기를 등록하세요.');
    try {
      const result = await api(config, '/sync', {});
      await applyBlocking(result.blocking, config);
      await chrome.storage.local.set({
        materials: result.materials,
        focusMode: result.focusMode,
        syncStatus: { connected: true, checkedAt: new Date().toISOString(), error: '' },
      });
      for (const material of result.materials) {
        if (!material.receivedAt) {
          await api(config, `/materials/${material.id}/ack`, { action: 'received' });
        }
      }
      const unread = result.materials.filter((material) => !material.openedAt).length;
      await chrome.action.setBadgeText({
        text: unread ? String(unread) : result.focusMode ? '집중' : '',
      });
      await chrome.action.setBadgeBackgroundColor({ color: '#263a94' });
    } catch (error) {
      let cleanupFailed = false;
      try {
        await serializeRules(clearBlocking);
      } catch (cause) {
        cleanupFailed = true;
        report(cause);
      }
      await chrome.storage.local.set({
        materials: [],
        focusMode: null,
        syncStatus: {
          connected: false,
          checkedAt: new Date().toISOString(),
          error: cleanupFailed
            ? '차단 규칙 해제를 확인하지 못했습니다. 확장을 비활성화하거나 다시 연결 해제를 시도하세요.'
            : error instanceof Error
              ? error.message
              : '연결 실패',
        },
      });
      if (error.status === 401) {
        await chrome.storage.local.remove(STATE_KEY);
        await chrome.alarms.clear('sync');
      }
      await chrome.action.setBadgeText({ text: '!' });
      throw error;
    }
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await serializeRules(clearBlocking);
  if (await connection()) {
    await chrome.alarms.create('sync', { periodInMinutes: 0.5 });
    await sync();
  }
}
function report(error) {
  console.error(
    'clario_device_operation_failed',
    error instanceof Error ? error.message : 'Unknown error',
  );
}
chrome.runtime.onInstalled.addListener(() => {
  void initialize().catch(report);
});
chrome.runtime.onStartup.addListener(() => {
  void initialize().catch(report);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') void sync().catch(report);
  if (alarm.name === 'blocking-expiry')
    void serializeRules(async () => {
      const { blocking } = await chrome.storage.local.get('blocking');
      if (!blocking || Date.parse(blocking.expiresAt) <= Date.now()) await clearBlocking();
    }).catch(report);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html'))
    return false;
  async function handle() {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    if (message.type === 'pair' || message.type === 'pairStudent') {
      if (await connection()) throw new Error('기존 기기 연결을 먼저 해제하세요.');
      const origin = originValue(message.origin);
      if (!/^[A-Fa-f0-9]{32}$/.test(message.code))
        throw new Error('32자리 연결 코드를 입력하세요.');
      const kind = message.type === 'pairStudent' ? 'browser' : 'device';
      const result = await api({ origin, kind }, '/pair', { code: message.code }, false);
      await chrome.storage.local.set({
        [STATE_KEY]: { origin, kind, token: result.token, device: result.device },
      });
      await chrome.alarms.create('sync', { periodInMinutes: 0.5 });
      await sync();
    } else if (message.type === 'sync') {
      await sync();
    } else if (message.type === 'disconnect') {
      if (inFlight) {
        try {
          await inFlight;
        } catch (error) {
          report(error);
        }
      }
      const config = await connection();
      await serializeRules(clearBlocking);
      let disconnectError;
      try {
        if (config) await api(config, '/disconnect', {});
      } catch (error) {
        disconnectError = error;
      }
      await chrome.storage.local.remove([STATE_KEY, 'materials', 'syncStatus', 'focusMode']);
      await chrome.alarms.clear('sync');
      await chrome.action.setBadgeText({ text: '' });
      if (disconnectError)
        throw new Error(
          '로컬 차단·연결은 해제했지만 서버 해제 확인에 실패했습니다. 학생 웹에서 새 코드를 발급하거나 참여를 종료하세요.',
        );
    } else if (message.type === 'open') {
      await sync();
      const { materials } = await chrome.storage.local.get('materials');
      const material = materials?.find((item) => item.id === message.id);
      if (!material) throw new Error('자료가 만료되었거나 전달이 취소되었습니다.');
      const url = new URL(material.url);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('허용되지 않는 자료 주소입니다.');
      await chrome.tabs.create({ url: url.href });
      await api(await connection(), `/materials/${material.id}/ack`, { action: 'opened' });
      await sync();
    } else if (message.type !== 'status') {
      throw new Error('지원하지 않는 요청입니다.');
    }
    const config = await connection();
    await serializeRules(async () => {
      const { blocking } = await chrome.storage.local.get('blocking');
      if (blocking && Date.parse(blocking.expiresAt) <= Date.now()) await clearBlocking();
    });
    const data = await chrome.storage.local.get([
      'materials',
      'syncStatus',
      'focusMode',
      'blocking',
    ]);
    return {
      device: config?.device ?? null,
      origin: config?.origin ?? '',
      materials: data.materials ?? [],
      status: data.syncStatus ?? null,
      focusMode: data.focusMode ?? null,
      blocking: data.blocking ?? null,
    };
  }
  void handle().then(
    (result) => respond({ ok: true, ...result }),
    (error) => respond({ ok: false, error: error instanceof Error ? error.message : '처리 실패' }),
  );
  return true;
});
