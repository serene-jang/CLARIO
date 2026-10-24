# 관리형 Chromebook 자동 연결 — Phase 0 분석 및 구현 전 조건

- 조사일: 2026-10-18
- 범위: 기존 문서·주요 실행 코드·데이터 모델·테스트 항목의 정적 확인, Chrome/Google 공식 공개 문서 조사.
- 학교 환경에 대한 사용자 확인: **학교 Google 계정은 있으나 Chromebook의 학교 관리 여부는 모른다.**
- Google Admin Console, Google Cloud 프로젝트, 실제 Chromebook, 실제 학교 OAuth 로그인, Verified Access 응답은 확인하지 못했다.
- 이번 작업은 분석과 문서 변경만 수행한다. 확장 프로그램, 기기 API, 실시간 연결, 화면 캡처 코드는 아직 구현하지 않는다.

후속 작업 참고: 이 문서는 최초 조사 시점의 기록이다. 이후 기기 명부·MV3 코드 페어링/기기 인증·상태/자료·자율 안내와 무계정 웹 참여를 별도로 구현했다. 최신 범위와 9단계 학교 시험 준비는 [Device Client 안내](./device-client.md)를 따른다. 2026-10-18 사용자가 관리형 Chromebook/관리자 협조 가능을 확인했지만 실제 기기 결과와 화면·녹화 승인은 없다. 아래 과거 미구현 표를 현재 코드의 상태로 해석하지 않는다.

## 1. 결론과 구현 가능 범위

**조건부로 가능한 방향:** 학교가 승인해 배포한 Manifest V3 확장 프로그램이, 최초 등록 이후 자체 기기 인증으로 CLARIO API에 연결한다. 교사는 기존 Google 학교 로그인으로 담당 학급의 등록 기기를 확인한다. 학생이 CLARIO 웹페이지를 매번 열거나 CLARIO 웹 로그인 세션을 유지할 필요는 없도록 설계할 수 있다.

**현재 확인하지 못한 점:** 해당 학교가 이 확장 프로그램을 강제 설치할 수 있는지, 관리형 ChromeOS API·Verified Access를 사용할 수 있는지, 실제 기기에서 재접속과 권한이 정상 동작하는지.

**보장하지 않는 점:** 설치만으로 기기 발견·학급 자동 배정·학생 신원 증명·전체 화면 원격 캡처·무인 녹화가 가능하다는 주장.

| 기능 | 공식 문서와 현재 코드에 근거한 판단 | CLARIO 실제 검증 |
|---|---|---|
| 교사 Google 로그인 | 기존 GIS ID 토큰 검증 경로 재사용 가능 | API/검증 경계 테스트는 이전 작업에서 수행, 학교 실계정은 미검증 |
| 학생 웹 방문 없는 상태 전송 | 관리 배포한 확장 프로그램 + 승인된 기기 등록/인증 + 서버 연결로 설계 가능 | 확장 프로그램·기기 API 모두 미구현 |
| 물리적 관리형 기기 증명 | ChromeOS `enterprise.platformKeys.challengeKey` + Verified Access가 후보 | 관리 정책·응답 필드·학교 권한 미검증 |
| 일련번호·Directory device ID 조회 | `enterprise.deviceAttributes`, 사용자 affiliation 등 조건 필요 | 식별값 조회·학교 장비 매칭 미검증, 식별값만으로 인증 불가 |
| 기기별 학급 배정 | 서버가 관리자/담당 교사 승인 범위 내 배정 | 데이터 모델·등록 흐름 추가 필요 |
| 로그인 전/절전 중 연결 유지 | 사용자 프로필 확장 프로그램의 상시 실행을 보장할 수 없음 | 해당 상태는 연결 단절 또는 확인 불가로 처리할 설계 필요 |
| 화면 공유 | 공식 캡처 API의 사용자 동작·선택·정책 조건을 만족하는 범위만 후보 | 대상 ChromeOS에서 미검증 |
| 모든 학생 화면 자동 수집·녹화 | 연결 가능 여부만으로 판단할 수 없음 | 지원 미확정, 구현 대상에서 보류 |

