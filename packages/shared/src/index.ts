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
