// 서버 진입점
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { buildApp } from './app';
import { createAtemAdapter } from './atem';
import { ServiceRepo } from './repo';
import { ShowRuntime } from './runtime';
import { SimulatedTimecodeSource } from './timecode';

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.DATABASE_URL ??= 'file:./dev.db';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const webDir = fileURLToPath(new URL('../../dist/web', import.meta.url));

const prisma = new PrismaClient();
const repo = new ServiceRepo(prisma);
const atem = createAtemAdapter(process.env.ATEM_HOST);
const runtime = new ShowRuntime({ atem, timecode: new SimulatedTimecodeSource() });

runtime.load(await repo.latest());
runtime.start();

const https =
  process.env.TLS_CERT && process.env.TLS_KEY
    ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
    : undefined;
const app = await buildApp({ repo, runtime, webDir, logger: true, https });
await app.listen({ port, host });

// ATEM 연결은 백그라운드에서. 실패해도 앱은 계속 동작하고 상태만 표시한다.
atem.connect().catch((err) => app.log.warn({ err }, 'ATEM 연결 실패 — ATEM 없이 계속 진행합니다'));

const lanUrls = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `${https ? 'https' : 'http'}://${i!.address}:${port}`);
const webPort = existsSync(webDir) ? port : 5173;
console.log(`
  Mini CuePilot 서버 실행 중 (API :${port})
  ATEM      : ${atem.status().mode}${atem.status().host ? ` (${atem.status().host})` : ''}
  웹 UI     : ${https ? 'https' : 'http'}://localhost:${webPort}${existsSync(webDir) ? '' : '  (개발 모드: Vite)'}
  CueScreen : ${lanUrls.map((u) => `${u.replace(`:${port}`, `:${webPort}`)}/cam/1`).join('  ') || '(LAN IP 없음)'}
`);

const shutdown = async () => {
  runtime.stop();
  await atem.disconnect().catch(() => {});
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
