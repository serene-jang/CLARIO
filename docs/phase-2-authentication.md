# Google 계정 로그인 및 작업공간 권한 관리

## 구현 범위와 검증 구분

- Google Workspace 및 개인 Google 계정으로 로그인할 수 있다. Google OAuth client 설정에서 External 사용자 접근을 허용해야 한다.
- 교사 앱에서 가입자가 작업공간 이름과 표시 이름을 입력해 가입하면 해당 사용자가 작업공간 최초 관리자가 된다.
- 이메일의 Google 소유 확인은 로그인한 Google 계정을 증명할 뿐 학교·교직원·학생 신분이나 학교의 작업공간 소유권을 증명하지 않는다.
- 사용자 역할은 Google 계정이나 브라우저의 역할 입력에서 추론하지 않는다. 서버 DB의 승인된 역할만 적용한다.
- 작업공간 관리자는 이메일 도메인과 관계없이 교사·학생을 등록하고 역할·이용 상태를 관리할 수 있다. 초대 이메일 발송은 구현하지 않았다. 등록한 이메일을 당사자에게 안전하게 전달해야 한다.
- 교사는 담당 학급을 만들고 이름 변경·보관 처리하며, 관리자가 해당 작업공간에 등록한 학생을 학급에 등록·제외한다.
- 학생은 자신의 작업공간과 등록 학급만 본다. 학생은 학급 구성원 API와 전체 사용자 API를 사용할 수 없다.
- 하나의 이메일 계정은 현재 하나의 작업공간에만 속한다. 다중 작업공간 멤버십·셀프서비스 초대 수락/만료, 학교 신분 검증은 미구현이다.

실제 PostgreSQL에서 API·권한·세션 테스트를 수행한다. 테스트의 Google 신원 검증 경계는 가짜 서명 토큰을 허용하는 주입형 테스트 대역이며 운영 시작 경로에서는 선택할 수 없다. 운영 경로는 `google-auth-library`를 통한 실제 ID 토큰 검증만 사용한다.

**실제 Google OAuth 클라이언트와 계정이 아직 설정되지 않아 실제 Google 로그인 브라우저 E2E는 미검증이다. 공개 가입 코드 구현이 Google 클라이언트 생성/설정을 대신하지 않는다.** 화면 확인·녹화는 미구현이다.

## 로컬 PostgreSQL 준비

### 초기 설정 입력 화면

루트에서 `npm run setup`을 실행하고 터미널의 전체 주소(`http://127.0.0.1:5180/#...`)를 엽니다. Google 웹 OAuth 클라이언트 ID·작업공간 이름·관리자 이메일·표시 이름과 이메일 도메인(메타데이터)을 입력합니다. 실제 Google Cloud 프로젝트/승인 원본은 아래 안내대로 먼저 준비해야 합니다.

- 입력값을 서버에서 검증한 뒤 개발 DB 시작 → 버전 5까지 마이그레이션 → 로컬 작업공간·최초 관리자 등록 → `server/.env` 저장을 수행합니다.
- 동일한 학교·활성 관리자 정보로 재시도할 수 있지만, 기존 관리자·역할·학교 이름을 바꾸거나 이용 중지 계정을 복구하지 않습니다.
- 환경 파일의 다른 설정은 보존합니다. 기존 외부 DB 또는 다른 포트·허용 원본 설정이 있으면 중단합니다. DB 적용 후 파일 저장이 실패하면 부분 완료를 알리고 동일 정보 재시도를 안내합니다.
- DB 비밀번호는 서버가 생성한 로컬 연결 파일에서 읽으며 브라우저로 전송하지 않습니다. Client secret도 필요 없습니다.
- 설정 서버는 별도 명령으로 loopback에만 바인딩하며, 정확한 Host·Origin과 실행마다 바뀌는 토큰을 확인합니다. 공개 Backend에는 해당 경로를 연결하지 않습니다. 운영 환경에서는 실행을 거부합니다.
- 설정 성공 뒤에도 DB가 필요하므로 터미널을 유지하세요. API가 이미 실행 중이면 원래 터미널에서 재시작하고 교사·학생 웹을 실행합니다. 다음 실행에는 아래 `db:local` 명령을 사용하면 됩니다.
- 실제 학교 OAuth 성공, Chromebook 설치 및 공개 사이트 배포는 별도 검증입니다.

