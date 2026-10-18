import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeviceRegistry from './DeviceRegistry.js';
import type { RegisteredDevice } from '@clario/shared';

afterEach(cleanup);
const members = [{ id: 'student-id', name: 'Student One', email: 'student@school.example' }];
const device: RegisteredDevice = {
  id: 'device-id',
  studentId: 'student-id',
  studentName: 'Student One',
  name: 'Chromebook One',
  assetNumber: 'CB-001',
  connectionState: 'unknown',
  lastSeenAt: null,
  screenViewingSupport: 'unverified',
  recordingSupport: 'unverified',
};
function setup(initialDevices: RegisteredDevice[] = []) {
  let devices: RegisteredDevice[] = initialDevices;
  const requests = vi.fn<
    (path: string, token?: string, method?: string, body?: object) => Promise<unknown>
  >(async (_path, _token, method = 'GET') => {
    if (_path.endsWith('/materials')) return { materials: [] };
    if (_path.endsWith('/focus')) return { enabled: false };
    if (method === 'POST') {
      devices = [device];
      return { id: device.id };
    }
    if (method === 'DELETE') {
      devices = [];
      return undefined;
    }
    return { devices };
  });
  const api = async <T,>(
    path: string,
    token?: string,
    method?: string,
    body?: object,
  ): Promise<T> => (await requests(path, token, method, body)) as T;
  render(createElement(DeviceRegistry, { classId: 'class-id', token: 'token', members, api }));
  return requests;
}
describe('device registration form', () => {
  it('persists the selected student, name and asset, reloads inventory, and unregisters', async () => {
    const requests = setup();
    expect(await screen.findByText('등록된 기기가 없습니다.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('기기를 사용할 학생'), {
      target: { value: 'student-id' },
    });
    fireEvent.change(screen.getByLabelText('기기 이름'), { target: { value: device.name } });
    fireEvent.change(screen.getByLabelText('학교 자산번호'), {
      target: { value: device.assetNumber },
    });
    fireEvent.click(screen.getByText('기기 등록 저장'));
    expect(await screen.findByText(device.name)).toBeTruthy();
    expect(requests).toHaveBeenCalledWith('/classes/class-id/devices', 'token', 'POST', {
      studentId: 'student-id',
      name: device.name,
      assetNumber: device.assetNumber,
    });
    expect(screen.getByText(/연결 미확인 · 화면 확인·녹화 지원 미검증/)).toBeTruthy();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText(`${device.name} 등록 해제`));
    expect(await screen.findByText('등록된 기기가 없습니다.')).toBeTruthy();
    expect(requests).toHaveBeenCalledWith(
      '/classes/class-id/devices/device-id',
      'token',
      'DELETE',
      undefined,
    );
    confirm.mockRestore();
  });
  it('preserves input and displays a failed save without reporting success', async () => {
    const requests = setup();
    await screen.findByText('등록된 기기가 없습니다.');
    requests.mockRejectedValueOnce(new Error('학교에 이미 등록된 자산번호입니다.'));
    fireEvent.change(screen.getByLabelText('기기를 사용할 학생'), {
      target: { value: 'student-id' },
    });
    fireEvent.change(screen.getByLabelText('기기 이름'), { target: { value: device.name } });
    fireEvent.change(screen.getByLabelText('학교 자산번호'), {
      target: { value: device.assetNumber },
    });
    fireEvent.click(screen.getByText('기기 등록 저장'));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '학교에 이미 등록된 자산번호입니다.',
    );
    expect(screen.getByLabelText('학교 자산번호')).toHaveProperty('value', device.assetNumber);
    expect(screen.queryByText(/기기 명부를 저장했습니다/)).toBeNull();
  });
  it('distinguishes a failed list request from an empty list and supports retry', async () => {
    const requests = setup();
    await screen.findByText('등록된 기기가 없습니다.');
    requests.mockRejectedValueOnce(new Error('기기 조회 실패'));
    fireEvent.click(screen.getByText('기기 목록 다시 불러오기'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '기기 조회 실패');
    expect(screen.queryByText('등록된 기기가 없습니다.')).toBeNull();
    fireEvent.click(screen.getByText('기기 목록 다시 불러오기'));
    expect(await screen.findByText('등록된 기기가 없습니다.')).toBeTruthy();
  });
  it('does not allow registration without class members', async () => {
    const api = async <T,>(): Promise<T> => ({ devices: [], materials: [], enabled: false }) as T;
    render(
      createElement(DeviceRegistry, { classId: 'class-id', token: 'token', members: [], api }),
    );
    await waitFor(() =>
      expect(screen.getByText('기기 등록 저장')).toHaveProperty('disabled', true),
    );
    expect(screen.getByText('학급에 학생을 먼저 등록해 주세요.')).toBeTruthy();
  });
  it('issues one-time codes and can revoke a device connection', async () => {
    const requests = setup([device]);
    await screen.findByText(device.name);
    const implementation = requests.getMockImplementation()!;
    requests.mockImplementation(async (path, token, method, body) => {
      if (path.endsWith('/pairing'))
        return { code: 'A'.repeat(32), expiresAt: new Date(Date.now() + 300000).toISOString() };
      if (path.endsWith('/connection')) return undefined;
      return implementation(path, token, method, body);
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText(`${device.name} 연결 코드 발급`));
    expect(await screen.findByText('A'.repeat(32))).toBeTruthy();
    expect(requests).toHaveBeenCalledWith(
      '/classes/class-id/devices/device-id/pairing',
      'token',
      'POST',
      {},
    );
    fireEvent.click(screen.getByText(`${device.name} 연결 권한 해제`));
    expect(await screen.findByText('기기 연결 권한을 해제했습니다.')).toBeTruthy();
    expect(screen.queryByText('A'.repeat(32))).toBeNull();
    confirm.mockRestore();
  });
  it('queues classroom materials without claiming they were received or opened', async () => {
    const requests = setup([device]);
    await screen.findByText(device.name);
    const implementation = requests.getMockImplementation()!;
    let sent = false;
    requests.mockImplementation(async (path, token, method, body) => {
      if (path.endsWith('/materials')) {
        if (method === 'POST') {
          sent = true;
          return { id: 'material' };
        }
        return {
          materials: sent
            ? [
                {
                  id: 'material',
                  title: 'Lesson',
                  url: 'https://example.com/lesson',
                  deliveries: [{ deviceId: device.id, receivedAt: null, openedAt: null }],
                },
              ]
            : [],
        };
      }
      return implementation(path, token, method, body);
    });
    fireEvent.change(screen.getByLabelText('자료 제목'), { target: { value: 'Lesson' } });
    fireEvent.change(screen.getByLabelText('자료 HTTPS 주소'), {
      target: { value: 'https://example.com/lesson' },
    });
    fireEvent.click(screen.getByText('학급에 자료 보내기'));
    expect(await screen.findByText('Lesson')).toBeTruthy();
    expect(screen.getByText(/수신 0대/)).toBeTruthy();
    expect(requests).toHaveBeenCalledWith('/classes/class-id/materials', 'token', 'POST', {
      title: 'Lesson',
      url: 'https://example.com/lesson',
    });
  });
  it('sets only a voluntary focus notice without claiming website blocking', async () => {
    const requests = setup([device]);
    await screen.findByText(device.name);
    fireEvent.click(screen.getByText('자율 집중 안내 시작'));
    await waitFor(() =>
      expect(requests).toHaveBeenCalledWith('/classes/class-id/focus', 'token', 'PATCH', {
        enabled: true,
      }),
    );
    expect(screen.getByText(/다른 웹사이트·앱을 차단하거나/)).toBeTruthy();
  });
});
