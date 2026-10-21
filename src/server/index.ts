// 서버 진입점
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { APP_NAME, APP_VERSION } from '../shared/version';
import { buildApp } from './app';
import { prepareDataDir, saveConfigPort, type DataDirResult } from './bootstrap';
import { DeviceManager } from './devices/manager';
import { DISCOVERY_PORT, discoveryInfo, startDiscoveryResponder, type DiscoveryResponder } from './discovery';
import { DEFAULT_PORT, isCamCueRunning, listenWithFallback } from './listen';
import { ServiceRepo } from './repo';
import { ShowRuntime } from './runtime';
import { sampleServiceInput } from './sampleService';
import { SimulatedTimecodeSource } from './timecode';

// 설치판: 런처가 CAMCUE_DATA_DIR 지정 → 설정·DB 를 사용자 데이터 폴더에 보관
// 개발/소스 실행: 현재 폴더의 .env + prisma/dev.db
let dataDir: DataDirResult | null = null;
if (process.env.CAMCUE_DATA_DIR) {
  dataDir = prepareDataDir(process.env.CAMCUE_DATA_DIR, fileURLToPath(new URL('../../', import.meta.url)));
} else {
  if (existsSync('.env')) process.loadEnvFile('.env');
  process.env.DATABASE_URL ??= 'file:./dev.db';
}

const preferredPort = Number(process.env.PORT) || DEFAULT_PORT;
const host = process.env.HOST ?? '0.0.0.0';
const openOnStart = process.env.CAMCUE_OPEN_BROWSER === '1';
const webDir = fileURLToPath(new URL('../../dist/web', import.meta.url));
// 안드로이드 앱 설치 파일 (배포판에 동봉) — 폰에서 http://PC:포트/app 으로 내려받음
const apkPath = fileURLToPath(new URL('../../camcue.apk', import.meta.url));

const prisma = new PrismaClient();
const repo = new ServiceRepo(prisma);
const SWITCHER_LABEL: Record<string, string> = {
  disabled: '사용 안 함',
  mock: '가상 ATEM (mock)',
  real: 'ATEM',
  ikegami: '이케가미 라우터 (RS-422)',
  gpi: 'GPI 접점 컷',
};

// 스위처(ATEM / 이케가미 라우터 / GPI) + GPI 탈리 입력. 장비 연결 화면에서 바꾸면 이 파일에 저장된다
const devices = new DeviceManager({
  configPath: dataDir?.configPath ?? resolve('.env'),
  log: (msg, err) => console.warn(`  [장비] ${msg}: ${(err as Error)?.message ?? err ?? ''}`),
});
const atem = devices.switcher;
const runtime = new ShowRuntime({ atem, timecode: new SimulatedTimecodeSource(), tallyInput: devices.tallyInput });

// 설치 후 첫 실행: 샘플 행사를 넣어 바로 둘러볼 수 있게 함
if (dataDir?.freshDb) await repo.create(sampleServiceInput);

runtime.load(await repo.latest());
runtime.start();

const https =
  process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
    : undefined;
const proto = https ? 'https' : 'http';
// 설치판은 콘솔 창이 요청 로그로 넘치지 않도록 경고 이상만 출력
const app = await buildApp({ repo, runtime, devices, webDir, apkPath, logger: dataDir ? { level: 'warn' } : true, https });

// 포트: 지정 포트 → 막혀 있으면(Windows 예약 포트 EACCES / 사용 중 EADDRINUSE) 다른 5자리 포트로 자동 변경
let port: number;
try {
  const result = await listenWithFallback(
    async (p) => {
      await app.listen({ port: p, host });
      return (app.server.address() as AddressInfo).port;
    },
    preferredPort,
    {
      // 원래 포트에 이미 CamCue 가 떠 있으면 새로 띄우지 않고 그 화면을 연다
      shouldStop: async ({ port: p, code }) => p === preferredPort && code === 'EADDRINUSE' && (await isCamCueRunning(p)),
    },
  );
  port = result.port;
  if (result.failed.length > 0) {
    console.warn(
      `\n  [알림] 포트 ${result.failed.map((f) => `${f.port}(${f.code === 'EACCES' ? 'Windows 가 막음' : '다른 프로그램 사용 중'})`).join(', ')} 을(를) 쓸 수 없어 ${port} 번으로 실행합니다.`,
    );
    if (dataDir) {
      saveConfigPort(dataDir.configPath, port);
      console.warn(`  다음 실행부터도 ${port} 번을 쓰도록 설정 파일에 저장했습니다.`);
    }
  }
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.log(`\n  ${APP_NAME} 이(가) 이미 실행 중입니다 → ${proto}://localhost:${preferredPort}\n`);
    if (openOnStart) openBrowser(`${proto}://localhost:${preferredPort}`);
    await prisma.$disconnect();
    process.exit(0);
  }
  throw err;
}

// 폰 앱 자동 검색 응답 (UDP). 실패해도 앱은 HTTP 스캔·IP 직접 입력으로 접속 가능
let discovery: DiscoveryResponder | null = null;
try {
  discovery = await startDiscoveryResponder(() => discoveryInfo(port, proto));
} catch (err) {
  console.warn(`  [알림] 폰 앱 자동 검색(UDP ${DISCOVERY_PORT})을 시작하지 못했습니다: ${(err as Error).message}`);
}

// 장비 연결은 백그라운드에서. 실패해도 앱은 계속 동작하고 상태만 표시한다.
await devices.start();
const sw = atem.status();

const lanUrls = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `${proto}://${i!.address}:${port}`);
const devMode = !existsSync(webDir);
const webUrl = devMode ? 'http://localhost:5173' : `${proto}://localhost:${port}`;
const camUrls = devMode ? lanUrls.map((u) => u.replace(`:${port}`, ':5173')) : lanUrls;
console.log(`
  ==========================================================
   ${APP_NAME} v${APP_VERSION} 실행 중
  ==========================================================
   이 PC 에서 열기 : ${webUrl}${devMode ? '  (개발 모드: Vite)' : ''}
   카메라맨 폰     : ${camUrls.map((u) => `${u}/cam/1`).join('   ') || '(네트워크 연결 없음)'}
                     (/cam/1 ~ /cam/8 — 같은 Wi-Fi 에서 접속)
   스위처          : ${SWITCHER_LABEL[sw.mode]}${sw.host && sw.mode !== 'mock' ? ` (${sw.host})` : ''}${
     devices.config.tally.source === 'gpi' ? '\n   탈리 입력       : GPI 모듈 (' + (devices.config.gpi.kind === 'none' ? '미설정' : devices.config.gpi.host) + ')' : ''
   }
   장비 연결 설정  : ${webUrl}/devices
   폰 앱 자동 검색 : ${discovery ? `켜짐 (UDP ${discovery.port})` : '꺼짐 — 앱에서 IP 직접 입력'}${existsSync(apkPath) ? `\n   폰 앱 설치      : ${lanUrls[0] ?? webUrl}/app` : ''}${
     dataDir
       ? `\n   설정 파일       : ${dataDir.configPath}\n   데이터          : ${dataDir.dbPath}${
           dataDir.migratedFrom ? `\n   (이전 버전 데이터를 가져왔습니다: ${dataDir.migratedFrom})` : ''
         }`
       : ''
   }
  ----------------------------------------------------------
   브라우저가 자동으로 열리지 않으면 위 주소를 직접 여세요.
   이 창을 닫으면 프로그램이 종료됩니다.
  ==========================================================
`);

if (openOnStart) openBrowser(webUrl);

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
  await devices.stop().catch(() => {});
  await discovery?.close().catch(() => {});
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
