// 설치판(Windows 패키지) 실행 준비.
// 런처가 CAMCUE_DATA_DIR 를 지정하면 설정·DB 를 그 폴더(기본 %LOCALAPPDATA%\CamCue)에 둔다.
// 앱 폴더(Program Files)는 쓰기 불가일 수 있고, 업데이트/재설치해도 큐시트가 유지되어야 하기 때문.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_PORT } from './listen';

export const CONFIG_FILE = 'config.env';
export const DB_FILE = 'camcue.db';
export const TEMPLATE_DB = 'template.db';

/** v0.0.1 (Mini CuePilot 시절) 데이터 위치 — 같은 상위 폴더의 MiniCuePilot\cuepilot.db */
export const LEGACY_DIR_NAME = 'MiniCuePilot';
export const LEGACY_DB_FILE = 'cuepilot.db';

export const DEFAULT_CONFIG = `# CamCue(캠큐) 설정 — 수정 후 프로그램을 다시 시작하세요.

# 서버 포트 (폰 접속 주소의 :38080 부분)
# 이 포트를 쓸 수 없으면 자동으로 다른 포트를 골라 여기에 저장합니다.
PORT=38080

# ATEM 스위처
#   mock            : 가상 스위처 (장비 없이 연습)
#   (비움)          : ATEM 제어 안 함
#   192.168.10.240  : 실제 ATEM IP (ATEM Setup 에서 확인)
ATEM_HOST=mock

# 제어할 M/E 버스 번호 (대부분 1)
# ATEM_ME=1

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

/** 설정 파일의 PORT 값을 바꿔 저장 (포트 자동 변경 시 다음 실행부터 같은 주소 유지) */
export function saveConfigPort(configPath: string, port: number): void {
  const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : DEFAULT_CONFIG;
  const next = /^PORT=.*$/m.test(text) ? text.replace(/^PORT=.*$/m, `PORT=${port}`) : `PORT=${port}\n${text}`;
  writeFileSync(configPath, next, 'utf8');
}
