# 설계 결정 기록 (DECISIONS)

요청서에 명시되지 않았거나 해석이 필요한 부분을 어떻게 결정했는지 기록합니다.

## 1. 프로젝트 구조

| 항목 | 결정 | 이유 |
|---|---|---|
| 저장소 형태 | 단일 `package.json` (워크스페이스 미사용) | 서버/웹/공용 코드가 같은 TS 설정을 공유. 설치·실행 명령 단순화 |
| 디렉터리 | `src/shared`(도메인·엔진), `src/server`, `web`(Vite root), `prisma`, `tests` | 엔진은 서버와 브라우저 양쪽에서 import (카운트다운 계산 재사용) |
| 서버 실행 | `tsx` 로 TS 직접 실행 (별도 빌드 없음) | MVP 단계에서 빌드 파이프라인 최소화 |
| 웹 배포 | `vite build` → `dist/web` 를 Fastify가 정적 서빙 | 운영 시 포트 1개(38080)로 폰 접속 단순화 |
| Prisma 버전 | 6.x (`prisma-client-js`) | 7.x는 driver adapter/`prisma.config.ts` 필수로 구성이 복잡. 6.x가 SQLite 단일 파일 운용에 가장 단순 |
| TypeScript | 5.x | 7.x(네이티브 포트)는 생태계 호환성 검증 부족 |
| 환경 변수 | Node 내장 `process.loadEnvFile()` 사용, dotenv 미사용 | 의존성 최소화 |

### 알려진 이슈
- `npm audit` 에서 `prisma`(CLI, devDependency) → `@prisma/config` → `deepmerge-ts` high 경고가 보고됨. 런타임(@prisma/client)이 아닌 CLI 전용 경로이며, 권장 수정(`--force`)은 prisma 다운그레이드라 적용하지 않음.
- `concurrently`(개발 모드 전용)가 고정한 `shell-quote@1.9.0` 의 critical 경고(GHSA-pqg4-j6r4-53mv)는 `package.json` `overrides` 로 `^1.12.0` 강제. 배포판에는 포함되지 않는 개발 도구.

## 2. 도메인 모델 확장

요청서의 Cue 필드(camera, shotSize, note, durationSec, section, atemAction) 외에 진행 모드 구현에 필요한 최소 필드를 추가했습니다.

| 위치 | 필드 | 용도 |
|---|---|---|
| Act | `mode` | `MANUAL` / `SECTION` / `TIMECODE` (Act별 진행 모드) |
| Act | `bpm`, `beatsPerBar`(기본 4) | SECTION 모드 자동 진행 시간 계산 |
| Cue | `bars` | SECTION 모드에서 이 큐가 유지되는 마디 수. 길이 = `bars × beatsPerBar × 60 / bpm` 초 |
| Cue | `tcInSec` | TIMECODE 모드에서 Act 시작 기준 진입 시각(초). 비우면 앞 큐들의 `durationSec` 누적값 |

- **section**: 요청서 예시(V1/PRE/CH/BR/OUTRO)에 INTRO, V2, V3, INST, TAG 를 프리셋으로 추가. 값 검증은 `^[A-Z][A-Z0-9]{0,7}$` 로 느슨하게 허용 (V4, CH2 등 실제 콘티 대응).
- **camera**: 1~8 (ATEM 입력 번호와 1:1 매핑).

## 3. 큐 진행 엔진 (`src/shared/engine.ts`)

- `reduce(service, state, event) → { state, effects }` 순수 함수. 시간은 모든 이벤트에 `now` 로 주입 → 테스트에서 가짜 시계 불필요.
- 부수효과는 `effects` 로만 표현: `ATEM`(큐의 atemAction), `TIMECODE_START/STOP`(타임코드 소스 제어). 서버가 실제 실행.
- 위치는 `(actIndex, cueIndex)`, STANDBY 는 `(-1, -1)`. 빈 Act 는 GO/BACK 시 건너뜀.

### 모드별 규칙

| 모드 | GO | 자동 진행 |
|---|---|---|
| MANUAL | 다음 큐 | 없음 (`durationSec` 은 카운트다운 표시용) |
| SECTION | 자동 진행 중인 섹션 블록 안이면 **다음 섹션 첫 큐로 점프**(=섹션 시작 수동 트리거), 아니면 다음 큐 | 같은 section 라벨이 연속된 블록 안에서 `bars`·`bpm` 기준. 블록의 마지막 큐는 시간이 지나도 머무름(다음 섹션 트리거 대기) |
| TIMECODE | 다음 큐 (수동 선행 허용) | 타임코드가 가리키는 마지막 큐로 **전진만** 함. 중간 큐를 건너뛰면 ATEM 은 최종 큐만 전송 |

