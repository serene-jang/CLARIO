import { describe, expect, it } from 'vitest';
import { classroomPolicy, normalizeStudentInformation } from '../src/index.js';

describe('approved classroom policy', () => {
  it('requires teacher approval independently of Google identity and roster matching', () => {
    expect(classroomPolicy.canCreateClassroom).toBe(true);
    expect(classroomPolicy.approvalRequiredByDefault).toBe(true);
    expect(classroomPolicy.defaultCapacity).toBe(40);
    expect(classroomPolicy.maximumCapacity).toBe(100);
  });
  it('uses the approved invitation space, expiry and distinct future join limits', () => {
    expect(classroomPolicy.invitationAlphabet).toHaveLength(32);
    expect(new Set(classroomPolicy.invitationAlphabet).size).toBe(32);
    expect(classroomPolicy.invitationAlphabet).not.toMatch(/[IO01]/);
    expect(classroomPolicy.invitationLength).toBe(12);
    expect(classroomPolicy.invitationLifetimeMs).toBe(86400000);
    expect(classroomPolicy.joinWindowMs).toBe(900000);
    expect(classroomPolicy.joinAttemptsPerBrowser).toBe(10);
    expect(classroomPolicy.joinAttemptsPerIp).toBe(100);
  });
  it('defines bounded pending and approved credentials without extending absolute lifetime', () => {
    expect(classroomPolicy.pendingCredentialLifetimeMs).toBe(30 * 60 * 1000);
    expect(classroomPolicy.participationIdleLifetimeMs).toBe(2 * 60 * 60 * 1000);
    expect(classroomPolicy.participationAbsoluteLifetimeMs).toBe(12 * 60 * 60 * 1000);
  });
});

describe('student information normalization', () => {
  it('normalizes Unicode names and trims strings without dropping leading zeros', () => {
    expect(
      normalizeStudentInformation({ name: '  김 학생  ', studentNumber: ' 00102 ' }),
    ).toEqual({ ok: true, value: { name: '김 학생', studentNumber: '00102' } });
  });

  it.each([
    { name: '', studentNumber: '1' },
    { name: ' '.repeat(3), studentNumber: '1' },
    { name: '가'.repeat(101), studentNumber: '1' },
    { name: 123, studentNumber: '1' },
    { name: 'Student', studentNumber: 102 },
    { name: 'Student', studentNumber: '' },
    { name: 'Student', studentNumber: '1'.repeat(21) },
    { name: 'Student', studentNumber: '１２３' },
    { name: 'Student', studentNumber: '1 02' },
    { name: 'Student', studentNumber: '1e3' },
  ])('returns an explicit error for invalid name/number %#', (input) => {
    expect(normalizeStudentInformation(input)).toMatchObject({
      ok: false,
      error: expect.any(String),
    });
  });

  it('counts Unicode code points consistently with PostgreSQL character limits', () => {
    expect(
      normalizeStudentInformation({ name: '𠮷'.repeat(100), studentNumber: '0'.repeat(20) }).ok,
    ).toBe(true);
  });
});