## 2. 현재 구조와 재사용 대상

현재 저장소는 npm workspaces 기반 TypeScript 모노레포다. 직전 Phase 2의 변경이 아직 commit/push되지 않은 상태이며 이번 분석에서 보존한다.

| 영역 | 현재 구현과 근거 | 자동 연결 확장 시 처리 |
|---|---|---|
| Teacher/Student 웹 | React 19, Vite 7, TypeScript. `apps/teacher`, `apps/student`가 `apps/common/SchoolWorkspace.tsx` 사용 | 교사 로그인·승인/학급 관리 재사용. 학생 웹은 선택적 자료·상태 확인 경로로 보존 |
| API | Express 5, Node.js 24 권장. `server/src/app.ts`, `index.ts` | HTTP 서버에 인증된 기기 연결 경로를 추가하되 기존 사용자 API 유지 |
| 교사 인증 | `identity.ts`가 Google 라이브러리로 ID 토큰 검증. `access.ts`가 nonce, 승인 이메일/학교 도메인/subject 검사 | 교사·관리자 흐름 유지. 기기 인증을 이 로그인 API로 가장하지 않음 |
| 권한 | 서버 DB의 현재 역할/학교/담당 학급 검사, 계정 중지·역할 변경 시 세션 폐기 | 별도 device principal과 권한 철회/재배정 시 연결 폐기 추가 필요 |
| DB | PostgreSQL `pg`, 버전 1 마이그레이션. 학교·사용자·학급·학급 구성원·challenge·사용자 세션·감사 기록 | 기존 버전을 수정하지 않고 새 마이그레이션으로 기기·배정·기기 인증/연결 기록 추가 |
| 공통 타입 | `CurrentUser`, `StudentDevice`, 연결 상태와 기능 지원 상태 타입 | `StudentDevice`는 타입뿐이며 DB/API 구현이 아님. 공유 기기·프로필 구분을 설계한 뒤 확장 |
| 기기/실시간/자료 | 현재 기기 DB 테이블, 기기 등록 API, 확장 프로그램 manifest, WebSocket 구현, 자료 전달 API 없음 | 다음 단계의 신규 구현 대상 |
| 테스트 | Vitest, Supertest, 실제 임시 PostgreSQL, React DOM 테스트. 이전 작업 결과 27개 + 배포 검증기 2개 통과 | 기기 등록/격리/재연결/철회 테스트는 아직 없음 |

`ARCHITECTURE.md`에 나열된 `devices`, `sessions`, `materials`, `recordings`는 목표 모델이다. 현재 마이그레이션에 생성되어 있다는 뜻이 아니다.

현재 환경변수:

