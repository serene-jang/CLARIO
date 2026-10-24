import { useState } from 'react';
import StudentWorkspace from '../../common/StudentWorkspace.js';
import StudentPreview from '../../common/StudentPreview.js';

export default function App() {
  const [preview, setPreview] = useState(false);
  return preview ? (
    <StudentPreview onExit={() => setPreview(false)} />
  ) : (
    <StudentWorkspace onDemo={() => setPreview(true)} />
  );
}
