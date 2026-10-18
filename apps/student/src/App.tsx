import SchoolWorkspace from '../../common/SchoolWorkspace.js';

export default function App() {
  return <SchoolWorkspace audience="student" apiBase={import.meta.env.VITE_API_BASE_URL ?? ''} />;
}
