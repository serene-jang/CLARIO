import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClassMaterial, RegisteredDevice } from '@clario/shared';

interface Props {
  classId: string;
  token: string;
  members: { id: string; name: string; email: string }[];
  api: <T>(path: string, token?: string, method?: string, body?: object) => Promise<T>;
}

export default function DeviceRegistry({ classId, token, members, api }: Props) {
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [materials, setMaterials] = useState<ClassMaterial[]>([]);
  const [focusMode, setFocusMode] = useState<boolean | null>(null);
  const requestVersion = useRef(0);
  const active = useRef(true);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setState('loading');
    setError('');
    try {
      const [result, materialResult, focus] = await Promise.all([
        api<{ devices: RegisteredDevice[] }>(`/classes/${classId}/devices`, token),
        api<{ materials: ClassMaterial[] }>(`/classes/${classId}/materials`, token),
        api<{ enabled: boolean }>(`/classes/${classId}/focus`, token),
      ]);
      if (active.current && version === requestVersion.current) {
        setDevices(result.devices);
        setMaterials(materialResult.materials);
        setFocusMode(focus.enabled);
        setState('ready');
      }
    } catch (cause) {
      if (active.current && version === requestVersion.current) {
        setDevices([]);
        setMaterials([]);
        setFocusMode(null);
        setState('error');
        setError(cause instanceof Error ? cause.message : '기기 목록을 불러오지 못했습니다.');
      }
    }
  }, [api, classId, token]);
  useEffect(() => {
    active.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => {
      window.clearInterval(timer);
      active.current = false;
      requestVersion.current++;
    };
  }, [refresh, members]);

  async function toggleFocus() {
    if (busy || focusMode === null) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/classes/${classId}/focus`, token, 'PATCH', { enabled: !focusMode });
      if (!active.current) return;
      setNotice(
        '자율 집중 안내 상태를 저장했습니다. 학생 클라이언트의 다음 상태 확인 시 반영됩니다.',
      );
      await refresh();
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : '집중 안내 변경 실패');
    } finally {
      if (active.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(
      () => setPairing(null),
      Math.max(0, Date.parse(pairing.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [pairing]);

  async function deviceAction(device: RegisteredDevice, pairingRequested: boolean) {
    if (busy) return;
    if (
      !window.confirm(
        pairingRequested
          ? `${device.name}의 기존 연결을 해제하고 새 연결 코드를 만들까요? 코드는 해당 기기에서만 입력하세요.`
          : `${device.name}의 연결 권한을 해제할까요?`,
      )
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    setPairing(null);
    try {
      const result = await api<{ code: string; expiresAt: string }>(
        `/classes/${classId}/devices/${device.id}/${pairingRequested ? 'pairing' : 'connection'}`,
        token,
        pairingRequested ? 'POST' : 'DELETE',
        pairingRequested ? {} : undefined,
      );
      if (!active.current) return;
      if (pairingRequested) setPairing(result);
      else setNotice('기기 연결 권한을 해제했습니다.');
      await refresh();
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : '연결 설정 실패');
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function sendMaterial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(
        `/classes/${classId}/materials`,
        token,
        'POST',
        Object.fromEntries(new FormData(form)),
      );
      if (!active.current) return;
      form.reset();
      setNotice('자료를 전달 대기열에 등록했습니다. 수신·열기 여부는 별도로 확인해 주세요.');
      await refresh();
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : '자료 전달 실패');
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function deleteMaterial(material: ClassMaterial) {
    if (
      busy ||
      !window.confirm(
        `${material.title} 자료 전달을 취소하고 목록에서 삭제할까요? 이미 열린 탭은 닫히지 않습니다.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/classes/${classId}/materials/${material.id}`, token, 'DELETE');
      if (active.current) {
        setNotice('자료를 삭제했습니다. 이미 열린 페이지에는 적용되지 않습니다.');
        await refresh();
      }
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : '자료 삭제 실패');
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/classes/${classId}/devices`, token, 'POST', Object.fromEntries(data));
      if (!active.current) return;
      form.reset();
      setNotice('기기 명부를 저장했습니다. 실제 기기 연결은 아직 확인되지 않았습니다.');
      await refresh();
    } catch (cause) {
      if (active.current) {
        setError(cause instanceof Error ? cause.message : '기기를 등록하지 못했습니다.');
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function remove(device: RegisteredDevice) {
    if (busy || !window.confirm(`${device.name} 기기를 명부에서 등록 해제할까요?`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/classes/${classId}/devices/${device.id}`, token, 'DELETE');
      if (!active.current) return;
      setNotice('기기 명부에서 등록 해제했습니다.');
      await refresh();
    } catch (cause) {
      if (active.current) {
        setError(cause instanceof Error ? cause.message : '기기 등록을 해제하지 못했습니다.');
      }
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <section aria-labelledby="devices-title">
      <h3 id="devices-title">학생 기기 등록</h3>
      <p>
        기기를 명부에 등록한 뒤 연결 코드를 학교가 승인한 CLARIO 확장 프로그램에 입력하세요. 이것은
        최초 페어링이며 관리형 실물 Chromebook 증명은 아닙니다. 화면 확인·녹화는 제공하지 않습니다.
      </p>
      <form onSubmit={(event) => void save(event)}>
        <label>
          기기를 사용할 학생
          <select name="studentId" required defaultValue="" disabled={busy || members.length === 0}>
            <option value="" disabled>
              학생을 선택하세요
            </option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name} ({member.email})
              </option>
            ))}
          </select>
        </label>
        <label>
          기기 이름
          <input
            name="name"
            required
            maxLength={100}
            disabled={busy}
            placeholder="예: 1반 Chromebook 01"
          />
        </label>
        <label>
          학교 자산번호
          <input
            name="assetNumber"
            required
            maxLength={100}
            disabled={busy}
            placeholder="예: SCHOOL-CB-001"
          />
        </label>
        <button disabled={busy || members.length === 0}>기기 등록 저장</button>
      </form>
      {members.length === 0 && <p>학급에 학생을 먼저 등록해 주세요.</p>}
      <p>
        자산번호는 학교 안에서 중복될 수 없습니다. 학생을 학급에서 제외하거나 학급을 보관하면 해당
        기기 등록도 해제됩니다.
      </p>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="message" role="status">
          {notice}
        </p>
      )}
      {pairing && (
        <div className="message" role="status">
          <p>최초 연결 코드 (1회 사용 · {new Date(pairing.expiresAt).toLocaleTimeString()} 만료)</p>
          <code>{pairing.code}</code>
          <p>해당 학생 기기에서만 입력하세요. 다른 사람에게 전달하지 마세요.</p>
          <button type="button" onClick={() => setPairing(null)}>
            연결 코드 숨기기
          </button>
        </div>
      )}
      <p>
        기기는 약 30초 간격으로 상태를 전송하고, 이 화면은 15초마다 갱신합니다. 90초 이상 수신이
        없으면 오프라인입니다.
      </p>
      {state === 'loading' && <p role="status">기기 명부를 확인하고 있습니다.</p>}
      {state === 'error' && <p>기기 명부를 확인하지 못했습니다. 다시 불러와 주세요.</p>}
      <button type="button" disabled={busy || state === 'loading'} onClick={() => void refresh()}>
        기기 목록 다시 불러오기
      </button>
      {state === 'ready' && devices.length === 0 && <p>등록된 기기가 없습니다.</p>}
      {state === 'ready' && (
        <ul className="workspace-list">
          {devices.map((device) => (
            <li key={device.id}>
              <span>
                <strong>{device.name}</strong> · {device.studentName} · 자산번호:{' '}
                {device.assetNumber}
                <br />
                {device.connectionState === 'connected'
                  ? '온라인'
                  : device.connectionState === 'disconnected'
                    ? '오프라인'
                    : '연결 미확인'}
                {' · 화면 확인·녹화 지원 미검증'}
                {device.lastSeenAt && (
                  <> · 마지막 수신: {new Date(device.lastSeenAt).toLocaleString()}</>
                )}
              </span>
              <button type="button" disabled={busy} onClick={() => void deviceAction(device, true)}>
                {device.name} 연결 코드 발급
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void deviceAction(device, false)}
              >
                {device.name} 연결 권한 해제
              </button>
              <button type="button" disabled={busy} onClick={() => void remove(device)}>
                {device.name} 등록 해제
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>자율 집중 안내</h3>
      <p>
        학생 확장 프로그램에 집중 수업 상태와 자료를 안내합니다. 다른 웹사이트·앱을 차단하거나
        학생의 집중 여부를 감시하지 않습니다.
      </p>
      <p>학급 안내 설정: {focusMode === null ? '확인 불가' : focusMode ? '켜짐' : '꺼짐'}</p>
      <button
        type="button"
        disabled={busy || focusMode === null || state !== 'ready'}
        onClick={() => void toggleFocus()}
      >
        {focusMode ? '자율 집중 안내 종료' : '자율 집중 안내 시작'}
      </button>
      <h3>학급 자료 전달</h3>
      <p>
        현재 등록된 기기에 전달합니다. 오프라인 기기는 7일 안에 재연결하면 수신합니다. 이후 등록한
        기기는 이전 자료의 전달 대상이 아닙니다.
      </p>
      <form onSubmit={(event) => void sendMaterial(event)}>
        <label>
          자료 제목
          <input name="title" required maxLength={100} disabled={busy} />
        </label>
        <label>
          자료 HTTPS 주소
          <input
            name="url"
            type="url"
            required
            maxLength={2048}
            disabled={busy}
            placeholder="https://"
          />
        </label>
        <button disabled={busy || devices.length === 0 || state !== 'ready'}>
          학급에 자료 보내기
        </button>
      </form>
      {state === 'ready' && materials.length === 0 && <p>전달 중인 자료가 없습니다.</p>}
      {state === 'ready' && (
        <ul className="workspace-list">
          {materials.map((material) => (
            <li key={material.id}>
              <span>
                <a href={material.url} target="_blank" rel="noopener noreferrer">
                  {material.title}
                </a>
                {' · '}대상 {material.deliveries.length}대 · 수신{' '}
                {material.deliveries.filter((item) => item.receivedAt).length}대{' · '}열기{' '}
                {material.deliveries.filter((item) => item.openedAt).length}대
                <br />
                {material.deliveries.map((delivery) => (
                  <small key={delivery.deviceId}>
                    {devices.find((device) => device.id === delivery.deviceId)?.name ??
                      '등록 해제된 기기'}
                    :{' '}
                    {delivery.openedAt
                      ? '열기 확인'
                      : delivery.receivedAt
                        ? '수신 확인'
                        : '수신 대기'}
                    {' · '}
                  </small>
                ))}
              </span>
              <button type="button" disabled={busy} onClick={() => void deleteMaterial(material)}>
                자료 삭제
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
