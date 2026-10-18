# CLARIO

CLARIO는 교실 기기 관리 서비스 개발 프로젝트입니다. Google 개인 계정과 Workspace 계정으로 가입해 작업공간을 만들 수 있는 공개 가입 코드가 로컬에 구현되었습니다. 가입자는 해당 작업공간의 초기 관리자이며 이메일 도메인만으로 학교 소속을 검증하지 않습니다. 실제 Google OAuth client 설정·브라우저 로그인과 Chrome/Chromebook 실기기 검증은 아직 필요합니다. 기기 명부 등록 자체는 기기 인증·자동 연결이 아니며, 페어링도 하드웨어 attestation이 아닙니다. 강제 사이트/앱 차단·화면 확인·녹화는 구현되지 않았습니다.

제품 요구사항은 [PRD.md](./PRD.md), 시스템 구성은 [ARCHITECTURE.md](./ARCHITECTURE.md), 에이전트 지침은 [AGENT.md](./AGENT.md), 작업 상태는 [TASKS.md](./TASKS.md)를 참고하세요. Phase 0 기술 조사 결과는 [docs/phase-0-findings.md](./docs/phase-0-findings.md)에 있습니다.

학교 관리형 Chromebook의 **학생 웹 방문 없는 자동 연결**에 관한 조사와 조건은 [Chromebook Phase 0 문서](./docs/chromebook-phase-0.md)에 있습니다. 후속으로 일회성 코드 페어링·30초 상태 전송·학급 링크 전달 코드를 추가했습니다. [Device Client 설정과 제한](./docs/device-client.md)을 참고하세요. 기기 관리·학교 확장 배포 권한·실기기 연결·화면 캡처는 미검증입니다.

## 요구 환경

- Node.js 24 LTS 권장
- npm 11 이상

## 설치 및 실행

### 로그인 없이 화면 먼저 보기

`npm run dev:teacher` 실행 후 교사 앱을 열면 **대시보드 미리보기**를 볼 수 있습니다. Google 설정이나 API 연결 없이 학급 선택, 예시 기기 검색/상태 필터/상세, 자료 준비·삭제, 자율 집중 안내, 녹화 미제공 안내, 작업공간 이름 변경 화면을 확인합니다. 모든 데이터는 예시이며 현재 탭의 메모리에만 있고 새로고침하면 초기화됩니다. 서버 요청·실제 기기 제어·녹화는 하지 않습니다.

미리보기의 **로그인 · 가입**을 선택하면 기존 실제 인증 화면으로 이동합니다. 실제 서비스 이용에는 아래 OAuth·DB 설정이 필요하며 미리보기는 인증 우회 기능이 아닙니다.

### 입력 화면으로 최초 로컬 설정 (권장)

```powershell
npm run setup
```

터미널에 표시된 **`#` 이후를 포함한 전체 로컬 주소**를 브라우저에서 엽니다. Google OAuth 클라이언트 ID, 작업공간 이름·관리자 이메일·이름을 입력하면 로컬 PostgreSQL 시작, DB 마이그레이션, 작업공간·관리자 등록, `server/.env` 저장을 진행합니다. DB 비밀번호나 Google Client secret을 입력하지 않습니다.

설정 터미널은 DB 실행을 위해 유지하고, 화면에 안내된 `dev:server`, `dev:teacher`, `dev:student` 명령을 각각 별도 터미널에서 실행합니다. 이미 실행 중인 API는 해당 터미널에서 재시작해야 새 설정이 적용됩니다. 이후 다시 개발할 때는 `db:local`로 DB를 시작할 수 있습니다.

이 화면은 `127.0.0.1:5180`에서만 실행하는 **로컬 전용 도구**입니다. 공개 API에 설정 경로를 추가하지 않으며 Azure 배포 설정도 바꾸지 않습니다. 터미널 주소는 설정 권한을 포함하므로 공유하지 마세요. 기존 외부 DB/비표준 포트·허용 주소는 덮어쓰지 않습니다. Google Cloud의 OAuth 클라이언트 설정은 직접 필요합니다. 학교 계정 관리 권한은 개인 작업공간 생성에 필요하지 않지만, 학교가 관리하는 Google 계정의 로그인 정책은 적용됩니다.

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

서버는 프로젝트 루트의 `.env.example`을 `server/.env`로 복사해 로컬 설정을 지정할 수 있습니다. npm workspace로 실행하면 서버 폴더를 기준으로 설정을 읽습니다. 로컬 API의 `PORT` 기본값은 `4000`입니다. `NODE_ENV=production`이면 `0.0.0.0`, 그 외에는 `127.0.0.1`에 바인딩합니다. `.env`는 Git에서 제외됩니다. 로그인에는 `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `APP_ORIGINS`를 모두 설정하고 마이그레이션·학교 관리자 등록을 수행해야 합니다. 아무 인증 설정도 없으면 `/health`는 유지하고 `/api`는 설정 미완료(503)를 반환합니다.

**로그인 개발 시작:** [Phase 2 설정 안내](./docs/phase-2-authentication.md)에서 OAuth 클라이언트 준비 → 로컬 설정 화면 → 교사 앱에서 개인 작업공간 가입 순서로 진행하세요.

**학생 기기 등록:** 로그인 후 담당 작업공간 학급의 **학급 관리 → 학생 기기 등록**에서 학생·기기 이름·자산번호를 입력합니다. 기존 DB도 `npm run db:migrate --workspace @clario/server`로 버전 5까지 적용해야 합니다. 자세한 동작과 삭제 규칙은 [기기 명부 사용 안내](./docs/phase-2-authentication.md#학생-기기-명부-등록-추가-기능)를, 코드 발급·연결·자료 전달은 [Device Client 안내](./docs/device-client.md)를 참고하세요. 공개 가입 변경도 아직 배포하지 않았으므로 공개 사이트에는 반영되지 않았습니다.

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

공통 도메인 타입과 로그인 사용자 타입을 공유합니다. Phase 2 PostgreSQL 스키마·마이그레이션과 권한 검사 코드는 `server/src/`에, 교사·학생 공통 로그인/학급 UI는 `apps/common/`에 있습니다. [Phase 2 구현·검증 범위](./docs/phase-2-authentication.md)를 참고하세요.
