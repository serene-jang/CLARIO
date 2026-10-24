# CLARIO Azure 배포 사전 분석

## 현재 10·11단계 — 로컬 운영 준비

이 절은 아래 **과거 시험 배포 기록보다 우선**한다. 이번 범위는 코드·CI/CD·합성 인증/임시 PostgreSQL 로컬 검증이다. 실제 OAuth·운영 DB·새 Azure 리소스·비밀·저장소 설정·push·배포를 수행하지 않는다. 기존 Free/F1 주소를 새 학생 흐름의 배포 완료로 해석하지 않는다.

### 같은 원본 실행과 준비 점검

1. Node 24/npm 11과 기존 의존성으로 루트에서 `npm run build`한다. 두 웹은 상대 자산을 사용하므로 기존 정적 사이트 루트와 중앙 서버 하위 경로 모두에 배포할 수 있다. 같은 원본 모드는 `VITE_API_BASE_URL`을 비워 빌드한다. 비밀은 웹 빌드 변수에 넣지 않는다.
2. 서비스 중단/이전 산출물·환경 기록과 검증된 DB 백업/복구를 먼저 준비한다. 새 DB도 기존 DB도 `DATABASE_URL`을 서버 비밀 설정으로 제공하고 `npm run db:migrate --workspace @clario/server`로 **버전 12**까지 명시적으로 적용한다. 시작 시 자동 migrate하지 않는다. 운영 DB를 이번 작업에서 생성/변경하지 않았다.
3. `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `APP_ORIGINS`는 모두 설정하거나 모두 생략한다. `APP_ORIGINS`는 경로 없는 정확한 원본이며 운영 HTTPS를 사용한다. 교사 OAuth 승인 원본도 그 원본과 일치해야 한다. 교사 로그인은 실제 Google 검증을 사용하며 합성 fixture는 제품 실행 경로에 없다.
4. `SERVE_WEB=true`로 `npm start`하면 같은 호스트의 `/teacher/`, `/student/`, `/api`를 제공한다. `/`는 `/teacher/`로 이동한다. 기본 미설정/false는 기존 API 전용이다. 잘못된 플래그나 빌드 누락은 시작 실패다. TLS 종료 지점은 원래 Host를 보존해야 한다. 임의 `X-Forwarded-*` 신뢰를 켜지 말고 실제 프록시/공유 IP 한도를 별도 검증한다.
5. `/health` 200은 프로세스 응답만 뜻한다. `/ready`는 인증 설정·현재 스키마 존재 시 200 `{"status":"ready"}`, 미설정/마이그레이션 누락/DB 장애 시 503이다. DB 조회는 3초 query timeout과 기존 최대 5초 연결 획득 제한을 적용한다. 오류는 비밀 없는 `readiness_database_failed`만 기록한다. 실제 Google 성공·법적 승인·백업·수업 용량까지 검증하는 지표가 아니다.
6. 학생은 정확한 같은 원본 `/api/student`와 HttpOnly·Strict·host-only 쿠키를 사용하며 운영 HTTPS에서는 Secure·`__Host-` 접두사를 적용한다. 교차 원본 SWA+API는 이 조건을 충족하는 대안이 아니며 현재 두 SWA를 그대로 배포해 새 참여 흐름이 된다고 주장하지 않는다.
7. SIGINT/SIGTERM은 기존 요청·DB 종료를 기다리고 10초 초과 시 오류 종료한다. 이 동작은 연결 만료/학생 브라우저 재조회와 함께 운영 플랫폼에서 검증해야 한다.

로컬 Windows 예시(합성 설정은 실제 운영 설정이 아니다):

```powershell
npm run build
$env:SERVE_WEB = 'true'
$env:PORT = '5331'
npm start
# 별도 터미널: 미설정 인증이면 /health=200, /ready·/api=503이어야 한다.
```

### 선택형 PDF 디스크와 Chrome 차단의 추가 운영 조건

- `CLARIO_DOCUMENTS_DIR`는 API 서비스 계정만 접근하는 **전용 절대 경로**로 제공한다. 저장소 및 모든 정적/공개 웹 루트 밖이어야 한다. 경로를 생략하면 PDF 업로드/다운로드가 비활성이다. 인증/DB 없이 값만 설정하거나 잘못된 경로면 시작에 실패한다. Windows 예시는 `.env.example`의 `C:\CLARIO-private\documents`이고 Linux는 승인된 전용 영속 마운트 경로를 사용한다.
- API 런타임 권한/Windows ACL·전송 HTTPS·디스크 암호화·영속 볼륨·여유 용량·백업/복원·담당자를 검증한다. 이 코드는 비공개 파일 경로/권한 검사를 제공하지만 저장소 암호화·악성코드 검사·자동 만료·백업/복제본 삭제를 구현한 것은 아니다. 임시 컨테이너 파일시스템을 영구 보관으로 오인하지 않는다. 다중 API 인스턴스는 동일한 승인 저장소를 사용하지 않으면 파일이 없는 요청이 발생하므로 현재 구성은 단일 API 시험용이다.
- 최대 PDF 10 MiB/교실 100개, 헤더/종료 표식만 확인한다. 신뢰할 수 있는 승인 시험 문서만 사용하고 실제 데이터 도입 전 악성 파일 검사·보관 상한/만료·감사·백업 삭제를 승인/구현한다. 다운로드는 첨부파일이며 학생 다른 교실/철회/만료 접근을 서버에서 재검사한다.
- 원본 삭제 버튼은 디스크 제거 확인과 감사 commit 이후만 완료다. 실패/프로세스 중단은 `uploading`/`failed`/`deleting` 상태로 남아 교사가 삭제 재시도/재등록한다. 수업 종료/서버 재시작이 PDF 삭제는 아니다. 다운로드한 사본은 회수할 수 없고 DB 원본·디스크·백업은 각각 확인해야 한다.
- Chrome 차단은 [설치/연결 안내](./device-client.md)의 선택형 확장 0.2.0과 학생별 코드가 필요하다. 교실 설정 저장만으로 모든 학생에게 강제 적용되지 않는다. 학교 확장 배포·설치/제거 방지·실제 Chromebook·절전/alarm 지연을 별도 검증한다. 방문 기록·앱 제어·캡처 권한은 없다.
- 새 파일/확장 기능은 로컬 개발과 격리 데이터 검증 범위다. 신규 Azure 저장소/유료 자원·학교 관리 정책·실제 운영 배포를 이 작업에서 생성/변경하지 않는다. 실제 화면 녹화의 정책/저장소 차단 게이트도 그대로 유지한다.

### CI/CD와 승인 경계

- PR/main 검증은 포맷·타입·전체 테스트·배포 검증 단위 테스트·전체 빌드·실제 빌드 runtime HTTP 테스트를 수행한다. Linux runtime ZIP에는 두 웹의 dist·서버/shared dist·운영 의존성과 workspace manifest를 함께 넣고 패키지 내 `createApp`으로 빌드 존재도 검사한다.
- 기존 실제 배포 job은 `CLARIO_TRIAL_DEPLOY_ENABLED` 저장소 변수가 정확히 `true`일 때만 실행된다. 기본은 차단이다. `trial` environment는 선언만으로 사람 승인을 강제하지 않으므로 담당자가 required reviewers/브랜치 제한을 실제 설정해야 한다. OIDC subject도 기존 main subject와 environment subject의 차이를 검토/승인한 후 별도 구성한다. 이번에는 설정하지 않았다.
- 승인 없이 해당 변수를 켜지 않는다. 운영 rollout에는 DB migrate→스키마 확인→API/웹 산출물→`/ready`→두 경로 자산→실제 교사 로그인·학생 흐름 검증이 필요하다. 기존 trial job은 과거 분리 SWA 배포용이며 `/health` 확인만으로 새 흐름 인수를 완료하지 않는다.
- 승인된 환경에서 `node scripts/verify-deployment.mjs ready https://승인된원본`과 `static https://승인된원본/student/ apps/student/dist`로 준비/정확한 자산을 구분해 확인한다. 도구의 HTTPS 검사는 우회하지 않는다. 로컬은 `node --test scripts/verify-runtime.test.mjs`를 사용한다.
- 복구 시 배포 중단→권한/요청 차단 유지→검증된 이전 산출물과 호환 스키마 확인→전진 복구가 기본이다. 무단 다운 마이그레이션/DB 덮어쓰기 금지. 복구된 DB의 개인정보 철회 이력을 별도 안전한 기록과 대조·재적용하기 전 재개하지 않는다. 실제 복구 리허설은 미수행이다.