- SECTION 자동 진행 시 새 큐 시작 시각 = 이전 큐 시작 + 길이 (TICK 지연과 무관하게 박자 누적 오차 없음). 지연된 TICK 한 번에 여러 큐를 넘기면 ATEM 효과도 순서대로 모두 발생.
- 섹션 라벨이 없는 큐, 또는 `bars`/`bpm` 이 없는 큐는 SECTION 모드에서도 GO 로 한 큐씩 진행.
- 같은 섹션을 연속 반복(예: 후렴 2회)하려면 섹션 라벨을 달리 하거나(CH, CH2) 사이에 다른 섹션이 있어야 블록이 분리됨.
- Act 경계는 모드와 관계없이 항상 GO 로 넘어감 (자동으로 다음 순서로 넘어가지 않음 — 예배 안전성 우선).

### BACK
- 직전 큐로 이동(Act 경계 넘음)하고 해당 큐의 ATEM 액션을 **다시 전송** → 화면도 이전 샷으로 복귀.
- SECTION 블록 안으로 돌아가면 그 큐부터 자동 진행 재개.

### HOLD (토글)
- HOLD 중: SECTION 자동 진행·TIMECODE 추종 정지. 큐 경과 시간도 멈춤.
- 해제 시 `cueStartedAt` 을 HOLD 시간만큼 뒤로 밀어 남은 마디부터 이어감.
- HOLD 중에도 디렉터의 GO/BACK/JUMP 는 동작(수동 개입 우선), HOLD 상태는 유지.
- TIMECODE 는 HOLD 중에도 수신값만 기록하고, 해제 후 다음 타임코드 수신 시 현재 위치로 따라잡음(외부 타임코드는 멈추지 않는 것이 실제 동작).

### 탈리(ON AIR) 판단
- `cut`/`auto` 큐만 PGM 카메라를 바꾼 것으로 간주(`programCamera`). `macro`/`dsk` 큐는 PGM 유지.
- 서버는 ATEM 이 연결돼 있으면 **실제 ATEM PGM 입력**을, 아니면 엔진의 `programCamera` 를 탈리로 사용.

### 카운트다운 (`upcoming`, `cameraView`)
- 현재 큐 남은 시간 + 이후 큐 길이 누적으로 각 큐의 ETA 계산.
- 모든 전환이 자동이면 `exact=true`(정확), 중간에 수동 GO 가 필요하면 "즉시 GO 가정" 최소 추정치(`exact=false`), 길이를 모르는 큐가 끼면 `etaMs=null`(“큐 N개 후”로 표시).
- 엔진이 브라우저에서도 동작하므로 CueScreen 은 서버 시간 오프셋만 보정해 로컬에서 매 프레임 카운트다운 계산.

### 편집 중 갱신 (`reconcile`)
- 라이브 중 에디터 저장 시 현재 큐 id 로 위치를 다시 찾음. 큐 삭제 시 같은 Act 의 가까운 큐, Act 삭제 시 STANDBY.

## 4. 서버 / WebSocket

| 항목 | 결정 |
|---|---|
| WebSocket | `@fastify/websocket` 대신 `ws` 를 Fastify 의 http 서버 `upgrade` 이벤트에 직접 연결 (요청서 "WebSocket(ws)"). 경로 `/ws` |
| 상태 보관 | `ShowRuntime` 이 메모리에 엔진 상태 보관. 서버 재시작 시 STANDBY 로 시작 (라이브 위치는 DB 저장 안 함 — 재시작 후 디렉터가 JUMP 로 복귀) |
| 시작 시 로드 | 가장 최근 수정된 예배를 자동 로드. 디렉터 콘솔에서 교체 가능(`POST /api/show/load`) |
| 자동 진행 주기 | 20ms 간격 TICK (SECTION Act 에서만). 박자 기준 시각은 엔진이 보정하므로 타이머 지터는 누적되지 않음 |
| 명령 권한 | WS 에서 `hello.role = director` 인 클라이언트만 GO/BACK/HOLD/JUMP/RESET 허용. CueScreen(cam)은 읽기 전용. 인증은 없음(교회 내부 LAN 전제) |
| HTTP 명령 | `POST /api/show/command` 추가 — Bitfocus Companion/Stream Deck 의 HTTP 액션으로 GO 버튼 매핑 가능 |
| 시간 동기화 | `ping`/`pong` 으로 서버 시각 오프셋 계산 → 폰 시계가 틀려도 카운트다운 정확 |
| 끊김 감지 | 15초 주기 WS ping/pong, 응답 없으면 정리 (폰 잠금/와이파이 전환 대비). 클라이언트는 자동 재접속 |
| 에디터 저장 | 전체 문서 PUT. 클라이언트가 Act/Cue id 를 유지해 보내면 upsert, 빠진 항목 삭제. 다른 예배 소유 id 는 409 |
| JSON 내보내기 | `{ format: "camcue/service@1", exportedAt, service }`, id 제거(다른 PC로 이식 시 충돌 방지). 가져오기는 래퍼 없는 서비스 객체도 허용 |
| 테스트 DB | Vitest globalSetup 에서 `prisma db push` 로 템플릿 SQLite 생성 → 테스트 파일마다 복사해 독립 사용 |