아래 수동 명령은 입력 화면을 사용하지 않을 때의 대안입니다.

Node.js 24, npm 11을 사용한다. 루트에서:

```powershell
npm install
npm run db:local --workspace @clario/server
```

개발 전용 portable PostgreSQL이 `127.0.0.1:55432`에서 실행된다. 해당 터미널은 유지한다. 비밀번호는 실행 시 무작위 생성되며, 데이터와 연결 정보는 Git에서 제외된 `server/.local-postgres/` 안에 보관된다. 이미 사용하는 55432 포트의 프로세스를 임의로 종료하지 말고 기존 PostgreSQL을 사용하거나 충돌을 해소한다.

이 도구는 `embedded-postgres`의 고정된 개발용 버전을 사용한다. 시스템 서비스나 OS 사용자를 생성하지 않는다. 운영 DB 대체물이 아니며, Windows 종료 시 라이브러리가 프로세스를 강제 종료할 수 있으므로 개발·합성 데이터에만 사용한다. CI도 별도 임시 클러스터만 생성하고 종료·삭제한다.

다른 터미널에서, 기존 `server/.env`가 없다면 연결 정보를 복사한다. 기존 파일이 있으면 덮어쓰지 말고 필요한 값을 병합한다.

```powershell
Copy-Item server\.local-postgres\connection.env server\.env
```

그 파일에 아래 설정을 추가한다.

```dotenv
PORT=4000
GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
APP_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:5174
```

Google 설정은 공개 웹 클라이언트 ID만 필요하다. ID 토큰 로그인 방식이므로 OAuth client secret, Google access/refresh token, Drive/Classroom 권한은 필요하지 않다.

마이그레이션과 최초 작업공간 관리자 등록:

```powershell
npm run db:migrate --workspace @clario/server
npm run school:create --workspace @clario/server -- "학교 이름" school.example admin@school.example "관리자 이름"
```

`school.example`은 형식 예시다. 실제 로그인에는 학교가 승인한 실제 Google Workspace 도메인과 관리자 계정을 입력해야 한다. 명령은 기존 학교·계정·역할을 덮어쓰지 않으며 중복이면 실패한다. 데이터베이스 운영 권한이 있는 담당자만 이 명령을 실행해야 한다.

마이그레이션 버전은 DB에 저장되며 재실행 가능하다. 향후 스키마 변경은 이미 적용한 버전을 수정하지 말고 새 버전으로 추가해야 한다.

### 학생 기기 명부 등록 (추가 기능)

관리자 또는 담당 교사가 **학급 관리 → 학생 기기 등록**에서 다음을 입력한다.

- 기기를 사용할 학생: 해당 학급의 승인된 활성 학생 중 선택.
- 기기 이름: 앞뒤 공백을 제외한 1~100자.
- 학교 자산번호: 앞뒤 공백을 제외한 1~100자. 같은 학교에서는 대소문자만 다른 번호도 중복으로 처리한다.

저장은 서버 응답을 확인한 뒤 성공을 안내한다. 저장 실패 시 입력값을 보존하고 오류를 표시한다. 목록 조회 실패는 빈 목록과 구분하며 재시도할 수 있다. 잘못 등록했다면 등록 해제 후 다시 등록한다.

DB 마이그레이션 **버전 2**가 `registered_devices`와 학교별 자산번호 고유 인덱스를 추가한다. 버전 1은 수정하지 않는다. 기존 데이터베이스에도 다음 명령을 실행하고 API를 시작한다.

```powershell
npm run db:migrate --workspace @clario/server
```

명부 도입 시 버전은 2이며 후속 기기 연결/자료/자율 집중 안내 및 작업공간 이메일 도메인 완화를 포함한 현재 API는 **버전 5**까지 적용해야 시작한다. 새 환경변수나 외부 API 권한은 필요하지 않다. [최신 기기 연결 안내](./device-client.md)를 참고한다.

