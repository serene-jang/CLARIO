import SchoolWorkspace from '../../common/SchoolWorkspace.js';
import DashboardPreview from '../../common/DashboardPreview.js';
import { useState } from 'react';

export default function App() {
  const [preview, setPreview] = useState(true);
  if (preview) return <DashboardPreview onConnect={() => setPreview(false)} />;
  return (
    <>
      <button className="preview-return" onClick={() => setPreview(true)}>
        ← 대시보드 미리보기로 돌아가기
      </button>
      <SchoolWorkspace audience="teacher" apiBase={import.meta.env.VITE_API_BASE_URL ?? ''} />
    </>
  );
}
