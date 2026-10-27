# CamCue (캠큐)

> v0.0.1 까지의 이름은 "Mini CuePilot" 이었습니다. 상용 제품 CuePilot 과의 혼동을 피하기 위해 이름을 바꿨습니다.

공연·컨퍼런스·행사 등 **라이브 중계용 카메라 큐시트 진행 + ATEM 스위처 제어 + 카메라맨 모바일 CueScreen** 웹앱.

```
에디터(큐시트 작성) ──► 디렉터 콘솔(GO/BACK/HOLD) ──► ATEM 스위처 (CUT/AUTO/매크로/DSK)
                               │
                               └──► 카메라맨 폰 /cam/1 ~ /cam/8 (내 샷·카운트다운·탈리)
```

| 구분 | 스택 |
|---|---|
| 서버 | Node.js + TypeScript, Fastify, WebSocket(`ws`) |
| 프론트 | React + Vite |
| DB | SQLite (Prisma 6) |
| ATEM | `atem-connection` (+ 테스트용 Mock 어댑터) |
| 테스트 | Vitest |

설계 판단 근거는 [`docs/DECISIONS.md`](docs/DECISIONS.md) 참고.

---

## 0. Windows 에 바로 설치 (개발 환경 불필요)

[**Releases**](https://github.com/ighjwg-coder/mini-cuepilot/releases) 에서 최신 버전을 받습니다.

| 파일 | 용도 |
|---|---|
| `CamCue-Setup-v0.0.x-win-x64.exe` | **설치판 (권장)** — 시작 메뉴·바탕화면 바로가기, 방화벽 자동 허용 |
| `CamCue-portable-v0.0.x-win-x64.zip` | 포터블 — 압축 풀고 `CamCue.cmd` 더블클릭 |

1. 설치 후 **CamCue** 실행 → 서버 창이 열리고 브라우저가 자동으로 `http://localhost:38080` 을 엽니다.
2. 처음 실행 시 "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행** (코드 서명 미적용 무료 배포본).
3. 스위처·GPI 연결은 상단 **[장비 연결]** 화면에서 바꾸면 바로 적용됩니다 (설정은 `%LOCALAPPDATA%\CamCue\config.env` 에 저장).
4. 큐시트는 `%LOCALAPPDATA%\CamCue\camcue.db` 에 저장되며, 새 버전으로 업데이트하거나 제거해도 유지됩니다.

버전 규칙과 릴리스 절차는 [`docs/RELEASING.md`](docs/RELEASING.md), 변경 이력은 [`CHANGELOG.md`](CHANGELOG.md).

---

## 1. 로컬 실행 (소스에서)

### 요구 사항
- Node.js **20.12 이상** (22 LTS 권장)
- Windows / macOS / Linux

### 최초 1회 셋업

```bash
npm install
npm run setup      # .env 생성 → Prisma 클라이언트 생성 → SQLite(prisma/dev.db) 생성 → 샘플 행사 시드
```

샘플 행사: **오프닝 공연 1곡(SECTION, 128BPM) · 공연 2곡(SECTION, 72BPM) · 공연 3곡(MANUAL) · 인사말(MANUAL, DSK 자막) · 메인 강연(TIMECODE, 매크로)**

### 개발 모드 (코드 수정하며 실행)

```bash
npm run dev
```

| 주소 | 화면 |
|---|---|
| http://localhost:5173 | 홈 (행사 목록) |
| http://localhost:5173/director | 디렉터 콘솔 |
| http://localhost:5173/editor | 에디터 |
| http://localhost:5173/cam/1 | CueScreen (CAM 1) |

> 개발 모드는 Vite(5173)가 API/WS 를 서버(38080)로 프록시합니다.

### 운영 모드 (행사 당일 권장)

```bash
npm run build      # 웹 빌드 → dist/web
npm start          # http://<서버IP>:38080 하나로 전체 서비스
```

### 테스트

```bash
npm test           # Vitest 전체 (엔진·서버·WS·ATEM mock 통합)
npm run typecheck
```

### 배포 패키지 / 릴리스

```bash
npm run package          # release/CamCue/ 조립 (실행 중인 OS 용)
npm run release:patch    # 0.0.1 → 0.0.2 + CHANGELOG 정리 + 태그
git push --follow-tags   # → GitHub Actions 가 Windows 설치 파일을 만들어 Releases 에 게시
```

### 환경 변수 (`.env`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | SQLite 파일 (prisma/ 기준 상대경로) |
| `PORT` | `38080` | 서버 포트 |
| `HOST` | `0.0.0.0` | 바인드 주소 (폰 접속을 위해 0.0.0.0 유지) |
| `ATEM_HOST` | `mock` | 비움=ATEM 미사용 / `mock`=가상 스위처 / `192.168.10.240[:9910]`=실제 장비 |
| `ATEM_ME` | `1` | 제어할 M/E 버스 번호 |
| `SWITCHER` | `atem` | 스위처 종류: `atem` / `ikegami` / `gpi` / `none` — [3-6](#3-6-이케가미-라우터--gpi-연결-003) |
| `IKEGAMI_*`, `GPI_*`, `TALLY_SOURCE` | - | 이케가미 RS-422 · GPI 모듈 설정 — [3-6](#3-6-이케가미-라우터--gpi-연결-003) |
| `TLS_CERT`, `TLS_KEY` | - | (선택) HTTPS 인증서 경로 → 폰 Wake Lock 보장 |

---

## 2. 사용법

### 진행 모드 (Act 별 선택)

| 모드 | GO 동작 | 자동 진행 |
|---|---|---|
| **MANUAL** | 다음 큐 | 없음 (`길이` 는 카운트다운 표시용) |
| **SECTION** | 섹션 블록 안이면 **다음 섹션 첫 큐로** (= 섹션 시작 트리거) | 같은 섹션(V1, CH …) 안의 큐는 `마디 수 × 박자 × 60 / BPM` 초마다 자동 전환. 섹션 마지막 큐에서 대기 |
| **TIMECODE** | 다음 큐 (수동 선행 허용) | 타임코드가 큐의 `TC 진입(초)` 에 도달하면 자동 전환. MVP 는 Act 진입 시 0초부터 흐르는 **내부 시뮬레이션 클락** 사용 |

- Act 경계는 항상 GO 로 넘어갑니다 (자동으로 다음 순서로 넘어가지 않음).
- **HOLD**: 자동 진행·타이머 정지, 다시 누르면 남은 시간부터 재개. HOLD 중에도 GO/BACK 은 동작.
- **BACK**: 직전 큐로 돌아가며 해당 카메라로 다시 전환.
- **큐만 이동 (컷 없음)**: 디렉터 화면 체크박스 또는 `Shift`+더블클릭. 스위처를 건드리지 않고 큐 위치만 맞춤
  (패널이 큐보다 앞서 나갔을 때, 위치를 되돌릴 때)
- **GO 연타 방지**: GO·BACK 을 0.5초 안에 다시 누르면 무시 (`CAMCUE_GO_LOCK_MS`, 0 = 끔)
- GO 버튼에 **실제로 갈 큐**(카메라·섹션)가 표시됩니다. SECTION 자동 구간에서는 다음 섹션 첫 큐로 건너뜀
- 컷이 실패하거나 스위처 미연결로 못 보내면 디렉터 화면에 빨간 알림 + [스위처 명령 기록]
- **진행 위치 자동 저장**: 캠큐가 재시작돼도 진행 중이던 행사·큐 위치로 컷 없이 돌아옵니다 (3시간 이내)
- 이미 라이브 중인 행사의 [라이브로 열기] 는 진행 위치를 지우지 않습니다 (처음부터는 디렉터의 RESET)

### 디렉터 콘솔 단축키

| 키 | 동작 |
|---|---|
| `Space` | GO |
| `Shift`+`Backspace` | BACK (`Backspace` 만 누르면 안내만 — 실수 방지) |
| `H` | HOLD / RESUME |
| 런시트 더블클릭 | 해당 큐로 JUMP (+ 컷) |
| 런시트 `Shift`+더블클릭 | 해당 큐로 컷 없이 이동 |

### 제어 권한 (0.0.7~)

GO·RESET·행사 편집·장비 설정은 **캠큐 PC 에서만** 됩니다. 카메라맨 화면(`/cam/N`)은 누구나 열 수 있습니다.
다른 기기(노트북·태블릿·다른 PC 의 Companion)에서 제어하려면 `config.env` 에 PIN 을 정하고 다시 시작하세요.

```
CAMCUE_PIN=4821
```

다른 기기에서 디렉터 화면을 열면 [PIN 입력] 이 나오고, 한 번 입력하면 그 브라우저에 기억됩니다.
HTTP 로 제어할 때는 `x-camcue-pin: 4821` 헤더를 붙입니다.

### 에디터 단축키

| 키 | 동작 |
|---|---|
| 블록 드래그 | 순서 변경 |
| `Ctrl`+`S` | 저장 (라이브 중이면 즉시 반영, 현재 큐 유지) |
| `Alt`+`←/→` | 선택 큐 이동 |
| `Ctrl`+`D` | 선택 큐 복제 |
| `Delete` | 선택 큐 삭제 |

- **JSON 내보내기**: 에디터 상단 → `{date}-{title}.json` 다운로드 (id 제외, 다른 PC 이식 가능)
- **JSON 가져오기**: 홈/에디터 → 항상 **새 행사**로 생성

### atemAction 값

| 값 | 동작 |
|---|---|
| `cut` | 큐 카메라(= ATEM Input 번호)로 즉시 전환 |
| `auto` | 큐 카메라로 AUTO 트랜지션 (스위처에 설정된 믹스/와이프·레이트) |
| `macro:3` | 매크로 3번 실행 (ATEM Software Control 의 번호, 1부터) |
| `dsk:1:on` / `dsk:1:off` | 다운스트림 키 1 ON AIR 켜기/끄기 (자막 등) |

> `macro`, `dsk` 큐는 PGM 카메라를 바꾸지 않습니다. 카메라 전환까지 하려면 매크로 안에 포함하거나 앞뒤에 cut 큐를 두세요.

---

## 3. 실제 ATEM 연결

### 3-1. 네트워크 구성

```
[ATEM 스위처] ──LAN── [스위치 허브] ──LAN── [CamCue 서버 PC]
                            └── Wi-Fi AP ── 카메라맨 폰들
```

1. **ATEM IP 확인**: PC 를 ATEM 에 USB 로 연결 → `ATEM Setup` 실행 → *Configure* 탭의 IP 주소 확인 (예: `192.168.10.240`). DHCP 대신 **고정 IP** 권장.
2. **서버 PC 를 같은 서브넷**에 고정 IP 로 설정 (예: `192.168.10.10 / 255.255.255.0`).
3. 연결 확인:
   ```bash
   ping 192.168.10.240
   ```
4. ATEM 통신은 **UDP 9910**. 서버 PC 방화벽에서 아웃바운드 UDP 가 막혀 있지 않아야 합니다.

### 3-2. 설정 및 실행

`.env`:
```ini
ATEM_HOST=192.168.10.240
# M/E 2 를 쓰는 모델이면
# ATEM_ME=2
```

```bash
npm start
```

- 디렉터 콘솔 상단 배지: `● ATEM 192.168.10.240  <모델명>` (초록 = 연결, 빨강 = 미연결)
- 상태 API: `curl http://localhost:38080/api/atem`
- **연결이 안 되거나 끊겨도 앱은 계속 동작**합니다. 큐 진행·CueScreen 은 정상, 탈리는 "엔진 추정" 으로 표시되며 라이브러리가 자동 재접속합니다. 재접속 시 현재 큐를 자동 재송출하지 않으니 필요하면 디렉터가 JUMP 로 다시 보내세요.
- ATEM Software Control / 하드웨어 패널과 **동시 사용 가능**. 패널에서 직접 전환해도 탈리는 실제 PGM 을 따라갑니다.

### 3-3. 카메라 번호 매핑

큐의 `camera`(1~8) = **ATEM 입력 번호**. 예) CAM 3 큐 → Input 3 으로 전환. 카메라를 ATEM 입력 1~8 에 순서대로 꽂아 두세요.

### 3-4. 장비 없이 리허설

```ini
ATEM_HOST=mock
```
가상 스위처가 PGM/PVW/DSK/매크로를 시뮬레이션합니다 (AUTO 1초). ATEM 을 아예 쓰지 않으려면 `ATEM_HOST=` (빈 값).

### 3-5. Stream Deck / Companion 연동 (선택)

Bitfocus Companion 의 *Generic HTTP* 액션으로 GO 버튼을 만들 수 있습니다.

```bash
curl -X POST http://192.168.10.10:38080/api/show/command \
  -H 'content-type: application/json' -H 'x-camcue-pin: 4821' -d '{"command":"GO"}'
# command: GO | BACK(+ silent) | HOLD | RESET | JUMP(+ actIndex, cueIndex, silent)
# 캠큐 PC 에서 실행하는 Companion 은 PIN 이 필요 없습니다
```

### 3-6. 이케가미 라우터 · GPI 연결 (0.0.3~)

상단 **[장비 연결]** (`/devices`) 화면에서 설정·시험합니다. 저장하면 프로그램을 다시 시작하지 않고 바로 다시 연결합니다.

| 방식 | 연결 | 하는 일 | 필요한 것 |
|---|---|---|---|
| **이케가미 라우터** (`SWITCHER=ikegami`) | USB-RS422 변환기 → 라우터 `422` 포트 (D-sub 9) | 큐 컷 = PGM 출력의 크로스포인트 전환 명령 전송 | 크로스포인트 명령 형식 (`IKEGAMI_TAKE`) |
| **GPI 탈리 입력** (`TALLY_SOURCE=gpi`) | 라우터 GPI OUT → 절연 입력 모듈(Modbus TCP) → LAN | 실제 송출 카메라를 읽어 CueScreen·디렉터 탈리에 표시, 큐와 다르면 경고 | Modbus TCP 입력 모듈 (ADAM-6050, ioLogik E1210 등) |
| **GPI 접점 컷** (`SWITCHER=gpi`) | 모듈 출력 → 라우터 GPI IN | 카메라별 출력에 펄스 → 장비 쪽에 지정한 동작 실행 | 라우터 GPI IN 동작 지정 |

- 이케가미 MUPS-FRM45 매뉴얼 기준 RS-422 통신 설정은 **38400bps · 8bit · 1stop · ODD** (기본값).
- 명령 바이트 형식은 매뉴얼에 없어 **템플릿**으로 넣습니다: `02 {OUT0} {IN0} {SUM}` 처럼 16진수 바이트 + 자리표시
  (`{IN}`/`{OUT}` 1부터 번호, `{IN0}`/`{OUT0}` 0부터, `{SUM}` 앞 바이트 합 하위 8비트, `{XOR}` 앞 바이트 XOR).
- 라우터에는 PVW·믹스가 없어 `auto` 큐도 컷으로 동작하고, `macro`·`dsk` 큐는 실행되지 않습니다(디렉터 로그에 기록).
- 장비 없이 시험: `IKEGAMI_PORT=mock` (보낸 바이트를 모니터에 기록), `GPI_HOST=mock` (화면에서 입력 채널을 눌러 켜고 끔).
- 장비 연결 화면의 **시험 컷** 버튼과 **RS-422 송수신 모니터**(임의 16진수 전송)로 실제 장비 반응을 확인할 수 있습니다.

---

## 4. 폰으로 CueScreen 접속

### 4-0. 안드로이드 앱 (권장, 0.0.4~)

1. 캠큐 PC 의 **홈** 화면 QR 을 폰 카메라로 찍어 앱을 내려받아 설치 (Releases 의 `CamCue-Android-v*.apk` 도 동일)
   - 처음 설치 시 "출처를 알 수 없는 앱" 허용 필요
2. 앱 실행 → 같은 Wi-Fi 의 캠큐 PC 를 자동으로 찾음 → **CAM 번호**를 누르면 CueScreen
3. 다음부터는 앱만 켜면 지난번 카메라로 바로 접속 (뒤로 가기 두 번 = 카메라 변경)

| 기능 | 설명 |
|---|---|
| 자동 검색 | UDP 브로드캐스트(38089) → 응답 없으면 같은 대역 HTTP 스캔 → IP 직접 입력 |
| 화면 유지 | 앱이 화면 꺼짐을 막음 (브라우저 HTTP 접속의 한계 해결) |
| 진동 | 내 차례 3초 전 2회 (기본). 화면 ⚙ 에서 끔 / 예고 + ON AIR 선택 |
| 화면 설정 ⚙ | 진동, 밝기(100~25%), ON AIR 깜빡임, 화면 방향 고정 — 폰마다 저장 |
| 뒤로 가기 | 두 번 눌러야 큐 화면이 닫힘 (생방송 중 실수 방지) |
| 재접속 | PC 재시작·IP 변경 시 자동으로 다시 찾음 |

아이폰은 앱 대신 브라우저로 접속하세요 (Safari 공유 → 홈 화면에 추가).

### 4-1. 접속

1. 폰을 **서버 PC 와 같은 Wi-Fi** 에 연결.
2. 서버 PC IP 확인 — 서버 시작 로그에 표시됩니다:
   ```
   CueScreen : http://192.168.10.10:38080/cam/1
   ```
   (Windows `ipconfig` / macOS `ipconfig getifaddr en0` 로도 확인. 홈 화면 하단에도 표시)
3. 폰 브라우저에서 `http://<서버IP>:38080/cam/<카메라번호>` 접속
   - 개발 모드(`npm run dev`)라면 포트 **5173**
4. **"화면을 탭해서 시작"** 터치 → 전체화면 + 화면 꺼짐 방지 활성화.
5. 카메라 마운트에는 **가로 모드** 권장. Safari/Chrome 메뉴의 "홈 화면에 추가" 로 앱처럼 사용 가능.

### 4-2. 화면 읽는 법

| 표시 | 의미 |
|---|---|
| 화면 테두리 **빨강** + `ON AIR` 깜빡임 | 지금 내 카메라가 송출 중 (탈리) |
| 테두리 **초록** + `PVW` | ATEM PVW 에 올라감 = 곧 내 차례 (ATEM 일 때만) |
| `수동 컷 — 큐와 별개로 송출 중` | 패널에서 손으로 컷해서 송출 중 (큐 진행과 무관) |
| `큐상 내 차례 · 송출 아님` | 큐로는 내 차례인데 실제로는 다른 카메라가 송출 중 |
| `탈리 추정` (주황 표시) | 스위처 연결이 끊겨 큐 진행 기준으로 보여 주는 중 — 카메라 위 탈리 램프 확인 |
| `연결 끊김 — 탈리 정보 없음` | 서버와 5초 이상 연락이 끊김. 자동 재접속 중 |
| `지금 내 샷` / `남은 시간` | ON AIR 중인 내 샷과 남은 시간 |
| `다음 내 샷` / `내 차례까지 0:12` | 정확한 카운트다운 (자동 전환만 남음) |
| `≈ 0:41` (수동 GO 포함) | 디렉터 GO 가 끼어 있어 최소 예상 시간 |
| `큐 3개 후` | 길이 미정 큐가 끼어 있어 시간 예측 불가 |
| 흰색 → 노랑 → 주황 카운트다운 | 10초 안으로 다가옴, 5초 전부터 흔들림 (**빨강은 ON AIR 전용**) |
| `GO 대기` | 예상 시간이 지났는데 아직 디렉터 GO 가 안 됨 |

### 4-3. 문제 해결

| 증상 | 조치 |
|---|---|
| 폰에서 접속 안 됨 | 같은 Wi-Fi 인지, 게스트 Wi-Fi(단말 간 격리) 아닌지 확인. 서버 PC 방화벽에서 TCP 38080 허용 (아래) |
| `● 재연결 중` | Wi-Fi 끊김. 자동 재접속되며 화면을 다시 켜면 즉시 재연결 |
| 화면이 꺼짐 | 아래 4-4 참고 |

Windows 방화벽 허용 (관리자 PowerShell):
```powershell
netsh advfirewall firewall add rule name="CamCue" dir=in action=allow protocol=TCP localport=38080
```

### 4-4. 화면 꺼짐 방지 (중요)

브라우저의 **Wake Lock API 는 HTTPS 에서만 동작**합니다. `http://192.168.x.x` 접속에서는 무음 비디오 재생 방식의 폴백을 쓰지만 기기에 따라 보장되지 않습니다. 확실히 하려면 다음 중 하나:

1. **가장 간단**: 폰 설정에서 자동 잠금 "안 함" (iOS: 설정 › 디스플레이 및 밝기 › 자동 잠금)
2. **HTTPS 로 서비스** ([mkcert](https://github.com/FiloSottile/mkcert) 사용):
   ```bash
   mkcert -install
   mkdir certs && mkcert -cert-file certs/cert.pem -key-file certs/key.pem 192.168.10.10 localhost
   ```
   `.env`:
   ```ini
   TLS_CERT=./certs/cert.pem
   TLS_KEY=./certs/key.pem
   ```
   `npm run build && npm start` → 폰에서 `https://192.168.10.10:38080/cam/1`.
   폰에 mkcert 루트 인증서(`mkcert -CAROOT` 폴더의 `rootCA.pem`)를 설치·신뢰해야 경고 없이 접속됩니다.

CueScreen 하단에 `화면 유지 ON` / `화면 유지 ON(호환)` / `화면 유지 불가` 로 상태가 표시됩니다.

---

## 5. 참고

### REST API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/services` | 행사 목록 |
| POST | `/api/services` | 새 행사 `{ title, date }` |
| GET / PUT / DELETE | `/api/services/:id` | 조회 / 전체 저장 / 삭제 |
| GET | `/api/services/:id/export` | JSON 내보내기 |
| POST | `/api/import` | JSON 가져오기 (새 행사 생성) |
| GET | `/api/show` | 라이브 상태 스냅샷 |
| POST | `/api/show/load` | 라이브 행사 교체 `{ serviceId }` |
| POST | `/api/show/command` | 진행 명령 |
| GET | `/api/atem` | ATEM 상태 |
| WS | `/ws` | 실시간 상태 (`src/shared/protocol.ts`) |

### JSON 형식

```json
{
  "format": "camcue/service@1",
  "service": {
    "title": "가을 정기 공연",
    "date": "2026-10-11",
    "acts": [
      {
        "title": "오프닝 공연",
        "mode": "SECTION",
        "bpm": 128,
        "beatsPerBar": 4,
        "cues": [
          { "camera": 5, "shotSize": "WS", "note": "객석 와이드", "section": "V1", "bars": 8, "atemAction": "auto" },
          { "camera": 3, "shotSize": "CU", "note": "메인 보컬", "section": "CH", "bars": 8, "atemAction": "cut" }
        ]
      }
    ]
  }
}
```

Cue 필드: `camera`(1~8), `shotSize`(LS/WS/FS/KS/MS/BS/CU/ECU/2S — WS = 와이드), `note`, `durationSec?`, `section?`, `bars?`, `tcInSec?`, `atemAction`

### 디렉터리 구조

```
src/shared/      도메인 타입, 큐 진행 엔진(순수 함수), 입력 검증, WS 프로토콜, 에디터 연산
src/server/      Fastify 앱, WebSocket 허브, ShowRuntime, Prisma 저장소, 타임코드 소스, ATEM 어댑터
web/src/         React 페이지 (Home / Director / Editor / CueScreen)
prisma/          스키마, 시드
tests/           Vitest
docs/            DECISIONS.md
```

### 한계 / 다음 단계
- 외부 타임코드(LTC/MTC) 수신기 미구현 — `TimecodeSource` 인터페이스 구현체만 추가하면 됨 (`src/server/timecode.ts`)
- 인증 없음 (행사장 내부 LAN 전제)
- 카메라 번호 ↔ ATEM 입력 매핑 테이블, 다중 M/E, 라이브 위치 영속화 미지원
