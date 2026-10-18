import { useState } from 'react';
import './dashboard-preview.css';

type Page = 'classroom' | 'materials' | 'recordings' | 'settings';
type DeviceStatus = 'online' | 'offline' | 'unknown';
const pages: { id: Page; label: string; mark: string }[] = [
  { id: 'classroom', label: '내 교실', mark: '▦' },
  { id: 'materials', label: '수업 자료', mark: '↗' },
  { id: 'recordings', label: '녹화 보관함', mark: '▷' },
  { id: 'settings', label: '작업공간 설정', mark: '⚙' },
];
const students: { name: string; device: string; status: DeviceStatus }[] = [
  { name: '예시 학생 01', device: 'Chromebook · DEMO-001', status: 'online' },
  { name: '예시 학생 02', device: 'Windows · DEMO-002', status: 'online' },
  { name: '예시 학생 03', device: 'Chromebook · DEMO-003', status: 'offline' },
  { name: '예시 학생 04', device: 'macOS · DEMO-004', status: 'online' },
  { name: '예시 학생 05', device: 'Chromebook · DEMO-005', status: 'unknown' },
  { name: '예시 학생 06', device: 'Chromebook · DEMO-006', status: 'online' },
];
const statusLabels: Record<DeviceStatus, string> = {
  online: '온라인 예시',
  offline: '오프라인 예시',
  unknown: '상태 미확인',
};

