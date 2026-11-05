// 설치판(Windows 패키지) 실행 준비.
// 런처가 CAMCUE_DATA_DIR 를 지정하면 설정·DB 를 그 폴더(기본 %LOCALAPPDATA%\CamCue)에 둔다.
// 앱 폴더(Program Files)는 쓰기 불가일 수 있고, 업데이트/재설치해도 큐시트가 유지되어야 하기 때문.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_PORT } from './listen';

export const CONFIG_FILE = 'config.env';
export const DB_FILE = 'camcue.db';
export const TEMPLATE_DB = 'template.db';

/** v0.0.1 (Mini CuePilot 시절) 데이터 위치 — 같은 상위 폴더의 MiniCuePilot\cuepilot.db */
export const LEGACY_DIR_NAME = 'MiniCuePilot';
export const LEGACY_DB_FILE = 'cuepilot.db';

export const DEFAULT_CONFIG = `# CamCue(캠큐) 설정
# 장비 관련 값은 프로그램의 [장비 연결] 화면에서 바꾸는 것을 권장합니다 (저장 즉시 적용).
# 이 파일을 직접 고친 경우에는 프로그램을 다시 시작하세요.

# 서버 포트 (폰 접속 주소의 :38080 부분)
# 이 포트를 쓸 수 없으면 자동으로 다른 포트를 골라 여기에 저장합니다.
PORT=38080

# 스위처 종류
#   atem    : Blackmagic ATEM (아래 ATEM_HOST)
#   vmix    : vMix (VMIX_*)
#   obs     : OBS Studio (OBS_*)
#   ikegami : 이케가미 라우터 RS-422 (IKEGAMI_*)
#   gpi     : GPI 모듈 접점 출력으로 컷 (GPI_*)
#   none    : 스위처 제어 안 함 (큐 진행만, TALLY_SOURCE=gpi 면 GPI 실제 탈리만 표시)
SWITCHER=atem

# ATEM 스위처
#   mock            : 가상 스위처 (장비 없이 연습)
#   (비움)          : ATEM 제어 안 함
#   192.168.10.240  : 실제 ATEM IP (ATEM Setup 에서 확인)
ATEM_HOST=mock

# 제어할 M/E 버스 번호 (대부분 1)
# ATEM_ME=1

# 1 = ATEM 에 컷을 보내지 않고 탈리만 읽기 (단순 탈리 — 컷은 운영자가 직접)
# ATEM_TALLY_ONLY=0

# vMix (TCP API, 기본 포트 8099). 같은 PC 면 127.0.0.1, mock = 가상 스위처
# VMIX_HOST=127.0.0.1
# CAM1, CAM2 … 순서대로 vMix 입력 번호 (0 = 없음)
# VMIX_CAM_INPUTS=1,2,3,4,5,6,7,8
# VMIX_TALLY_ONLY=0

# OBS Studio (obs-websocket v5, OBS 28 이상 · 기본 포트 4455). 도구 → WebSocket 서버 설정에서 켜기
# OBS_HOST=127.0.0.1
# OBS_PASSWORD=
# CAM1, CAM2 … 순서대로 OBS 장면 이름 (쉼표 구분)
# OBS_CAM_SCENES=CAM 1,CAM 2,CAM 3,CAM 4,CAM 5,CAM 6,CAM 7,CAM 8
# OBS_TALLY_ONLY=0

# 이케가미 라우터 (RS-422, USB-RS422 변환기)
# IKEGAMI_PORT=COM3
# IKEGAMI_BAUD=38400
# IKEGAMI_PARITY=odd
# IKEGAMI_PGM_OUT=1
# IKEGAMI_CAM_INPUTS=1,2,3,4,5,6,7,8
# IKEGAMI_TAKE=

# 탈리 기준: switcher (스위처 보고값) / gpi (GPI 모듈로 실제 탈리 신호를 읽음)
# TALLY_SOURCE=switcher

# GPI 입력/출력 모듈 (Modbus TCP — ADAM-6050, ioLogik E1210 등). mock = 가상 모듈
# GPI_HOST=192.168.0.50
# GPI_TALLY_INPUTS=1,2,3,4,5,6,7,8
# GPI_TALLY_INVERT=0

# 다른 기기(노트북·태블릿)에서 GO·편집·장비 설정을 하려면 PIN 을 정하세요.
# 비워 두면 제어는 이 PC 에서만 됩니다. 카메라맨 폰 화면(/cam/N)은 PIN 없이 열립니다.
# CAMCUE_PIN=

# GO·BACK 연타 방지 시간(ms). 0 = 끔
# CAMCUE_GO_LOCK_MS=500

# (선택) HTTPS 인증서 — 폰 화면 꺼짐 방지(Wake Lock) 보장용
# TLS_CERT=C:\\cert\\cert.pem
# TLS_KEY=C:\\cert\\key.pem
`;

