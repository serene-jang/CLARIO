import { useState } from 'react';
import './school.css';

type Stage = 'join' | 'pending' | 'classroom';

export default function StudentPreview({ onExit }: { onExit: () => void }) {
  const [stage, setStage] = useState<Stage>('join');
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  return (
    <main className="page-shell">
      <header className="topbar">
        <span className="brand">CLARIO</span>
        <span>학생 데모</span>
      </header>
      <section className="welcome-panel school-workspace" aria-label="학생 데모">
        <h1>학생 수업 화면 둘러보기</h1>
        <p className="message" role="note">
          데모 전용 예시입니다. 입력값은 이 브라우저에서만 사용하며 전송·저장하지 않습니다. 실제
          교실 참여나 교사 승인, 녹화가 진행되지 않습니다.
        </p>
        {stage === 'join' && (
          <>
            <h2>초대코드로 참여 신청</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setStage('pending');
              }}
            >
              <label>
                예시 초대코드
                <input value="DEMO-ONLY" readOnly aria-label="예시 초대코드" />
              </label>
              <label>
                이름
                <input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                학번
                <input
                  required
                  maxLength={20}
                  inputMode="numeric"
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                />
              </label>
              <button type="submit">예시 참여 흐름 보기</button>
            </form>
            <p>예시 코드는 실제 교실 초대코드가 아니며 어느 서버에도 전송되지 않습니다.</p>
          </>
        )}
        {stage === 'pending' && (
          <>
            <h2>교사 승인 대기 예시</h2>
            <p role="status">
              {name} · 학번 {number} · 예시 요청 상태입니다. 실제 교사에게 신청이 전달되지
              않았습니다.
            </p>
            <button type="button" onClick={() => setStage('classroom')}>
              예시 승인 후 화면 보기
            </button>
            <button type="button" onClick={() => setStage('join')}>
              신청 화면으로 돌아가기
            </button>
          </>
        )}
        {stage === 'classroom' && (
          <>
            <h2>함께 배우는 교실 · 데모</h2>
            <p>
              {name} · 학번 {number}
            </p>
            <p role="status">수업 연결 예시 · 실제 교실 서버에 연결되지 않았습니다.</p>
            <section aria-label="수업 자료 데모">
              <h3>수업 자료 예시</h3>
              <ul>
                <li>수업 안내 자료 · 예시 링크 (다운로드 불가)</li>
              </ul>
            </section>
            <section aria-label="학생 개인정보 안내">
              <h3>화면·녹화 상태</h3>
              <p>실제 화면 확인이나 녹화는 시작되지 않았습니다.</p>
            </section>
            <button type="button" onClick={() => setStage('join')}>
              데모 참여 종료
            </button>
          </>
        )}
        <button type="button" onClick={onExit}>
          실제 학생 참여 화면으로 돌아가기
        </button>
      </section>
    </main>
  );
}
