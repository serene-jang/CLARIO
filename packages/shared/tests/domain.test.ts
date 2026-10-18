import { describe, expect, it } from 'vitest';
import {
  deviceConnectionStates,
  featureSupportStates,
  recordingStates,
  userRoles,
} from '../src/index.js';

describe('shared domain constants', () => {
  it('defines the supported user roles', () => {
    expect(userRoles).toEqual(['teacher', 'student', 'school_admin']);
  });

  it('keeps unverified capabilities distinct from supported capabilities', () => {
    expect(featureSupportStates).toContain('unverified');
    expect(featureSupportStates).toContain('unsupported');
    expect(featureSupportStates).toContain('supported');
  });

  it('defines recording and device connection states', () => {
    expect(recordingStates).toContain('recording');
    expect(recordingStates).toContain('partially_failed');
    expect(recordingStates).toContain('deletion_pending');
    expect(recordingStates).toContain('deleted');
    expect(deviceConnectionStates).toContain('unknown');
  });
});
