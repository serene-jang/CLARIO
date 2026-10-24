import { fail, text } from './api-core.js';

export function materialUrl(value: unknown) {
  const raw = text(value, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(400, 'INVALID_URL', '올바른 HTTPS 자료 주소를 입력해 주세요.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    fail(400, 'INVALID_URL', '인증 정보가 포함되지 않은 HTTPS 자료 주소가 필요합니다.');
  }
  if (url.href.length > 2048) {
    fail(400, 'INVALID_URL', '자료 주소는 2048자 이내여야 합니다.');
  }
  return url.href;
}
