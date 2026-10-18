# CLARIO Azure 배포 사전 분석

## 현재 진행 상태

사용자는 이후 무료 리소스 자동 생성·GitHub push·실제 배포를 승인했다. 아래 Portal 절차는 수동 재구성 참고용이며 다시 실행할 필요가 없다.

현재 `rg-clario-dev-42e4`에 F1 API, Free 정적 웹 2개 및 OIDC 배포 ID를 생성했다. `infra/main.bicep`에 인프라를 기록했고 `.github/workflows/azure-deploy.yml`에 자동 배포를 구성했다. 아래 URL은 생성된 리소스의 실제 주소이며, 애플리케이션 배포 검증 결과는 마지막 절에 기록한다.

- 교사: https://thankful-flower-0c61c7200.6.azurestaticapps.net
- 학생: https://polite-desert-0eb612f00.2.azurestaticapps.net
- API: https://app-clario-dev-42e4.azurewebsites.net/health

## 1. 확인한 프로젝트 구성

| 구성 | 현재 기술 / 위치 | 배포 산출물 |
|---|---|---|
| 교사 웹 | React 19 + TypeScript + Vite 7, `apps/teacher` | `apps/teacher/dist` |
| 학생 웹 | React 19 + TypeScript + Vite 7, `apps/student` | `apps/student/dist` |
| API | Node.js + TypeScript + Express 5, `server` | `server/dist` |
| 공통 패키지 | npm workspace `@clario/shared`, `packages/shared` | `packages/shared/dist` |
| 데이터베이스 | PostgreSQL은 설계 후보이며 연결 코드·스키마·마이그레이션 없음 | 지금은 생성 불필요 |
| 녹화 저장소 | 미구현 | 지금은 생성 불필요 |

현재 웹은 기반 화면이며 API는 `GET /health`만 제공한다. 로그인, 학생 실시간 연결, 자료 전송, 화면 확인 및 녹화는 구현되어 있지 않다. 배포 성공을 해당 기능의 완성으로 해석하면 안 된다. 실제 학생 데이터는 입력하지 않는다.

구성 전 원격 Actions 목록은 비어 있었다. 단일 배포 워크플로만 추가했으며 중복 배포는 없다.

## 2. 서비스 후보와 비용

기존 구조를 보존하는 우선 후보:

- 교사 웹: Azure Static Web Apps Free 1개
- 학생 웹: Azure Static Web Apps Free 1개
- API: Azure App Service Linux 1개
- DB 및 녹화 저장소: 관련 기능 구현 시 별도 결정

Static Web Apps의 API 빌드는 Azure Functions용이다. 기존 Express 서버를 `api_location`에 지정한다고 App Service API로 배포되는 것은 아니다. 기존 Express 앱을 Functions로 변환하지 않는다.

| 서비스 | 예상 기본 비용 | 조건 |
|---|---|---|
| Static Web Apps Free 2개 | 무료 한도 내 US$0 | 앱별 크기, 대역폭 등 한도 적용. SLA 없음 |
| App Service Linux F1 | 무료 한도 내 US$0 | 일 60 CPU분, 공유 자원, SLA 없음. 시험·학습용이며 운영용 아님 |
| App Service Linux B1 | 예시 US$13.14/월 | 한국 중부 소매가 US$0.018/시간 × 730시간, 인스턴스 1개 |

B1 가격은 Azure Retail Prices API의 `Azure App Service Basic Plan - Linux`, `B1`, `koreacentral`, `Consumption` 항목으로 조회한 참고값이다. 이 지역을 배포 대상으로 확정하거나 할당량을 검증한 것은 아니다. 계약, 환율, 세금, 전송량, 모니터링 및 추가 서비스는 별도다. Portal의 실제 예상 요금을 최종 확인한다. App Service는 앱을 중지해도 유료 플랜을 유지하면 비용이 발생할 수 있다.

F1로 시험할 경우 GitHub Actions에서 미리 빌드한 산출물 배포를 검토한다. TypeScript 빌드가 필요하다는 이유만으로 F1 자체가 기술적으로 불가능하다고 단정하지 않는다. 가용성·CPU 제한 때문에 지속 사용에는 B1을 우선 검토한다.

## 3. 확인한 빌드·실행 명령과 환경 변수

저장소 루트에서:

```sh
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
```

공통 패키지를 먼저 빌드하도록 기존 스크립트가 구성되어 있다. 앱 하위 폴더만 독립 프로젝트처럼 설치·빌드하면 workspace 의존성 문제가 생길 수 있다.

