const form = document.querySelector('#pair');
const status = document.querySelector('#status');
const errorBox = document.querySelector('#error');
const materials = document.querySelector('#materials');
let busy = false;

async function request(message) {
  if (busy) return;
  busy = true;
  errorBox.textContent = '';
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error ?? '확장 프로그램 연결 실패');
    form.hidden = Boolean(result.device);
    const fresh =
      result.status?.connected && Date.now() - Date.parse(result.status.checkedAt) < 90000;
    status.textContent = result.device
      ? `${result.device.name} · ${fresh ? '연결됨' : '연결 확인 불가'} · ${result.origin}`
      : '기기 연결 미등록';
    if (result.status?.error) errorBox.textContent = result.status.error;
    document.querySelector('#focus').textContent =
      !fresh || result.focusMode === null
        ? '현재 집중 안내 상태를 확인할 수 없습니다.'
        : result.focusMode
          ? '교사가 자율 집중 수업 안내를 켰습니다.'
          : '현재 자율 집중 안내가 꺼져 있습니다.';
    if (result.status?.checkedAt) {
      status.textContent += ` · 마지막 확인 ${new Date(result.status.checkedAt).toLocaleTimeString()}`;
    }
    materials.replaceChildren();
    for (const material of result.materials) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${material.title} · ${material.openedAt ? '열기 이력 있음' : '새 자료'}`;
      button.addEventListener('click', () => void request({ type: 'open', id: material.id }));
      item.append(button);
      materials.append(item);
    }
    if (!result.materials.length) materials.textContent = '현재 확인할 수 있는 자료가 없습니다.';
    form.reset();
  } catch (error) {
    errorBox.textContent = error instanceof Error ? error.message : '연결 처리 실패';
  } finally {
    busy = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
  }
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const origin = String(data.get('origin')).trim();
  let url;
  try {
    url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
    ) {
      throw new Error('학교에서 안내한 HTTPS API 원본 주소가 필요합니다.');
    }
  } catch {
    errorBox.textContent = '학교에서 안내한 HTTPS API 원본 주소가 필요합니다.';
    return;
  }
  void chrome.permissions
    .request({ origins: [`${url.origin}/*`] })
    .then((granted) => {
      if (!granted) throw new Error('학교 API 연결 권한을 허용해야 합니다.');
      return request({ type: 'pair', origin, code: String(data.get('code')).trim() });
    })
    .catch((error) => {
      errorBox.textContent = error.message;
    });
});
document.querySelector('#sync').addEventListener('click', () => void request({ type: 'sync' }));
document.querySelector('#disconnect').addEventListener('click', () => {
  if (confirm('이 기기의 CLARIO 연결을 해제할까요? 다시 연결하려면 교사의 새 코드가 필요합니다.')) {
    void request({ type: 'disconnect' });
  }
});
void request({ type: 'status' });