## 5. 디렉터 콘솔 (`/director`)

- 단축키: `Space`=GO, `Backspace`=BACK, `H`=HOLD 토글. 키 반복(`repeat`)·입력 필드 포커스·조합키(Ctrl/Alt/Meta)는 무시해 오조작 방지.
- 버튼을 마우스로 누른 뒤 Space 를 치면 "버튼 클릭 + 단축키" 로 GO 가 두 번 나가는 문제 → 전송 버튼은 포커스를 받지 않게 처리.
- 런시트(우측)는 **더블클릭**으로 JUMP (한 번 클릭 오조작 방지). 현재 큐 자동 스크롤.
- NEXT 카드에 "자동 전환 0:15" / "수동 GO 대기" 를 구분 표시.
- RESET 은 확인 대화상자 필수.
- 탈리 그리드: ATEM 연결 시 실제 PGM/PVW, 미연결 시 엔진 추정(라벨로 출처 표시).
- 카메라별 고정 색상(1 파랑, 2 초록, 3 노랑, 4 보라, 5 청록, 6 주황, 7 분홍, 8 회색)을 전 화면 공통 사용.

## 6. CueScreen (`/cam/:n`)

- 다크 고정(테마 토글 없음), 모든 크기 `vmin` 기준 → 폰 세로/가로·태블릿 모두 큰 글씨.
- 표시 우선순위: **ON AIR 중이면 "지금 내 샷" + 남은 시간**, 아니면 **"다음 내 샷" + 내 차례까지 카운트다운**. 하단에 "그 다음" 샷.
- 카운트다운 표기: 정확(자동 전환만 남음) `0:12` / 수동 GO 포함 추정 `≈ 0:41+` / 길이 미정 `큐 N개 후`. 5초 이하(정확)일 때 노란색 강조.
- 탈리: PGM = 빨간 두꺼운 테두리 + 배경 붉게 + ON AIR 배지 깜빡임, PVW = 초록 테두리(“곧 내 차례” 준비). ATEM 실제 상태 우선.
- ON AIR 진입 시 진동(안드로이드, 사용자 탭 이후).
- **화면 꺼짐 방지**: 첫 진입 시 "탭해서 시작" 오버레이 → 사용자 제스처로 Wake Lock + 전체화면 요청.
  - Wake Lock API 는 **보안 컨텍스트(HTTPS/localhost)에서만** 동작. 교회 LAN 에서 `http://192.168.x.x` 로 접속하면 사용 불가 → 음소거 반복 비디오(canvas `captureStream`) 재생 폴백(NoSleep 방식, best-effort).
  - 확실히 하려면 `TLS_CERT`/`TLS_KEY` 환경변수로 HTTPS 서비스(README 의 mkcert 안내) 또는 폰 자동 잠금 해제.
- 탭 전환·잠금 후 복귀 시 Wake Lock 재요청 + WebSocket 즉시 재접속.

## 7. 에디터 (`/editor/:id`)