### 개인정보 요청과 정책 승인

| 데이터 | 목적·범위 | 현재 처리 / 승인 전 제한 |
|---|---|---|
| 교사 Google 신원·교실 관리 관계 | 교사 인증/권한 | 계정 해지·참조/감사 보존은 학교/운영자 검토 필요 |
| 학생 이름·문자열 학번·선택 명단 | 해당 교실의 신청·본인 확인 보조 | 공개 명부 없음. 별도 법적 근거·안내·기간 승인 필요 |
| 신청/자격 해시·익명 요청 제한 식별자 | 대기/복구·안전한 접속·오용 제한 | 자격 만료·철회는 물리 삭제가 아님. 학생 Google 신원/이메일/비밀번호 수집 없음 |
| 연결·출석·자료 수신/열기 요청 | 실제 수업 상태·전달 확인 | 방문/행동 수집 아님. 7일 자료 접근 만료도 보관 기간 승인 아님 |
| 감사·삭제 요청 | 권한/철회·정책 처리 추적 | 최소 행위자/대상/시각/결과. 보관·삭제 예외 승인 필요 |
| 백업/복제본·향후 녹화 | 장애 복구/별도 승인 목적 | 관리 대상 목록·만료·복구 재삭제 책임 미확정. 녹화 수집/저장 없음 |

