import { describe, expect, it, vi } from 'vitest';
import { googleVerifier } from '../src/identity.js';

const verify = vi.hoisted(() => vi.fn());
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = verify;
  },
}));

describe('Google verification boundary', () => {
  it('delegates signature/issuer/expiry verification and pins the audience', async () => {
    verify.mockResolvedValue({
      getPayload: () => ({
        sub: 'subject',
        email: 'Teacher@school.example',
        email_verified: true,
        hd: 'school.example',
        nonce: 'nonce',
      }),
    });
    expect(await googleVerifier('registered-client')('signed-token')).toEqual({
      sub: 'subject',
      email: 'teacher@school.example',
      domain: 'school.example',
      nonce: 'nonce',
    });
    expect(verify).toHaveBeenLastCalledWith({
      idToken: 'signed-token',
      audience: 'registered-client',
    });
  });
  it('accepts verified consumer accounts without hd and rejects unverified emails, missing subjects/nonces and failed verification', async () => {
    const valid = {
      sub: 'subject',
      email: 'student@school.example',
      email_verified: true,
      hd: 'school.example',
      nonce: 'nonce',
    };
    for (const override of [
      { email_verified: false },
      { nonce: undefined },
      { sub: undefined },
      { email: undefined },
    ]) {
      verify.mockResolvedValue({ getPayload: () => ({ ...valid, ...override }) });
      await expect(googleVerifier('client')('token')).rejects.toThrow();
    }
    verify.mockResolvedValue({
      getPayload: () => ({ ...valid, email: 'person@gmail.com', hd: undefined }),
    });
    expect(await googleVerifier('client')('consumer-token')).toMatchObject({
      email: 'person@gmail.com',
      domain: 'gmail.com',
    });
    verify.mockRejectedValue(new Error('Invalid signature or expired token'));
    await expect(googleVerifier('client')('forged-token')).rejects.toThrow();
  });
});