- **타임라인**: Act 마다 가로 레인 1개. 큐 블록 너비 = 계산된 길이(SECTION: 마디·BPM, TIMECODE: 다음 큐 TC 차이, 그 외 durationSec) × 줌. 길이 미정 큐는 고정 폭 + 점선 테두리.
- 블록 상단 색 = 카메라 색, 섹션 라벨 띠 = 섹션 색(CH 빨강, V 파랑, PRE 보라 …). 섹션 블록 시작 큐만 진하게 표시.
- **드래그 정렬**: `@dnd-kit/sortable` (5px 이상 움직여야 드래그 → 클릭 선택과 구분). 키보드 정렬도 지원(`Alt+←/→`).
- **Act 간 큐 이동**은 드래그 대신 인스펙터의 "다른 순서로 이동" 셀렉트로 처리 (레인 간 드래그는 오조작 위험 대비 이득이 작다고 판단).
- 새 큐는 직전 큐의 섹션·마디·카메라를 이어받음 (같은 섹션 연속 입력 속도).
- **저장 모델**: 로컬에서 편집 → `저장`(Ctrl+S) 시 전체 문서 PUT. 미저장 상태 표시 + 페이지 이탈 경고. 라이브 중인 예배면 즉시 런타임에 반영(현재 큐 유지).
- 새 Act/Cue id 는 클라이언트에서 UUID v4 생성. LAN HTTP(비보안 컨텍스트)에서는 `crypto.randomUUID` 가 없으므로 `getRandomValues` 폴백.
- **JSON 내보내기**는 저장된 서버 버전 기준(미저장 시 비활성). **가져오기**는 항상 새 예배로 생성(기존 예배 덮어쓰기 없음).
- 편집 연산은 `src/shared/editorOps.ts` 순수 함수로 분리하고 Vitest 로 검증.
- 정적 파일 서빙은 `@fastify/static` wildcard 모드 (서버 실행 중 `npm run build` 해도 새 자산 즉시 반영).

## 8. ATEM 어댑터 (`src/server/atem`)

| `ATEM_HOST` | 어댑터 | 동작 |
|---|---|---|
| (비움) | `DisabledAtemAdapter` | 장비 제어 없음. 큐 진행·CueScreen 만 사용 |
| `mock` | `MockAtemAdapter` | 가상 스위처(PGM/PVW/DSK/매크로 시뮬레이션, AUTO 1초). 장비 없이 리허설·데모 |
| `192.168.x.x[:port]` | `RealAtemAdapter` | `atem-connection` 으로 실제 장비 제어 (기본 UDP 9910) |

- 공통 인터페이스 `AtemAdapter` + `executeAtemAction()` 변환 함수. 런타임·테스트는 인터페이스에만 의존.
- **atemAction 매핑**

  | 큐 값 | 스위처 명령 | PGM 변경 |
  |---|---|---|
  | `cut` | `changePreviewInput(cam)` → `cut()` | O |
  | `auto` | `changePreviewInput(cam)` → `autoTransition()` (스위처에 설정된 트랜지션/레이트) | O |
  | `macro:n` | `macroRun(n-1)` — n 은 ATEM Software Control 표기(1부터) | X |
  | `dsk:n:on/off` | `setDownstreamKeyOnAir(on, n-1)` | X |

  - camera 번호 = ATEM 입력 번호 (CAM1 = Input 1). 매핑 테이블은 MVP 범위 밖.
  - M/E 는 기본 M/E 1, `ATEM_ME` 로 변경.
- **PVW 자동 준비**: CUT 직후 다음 큐 카메라를 PVW 에 올림(멀티뷰·탈리에서 "다음 차례" 확인). AUTO 직후에는 트랜지션 중 PVW 변경이 전환 대상을 바꿀 위험이 있어 생략.
- **장애 처리**
  - 연결 실패/끊김은 예외로 앱을 멈추지 않음. `status()` 의 `connected=false`, `lastError` 로 UI 에 표시. `atem-connection` 의 자동 재접속에 맡김.
  - 미연결 중의 큐 전환은 ATEM 으로 보내지 않음(엔진 진행은 계속). **재연결 시 현재 큐를 자동 재송출하지 않음** — 그 사이 수동 스위칭했을 수 있으므로 의도치 않은 화면 전환 방지. 디렉터가 필요 시 JUMP/BACK 으로 재송출.
  - 명령 실패는 로그만 남기고 다음 명령은 계속 실행. ATEM 명령은 직렬 큐로 순서 보장.
- `atem-connection` 은 실제 장비 모드에서만 동적 import (mock/disabled 에서는 워커 스레드 미생성).

## 9. 기타

- `.env` 는 git 제외, `.env.example` 커밋. `npm run setup` 이 없으면 복사.
- 기본 `ATEM_HOST=mock` — 처음 실행해도 탈리·PVW 흐름을 바로 확인 가능. 실제 장비는 IP 로 교체.
- GitHub Actions CI(`.github/workflows/ci.yml`): `npm ci → typecheck → test → build`.
- Node 20.12+ 요구 (`process.loadEnvFile`).

## 11. 이름 변경 · 포트 (0.0.2~)