- API 컴파일 후 실행 파일: `node server/dist/index.js` (저장소 루트 기준).
- 빌드 후 저장소 루트의 `npm start`는 서버 workspace의 `node dist/index.js`를 실행한다.
- API는 `PORT`와 `NODE_ENV`를 읽는다. Azure가 제공하는 포트를 사용하며 로컬 기본값은 4000이다. App Service에 `NODE_ENV=production`을 설정한다.
- 프런트엔드는 아직 API를 호출하지 않는다. 현재 사용하지 않는 API URL 변수나 CORS 설정은 추가하지 않는다.
- `DATABASE_URL`, OAuth 키, 스토리지 키는 현재 필요하지 않으며 임의로 만들지 않는다.
- 로컬 설정은 `.env.example`을 `server/.env`로 복사한다. README도 npm workspace 실행 기준으로 일치시켰다. Azure에서는 로컬 `.env`가 아닌 앱 환경 설정을 사용한다.

사용자 승인 후 `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`를 실행했으며 모두 통과했다(테스트 4개). 의존성 재설치는 하지 않았다. 빌드된 API의 개발 모드(127.0.0.1)와 프로덕션 모드(0.0.0.0)에서 `/health`가 HTTP 200과 정확한 `{"status":"ok"}`를 반환함을 확인하고 테스트 프로세스를 종료했다. 이는 로컬 검증이며 Azure 배포 성공을 의미하지 않는다.

## 4. 배포 전 최소 변경 및 준비 사항

1. 승인받아 API가 `NODE_ENV=production`일 때 `0.0.0.0`에 바인딩하도록 변경했다. 개발 기본값 `127.0.0.1`, PORT 검증 및 API 동작은 유지한다.
2. 승인받아 루트와 서버에 프로덕션 시작 스크립트를 추가했다.
3. 배포 산출물에 필요한 프로덕션 의존성과 workspace 패키지를 포함하는 방식을 검증한다. Windows의 로컬 `node_modules`를 Linux 서버에 그대로 올리지 않는다.
4. 지원되는 Node.js 런타임을 대상 App Service에서 확인하고 CI 버전과 일치시킨다.
5. 사용자가 후속으로 자동 생성을 승인했다. 환경은 시험용 dev, 리소스 그룹은 `rg-clario-dev-42e4`, API 지역은 한국 중부, 웹 지역은 동아시아다. F1 및 Free 이외 요금제를 생성하지 않았다.

## 5. CI/CD 구성 방향

App Service Portal의 생성 화면 또는 Deployment Center는 GitHub 저장소와 `main` 브랜치를 연결해 워크플로를 생성할 수 있다. 기본 인증을 끄고 사용자 할당 관리 ID를 사용하는 OIDC 인증을 우선한다. ID 생성, 역할 부여 및 페더레이션 설정 권한이 없으면 관리자의 도움이 필요하다.

Portal이 생성한 워크플로를 먼저 가져와 검토한 뒤 수정한다. 별도 중복 배포 워크플로를 만들지 않는다. 기본 템플릿만으로 현재 모노레포의 workspace 빌드·패키징이 올바르다고 가정하지 않는다.

확정할 파이프라인의 필수 조건:

- PR에서는 품질 검사만 수행하고 배포 권한이나 비밀 값을 제공하지 않는다.
- `main` push에서 설치 → 포맷·타입·테스트 → 빌드가 성공해야 배포한다.
- 배포 작업은 검증 작업을 `needs`로 의존한다. `always()`나 실패 무시로 배포를 강행하지 않는다.
- 검증된 같은 커밋의 산출물을 배포한다.
- API OIDC 권한은 대상 앱에 필요한 범위로 제한한다.
- Static Web Apps의 인증은 해당 서비스의 지원 방식을 별도 확인한다. App Service용 `azure/login`을 추가하는 것만으로 Static Web Apps 인증까지 해결됐다고 판단하지 않는다.
- 배포 후 두 웹의 실제 응답과 API `/health`의 상태 코드·응답 본문을 검증한다.
- 여러 서비스가 순차 또는 병렬 배포될 경우 원자적 배포가 보장되는 것은 아니다. 일부 실패를 전체 성공으로 표시하지 않는다.

후속 자동 생성 승인 후 모노레포용 워크플로를 직접 구성했다. Portal 자동 생성은 GitHub 대화형 연결 및 기본 단일 앱 빌드를 전제로 하므로, 미검증 기본 배포를 먼저 실행하지 않고 root workspace 검사·Linux 패키징을 포함하는 워크플로 하나를 추가했다.

