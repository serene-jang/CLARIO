import { featureSupportStates } from '@clario/shared';

export default function App() {
  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="CLARIO 교사 홈">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span>CLARIO</span>
        </a>
        <span className="environment-label">개발 환경</span>
      </header>

      <section className="welcome-panel" aria-labelledby="page-title">
        <p className="eyebrow">TEACHER WORKSPACE</p>
        <h1 id="page-title">수업을 위한 교사 공간</h1>
        <p className="intro">
          교사 앱 개발 기반이 준비되었습니다. 실제 학교 계정과 학급 데이터는 아직 연결되지
          않았습니다.
        </p>
        <div className="status-panel" role="status">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>서비스 연결 전</strong>
            <p>로그인, 학급 목록, 학생 기기 상태는 이후 단계에서 연결됩니다.</p>
          </div>
        </div>
        <p className="capability-note">
          화면 확인 지원 상태 예시: {featureSupportStates.join(' · ')}
        </p>
      </section>
      <footer>CLARIO · 학교 기기 관리</footer>
    </main>
  );
}