export default function DashboardPreview({ onConnect }: { onConnect: () => void }) {
  const [page, setPage] = useState<Page>('classroom');
  const [className, setClassName] = useState('함께 배우는 교실');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState(false);
  const [selected, setSelected] = useState<(typeof students)[number] | null>(null);
  const [materials, setMaterials] = useState([
    { title: 'CLARIO 사용 안내', url: 'https://example.com', classroom: '함께 배우는 교실' },
  ]);
  const [notice, setNotice] = useState('');
  const [workspace, setWorkspace] = useState('나의 작업공간');
  const visible = students.filter(
    (student) =>
      (filter === 'all' || student.status === filter) &&
      `${student.name} ${student.device}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="clario-dashboard">
      <aside className="dashboard-sidebar">
        <a
          className="dashboard-logo"
          href="#preview"
          aria-label="CLARIO 미리보기 홈"
          onClick={() => setPage('classroom')}
        >
          <span>C</span> CLARIO<span className="logo-period">.</span>
        </a>
        <div className="workspace-identity">
          <span className="workspace-avatar">W</span>
          <div>
            <strong>{workspace}</strong>
            <small>개인 작업공간 · 화면 미리보기</small>
          </div>
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav aria-label="주 메뉴">
          {pages.map((item) => (
            <button
              key={item.id}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => {
                setPage(item.id);
                setNotice('');
              }}
            >
              <span aria-hidden="true">{item.mark}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-help">
          <span className="help-kicker">수업에만 집중하세요</span>
          <p>
            교실의 연결을
            <br />더 간편하게.
          </p>
          <button onClick={onConnect}>
            실제 계정 연결하기 <span aria-hidden="true">↗</span>
          </button>
        </div>
        <div className="sidebar-profile">
          <span className="profile-avatar">P</span>
          <div>
            <strong>미리보기 사용자</strong>
            <small>실제 계정 아님</small>
          </div>
        </div>
      </aside>
      <div className="dashboard-main">
        <header className="dashboard-topbar">
          <span>
            작업공간 <span className="breadcrumb-divider">/</span>{' '}
            <strong>{pages.find((item) => item.id === page)?.label}</strong>
          </span>
          <button className="dashboard-button secondary" onClick={onConnect}>
            로그인 · 가입
          </button>
        </header>
        <div className="preview-banner">
          <span>
            <strong>화면 미리보기</strong> · 모든 이름·연결 상태는 예시입니다. 실제 기기를
            조회하거나 제어하지 않습니다.
          </span>
          <span className="preview-pill">DEMO</span>
        </div>
        <main className="dashboard-content" id="preview">
          <div className="dashboard-page-heading">
            <div>
              <p className="dashboard-eyebrow">YOUR CONNECTED CLASSROOM</p>
              <h1>{pages.find((item) => item.id === page)?.label}</h1>
              <p>
                {page === 'classroom'
                  ? '함께 연결하고, 더 나은 수업을 만들어 보세요.'
                  : page === 'materials'
                    ? '수업에 필요한 링크를 한곳에서 준비하세요.'
                    : page === 'recordings'
                      ? '기록은 안전하게, 지원 여부는 명확하게.'
                      : '나에게 맞는 작업공간을 준비하세요.'}
              </p>
            </div>
            <span className="dashboard-mode">
              <span />
              미리보기 모드
            </span>
          </div>
          {notice && (
            <p className="dashboard-notice" role="status">
              {notice}
            </p>
          )}
          {page === 'classroom' && (
            <>
              <section className="dashboard-metrics" aria-label="예시 기기 현황">
                {[
                  ['등록 기기', '6', '이 교실의 예시 기기', 'purple'],
                  ['온라인 예시', '4', '실제 접속 수가 아닙니다', 'green'],
                  ['오프라인 예시', '1', '연결 끊김 화면 예시', 'orange'],
                  ['상태 미확인', '1', '연결 확인이 필요한 예시', 'gray'],
                ].map(([label, count, detail, color]) => (
                  <article key={label} className={`metric-card ${color}`}>
                    <span className="metric-label">{label}</span>
                    <strong>
                      {count}
                      <small>대</small>
                    </strong>
                    <span className="metric-detail">{detail}</span>
                  </article>
                ))}
              </section>
              <section className="classroom-toolbar" aria-label="학급 선택 및 수업 도구">
                <label className="class-picker">
                  학급 선택
                  <select
                    value={className}
                    onChange={(event) => {
                      setClassName(event.target.value);
                      setSelected(null);
                    }}
                  >
                    <option>함께 배우는 교실</option>
                    <option>방과 후 스터디</option>
                  </select>
                </label>
                <div className="classroom-actions">
                  <button
                    className="dashboard-button secondary"
                    aria-pressed={focus}
                    onClick={() => {
                      setFocus(!focus);
                      setNotice(
                        `집중 안내 ${focus ? '꺼짐' : '켜짐'}을 미리 봅니다. 실제 기기에는 전송되지 않습니다.`,
                      );
                    }}
                  >
                    {focus ? '집중 안내 끄기' : '집중 안내 켜기'}
                  </button>
                  <button className="dashboard-button primary" onClick={() => setPage('materials')}>
                    ＋ 자료 준비
                  </button>
                </div>
              </section>
              {focus && (
                <div className="focus-preview">
                  <strong>집중 안내 미리보기</strong>
                  <span>
                    학생에게 수업 자료에 집중하도록 안내합니다. 사이트나 앱을 차단하지 않습니다.
                  </span>
                </div>
              )}
              <div className="device-section-heading">
                <div>
                  <h2>{className}</h2>
                  <p>
                    학생 기기 <strong>6</strong>대 · 화면 확인·녹화 미제공
                  </p>
                </div>
                <div className="device-controls">
                  <label className="sr-only" htmlFor="device-search">
                    학생 또는 기기 검색
                  </label>
                  <input
                    id="device-search"
                    placeholder="학생 또는 기기 검색"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  <label className="sr-only" htmlFor="device-filter">
                    연결 상태 필터
                  </label>
                  <select
                    id="device-filter"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <option value="all">모든 상태</option>
                    <option value="online">온라인 예시</option>
                    <option value="offline">오프라인 예시</option>
                    <option value="unknown">상태 미확인</option>
                  </select>
                </div>
              </div>
              <section className="device-grid" aria-label="예시 학생 기기">
                {visible.map((student) => (
                  <button
                    className="preview-device"
                    key={student.name}
                    onClick={() => setSelected(student)}
                    aria-label={`${student.name} 기기 정보`}
                  >
                    <div className={`device-placeholder ${student.status}`}>
                      <span className="monitor-icon" aria-hidden="true" />
                      <strong>
                        {student.status === 'offline'
                          ? '기기 연결 끊김 예시'
                          : student.status === 'unknown'
                            ? '연결 상태 확인 필요'
                            : '공유된 화면이 없습니다'}
                      </strong>
                      <small>실시간 화면 미리보기가 아닙니다</small>
                      <span className="device-preview-tag">화면 확인 미제공</span>
                    </div>
                    <div className="device-card-footer">
                      <div>
                        <strong>{student.name}</strong>
                        <small>{student.device}</small>
                      </div>
                      <span className={`device-status ${student.status}`}>
                        {statusLabels[student.status]}
                      </span>
                    </div>
                  </button>
                ))}
              </section>
              {visible.length === 0 && (
                <div className="dashboard-empty">
                  <h3>검색 결과가 없습니다</h3>
                  <p>이름이나 연결 상태 필터를 변경해 주세요.</p>
                  <button
                    className="dashboard-button secondary"
                    onClick={() => {
                      setSearch('');
                      setFilter('all');
                    }}
                  >
                    검색 초기화
                  </button>
                </div>
              )}
              {selected && (
                <section className="device-detail" aria-label="선택한 예시 기기">
                  <div>
                    <h3>{selected.name}</h3>
                    <p>
                      {selected.device} · {statusLabels[selected.status]}
                    </p>
                  </div>
                  <p>
                    기기 카드 상세 화면 예시입니다. 화면 공유·녹화는 아직 구현되지 않았습니다. 실제
                    연결 시험은 로그인 후 기기를 등록하고 확장 프로그램을 페어링해야 합니다.
                  </p>
                  <button className="dashboard-button secondary" onClick={() => setSelected(null)}>
                    상세 닫기
                  </button>
                </section>
              )}
              <div className="dashboard-bottom-note">
                <span aria-hidden="true">◇</span> 학생 화면은 권한과 명확한 안내 없이 수집하지
                않습니다. 지원되지 않는 기능은 비활성 상태로 표시합니다.
              </div>
            </>
          )}
          {page === 'materials' && (
            <div className="materials-layout">
              <section className="dashboard-panel">
                <h2>새 자료 준비</h2>
                <p>미리보기 목록에만 추가됩니다. 학생에게 전송하거나 서버에 저장하지 않습니다.</p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const data = new FormData(form);
                    const url = new URL(String(data.get('url')));
                    if (url.protocol !== 'https:' || url.username || url.password) {
                      setNotice('로그인 정보가 포함되지 않은 HTTPS 주소를 입력해 주세요.');
                      return;
                    }
                    setMaterials((current) => [
                      {
                        title: String(data.get('title')).trim(),
                        url: url.href,
                        classroom: String(data.get('classroom')),
                      },
                      ...current,
                    ]);
                    form.reset();
                    setNotice('미리보기 목록에 자료를 추가했습니다. 실제 전송은 하지 않았습니다.');
                  }}
                >
                  <label>
                    자료 제목
                    <input
                      name="title"
                      required
                      maxLength={100}
                      placeholder="예: 오늘의 수업 자료"
                      pattern=".*\S.*"
                    />
                  </label>
                  <label>
                    자료 링크
                    <input
                      name="url"
                      type="url"
                      required
                      maxLength={2048}
                      placeholder="https://..."
                    />
                  </label>
                  <label>
                    대상 학급
                    <select name="classroom">
                      <option>함께 배우는 교실</option>
                      <option>방과 후 스터디</option>
                    </select>
                  </label>
                  <button className="dashboard-button primary">미리보기 목록에 추가</button>
                </form>
              </section>
              <section className="dashboard-panel">
                <div className="panel-title">
                  <h2>준비한 자료</h2>
                  <span className="count-pill">{materials.length}</span>
                </div>
                {materials.length === 0 ? (
                  <p>준비한 예시 자료가 없습니다.</p>
                ) : (
                  <ul className="prepared-materials">
                    {materials.map((material, index) => (
                      <li key={`${material.url}-${index}`}>
                        <span className="material-icon" aria-hidden="true">
                          ↗
                        </span>
                        <div>
                          <strong>{material.title}</strong>
                          <small>{material.classroom} · 미전송</small>
                          <a href={material.url} target="_blank" rel="noreferrer">
                            {material.url}
                          </a>
                        </div>
                        <button
                          className="dashboard-text-button"
                          aria-label={`${material.title} 미리보기 삭제`}
                          onClick={() => {
                            setMaterials((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            );
                            setNotice('예시 목록에서 삭제했습니다.');
                          }}
                        >
                          삭제
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
          {page === 'recordings' && (
            <section className="dashboard-panel recording-panel">
              <span className="recording-symbol" aria-hidden="true">
                ▷
              </span>
              <span className="preview-pill">아직 제공하지 않는 기능</span>
              <h2>녹화 기능을 준비하고 있습니다</h2>
              <p>
                녹화된 파일이 있는 것처럼 예시 영상을 표시하지 않습니다.
                <br />
                학교·작업공간 승인, 대상 기기의 캡처 권한, 보호된 저장소와 보관·삭제 정책 구현이
                필요합니다.
              </p>
              <div className="recording-requirements">
                <div>
                  <strong>01 · 고지 및 권한</strong>
                  <span>참여자에게 명확한 안내와 적절한 권한 확보</span>
                </div>
                <div>
                  <strong>02 · 안전한 보관</strong>
                  <span>접근 제어 및 저장·전송 암호화</span>
                </div>
                <div>
                  <strong>03 · 보관 기한</strong>
                  <span>기한 만료와 실제 파일 삭제 검증</span>
                </div>
              </div>
              <button className="dashboard-button secondary" onClick={() => setPage('classroom')}>
                교실로 돌아가기
              </button>
            </section>
          )}
          {page === 'settings' && (
            <div className="settings-layout">
              <section className="dashboard-panel">
                <h2>작업공간 정보</h2>
                <p>이 화면에서 바꾼 이름은 현재 미리보기에서만 유지됩니다.</p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    setWorkspace(String(data.get('workspace')).trim());
                    setNotice('미리보기 이름을 변경했습니다. 서버에는 저장하지 않았습니다.');
                  }}
                >
                  <label>
                    작업공간 이름
                    <input
                      name="workspace"
                      defaultValue={workspace}
                      required
                      maxLength={100}
                      pattern=".*\S.*"
                    />
                  </label>
                  <button className="dashboard-button primary">미리보기 이름 변경</button>
                </form>
              </section>
              <section className="dashboard-panel">
                <h2>실제 사용 준비</h2>
                <ul className="setup-checklist">
                  <li>
                    <span>1</span>
                    <div>
                      <strong>서비스 로그인 설정</strong>
                      <p>
                        서비스 운영자가 Google OAuth 클라이언트를 설정합니다. 일반 사용자는
                        클라이언트 ID를 발급할 필요가 없습니다.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>내 작업공간 만들기</strong>
                      <p>
                        개인 Google 계정으로도 가입할 수 있습니다. 현재 실제 로그인 설정과 배포
                        확인은 필요합니다.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <strong>구성원과 기기 연결</strong>
                      <p>
                        구성원을 초대하고 기기 등록 후 일회성 코드로 확장 프로그램을 연결합니다.
                      </p>
                    </div>
                  </li>
                </ul>
                <button className="dashboard-button secondary" onClick={onConnect}>
                  실제 로그인 화면으로
                </button>
              </section>
            </div>
          )}
        </main>
        <footer className="dashboard-footer">
          <span>CLARIO · 더 나은 연결, 더 나은 수업</span>
          <span>예시 데이터 · 새로고침 시 초기화 · 서버 저장 없음</span>
        </footer>
      </div>
    </div>
  );
}