| API | 권한/동작 |
|---|---|
| `GET /api/classes/:classId/devices` | 담당 교사 또는 같은 학교 관리자만 기기 명부 조회 |
| `POST /api/classes/:classId/devices` | `studentId`, `name`, `assetNumber` 검증 후 저장. 학교는 서버 세션 기준 |
| `DELETE /api/classes/:classId/devices/:deviceId` | 해당 학급 범위에서 명부 등록 해제 |

- 학생·다른 교사·다른 학교 사용자는 명부 조회/등록/삭제가 차단된다.
- 기기 등록·해제는 감사 기록에 남긴다. 학생을 학급에서 제외하면 해당 학급의 기기 등록도 삭제하고 해제 감사 기록을 남긴다.
- 학급 보관 시에도 관련 기기 명부를 해제하고 감사 기록을 남긴다. 학생/학급 데이터는 기존 보관 동작을 유지하며, 해제된 자산번호는 다시 등록할 수 있다.
- 한 학생에게 여러 기기를 등록할 수 있지만 동일 자산번호를 여러 학급에 중복 등록할 수 없다.
- 자산번호는 사람이 입력한 명부 값이며 실제 하드웨어 인증 근거가 아니다. 비밀번호·키를 입력하지 않는다.
- 최초 명부 등록만으로는 `unknown`, 화면/녹화 지원은 `unverified`다. 후속 기기 페어링/heartbeat가 있으면 서버 수신 시각을 기준으로 연결 상태를 반환하며, 하드웨어 실물 인증을 의미하지 않는다.
- 실제 Google 계정 로그인 및 Chromebook 자동 연결은 여전히 별도 검증 대상이다.

추가 검증: 실제 임시 PostgreSQL에서 저장/중복/입력 검증·권한 격리·API 인스턴스 간 조회·등록 해제/학생 제외 연쇄 삭제·감사 로그·마이그레이션 재실행을 시험한다. UI 테스트는 저장·등록 해제·입력값 보존·조회 실패/재시도·빈 학생 목록·학급 관리 화면 연결을 다룬다.

```powershell
npm run dev:server
npm run dev:teacher
npm run dev:student
```

각각 별도 터미널에서 실행한다. 개발 앱의 `/api` 요청은 Vite가 로컬 API 4000 포트로 전달한다. API 포트를 변경하면 두 Vite proxy 대상도 조정한다. 프런트엔드를 직접 다른 API에 연결하려면 각 앱의 `.env.example`을 `.env`로 복사하여 `VITE_API_BASE_URL`을 설정한다.

## Google Cloud / OAuth 준비

1. 소유하거나 관리할 수 있는 Google Cloud 프로젝트에서 Google Auth Platform 브랜딩과 동의 화면을 설정한다. 개인·공개 사용자 이용을 위해 앱 대상 사용자를 **External**로 설정한다.
2. **웹 애플리케이션 OAuth 클라이언트**를 만든다.
3. 승인된 JavaScript 원본에 사용하는 교사·학생 원본을 정확히 등록한다. 로컬 예: `http://127.0.0.1:5173`, `http://127.0.0.1:5174`. localhost로 접속하려면 해당 원본도 별도로 등록한다.
4. Google의 로컬 origin 허용 조건은 클라이언트 설정에서 확인한다. IP 원본이 거부되면 `http://localhost:5173`, `http://localhost:5174`를 사용하고 `APP_ORIGINS`에도 동일하게 추가한다.
5. 게시 전 시험 상태라면 Google 동의 화면의 테스트 사용자에 로그인 계정을 추가한다. 공개 배포 때는 Google의 검증·게시 요건과 요청 범위를 확인한다. Google Workspace에서 조직 관리자가 OAuth 앱을 제한하면 해당 계정은 관리자의 승인이 여전히 필요할 수 있다.
6. 웹 클라이언트 ID를 서버 `GOOGLE_CLIENT_ID`에 설정한다. 이 구현은 GIS ID 토큰 callback 방식이며 서버 OAuth redirect URI나 client secret을 요구하지 않는다.
7. 교사 앱에서 최초 Google 로그인과 작업공간 만들기를 선택한다. 작업공간 이름/사용자 이름을 입력하면 해당 사용자에게 작업공간 관리자 권한을 부여한다.
8. 관리자는 작업공간 구성원 관리에서 교사·학생 이메일을 등록하고, 교사는 학급 생성 및 등록 학생 연결을 수행한다. 학생은 학생 앱에서 본인 Google 계정으로 로그인한다.

