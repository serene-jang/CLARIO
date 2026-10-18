const STATE_KEY = 'connection';
let inFlight;

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
  const response = await fetch(`${originValue(config.origin)}/api/device${path}`, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
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
      await chrome.storage.local.set({
        materials: [],
        focusMode: null,
        syncStatus: {
          connected: false,
          checkedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : '연결 실패',
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
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html'))
    return false;
  async function handle() {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    if (message.type === 'pair') {
      if (await connection()) throw new Error('기존 기기 연결을 먼저 해제하세요.');
      const origin = originValue(message.origin);
      if (!/^[A-Fa-f0-9]{32}$/.test(message.code))
        throw new Error('32자리 연결 코드를 입력하세요.');
      const result = await api({ origin }, '/pair', { code: message.code }, false);
      await chrome.storage.local.set({
        [STATE_KEY]: { origin, token: result.token, device: result.device },
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
      if (config) await api(config, '/disconnect', {});
      await chrome.storage.local.remove([STATE_KEY, 'materials', 'syncStatus', 'focusMode']);
      await chrome.alarms.clear('sync');
      await chrome.action.setBadgeText({ text: '' });
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
    const data = await chrome.storage.local.get(['materials', 'syncStatus', 'focusMode']);
    return {
      device: config?.device ?? null,
      origin: config?.origin ?? '',
      materials: data.materials ?? [],
      status: data.syncStatus ?? null,
      focusMode: data.focusMode ?? null,
    };
  }
  void handle().then(
    (result) => respond({ ok: true, ...result }),
    (error) => respond({ ok: false, error: error instanceof Error ? error.message : '처리 실패' }),
  );
  return true;
});
