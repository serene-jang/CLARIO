export const userRoles = ['teacher', 'student', 'school_admin'] as const;
export type UserRole = (typeof userRoles)[number];

export interface CurrentUser {
  id: string;
  schoolId: string;
  email: string;
  name: string;
  role: UserRole;
}

export const deviceConnectionStates = ['connected', 'disconnected', 'unknown'] as const;
export interface IdentityUser {
  id: string;
  email: string;
  name: string;
}

export type ClassroomRole = 'manager' | 'student';
export type MembershipStatus =
  'pending' | 'approved' | 'rejected' | 'left' | 'removed' | 'blocked' | 'cancelled';

export interface IdentityClassroom {
  id: string;
  name: string;
  role: ClassroomRole;
  closedAt?: string | null;
  archivedAt?: string | null;
}

export interface ClassroomRosterEntry extends StudentInformation {
  id: string;
}
export interface ManagedClassroom {
  id: string;
  name: string;
  capacity: number;
  approvalRequired: true;
  closedAt: string | null;
  archivedAt: string | null;
  invitation: {
    id: string | null;
    status: 'none' | 'active' | 'expired' | 'revoked';
    expiresAt: string | null;
  };
  roster: ClassroomRosterEntry[];
}
export interface IssuedClassroomInvitation {
  id: string;
  code: string;
  expiresAt: string;
}
export interface ClassroomManagementResponse {
  classroom: ManagedClassroom;
  invitation?: IssuedClassroomInvitation;
}

export interface IdentitySession {
  token: string;
  user: IdentityUser;
  capabilities: { canCreateClassroom: boolean };
  expiresAt: string;
}

export const classroomPolicy = {
  canCreateClassroom: true,
  approvalRequiredByDefault: true,
  defaultCapacity: 40,
  maximumCapacity: 100,
  invitationAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  invitationLength: 12,
  invitationLifetimeMs: 24 * 60 * 60 * 1000,
  joinWindowMs: 15 * 60 * 1000,
  joinAttemptsPerBrowser: 10,
  joinAttemptsPerIp: 100,
  joinAttemptsPerCode: 100,
  maximumPendingRequests: 100,
  pendingCredentialLifetimeMs: 30 * 60 * 1000,
  participationIdleLifetimeMs: 2 * 60 * 60 * 1000,
  participationAbsoluteLifetimeMs: 12 * 60 * 60 * 1000,
} as const;

export interface StudentInformation {
  name: string;
  studentNumber: string;
}

export type StudentParticipantStatus = 'approved' | 'left' | 'removed' | 'blocked';
export interface SyntheticMediaRun {
  id: string;
  participantId: string;
  lessonId: string;
  synthetic: true;
  startedAt: string;
  frameAt: string | null;
  frame: string | null;
  bytes: number;
  status: 'recording' | 'uploading' | 'ready' | 'failed';
}
export interface SyntheticMediaView {
  enabled: boolean;
  synthetic: true;
  lessonId?: string;
  observedAt?: string;
  targets?: { id: string; name: string; studentNumber: string }[];
  runs?: SyntheticMediaRun[];
}
export type StudentJoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type StudentCredentialScope = 'pending' | 'participant';

export type StudentSessionView =
  | { state: 'none'; joinAvailable: boolean }
  | {
      state: 'request';
      status: StudentJoinRequestStatus;
      student: StudentInformation;
      csrfToken: string;
      expiresAt: string;
    }
  | {
      state: 'participant';
      classroom: { id: string; name: string };
      student: StudentInformation;
      csrfToken: string;
      expiresAt: string;
    };

export interface StudentParticipant extends StudentInformation {
  id: string;
  classroomId: string;
  status: StudentParticipantStatus;
}

export interface StudentJoinInput extends StudentInformation {
  code: string;
  kind: 'join' | 'recovery';
}
export interface StudentJoinReview extends StudentInformation {
  id: string;
  kind: 'join' | 'recovery';
  status: StudentJoinRequestStatus;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  rosterMatch: 'not_configured' | 'match' | 'number_only' | 'not_found';
  existingStatus: StudentParticipantStatus | null;
}

export interface ManagedStudentParticipant extends StudentParticipant {
  erasureRequestedAt?: string | null;
  credentialGeneration: number;
  approvedAt: string;
  updatedAt: string;
  rosterMatch: StudentJoinReview['rosterMatch'];
  connectionState: 'unavailable';
}
export interface ParticipantListResponse {
  participants: ManagedStudentParticipant[];
  total: number;
  page: number;
  pageSize: number;
}

