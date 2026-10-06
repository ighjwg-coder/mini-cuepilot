# 설계 결정 기록 (DECISIONS)

요청서에 명시되지 않았거나 해석이 필요한 부분을 어떻게 결정했는지 기록합니다.

## 1. 프로젝트 구조

| 항목 | 결정 | 이유 |
|---|---|---|
| 저장소 형태 | 단일 `package.json` (워크스페이스 미사용) | 서버/웹/공용 코드가 같은 TS 설정을 공유. 설치·실행 명령 단순화 |
| 디렉터리 | `src/shared`(도메인·엔진), `src/server`, `web`(Vite root), `prisma`, `tests` | 엔진은 서버와 브라우저 양쪽에서 import (카운트다운 계산 재사용) |
| 서버 실행 | `tsx` 로 TS 직접 실행 (별도 빌드 없음) | MVP 단계에서 빌드 파이프라인 최소화 |
| 웹 배포 | `vite build` → `dist/web` 를 Fastify가 정적 서빙 | 운영 시 포트 1개(3000)로 폰 접속 단순화 |
| Prisma 버전 | 6.x (`prisma-client-js`) | 7.x는 driver adapter/`prisma.config.ts` 필수로 구성이 복잡. 6.x가 SQLite 단일 파일 운용에 가장 단순 |
| TypeScript | 5.x | 7.x(네이티브 포트)는 생태계 호환성 검증 부족 |
| 환경 변수 | Node 내장 `process.loadEnvFile()` 사용, dotenv 미사용 | 의존성 최소화 |

### 알려진 이슈
- `npm audit` 에서 `prisma`(CLI, devDependency) → `@prisma/config` → `deepmerge-ts` high 경고가 보고됨. 런타임(@prisma/client)이 아닌 CLI 전용 경로이며, 권장 수정(`--force`)은 prisma 다운그레이드라 적용하지 않음.

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
| JSON 내보내기 | `{ format: "mini-cuepilot/service@1", exportedAt, service }`, id 제거(다른 PC로 이식 시 충돌 방지). 가져오기는 래퍼 없는 서비스 객체도 허용 |
| 테스트 DB | Vitest globalSetup 에서 `prisma db push` 로 템플릿 SQLite 생성 → 테스트 파일마다 복사해 독립 사용 |
