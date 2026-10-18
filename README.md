# CLARIO

CLARIO는 교실 기기 관리 서비스 개발 프로젝트입니다. 현재 저장소에는 Teacher 웹 앱, Student 클라이언트, Backend API의 **개발 기반만** 구성되어 있습니다. 로그인, 학교/학급 데이터 연동, 기기 상태 수집, 화면 확인 및 녹화 기능은 아직 구현되지 않았습니다.

제품 요구사항은 [PRD.md](./PRD.md), 시스템 구성은 [ARCHITECTURE.md](./ARCHITECTURE.md), 에이전트 지침은 [AGENT.md](./AGENT.md), 작업 상태는 [TASKS.md](./TASKS.md)를 참고하세요. Phase 0 기술 조사 결과는 [docs/phase-0-findings.md](./docs/phase-0-findings.md)에 있습니다.

## 요구 환경

- Node.js 24 LTS 권장
- npm 11 이상

## 설치 및 실행

프로젝트 루트에서 의존성을 설치합니다.

```powershell
npm install
```

각 앱은 별도 터미널에서 실행합니다.

```powershell
npm run dev:teacher
npm run dev:student
npm run dev:server
```

개발 서버 주소:

- Teacher: http://127.0.0.1:5173
- Student: http://127.0.0.1:5174
- API health check: http://127.0.0.1:4000/health

서버는 프로젝트 루트의 `.env.example`을 `server/.env`로 복사해 로컬 설정을 지정할 수 있습니다. npm workspace로 실행하면 서버 폴더를 기준으로 설정을 읽습니다. 로컬 API의 `PORT` 기본값은 `4000`입니다. `NODE_ENV=production`이면 배포 환경의 외부 요청을 받도록 `0.0.0.0`에 바인딩하고, 그 외에는 기존처럼 `127.0.0.1`에 바인딩합니다. 실제 비밀 값이나 OAuth 자격 증명은 아직 필요하지 않으며 `.env`는 Git에서 제외됩니다.

빌드 후 저장소 루트에서 `npm start`로 API를 실행할 수 있습니다. Azure 배포 분석과 진행 상태는 [docs/azure-deployment.md](./docs/azure-deployment.md)를 참고하세요.

## Azure 자동 배포

`main`에 push하면 GitHub Actions가 포맷·타입·테스트·전체 빌드를 검사한 뒤 Azure 무료 시험 환경에 배포합니다. PR에서는 검사만 실행합니다. 배포 인증은 OIDC를 사용하며, 실제 배포 결과는 [Actions](https://github.com/serene-jang/CLARIO/actions)에서 확인합니다.

- [교사 웹](https://thankful-flower-0c61c7200.6.azurestaticapps.net)
- [학생 웹](https://polite-desert-0eb612f00.2.azurestaticapps.net)
- [API 상태 확인](https://app-clario-dev-42e4.azurewebsites.net/health)

무료 시험 환경이며 실제 학교 운영용 서비스가 아닙니다. 현재는 기반 화면과 상태 확인 API만 구현되어 있습니다. 구성·제한·복구 방법은 [배포 문서](./docs/azure-deployment.md)를 참고하세요.

## 검증 명령

```powershell
npm test
npm run typecheck
npm run build
npm run format:check
```

## 워크스페이스

- `apps/teacher`: 교사용 React + TypeScript + Vite 앱
- `apps/student`: 학생용 React + TypeScript + Vite 앱
- `server`: Express + TypeScript API 개발 서버
- `packages/shared`: 사용자 역할, 기기 상태, 기능 지원 상태, 녹화 상태와 기본 도메인 타입

공유 도메인 모델은 현재 타입 기반의 시작점입니다. PostgreSQL 연결, DB 스키마/마이그레이션 및 데이터 저장은 이후 Phase에서 요구사항을 구체화한 뒤 구현합니다.