## 6. 무료 시험 배포를 위한 Portal 준비 순서

### 사전 확인

- 선택한 구독에서 Linux의 `NODE|24-lts` 지원은 조회로 확인했다.
- 한국 중부와 동아시아의 F1 할당량은 확인하지 못했다. 할당량 API에서 `Microsoft.Quota` 공급자 미등록 문제가 발생했으며 자동 등록하거나 리소스를 생성하지 않았다. 따라서 어느 지역에서든 F1 생성이 반드시 가능하다고 보장하지 않는다.
- Static Web Apps 리소스 위치로 동아시아 지원을 확인했다. 정적 콘텐츠는 전역 제공되므로 App Service와 리소스 위치가 반드시 같을 필요는 없다.
- 조회상 구독에 기존 Static Web Apps 2개가 있다. 이번 CLARIO 리소스라고 가정하지 않고 변경하지 않는다. 신규 앱 2개는 문서상 무료 앱 한도 10개 이내지만 생성 시점의 정책·한도를 최종 확인한다.
- Portal에서 F1을 선택할 수 없거나 제한 오류가 나면 중단하고 오류 메시지를 기록한다. B1 등 유료 요금제로 자동 변경하지 않는다.
- 모든 구성은 데모용 `dev` 환경으로 한정한다. 실제 학생 데이터와 학교 운영 용도로 사용하지 않는다.

### A. 리소스 그룹

