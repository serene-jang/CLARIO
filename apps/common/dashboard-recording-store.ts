export interface DashboardRecording {
  id: string;
  classroomId: string;
  classroomName: string;
  startedAt: string;
  durationMs: number;
  size: number;
  complete: boolean;
  blob: Blob;
}

const databaseName = 'clario-dashboard-recordings';
const storeName = 'recordings';
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB)
    return Promise.reject(new Error('이 브라우저는 녹화 보관을 지원하지 않습니다.'));
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('녹화 보관소를 열 수 없습니다.'));
    request.onblocked = () => reject(new Error('다른 탭에서 녹화 보관소를 사용 중입니다.'));
  }).catch((cause) => {
    database = undefined;
    throw cause;
  });
  return database!;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('녹화 보관 작업에 실패했습니다.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('녹화 보관 작업이 취소되었습니다.'));
  });
}

export async function saveDashboardRecording(recording: DashboardRecording): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(recording);
  await transactionDone(transaction);
}

export async function listDashboardRecordings(): Promise<DashboardRecording[]> {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readonly');
  const request = transaction.objectStore(storeName).getAll() as IDBRequest<DashboardRecording[]>;
  const records = await new Promise<DashboardRecording[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('녹화 목록을 읽을 수 없습니다.'));
  });
  await transactionDone(transaction);
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function deleteDashboardRecording(id: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(id);
  await transactionDone(transaction);
}

export function downloadDashboardRecording(recording: DashboardRecording) {
  const url = URL.createObjectURL(recording.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${recording.classroomName}-${recording.startedAt.replace(/[:.]/g, '-')}.webm`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
