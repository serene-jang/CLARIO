import { OAuth2Client } from 'google-auth-library';
import type { Pool } from 'pg';
import { digest, fail } from './api-core.js';

export interface GoogleIdentity {
  sub: string;
  email: string;
  domain: string;
  nonce: string;
}

export type VerifyGoogle = (credential: string) => Promise<GoogleIdentity>;

export async function verifyGoogleLogin(
  pool: Pool,
  verify: VerifyGoogle,
  challengeId: string,
  credential: string,
) {
  const challenge = await pool.query<{ nonce_hash: string }>(
    'DELETE FROM auth_challenges WHERE id=$1 AND expires_at>now() RETURNING nonce_hash',
    [challengeId],
  );
  if (!challenge.rowCount)
    fail(401, 'LOGIN_EXPIRED', '로그인 요청이 만료되었거나 이미 사용되었습니다.');
  const identity = await verify(credential).catch(() =>
    fail(401, 'INVALID_GOOGLE_TOKEN', 'Google 계정을 확인하지 못했습니다.'),
  );
  if (digest(identity.nonce) !== challenge.rows[0].nonce_hash) {
    fail(401, 'INVALID_NONCE', '로그인 요청이 일치하지 않습니다.');
  }
  return identity;
}

export function googleVerifier(clientId: string): VerifyGoogle {
  const client = new OAuth2Client(clientId);
  return async (credential) => {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();
    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true ||
      typeof payload.nonce !== 'string'
    ) {
      throw new Error('Invalid Google identity.');
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      domain: (payload.hd ?? payload.email.split('@')[1]).toLowerCase(),
      nonce: payload.nonce,
    };
  };
}