개인 Gmail 및 다른 Google 도메인을 지원한다. 검증된 Google 이메일과 subject를 계정에 연결하며 `hd` 도메인을 학교 소속 판정에 사용하지 않는다. Google OAuth 앱의 시험 사용자 제한과 학교/조직의 Google 정책은 별도로 적용될 수 있다.

참고:

- [Google Identity Services 웹 로그인](https://developers.google.com/identity/gsi/web/guides/overview)
- [서버 ID 토큰 검증](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Google Workspace 앱 접근 관리](https://support.google.com/a/answer/7281227)

## 세션과 접근 통제

- 서버가 5분 유효한 단일 사용 challenge와 nonce를 생성한다. Google 검증 결과의 nonce가 일치해야 로그인된다.
- 서명·issuer·audience·만료는 Google 라이브러리로 검사하며, 검증된 이메일과 Google subject를 작업공간 구성원에 연결한다. Consumer 계정은 `hd`를 제공하지 않을 수 있으므로 조직 증명에 사용하지 않는다.
- 최초 작업공간 가입 시 서버가 새 작업공간과 관리자 계정을 원자적으로 생성한다. 학교명, 작업공간, 역할은 클라이언트가 기존 사용자 로그인에서 선택할 수 없다. 이메일 중복은 거부한다.
- 공개 가입은 프로세스별 IP 버킷 15분당 10회로 제한한다. 다중 인스턴스 운영에서는 게이트웨이/WAF 또는 공유 저장소 기반 rate limit을 추가해야 한다.
- CLARIO 세션은 무작위 256비트 opaque bearer token이다. DB에는 SHA-256 해시만 저장하고 만료는 서버 기준 1시간이다.
- 토큰은 React 메모리에만 보관한다. localStorage/sessionStorage, URL, 쿠키에 저장하지 않는다. 새로고침·탭 종료 시 다시 로그인해야 한다.
- 로그아웃은 서버 세션을 삭제한다. 계정 이용 중지·역할 변경은 해당 계정의 모든 세션을 삭제한다. 매 요청마다 현재 DB 역할·활성 여부를 다시 확인한다.
- API는 쿠키를 인증에 사용하지 않으므로 cross-site cookie 허용에 의존하지 않는다. 상태 변경 요청에는 bearer 인증이 필요하고, 명시된 origin만 CORS로 허용한다.
- 로그인 API는 socket별 600회/분, 최대 1,000개 socket bucket으로 제한한다. 신뢰할 수 없는 forwarded IP는 사용하지 않는다. 공유 프록시 환경에서는 제한이 함께 적용되므로 운영 규모별 프록시·분산 rate limiting 검토가 필요하다.
- 다른 학교나 담당하지 않는 학급에 대한 요청은 리소스 존재를 누설하지 않도록 404로 응답한다. 학생의 관리 API 접근은 403이다.
- DB 외래 키로 학교 범위 일치를 추가 강제하고 SQL은 파라미터 바인딩을 사용한다.
- 로그인/로그아웃, 계정 승인·권한 변경, 학급 변경·등록/해제, 차단된 접근은 감사 기록에 남긴다. 토큰, nonce, Google credential은 기록하지 않는다.
- API 응답은 `Cache-Control: no-store`를 사용하며 민감한 내부 오류를 사용자에게 반환하지 않는다.
- 외부 PostgreSQL 연결은 인증서 검증이 켜진 TLS를 사용한다. 로컬 loopback만 암호화하지 않는 연결을 허용한다.

## 주요 API

기본 접두사: `/api`. 오류: `{ "error": { "code": "...", "message": "..." } }`.

| 메서드/경로 | 접근 | 설명 |
|---|---|---|
| GET `/auth/config` | 공개 | 공개 Google client ID |
| POST `/auth/challenge` | 공개 | 로그인 nonce 발급 |
| POST `/auth/google` | 공개 | `{challengeId, credential}` 검증 후 세션 발급 |
| GET `/auth/me` | 로그인 사용자 | 본인 정보 |
| POST `/auth/logout` | 로그인 사용자 | 현재 세션 폐기 |
| GET `/school` | 로그인 사용자 | 본인 학교 |
| GET/POST `/users` | 학교 관리자 | 같은 학교 계정 목록·승인 |
| PATCH `/users/:userId` | 학교 관리자 | 교사·학생 역할·활성 변경, 세션 철회 |
| GET `/classes` | 로그인 사용자 | 역할별 허용 학급 |
| POST `/classes` | 교사 | 본인 담당 학급 생성 |
| PATCH/DELETE `/classes/:classId` | 담당 교사·학교 관리자 | 이름 변경·보관 |
| GET/POST `/classes/:classId/members` | 담당 교사·학교 관리자 | 등록 학생 목록·등록 |
| DELETE `/classes/:classId/members/:studentId` | 담당 교사·학교 관리자 | 학급 등록 해제 |

관리자 계정 신규 생성·관리자 역할 변경은 웹 API로 허용하지 않는다. 초기 관리 명령은 별도 운영 권한을 전제로 한다.

## 배포와 개인정보 주의

- 이번 개발에서 Azure 설정 변경·유료 DB 생성·GitHub push·재배포는 수행하지 않는다.
- 기존 배포는 환경변수 세 개가 모두 없을 때 `/health`만 정상이며 `/api`는 503으로 로그인 미설정을 표시한다. 일부만 설정하면 서버가 명시적으로 시작 실패한다.
- 실제 배포에는 별도로 승인된 PostgreSQL, 마이그레이션/학교 등록, API 환경변수, 두 프런트엔드 빌드의 `VITE_API_BASE_URL`, Google 승인 원본이 필요하다.
- 환경변수와 DB 연결 문자열은 Azure 비밀 설정으로 관리한다. DB 비밀번호를 GitHub 변수나 프런트엔드 `VITE_` 값에 넣지 않는다.
- 마이그레이션/학교 등록은 DB 연결이 가능한 승인된 운영 환경에서 수행한다. 예: 서버 빌드 디렉터리에서 `node dist/manage.js migrate`, `node dist/manage.js school ...`.
- DB 계정·이름·이메일·학교·역할·학급 등록, Google subject, 세션 해시와 만료, 감사 메타데이터를 저장한다. Google access token, 비밀번호, 화면 내용은 수집하지 않는다.
- 만료된 challenge·세션은 다음 로그인 challenge 생성 시 정리한다. 주기적 정리, 계정/감사 보관 기간·삭제 및 백업 정책은 아직 운영용으로 완성하지 않았다.
- 실제 학생 데이터 사용 전 학교의 개인정보 처리 근거·고지·계정 승인·DB 백업·보관 정책을 검토해야 한다.

## 검증

```powershell
npm test
npm run typecheck
npm run build
npm run format:check
node --test scripts/verify-deployment.test.mjs
```

서버 통합 테스트는 매번 실제 임시 PostgreSQL을 생성해 마이그레이션, 로그인 경계, 학교/학급 격리, 역할 위조, 로그아웃·만료·철회, 입력 검증, 감사 기록을 검사한다. 테스트용 계정은 합성 데이터이며 운영 로그인 우회 경로를 제공하지 않는다.

### 이번 작업의 실행 결과 (2026-10-18)

- `npm test`: 공통 도메인 3개 + 서버 18개 + React UI 6개, 총 27개 통과.
- 기존 배포 검증기 테스트 2개 통과. 합계 29개 통과.
- 타입 검사, 두 프런트엔드와 서버 빌드, Prettier 검사 통과.
- 실제 임시 PostgreSQL에 마이그레이션을 두 번 적용해 재실행 가능성 확인.
- 지속형 로컬 개발 DB 준비·마이그레이션·초기 관리자 생성 명령 확인. 검증에 사용한 합성 학교와 계정만 제거했고 로컬 DB 스키마는 유지했다.
- 컴파일한 서버의 `/health` 200과 인증 설정이 비어 있을 때 `/api/auth/config` 503 확인.
- 브라우저에서 교사·학생 화면의 로그인 설정 미완료 안내 확인. Google 실제 로그인·학교 관리자/교사/학생 실계정 흐름과 실기기는 미검증.
- 이번 작업에서는 commit, push, Azure 재배포를 수행하지 않았다.
