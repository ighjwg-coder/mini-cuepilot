// 서버 진입점
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { buildApp } from './app';
import { createAtemAdapter } from './atem';
import { prepareDataDir, type DataDirResult } from './bootstrap';
import { ServiceRepo } from './repo';
import { ShowRuntime } from './runtime';
import { sampleServiceInput } from './sampleService';
import { SimulatedTimecodeSource } from './timecode';
import { APP_VERSION } from '../shared/version';

// 설치판: 런처가 CUEPILOT_DATA_DIR 지정 → 설정·DB 를 사용자 데이터 폴더에 보관
// 개발/소스 실행: 현재 폴더의 .env + prisma/dev.db
let dataDir: DataDirResult | null = null;
if (process.env.CUEPILOT_DATA_DIR) {
  dataDir = prepareDataDir(process.env.CUEPILOT_DATA_DIR, fileURLToPath(new URL('../../', import.meta.url)));
} else {
  if (existsSync('.env')) process.loadEnvFile('.env');
  process.env.DATABASE_URL ??= 'file:./dev.db';
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const webDir = fileURLToPath(new URL('../../dist/web', import.meta.url));

const prisma = new PrismaClient();
const repo = new ServiceRepo(prisma);
const atem = createAtemAdapter(process.env.ATEM_HOST);
const runtime = new ShowRuntime({ atem, timecode: new SimulatedTimecodeSource() });

// 설치 후 첫 실행: 샘플 예배를 넣어 바로 둘러볼 수 있게 함
if (dataDir?.freshDb) await repo.create(sampleServiceInput);

runtime.load(await repo.latest());
runtime.start();

const https =
  process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
    : undefined;
// 설치판은 콘솔 창이 요청 로그로 넘치지 않도록 경고 이상만 출력
const app = await buildApp({ repo, runtime, webDir, logger: dataDir ? { level: 'warn' } : true, https });
try {
  await app.listen({ port, host });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`\n  [오류] 포트 ${port} 를 이미 사용 중입니다. Mini CuePilot 이 이미 실행 중이거나 다른 프로그램이 사용 중입니다.`);
    console.error(`  이미 실행 중이라면 브라우저에서 http://localhost:${port} 를 여세요.\n`);
    if (process.env.CUEPILOT_OPEN_BROWSER === '1') openBrowser(`http://localhost:${port}`);
    process.exit(1);
  }
  throw err;
}

// ATEM 연결은 백그라운드에서. 실패해도 앱은 계속 동작하고 상태만 표시한다.
atem.connect().catch((err) => app.log.warn({ err }, 'ATEM 연결 실패 — ATEM 없이 계속 진행합니다'));

const lanUrls = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `${https ? 'https' : 'http'}://${i!.address}:${port}`);
const webPort = existsSync(webDir) ? port : 5173;
console.log(`
  Mini CuePilot v${APP_VERSION} 서버 실행 중 (API :${port})
  ATEM      : ${atem.status().mode}${atem.status().host ? ` (${atem.status().host})` : ''}
  웹 UI     : ${https ? 'https' : 'http'}://localhost:${webPort}${existsSync(webDir) ? '' : '  (개발 모드: Vite)'}
  CueScreen : ${lanUrls.map((u) => `${u.replace(`:${port}`, `:${webPort}`)}/cam/1`).join('  ') || '(LAN IP 없음)'}${
    dataDir ? `\n  설정 파일 : ${dataDir.configPath}\n  데이터    : ${dataDir.dbPath}` : ''
  }

  이 창을 닫으면 서버가 종료됩니다.
`);

if (process.env.CUEPILOT_OPEN_BROWSER === '1') openBrowser(`${https ? 'https' : 'http'}://localhost:${port}`);

/** 기본 브라우저로 열기 (설치판 런처용) */
function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['explorer.exe', [url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } catch {
    // 브라우저를 못 열어도 서버는 계속
  }
}

const shutdown = async () => {
  runtime.stop();
  await atem.disconnect().catch(() => {});
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
