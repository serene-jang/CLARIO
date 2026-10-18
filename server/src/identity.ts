import { OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
  sub: string;
  email: string;
  domain: string;
  nonce: string;
}

export type VerifyGoogle = (credential: string) => Promise<GoogleIdentity>;

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
