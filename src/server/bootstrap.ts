// 설치판(Windows 패키지) 실행 준비.
// 런처가 CUEPILOT_DATA_DIR 를 지정하면 설정·DB 를 그 폴더(기본 %LOCALAPPDATA%\MiniCuePilot)에 둔다.
// 앱 폴더(Program Files)는 쓰기 불가일 수 있고, 업데이트/재설치해도 큐시트가 유지되어야 하기 때문.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILE = 'config.env';
export const DB_FILE = 'cuepilot.db';
export const TEMPLATE_DB = 'template.db';

export const DEFAULT_CONFIG = `# Mini CuePilot 설정 — 수정 후 프로그램을 다시 시작하세요.

# 서버 포트 (폰 접속 주소의 :3000 부분)
PORT=3000

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
}

/**
 * 데이터 폴더 준비: 설정 파일 생성/로드, DB 가 없으면 템플릿 DB(스키마만 있는 빈 SQLite) 복사.
 * DATABASE_URL 을 데이터 폴더의 DB 로 지정한다.
 */
export function prepareDataDir(dataDir: string, appDir: string): DataDirResult {
  mkdirSync(dataDir, { recursive: true });

  const configPath = join(dataDir, CONFIG_FILE);
  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG, 'utf8');
  // 이미 설정된 환경변수가 우선 (loadEnvFile 은 기존 값을 덮어쓰지 않음)
  process.loadEnvFile(configPath);

  const dbPath = join(dataDir, DB_FILE);
  const freshDb = !existsSync(dbPath);
  if (freshDb) copyFileSync(join(appDir, TEMPLATE_DB), dbPath);

  // Prisma(SQLite)는 Windows 경로도 슬래시 표기를 권장
  process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, '/')}`;
  return { configPath, dbPath, freshDb };
}