1. [Azure Portal](https://portal.azure.com/)에서 사용할 구독을 확인한다.
2. **리소스 그룹 → 만들기**에서 예를 들어 `rg-clario-dev`를 생성한다. 이미 같은 이름이 있다면 내용을 먼저 확인하고 무작정 재사용하지 않는다.
3. 지역은 Portal에서 무료 플랜의 생성 가능 여부를 확인한 후 선택한다. 한국 중부는 후보일 뿐 확정된 지역이 아니다.

### B. API용 App Service

1. **App Services → 만들기 → 웹앱**으로 이동한다.
2. 선택한 구독·리소스 그룹과 전역 고유 앱 이름을 입력한다. 게시 방식은 **코드**, 런타임은 **Node 24 LTS**, 운영체제는 **Linux**를 선택한다.
3. App Service 플랜의 가격 책정에서 반드시 **F1 / Free**를 명시적으로 선택한다. 기본 선택이 유료 플랜일 수 있다.
4. 이 단계에서는 **지속적인 배포를 끈 상태**로 만든다. 모노레포 패키징을 검토하지 않은 기본 워크플로가 즉시 실행되는 것을 피하기 위해서다. Application Insights 등 유료 부가 서비스도 추가하지 않는다.
5. **검토 + 만들기**에서 F1과 기본 요금 0을 확인한다. 무료 가용성/정책 오류가 있으면 만들기를 진행하지 않는다.
6. 생성 후 **설정 → 환경 변수**에서 `NODE_ENV=production`을 설정한다. `PORT`는 Azure 런타임이 제공하는 값을 사용하며 임의로 4000에 고정하지 않는다.
7. **구성 → 일반 설정/스택 설정**의 시작 명령은 저장소 구조를 보존한 배포 산출물 기준 `npm start`로 사용할 예정이다. 설정 후 저장한다. F1에서 Always On은 켜지 않는다.
8. **개요**에서 기본 도메인과 리소스 ID를 기록한다. 아직 코드가 배포되지 않았으므로 `/health` 성공을 기대하지 않는다.

### C. 교사·학생용 Static Web Apps

각각 별도 리소스로 만든다.

1. **Static Web Apps → 만들기**에서 동일 구독·리소스 그룹과 앱 이름을 입력한다.
2. 요금제는 **Free**를 선택한다. 위치가 필요하면 지원이 확인된 **East Asia(동아시아)**를 후보로 사용한다.
3. Portal에서 배포 소스 **기타/Other**를 사용할 수 있으면 우선 배포 연동 없이 리소스만 생성한다. 이후 GitHub 연결 시 자동 생성되는 워크플로를 검토한다.
4. Portal 흐름상 처음부터 GitHub 연결이 필요하면 `serene-jang/CLARIO`, `main`을 선택한다. 빌드 프리셋은 **Custom**으로 지정한다.
5. 앱 위치 `/`, API 위치는 **비움**, 출력 위치는 교사용 `apps/teacher/dist`, 학생용 `apps/student/dist`로 입력한다. Express 서버를 API 위치에 넣지 않는다.
6. GitHub 연결은 워크플로 파일을 main에 자동 추가하고 실행할 수 있다. 현재 로컬의 미push 변경이 있으므로 나중에 원격 변경을 보존하며 동기화해야 한다. 초기 워크플로는 Node 버전·workspace·검증 게이트 조정 전 실패할 수 있으며, 이 상태를 배포 완료로 처리하지 않는다.
7. **개요**에서 각 리소스 ID, 이름 및 URL을 기록한다. 배포 토큰은 공유하거나 문서에 붙여 넣지 않는다.

### D. Portal 자동 워크플로와 OIDC 연결

리소스 정보 확인과 로컬 변경의 안전한 동기화 후 진행한다.

1. App Service의 **배포 센터 → 설정**에서 GitHub, 저장소, `main`을 선택한다.
2. 인증 방식은 **사용자 할당 ID / OpenID Connect**를 선택하고 기본 게시 인증은 끈다. 기존 앱 실행용 ID와 배포용 ID를 혼동하지 않는다.
3. Portal이 ID를 만들거나 선택하도록 한다. 권한 부족 오류가 있으면 학교/구독 관리자에게 도움을 요청하며 광범위한 구독 Contributor를 임의 부여하지 않는다.
4. Portal이 생성하는 워크플로를 먼저 확인한다. Node 단일 앱용 기본 템플릿을 그대로 완료 처리하지 않는다.
5. 생성된 파일을 바탕으로 루트 설치·workspace 순서, 검증 성공 의존성, Linux 런타임 패키징, 배포 후 검사를 추가한다. 별도의 중복 API 배포 워크플로를 만들지 않는다.
6. Portal이 생성한 OIDC subject가 main 브랜치 기준이면 워크플로에 GitHub environment를 추가할 때 subject도 맞춰야 한다. 예: environment `dev` 사용 시 `repo:serene-jang/CLARIO:environment:dev`. 불일치 상태로 배포하지 않는다.
7. Static Web Apps 자동 워크플로와 해당 리소스의 비밀 설정도 별도 검토한다. 각 앱의 인증 값을 섞지 않는다. 장기 토큰이 필요한 구성이라면 해당 앱의 GitHub Actions secret에만 저장하고 로그에 출력하지 않는다.

## 7. 검증 방법과 이후 작업 흐름

실제 파이프라인 구축 후 확인할 내용:

1. GitHub 저장소의 **Actions**에서 해당 main 커밋의 실행을 연다. 검증·빌드·API·교사 웹·학생 웹이 모두 성공했는지 각각 확인한다. 녹색 체크 하나만으로 전체 배포 성공을 판단하지 않는다.
2. 검증 실패 시 배포 작업이 skipped인지 확인한다. PR 실행에는 배포 작업이 없어야 한다.
3. 웹 URL은 각 Static Web Apps의 **개요 → URL**, API URL은 App Service의 **개요 → 기본 도메인**에서 확인한다. 도메인 형식을 추정하지 말고 실제 값을 사용한다.
4. 두 웹은 배포된 화면과 실제 응답을 확인한다. API는 기본 도메인의 `/health`가 HTTP 200과 `{"status":"ok"}`를 반환해야 한다.
5. API가 유휴 후 느리게 시작하거나 CPU 한도를 초과하면 F1 제한 여부를 확인한다. 무조건 재배포하거나 성공 상태로 숨기지 않는다.

향후 흐름은 **코드 수정 → 로컬 검증 → 커밋 → main push → GitHub Actions 검증·빌드 → 성공한 산출물 배포 → URL/health 검증**이다. 구성 완료 전에는 push만으로 배포되는 상태가 아니다.

## 8. 실제 자동 배포 구성

### 트리거 및 검증

- `main` push와 수동 실행: 검사·빌드 성공 후 배포.
- main 대상 PR: 검사·빌드만 수행. OIDC 권한과 배포 작업 없음.
- 동시 실행은 순차 처리하며 진행 중 배포를 취소하지 않는다.
- 기존 포맷, 타입, 단위 테스트와 배포 검증기 테스트가 모두 성공해야 빌드 산출물을 생성한다.
- Ubuntu Node 24에서 전체 빌드 후 개발 의존성을 제거하고 API runtime ZIP을 생성한다. 공통 패키지와 운영 의존성을 포함하며 `.env`나 소스 전체를 업로드하지 않는다.
- 각 배포는 같은 실행에서 만든 산출물만 사용한다. GitHub 보관 기간은 3일이다.
- API부터 검증한 후 교사·학생 웹을 순서대로 배포한다. 원자적 배포는 아니며, 중간 실패 시 Actions에 실패로 표시한다.
- 각 웹 검사는 현재 빌드의 제목·JS/CSS 파일명과 파일 바이트를 비교한다. 오래된 페이지나 Azure 기본 페이지만으로 성공 처리하지 않는다.

### 인증과 GitHub 설정

GitHub **Settings → Secrets and variables → Actions → Variables**:

| 변수 | 용도 |
|---|---|
| `AZURE_CLIENT_ID` | 배포용 사용자 할당 관리 ID의 client ID |
| `AZURE_TENANT_ID` | Azure tenant |
| `AZURE_SUBSCRIPTION_ID` | 배포 대상 구독 |
| `AZURE_RESOURCE_GROUP` | `rg-clario-dev-42e4` |
| `AZURE_API_APP` | `app-clario-dev-42e4` |
| `AZURE_TEACHER_APP` | `swa-teacher-clario-dev-42e4` |
| `AZURE_STUDENT_APP` | `swa-student-clario-dev-42e4` |

이 값은 비밀 인증키가 아니다. client secret, 게시 프로필 또는 구독 전체 권한을 저장하지 않는다.

관리 ID `id-clario-dev-42e4`는 새 CLARIO 리소스 그룹에만 Contributor 역할을 가진다. OIDC issuer는 `https://token.actions.githubusercontent.com`, subject는 `repo:serene-jang/CLARIO:ref:refs/heads/main`, audience는 `api://AzureADTokenExchange`다. 워크플로에 GitHub environment를 추가하거나 저장소 이름을 바꾸면 subject도 함께 변경해야 한다.

App Service는 OIDC 로그인으로 배포하며 SCM/FTP 기본 인증은 꺼져 있다. Static Web Apps 배포 action에는 서비스 전용 토큰이 필요하므로 OIDC 로그인 후 Azure에서 실행 중 조회한다. 토큰은 즉시 마스킹하고 같은 job에만 전달하며 GitHub secret이나 저장소에 장기 복사하지 않는다. 배포 ID의 그룹 권한으로 토큰을 조회할 수 있으므로 main 및 워크플로 수정 권한을 신뢰하는 관리자에게만 부여한다.

인프라 템플릿은 매 push마다 적용하지 않는다. 파이프라인은 배포 직전 실제 요금제가 F1/Free인지 확인하고 다르면 실패한다. 워크플로의 Actions 참조는 조회한 커밋 SHA로 고정했다.

### 장애 대응 및 비용

- 실패한 단계의 Actions 로그에서 원인을 확인한다. 비밀 값은 로그에 출력하지 않는다.
- 이전 정상 커밋으로 되돌리는 새 커밋을 main에 push하면 재배포한다. 자동 롤백·배포 슬롯은 없다.
- F1은 유휴 중지·공유 CPU 제한이 있고 학교 운영용 SLA는 제공하지 않는다. 로그인과 학교 데이터 격리는 아직 미구현이다.
- 시험 종료 시 이 프로젝트만 정리하려면 Portal에서 `rg-clario-dev-42e4` 내부를 확인한 후 그룹을 삭제하고 GitHub Actions 워크플로를 비활성화한다. 다른 프로젝트 그룹을 삭제하지 않는다. GitHub 변수 및 OIDC ID도 정리한다.

### 검증 기록

- Azure 인프라 생성: 성공.
- F1/Free 리소스 및 그룹 한정 배포 역할: 조회 확인.
- 로컬 기존 테스트 4개 및 추가 검증기 테스트 2개: 통과.
- 실제 GitHub Actions 및 배포 URL 검증: 첫 push 후 기록 예정. 아직 성공으로 단정하지 않는다.

## 공식 참고 자료

- [Static Web Apps 요금제](https://learn.microsoft.com/en-us/azure/static-web-apps/plans)
- [Static Web Apps 빌드 설정](https://learn.microsoft.com/en-us/azure/static-web-apps/build-configuration)
- [App Service GitHub Actions 및 Portal OIDC 설정](https://learn.microsoft.com/en-us/azure/app-service/deploy-github-actions)
- [App Service Linux 가격과 Free 제한](https://azure.microsoft.com/en-us/pricing/details/app-service/linux/)
- [App Service 플랜과 과금](https://learn.microsoft.com/en-us/azure/app-service/overview-hosting-plans)
- [Azure Retail Prices API](https://prices.azure.com/api/retail/prices)
