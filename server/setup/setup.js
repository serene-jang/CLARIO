const token = location.hash.slice(1);
history.replaceState(null, '', '/');
const form = document.querySelector('#setup');
const button = form.querySelector('button');
const status = document.querySelector('#status');
if (!token) {
  button.disabled = true;
  status.textContent = '설정 터미널에 표시된 # 이후를 포함한 전체 주소로 접속하세요.';
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  button.disabled = true;
  status.textContent =
    '로컬 DB 준비 및 설정 적용 중입니다. 처음 실행할 때는 잠시 걸릴 수 있습니다.';
  status.removeAttribute('role');
  try {
    const fields = new FormData(form);
    const input = Object.fromEntries(
      ['googleClientId', 'schoolName', 'domain', 'email', 'adminName'].map((key) => [
        key,
        fields.get(key),
      ]),
    );
    const response = await fetch('/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Setup-Token': token },
      body: JSON.stringify(input),
      credentials: 'omit',
      redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      throw new Error(result.error ?? '설정을 적용하지 못했습니다.');
    }
    form.hidden = true;
    status.textContent = '설정 적용 완료';
    document.querySelector('#result').hidden = false;
    document.querySelector('#result').scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    status.setAttribute('role', 'alert');
    status.textContent =
      error instanceof Error ? error.message : '연결 오류입니다. 다시 시도하세요.';
    button.disabled = false;
  }
});
