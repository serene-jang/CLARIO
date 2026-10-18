export default function App() {
  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="CLARIO 학생 홈">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span>CLARIO</span>
        </a>
        <span className="environment-label">학생 공간</span>
      </header>

      <section className="welcome-panel" aria-labelledby="page-title">
        <p className="eyebrow">STUDENT WORKSPACE</p>
        <h1 id="page-title">수업에 연결할 준비를 해요</h1>
        <p className="intro">
          학교 계정과 수업 세션을 연결하면 교사가 공유한 수업 자료와 내 기기 상태를 확인할 수
          있습니다.
        </p>
        <div className="status-panel" role="status">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>학교 계정 연결 전</strong>
            <p>현재 로그인, 학급 연결, 화면 확인 또는 녹화 기능은 활성화되어 있지 않습니다.</p>
          </div>
        </div>
      </section>
      <footer>CLARIO · 학생 수업 공간</footer>
    </main>
  );
}