- API: `PORT`, `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `APP_ORIGINS`, 배포 시 `NODE_ENV`.
- 프런트엔드: 필요한 경우 공개 API 원본인 `VITE_API_BASE_URL`.
- 인증 설정 세 개가 모두 없으면 `/health`만 유지하고 `/api`는 503으로 미설정을 알린다.
- 기기 인증/Verified Access용 환경변수는 아직 정의하지 않았다. 존재하지 않는 설정을 필수 변수처럼 추가하지 않는다.

현재 학교 모델은 **Google 도메인 하나당 학교 하나**다. 교육청 도메인을 여러 학교가 공유한다면 도메인만으로 학교를 판별해서는 안 되며 별도 조직 식별·승인 모델을 먼저 결정해야 한다.

## 3. 교사 Google 로그인

기존 방식을 유지한다:

1. 학교가 승인한 Google Cloud 웹 OAuth client ID와 JavaScript 원본을 설정한다.
2. GIS에서 받은 ID 토큰을 서버에서 검증한다. 이메일 검증, 학교 `hd`, 서버 발급 nonce, 이미 연결한 Google subject를 검사한다.
3. DB에 사전 승인한 교사·관리자 역할만 허용한다. Google 로그인 성공만으로 교사가 되지 않는다.
4. 로그인 후 기존 학교/담당 학급 조회를 실행한다.
5. 실제 대시보드의 온라인 수치는 향후 기기 연결 증거로만 채운다. 사용자 로그인 이력을 기기 온라인 상태로 바꾸지 않는다.

교사 로그인용 OAuth client ID, Verified Access 서비스 계정, 향후 확장 프로그램 OAuth 등록은 서로 다른 용도다. 하나를 설정했다고 나머지가 자동 승인되지 않는다.

실제 학교 OAuth 승인·사용자·운영 DB 연결은 여전히 필요하다. [기존 Phase 2 설정](./phase-2-authentication.md)을 그대로 재사용한다.

## 4. 학생의 별도 CLARIO 로그인 없는 기기 인증

### 4.1 우선 검증 후보: 관리형 ChromeOS + Verified Access

공식 문서에 따르면 관리되는 Chromebook, 관리되는 사용자, 명시적 enterprise 정책 등의 조건에서 `enterprise.platformKeys.challengeKey`와 Verified Access로 기기/사용자 관리 상태를 증명할 수 있다. 이 증명은 CLARIO 학급 권한이나 화면 캡처 허가를 대신하지 않는다. [S1][S2]

후속 PoC 흐름:

1. 학교 관리자가 시험 OU에 고정 ID의 CLARIO 확장 프로그램을 배포하고, 승인된 API 원본 등 비밀이 아닌 설정을 managed storage로 전달한다.
2. 서버가 등록 시도와 검증 challenge를 연결한다. Google challenge 발급/검증의 인증 방식, 짧은 유효기간, 기대 identity·조직 검증을 실제 v2 응답으로 확인한다. 기존 웹 로그인용 5분 nonce와 혼동하지 않는다.
3. 확장 프로그램이 허용된 `challengeKey` 호출로 응답을 생성하고 HTTPS 요청 본문으로 서버에 전달한다. 서비스 계정 비밀 키를 확장 프로그램에 넣지 않는다.
4. 서버가 Google의 검증 성공·기대 관리 조직·사용 가능한 검증된 기기 식별값·등록 시도의 단일 사용을 확인한다. 확장 프로그램이 직접 보낸 이메일/학교 ID/일련번호를 신뢰 근거로 쓰지 않는다.
5. 관리자가 승인한 기기 기록에 연결한다. 교사의 등록 권한은 담당 학급/학교 범위로 제한한다.
6. 별도 기기 세션을 발급하고 만료·갱신·회전·철회를 구현한다. 처음에는 재연결 시 재검증하는 PoC로 시작하고, 영구 비밀 토큰 저장을 기본값으로 삼지 않는다.
7. 서버가 승인한 배정만 적용한다. 장치가 보내는 `classId`, `studentId`, 학교 힌트는 권한 부여 근거가 아니다.

Verified Access API 문서는 **비관리 브라우저의 관리 프로필 검증 결과에는 물리적 device identity 필드가 없을 수 있음**을 명시한다. 프로필 검증 성공을 관리형 Chromebook 실물 검증으로 취급하지 않는다. 기기 identity를 받는 데 필요한 관리자 권한이 없거나 응답에 필요한 값이 없다면 자동 등록을 중단하고 설정 부족을 표시한다. [S3]

서비스 계정은 최소 scope/학교 정책 허용을 적용하고 백엔드에만 둔다. 장기 키 없이 운영할 수 있는 인증 방식은 별도 배포 환경 검증 후 선택한다. 이번 단계에서는 서비스 계정이나 API 키를 생성하지 않는다.

### 4.2 대안: 권한자가 최초 승인하는 일회성 페어링

Verified Access를 사용할 수 없다면, 학생 웹 로그인 대신 학교 관리자/담당 교사가 최초 기기에서 짧은 유효기간·단일 사용 페어링을 승인하는 방식은 별도 후보가 될 수 있다.

- 기기별 승인, 시도 제한, 재사용 방지, 학교·학급 범위, 재설치·분실 시 재등록, 세션 철회가 필요하다.
- 학교 전체 공용 등록 비밀이나 학급 ID만으로 자동 등록하지 않는다.
- 일반 소프트웨어 키/토큰 방식은 물리적 학교 Chromebook임을 하드웨어 수준으로 보장하지 않는다. 그 한계를 학교에 설명하고 승인받기 전 기본 경로로 채택하지 않는다.
- 기기 자격 증명 저장은 별도 검토 대상이다. `storage.local`/`storage.managed`를 암호화된 비밀 저장소라고 부르지 않으며, 가능한 한 비추출 키·짧은 세션·복사 방지 증명 등을 검토한다.

### 4.3 학생 신원과 기기 신원의 분리

“학생이 CLARIO에 로그인하지 않음”은 “인증하지 않음”이 아니다. ChromeOS 학교 계정 로그인, 관리형 프로필, 최초 학교 등록은 필요할 수 있다.

- 1인 1기기와 공용/교대 사용 기기는 별개다. 공유 기기는 고정된 기기 ID만으로 현재 학생을 특정할 수 없다.
- `identity.getProfileUserInfo()`는 로컬 프로필 정보이지 서버가 검증한 로그인 증명이 아니다. `getAuthToken({interactive:false})`도 토큰 발급을 보장하지 않으며, 반환되는 access token은 기존 GIS ID 토큰과 같은 계약이 아니다. [S4]
- 학생 신원을 검증하지 못한 경우 “학생 확인 필요” 또는 “기기만 등록됨”을 표시한다. 마지막 사용자를 현재 사용자처럼 표시하지 않는다.
- 학생 배정이 없는 기기도 관리자 승인 하에 교실 공용 기기로 등록할 수 있는지 정책을 먼저 정한다.

## 5. 연결과 교사 대시보드 설계 방향

다음은 제안 계약이며 아직 구현/측정한 값이 아니다.

```text
Teacher Web -- Google ID token --> 사용자 인증/학급 권한
                                     |