export interface DataDirResult {
  configPath: string;
  dbPath: string;
  /** 이번 실행에서 DB 를 새로 만들었는가 (샘플 시드 여부 판단) */
  freshDb: boolean;
  /** 이전 이름(MiniCuePilot) 폴더에서 데이터를 가져왔는가 */
  migratedFrom: string | null;
}

/**
 * 데이터 폴더 준비
 *  1) 새 폴더에 DB 가 없고 예전 폴더(MiniCuePilot)에 있으면 설정·DB 를 복사해 옴 (예전 폴더는 그대로 둠)
 *  2) 설정 파일이 없으면 기본값 생성 후 로드
 *  3) DB 가 없으면 템플릿 DB(스키마만 있는 빈 SQLite) 복사
 *  4) DATABASE_URL 을 데이터 폴더의 DB 로 지정
 */
export function prepareDataDir(dataDir: string, appDir: string): DataDirResult {
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, CONFIG_FILE);
  const dbPath = join(dataDir, DB_FILE);

  let migratedFrom: string | null = null;
  const legacyDir = join(dirname(dataDir), LEGACY_DIR_NAME);
  const legacyDb = join(legacyDir, LEGACY_DB_FILE);
  if (!existsSync(dbPath) && existsSync(legacyDb)) {
    copyFileSync(legacyDb, dbPath);
    const legacyConfig = join(legacyDir, CONFIG_FILE);
    if (!existsSync(configPath) && existsSync(legacyConfig)) {
      copyFileSync(legacyConfig, configPath);
      // v0.0.1 기본값 3000 은 Windows 예약 포트와 자주 겹쳐 새 기본값으로 교체 (직접 바꾼 값은 유지)
      if (/^PORT=3000\s*$/m.test(readFileSync(configPath, 'utf8'))) saveConfigPort(configPath, DEFAULT_PORT);
    }
    migratedFrom = legacyDir;
  }

  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG, 'utf8');
  // 이미 설정된 환경변수가 우선 (loadEnvFile 은 기존 값을 덮어쓰지 않음)
  process.loadEnvFile(configPath);

  const freshDb = !existsSync(dbPath);
  if (freshDb) copyFileSync(join(appDir, TEMPLATE_DB), dbPath);

  // Prisma(SQLite)는 Windows 경로도 슬래시 표기를 권장
  process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, '/')}`;
  return { configPath, dbPath, freshDb, migratedFrom };
}

/** 자동 백업 보관 개수 */
export const BACKUP_KEEP = 14;

/**
 * DB 자동 백업: 서버 시작 시(DB 를 열기 전) backup\camcue-YYYY-MM-DD_HHMM.db 로 복사, 최근 keep 개만 보관.
 * 복원: 캠큐를 끄고 원하는 백업 파일을 camcue.db 로 바꿔 넣으면 된다.
 * 반환: 만든 백업 경로 (DB 가 없으면 null)
 */
export function backupDb(dbPath: string, backupDir: string, keep = BACKUP_KEEP, now = new Date()): string | null {
  if (!existsSync(dbPath)) return null;
  mkdirSync(backupDir, { recursive: true });
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
  const target = join(backupDir, `camcue-${stamp}.db`);
  copyFileSync(dbPath, target);
  const old = readdirSync(backupDir)
    .filter((n) => /^camcue-\d{4}-\d{2}-\d{2}_\d{4}\.db$/.test(n))
    .sort()
    .reverse()
    .slice(keep);
  for (const n of old) rmSync(join(backupDir, n), { force: true });
  return target;
}

/** 설정 파일의 PORT 값을 바꿔 저장 (포트 자동 변경 시 다음 실행부터 같은 주소 유지) */
export function saveConfigPort(configPath: string, port: number): void {
  const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : DEFAULT_CONFIG;
  const next = /^PORT=.*$/m.test(text) ? text.replace(/^PORT=.*$/m, `PORT=${port}`) : `PORT=${port}\n${text}`;
  writeFileSync(configPath, next, 'utf8');
}