export const presencePolicy = {
  heartbeatMs: 10000,
  teacherPollMs: 5000,
  requestTimeoutMs: 5000,
  freshMs: 20000,
  leaseMs: 45000,
  maximumActiveTabs: 16,
  requestsPerMinute: 240,
} as const;
export interface ClassroomLesson {
  id: string;
  startedAt: string;
}
export interface StudentLessonView {
  lesson: ClassroomLesson | null;
  observedAt: string;
  expiresAt: string;
}
export interface ClassroomFocusView {
  enabled: boolean;
  version: number;
  updatedAt: string;
  observedAt: string;
  lesson: ClassroomLesson | null;
}
export interface StudentFocusView extends ClassroomFocusView {
  expiresAt: string;
}
export type StudentPresenceState = 'online' | 'reconnecting' | 'offline';
export interface ClassroomPresence extends StudentInformation {
  id: string;
  state: StudentPresenceState;
  lastSeenAt: string | null;
}
export interface ClassroomMaterial {
  id: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  receivedAt: string | null;
  openedAt: string | null;
}
export interface ManagedClassroomMaterial extends ClassroomMaterial {
  url: string;
  audience: 'all' | 'selected';
  recipientCount: number;
  receivedCount: number;
  openedCount: number;
}
export interface MaterialList<T extends ClassroomMaterial = ClassroomMaterial> {
  materials: T[];
  total: number;
  page: number;
  pageSize: number;
  observedAt: string;
  expiresAt?: string;
}
export interface TeacherLessonView {
  lesson: ClassroomLesson | null;
  observedAt: string;
  students: ClassroomPresence[];
  counts: Record<StudentPresenceState, number>;
}

export type StudentInformationResult =
  { ok: true; value: StudentInformation } | { ok: false; error: string };

export function normalizeStudentInformation(input: {
  name: unknown;
  studentNumber: unknown;
}): StudentInformationResult {
  if (typeof input.name !== 'string' || typeof input.studentNumber !== 'string') {
    return { ok: false, error: '이름과 학번을 문자열로 입력해 주세요.' };
  }
  const name = input.name.normalize('NFC').trim();
  const studentNumber = input.studentNumber.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 100) {
    return { ok: false, error: '이름은 앞뒤 공백을 제외한 1~100자로 입력해 주세요.' };
  }
  if (!/^[0-9]{1,20}$/.test(studentNumber)) {
    return { ok: false, error: '학번은 1~20자리 숫자로 입력해 주세요. 앞자리 0은 유지됩니다.' };
  }
  return { ok: true, value: { name, studentNumber } };
}
export type DeviceConnectionState = (typeof deviceConnectionStates)[number];

export const featureSupportStates = [
  'supported',
  'unsupported',
  'permission_required',
  'unverified',
] as const;
export type FeatureSupportState = (typeof featureSupportStates)[number];

export const recordingStates = [
  'pending',
  'checking_permission',
  'recording',
  'uploading',
  'saved',
  'partially_failed',
  'failed',
  'deletion_pending',
  'deleted',
] as const;
export type RecordingState = (typeof recordingStates)[number];

export interface School {
  id: string;
  name: string;
}

export interface Classroom {
  id: string;
  schoolId: School['id'];
  name: string;
}

export interface ClassSession {
  id: string;
  classroomId: Classroom['id'];
  startedAt: string;
  endedAt?: string;
}

export interface StudentDevice {
  id: string;
  schoolId: School['id'];
  studentId: string;
  connectionState: DeviceConnectionState;
  screenViewingSupport: FeatureSupportState;
  recordingSupport: FeatureSupportState;
  lastConnectedAt?: string;
}

export interface RegisteredDevice {
  id: string;
  studentId: string;
  studentName: string;
  name: string;
  assetNumber: string;
  connectionState: DeviceConnectionState;
  lastSeenAt: string | null;
  screenViewingSupport: 'unverified';
  recordingSupport: 'unverified';
}

export interface ClassMaterial {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  deliveries: { deviceId: string; receivedAt: string | null; openedAt: string | null }[];
}

export interface Recording {
  id: string;
  schoolId: School['id'];
  classroomId: Classroom['id'];
  sessionId: ClassSession['id'];
  deviceId: StudentDevice['id'];
  state: RecordingState;
  startedAt?: string;
  endedAt?: string;
  retentionExpiresAt?: string;
  errorCode?: string;
}