관리형 확장 -- 검증된 기기 증명 --> 기기 등록/기기 세션
                                     |
                            학급별 인증된 상태 전달
                                     |
                               Teacher Dashboard
```

- 동일 Wi-Fi, IP 검색, 웹페이지 방문만으로 발견하지 않는다. 등록된 클라이언트가 서버에 연결한다.
- Chrome 116부터 MV3 service worker에서 WebSocket 메시지를 30초 활동 창 안에 교환하면 연결 유지에 도움이 된다는 공식 예제가 있다. 예제의 20초 간격은 CLARIO 성능 보장이 아니다. 종료·업데이트·절전·네트워크 끊김을 고려해야 한다. [S5][S6]
- startup/설치/재시도 이벤트, 제한된 지수 backoff·jitter, 중복 연결 구분, 재인증, 서버 재시작 후 복구를 설계한다.
- 서버 수신 시각과 연결 epoch/세션을 기준으로 상태를 판단한다. 클라이언트가 보내는 과거 시각으로 온라인을 연장하지 않는다.
- `연결 중`은 실제 연결/인증 시도, `온라인`은 인증·heartbeat 유효, `오프라인`은 연결 종료 또는 측정된 timeout, `확인 불가`는 서버와 대시보드의 상태 동기화 실패로 구분한다. 단순 연결 끊김은 원인을 확정하지 못하므로 절전/전원 꺼짐/네트워크 장애 중 하나로 단정하지 않는다.
- timeout을 확정하지 않은 상태에서 “즉시 오프라인”을 약속하지 않는다. 실제 네트워크 시험으로 허용 지연을 정하고 UI에 마지막 수신 시각을 표시한다.
- 교사 구독도 기존 권한으로 인증한다. 브라우저 WebSocket은 일반 fetch처럼 임의 Authorization 헤더를 설정할 수 없으므로, 짧은 일회성 ticket 또는 인증 handshake 중 하나를 설계하고 검증한다. 장기 토큰을 URL에 넣지 않는다.
- 학급 변경/계정 중지/기기 철회 시 기존 구독·기기 세션을 종료한다. 최초 연결 검사뿐 아니라 이벤트 대상 범위와 현재 배정을 재확인한다.
- 다중 인스턴스가 필요해지면 연결 상태 공유·재전송·이벤트 버전 정책을 결정한다. 현재 단일 프로세스의 메모리만으로 영구 온라인을 주장하지 않는다.

대시보드는 학급 선택 → 학생/기기 카드 → 연결/기능 지원 상태 → 자료 공유 흐름을 중심으로 확장한다. 과목 선택은 필수로 추가하지 않는다.

| 화면 상태 | 표시 및 동작 |
|---|---|
| 미등록 | 기기 등록/학교 관리자 확인 안내. 온라인으로 표시하지 않음 |
| 연결 중/온라인/오프라인 | 실제 서버 증거와 마지막 수신 시각 표시 |
| 서버 확인 불가 | 오래된 온라인 배지를 정상처럼 유지하지 않고 상태 확인 불가 표시 |
| 화면 지원 미검증/권한 필요/불가 | 명확한 이유와 안내. 미리보기 비활성화 |
| 학생 배정 미확인 | 기기와 현재 학생의 연결을 확정하지 않았음을 표시 |
| 자료 공유 | URL 검증·교사 권한·학교/학급 대상·수신/열기 확인을 분리 |
| 빈 목록/조회 오류/권한 없음 | 서로 다른 안내와 복구 동작. 예시 학생 카드를 실제 목록처럼 채우지 않음 |

## 6. 화면 확인 및 녹화

- `desktopCapture.chooseDesktopMedia()`는 공식 문서상 화면/창/탭 선택 UI를 표시한다. 확장 프로그램 강제 설치만으로 선택 UI가 없어지거나 원격 전체 화면이 허용된다고 가정하지 않는다. [S7]
- `tabCapture`는 현재 탭 캡처이며 공식 가이드는 사용자 확장 호출/동작을 설명한다. 학생 기기 전체 화면 권한으로 확장 해석하지 않는다. [S8]
- `getDisplayMedia()`는 학생 측 소스 선택을 포함한다. offscreen document는 승인된 스트림 처리 수명을 다루는 수단이지 캡처 권한 우회 수단이 아니다. [S9]
- 공식 관리 정책에 따른 추가 허용 여부는 학교의 ChromeOS 버전·프로필·정책·배포 형태로 별도 확인한다. 확인되지 않은 무인 캡처 정책이나 비공개 API를 코드에 가정하지 않는다.
- 향후 스트림 전달에는 인증된 signaling과 WebRTC 등 별도 미디어 경로, NAT/TURN 검토가 필요하다. 상태용 WebSocket이 곧 영상 스트림 구현은 아니다.
- MediaRecorder는 이미 확보한 스트림을 기록하는 후보일 뿐이다. 관리자 승인·학생 안내·학교/학급 권한·암호화 저장·학생별 성공/미녹화 구간·보관 만료·복제본 삭제를 별도로 구현/검증해야 한다.
- 자동 연결 시험에 성공해도 화면 확인·녹화 지원 상태를 `supported`로 올리지 않는다.

## 7. 학교 관리자 확인과 외부 서비스

| 항목 | 필요한 확인 | 현재 |
|---|---|---|
| ChromeOS 기기 | 모델, OS/Chrome 버전, AUE/업데이트, 관리 등록, 관리 프로필 | 미확인 |
| 관리 형태 | 일반 학교 사용자 프로필/공용·게스트·키오스크 여부, OU, 사용자 affiliation | 미확인 |
| 배포 권한 | 시험 OU에 확장 프로그램 강제 설치, 고정 extension ID·업데이트 경로 | 미확인 |
| 관리 라이선스 | 해당 학교 기기의 Chrome 관리/교육용 업그레이드 보유 및 정책 사용 가능 여부 | 미확인, 추가 비용 없음으로 단정하지 않음 |
| Google 교사 로그인 | 웹 OAuth client ID, 동의/원본, 앱 접근 승인, 승인된 교사 계정 | 코드 있음, 실제 설정 미확인 |
| Verified Access | API 활성화, enterprise allowlist, 관리 정책, 서비스 계정 허용/identity 접근 | 미설정·미검증 |
| 기기 자산 목록 | Directory ID/학교 자산번호와 실물 매칭, 학생·학급 명부 승인 | 미제공 |
| Directory API | 필요할 때만 읽기 scope·관리자 위임/권한·조직 customer 범위 검토 | 선택 사항, 아직 불필요한 권한 요청 금지 |
| 배포/DB/네트워크 | 운영 DB·TLS·지속 연결 경로·학교 방화벽/프록시·절전 조건 | 기기 연결 관점 미검증 |
| 개인정보 | 기기 등록·상태·화면 목적, 수업 시간 범위, 안내·법적 근거·보관/삭제 | 학교 확인 필요 |

Admin Directory의 ChromeOS 장비 목록은 자산 인벤토리다. 조회 성공이나 목록의 last-sync 정보를 CLARIO 실시간 연결 상태/화면 접근 권한으로 사용하지 않는다. Directory API는 명부 연동이 필요할 때만 추가한다. [S10]

`storage.managed`는 관리자 배포 설정용 읽기 전용 영역이다. API 원본·정책 버전 같은 비밀이 아닌 설정에 사용하고 학교 전체 공용 비밀번호를 넣지 않는다. content script 접근 범위도 제한해야 한다. [S11]

## 8. 보안·개인정보 설계 검토 항목

아래는 발견된 취약점 목록이 아니라 신규 기기 경로 구현 전에 검증할 요구사항이다.

- 인증: ID/일련번호 위조, 폐기 기기 재등록, challenge 재전송·다른 요청으로 바꿔치기, 키/세션 복제 방지.
- 권한: 다른 학교/학급 등록, teacher→device 가장, 기기의 교사 API 접근, 기기 재배정 후 이전 교사의 구독 잔존 차단.
- 수집: 기본 상태 수집에 방문 기록·페이지 본문·키 입력·음성·화면을 포함하지 않음. 사용자 활동 감시와 heartbeat를 혼동하지 않음.
- 자격 증명: 서버 비밀은 확장 프로그램/프런트엔드/소스/로그/공유 관리 정책에 넣지 않음. 일반 extension storage를 하드웨어 보안 저장소라고 설명하지 않음.
- 공유 기기: 이전 학생·이전 프로필의 자료/화면/세션을 다음 학생에게 노출하지 않음. 사용자 변경 시 identity와 수업 배정 재평가.
- 투명성: 상태 연결·화면 확인·녹화를 학생이 확인할 수 있는 클라이언트 UI 제공. 학생 웹 방문 없이도 안내가 유지되어야 함.
- 보관: 학생 식별·기기 식별·접속 기록의 목적별 보관 기간과 삭제/철회, 녹화 원본·복제본 처리 및 감사 기록 접근 통제.
- 검증: 시험 OU와 합성 데이터부터 사용. 실제 학교 계정/기기 시험과 자동 테스트 결과를 구분.

## 9. 다음 단계와 문서 정합성

기존 `TASKS.md` Phase 번호를 덮어쓰지 않는다. 이번 요청의 단계와 매핑:

| 이번 요청 | 기존 작업 연결 | 다음 산출물/통과 기준 |
|---|---|---|
| 새 Phase 0 | 기존 Phase 0 기술 검증 보완 | 본 문서, 학교 환경 확인 및 등록 방식 결정. 실기기 부분은 미완료 |
| 새 Phase 1 | 기존 Phase 2 + Phase 3 일부 | 기존 Google 로그인 실계정 검증·기본 학급 UI 보완, 새로 만들지 않음 |
| 새 Phase 2 | 기존 Phase 0 기기 검증 + Phase 4, 기기 등록 신규 작업 | 승인된 최소 확장 + 별도 기기 인증/배정/철회 + heartbeat PoC |
| 새 Phase 3 | 기존 Phase 3/5/7 | 실제 기기 카드·자료 전달, 별도 검증된 경우에만 화면 확인 |
| 새 Phase 4 | 기존 Phase 9/10 | 학교/학급 격리·재연결·철회·개인정보·실기기 시험 |

구현 전에 확정할 결정:

1. 관리자가 관리형 기기/계정·시험 OU·정책 권한을 확인한다.
2. 1인 1기기인지 공유 기기인지, 학교 식별을 도메인으로 나눌 수 있는지 확인한다.
3. Verified Access PoC를 우선할지, 명시적으로 승인된 최초 페어링 대안을 사용할지 결정한다. 둘 다 근거가 없으면 기기 자동 인증 구현을 보류한다.
4. 실제 Google 로그인 검증과 기기 인증을 분리하고, 기기 상태만 먼저 시험한다. 화면 캡처/녹화는 시험 범위에서 제외한다.
5. 성공 후 기기 등록 스키마·인증 계약·철회/삭제·실시간 상태 유효기간을 확정해 작은 기능 단위로 구현한다.

문서 처리:

- `PRD.md`: 학생 웹 매번 로그인 불요라는 목표와 인증/화면 권한 분리를 반영.
- `ARCHITECTURE.md`: 기존 Student Web 보존, 별도 Device Client 목표 구조와 구현 상태 구분.
- `TASKS.md`: 새 요청과 기존 번호 매핑, 조사 완료와 실기기 미검증 분리.
- `AGENT.md`: 기존 승인·보안·정직한 상태 원칙 유지. 현재 학생 로그인 경로는 선택 경로이며 자동 연결 구현 시 기기 인증을 별도로 검증한다는 본 문서의 요구를 함께 적용한다.
- `docs/phase-0-findings.md`: 초기 코드가 없던 시점의 역사적 조사로 보존.
- `docs/phase-2-authentication.md`: 기존 웹 로그인 구현의 검증 기록으로 보존. 기기 인증이 구현된 기록으로 읽지 않는다.

이번 조사에서는 소스·마이그레이션·의존성·배포 설정을 변경하지 않았으며 새 빌드/테스트를 실행하지 않았다. 이전 29개 통과 결과는 기기 기능 검증 결과가 아니다. 학교 환경·실기기 검증 전에는 새 Phase 0 전체 완료와 자동 연결 지원을 선언하지 않는다.

## 공식 참고 자료

- [S1: Chrome enterprise.platformKeys / challengeKey](https://developer.chrome.com/docs/extensions/reference/api/enterprise/platformKeys)
- [S2: Chrome Verified Access 개발자 가이드](https://developers.google.com/chrome/verified-access/developer-guide)
- [S3: Verified Access v2 verify 응답과 관리 프로필/기기 차이](https://developers.google.com/chrome/verified-access/reference/rest/v2/challenge/verify)
- [S4: Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [S5: 확장 프로그램 service worker의 WebSocket](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [S6: service worker 수명과 종료](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [S7: desktopCapture 선택 UI](https://developer.chrome.com/docs/extensions/reference/api/desktopCapture)
- [S8: tabCapture 사용자 호출과 탭 범위](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
- [S9: Chrome 공식 화면 캡처/녹화 가이드](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)
- [S10: Admin Directory ChromeOS 기기 관리](https://developers.google.com/admin-sdk/directory/v1/guides/manage-chrome-devices)
- [S11: storage.managed와 저장소 접근 수준](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [S12: 관리자 확장 프로그램 강제 설치](https://support.google.com/chrome/a/answer/6306504?hl=en)
- [S13: enterprise.deviceAttributes의 affiliation·식별자 조건](https://developer.chrome.com/docs/extensions/reference/api/enterprise/deviceAttributes)
