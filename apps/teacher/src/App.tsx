import DashboardPreview from '../../common/DashboardPreview.js';
import { useState } from 'react';
import IdentityWorkspace from '../../common/IdentityWorkspace.js';

export default function App() {
  const [preview, setPreview] = useState(false);
  if (preview) return <DashboardPreview onConnect={() => setPreview(false)} />;
  return (
    <>
      <button className="preview-return" onClick={() => setPreview(true)}>
        예시 대시보드 보기 · 실제 교실 아님
      </button>
      <IdentityWorkspace
        audience="teacher"
        apiBase={import.meta.env.VITE_API_BASE_URL ?? ''}
        allowGoogle={false}
        onDemo={() => setPreview(true)}
      />
    </>
  );
}