| 항목 | 결정 | 이유 |
|---|---|---|
| 이름 | Mini CuePilot → **CamCue(캠큐)** | "CuePilot" 은 같은 분야(생중계 카메라 큐) 상용 제품(CuePilot ApS) 이름. 공개 배포 시 상표·혼동 시비 소지 제거. "CamCue" 동명 방송 소프트웨어 검색 결과 없음 |
| 업그레이드 | 설치 프로그램 AppId 유지 + 예전 폴더·바로가기·방화벽 규칙 정리, 데이터는 `MiniCuePilot\cuepilot.db` → `CamCue\camcue.db` 복사 | 기존 사용자 큐시트 보존. 예전 데이터 폴더는 삭제하지 않음(롤백 대비) |
| 기본 포트 | **38080** | v0.0.1 기본 3000 이 Hyper-V/WSL/Docker 의 예약 포트 대역(`netsh int ipv4 show excludedportrange`)과 겹쳐 `EACCES` 로 실행 실패한 실제 사례. 사용자 요청으로 5자리, 동적 포트 대역(49152~) 밖 |
| 포트 자동 변경 | EACCES/EADDRINUSE 시 38080 → 38090 → 28080 → 18080 → 48080 → OS 자동(0). 바뀐 포트는 `config.env` 에 저장 | 폰 접속 주소가 실행마다 바뀌지 않게 |
| 중복 실행 | 설정 포트에 CamCue 가 이미 응답하면 새로 띄우지 않고 기존 화면을 엶 | 바로가기 두 번 클릭 시 포트만 바뀐 두 번째 서버가 뜨는 혼란 방지 |
| 검증 | EACCES/EADDRINUSE 분류·후보 순서·저장은 단위 테스트, 실제 Windows 에서는 38080 을 점유한 상태로 자동 전환·`config.env` 저장을 CI 스모크 테스트 | GitHub Windows 러너에서는 Hyper-V 예약과 같은 EACCES 를 만들 수 없음을 확인(`netsh` 관리자 제외는 bind 를 막지 않고, 배타적 점유 소켓은 EADDRINUSE 로 보고됨). 두 오류는 같은 전환 경로를 탐 |

## 10. 버전 관리 · Windows 배포 (0.0.1~)

| 항목 | 결정 | 이유 |
|---|---|---|
| 버전 체계 | SemVer, 정식 전 `0.0.x` | 사용자 요청. `0.` 버전은 Release 에 Pre-release 표시 |
| 버전 기준 | `package.json` 단일 소스 → `src/shared/version.ts` 로 서버·웹에 주입 | 표시 버전과 배포 파일 버전 불일치 방지 |
| 변경 이력 | `CHANGELOG.md` (Keep a Changelog). `npm version` 훅이 `[Unreleased]` → 버전 섹션 이동, 비어 있으면 중단 | 릴리스 노트 자동화 + 기록 누락 방지 |
| 배포 형식 | Inno Setup 설치판 + 포터블 ZIP | 단일 exe(Node SEA/pkg)는 Prisma 네이티브 엔진·atem-connection 워커 스레드 때문에 불안정. 런타임 동봉 폴더 방식이 가장 확실 |
| 빌드 위치 | GitHub Actions `windows-latest` | Windows 용 Prisma 엔진을 정식 경로로 생성. 태그 push 시 Release 자동 게시, PR 에서는 아티팩트만 |
| 런타임 | 빌드에 쓴 Node 22 `node.exe` 동봉 | PC 에 Node 설치 불필요 |
| 데이터 위치 | `%LOCALAPPDATA%\CamCue` (`config.env`, `camcue.db`) | Program Files 는 쓰기 불가, 업데이트/제거 시 큐시트 보존 |
| 첫 실행 | 빌드 시 만든 빈 `template.db` 복사 + 샘플 예배 시드 | 사용자 PC 에서 prisma CLI(스키마 엔진) 실행 불필요 |
| 방화벽 | 설치 옵션으로 `node.exe` 프로그램 기준 인바운드 허용, 모든 프로필 | 교회 Wi-Fi 가 '공용 네트워크'로 분류되는 경우가 많음. 제거 시 규칙 삭제 |
| 용량 | 런타임 의존성만 + Prisma 미사용 DB 엔진(WASM)·소스맵 제거 | 386MB → 약 200MB(압축 시 약 60MB) |
| 코드 서명 | 미적용 | 인증서 비용. SmartScreen 경고 안내로 대체 |
| 실행기 | `.cmd` + 서버 콘솔 창 | 창이 떠 있어야 "서버 동작 중"이 명확하고, 닫으면 종료되는 직관적 모델 |