현재 교실 관리 → 참여 학생 → **개인정보 삭제 요청**에서 대상/최신 세대·기존 자격/연결 철회 내용을 확인한다. 종료/보관 교실도 요청 가능하다. 서버는 요청/감사와 blocked·세대 증가·기존 신청 취소·자격/연결 철회를 한 트랜잭션으로 처리하며 감사 실패 시 전체 rollback한다. 이후 기존 쿠키/복구 승인이 접근을 되살릴 수 없다. 최신 세대 재요청은 중복 접수하지 않는다. 학생 공개 API는 해당 학생의 요청 여부를 노출하지 않는다. 다른 학번의 동일인 탐지는 제공하지 않는다.

`participant_erasure_requests`의 상태는 **awaiting_policy 하나뿐**이다. 원본·명단·신청·자료 수신·감사·복제/백업은 미삭제이며 UI도 삭제 완료라고 표시하지 않는다. 요청 철회/보류 해제·정책 승인/삭제 실행 기능은 없다. 학교 담당자와 사전 확인하고 합성 데이터로만 검증한다. 미정 기간을 무기한 보관 승인으로 보지 않는다.

실제 데이터 도입 전 학교 개인정보 책임자와 운영 담당자는 다음을 서면 확정해야 한다:

1. 범주별 처리 근거·학생/보호자 안내·최소 수집·보관 상한/기산점·감사 보존 예외·열람/정정/삭제 요청 본인 확인/응답 절차.
2. 연결된 원본/명단/신청/자격/수신/감사·학교별 범위·복제/백업 목록, 삭제 재시도·관리자 경고·작업 중단/복구·완료 증거.
3. 승인된 삭제 이력의 안전한 별도 보존과 백업 복원 후 재적용. 단순 복원으로 철회된 자격이 살아나지 않도록 서비스 재개 전에 확인.
4. 접근 철회 실패/삭제 실패 시 해당 범위를 닫고 민감하지 않은 오류로 담당자에게 알리는 운영 연락망·감시·기한. 현재 자동 삭제 worker/알림은 미구현이다.

### 남은 출시 게이트

실제 교사 OAuth, 운영 PostgreSQL/TLS·저장 암호화·최소 권한·비밀 교체, 같은 원본 HTTPS Secure 쿠키/프록시·제3자 쿠키 제한 환경, 백업/복구·철회 재적용·실제 삭제, 공유 학교 IP/용량/절전·재시작/장애 실측, 관측/경고 연락망·운영 책임, 관리형 Chromebook 실기기 결과와 별도 미디어 승인은 미완료다. 아래 기록은 역사적 시험 결과이며 현재 10·11단계 전체 완료/배포 승인이 아니다.

## 현재 진행 상태

과거에는 사용자가 무료 리소스 자동 생성·GitHub push·실제 배포를 승인했다. 현재 작업의 배포 승인은 아니며 아래 Portal 절차는 수동 재구성 참고용이다.

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

관리 ID `id-clario-dev-42e4`는 새 CLARIO 리소스 그룹에만 Contributor 역할을 가진다. OIDC issuer는 `https://token.actions.githubusercontent.com`, 실제 실행에서 확인한 subject는 `repo:serene-jang@277176776/CLARIO@1423864194:ref:refs/heads/main`, audience는 `api://AzureADTokenExchange`다. GitHub가 이 저장소에 발급하는 형식은 소유자·저장소 ID를 포함한다. 이름만 사용한 기존 예시 subject로는 로그인에 실패했다. 워크플로에 GitHub environment를 추가하거나 저장소 이름을 바꾸면 실제 토큰 subject에 맞춰 신뢰 설정도 함께 변경해야 한다.

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
- [GitHub Actions 실행 39086161420](https://github.com/serene-jang/CLARIO/actions/runs/39086161420): 검사·빌드·배포 작업 모두 성공. 첫 시도는 OIDC subject 불일치로 실패했으며 실제 토큰 형식에 맞춘 후 재실행해 성공했다.
- 외부 HTTPS 검사: API `/health`의 정확한 JSON 응답과 두 웹의 빌드 산출물(JS/CSS 바이트 일치)을 확인했다.
- 브라우저 검사: 교사·학생 웹의 실제 React 화면과 미구현 기능 안내를 확인했다.
- 배포 후 F1 요금제와 SCM/FTP 기본 인증 비활성화 상태를 다시 확인했다.
- Log Analytics를 만들지 않았으므로 공통 로그 조회 도구로 중앙 로그를 가져올 수 없었다. 중앙 모니터링을 구성했다고 주장하지 않는다. Actions 단계 로그와 실제 HTTP·브라우저 결과로 이번 배포를 검증했다.

## 공식 참고 자료

- [Static Web Apps 요금제](https://learn.microsoft.com/en-us/azure/static-web-apps/plans)
- [Static Web Apps 빌드 설정](https://learn.microsoft.com/en-us/azure/static-web-apps/build-configuration)
- [App Service GitHub Actions 및 Portal OIDC 설정](https://learn.microsoft.com/en-us/azure/app-service/deploy-github-actions)
- [App Service Linux 가격과 Free 제한](https://azure.microsoft.com/en-us/pricing/details/app-service/linux/)
- [App Service 플랜과 과금](https://learn.microsoft.com/en-us/azure/app-service/overview-hosting-plans)
- [Azure Retail Prices API](https://prices.azure.com/api/retail/prices)
