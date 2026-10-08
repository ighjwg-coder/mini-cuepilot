// 배포 패키지 조립: release/MiniCuePilot/
//   MiniCuePilot.cmd        ← 더블클릭 실행 (Windows)
//   node/node.exe           ← Node.js 런타임 (PC에 Node 설치 불필요)
//   app/dist/server/        ← 서버 번들 (esbuild)
//   app/dist/web/           ← 웹 UI (vite build)
//   app/node_modules/       ← 런타임 의존성만 (+ 현재 OS 용 Prisma 엔진)
//   app/template.db         ← 스키마만 있는 빈 SQLite (첫 실행 시 데이터 폴더로 복사)
//
// 실행하는 OS 용으로 만들어진다. Windows 배포본은 GitHub Actions(windows-latest)에서 생성.
// 사용: node scripts/package.mjs   (버전은 package.json 의 version 을 그대로 사용)
import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const isWin = process.platform === 'win32';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const out = resolve('release', 'MiniCuePilot');
const app = join(out, 'app');

const run = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};
/** 메모장/cmd 호환: CRLF */
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

console.log(`[package] Mini CuePilot v${version} (${process.platform}-${process.arch})`);
rmSync(out, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

// 1) 웹 빌드
run('npx vite build');
cpSync('dist/web', join(app, 'dist', 'web'), { recursive: true });

// 2) 서버 번들 (자체 소스만 묶고 npm 패키지는 node_modules 에서 로드)
await build({
  entryPoints: ['src/server/index.ts'],
  outfile: join(app, 'dist', 'server', 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'info',
});

// 3) 런타임 의존성만 설치 (package-lock 그대로 → 재현 가능한 설치)
const appPkg = { ...pkg };
delete appPkg.scripts;
delete appPkg.prisma;
writeFileSync(join(app, 'package.json'), JSON.stringify(appPkg, null, 2));
copyFileSync('package-lock.json', join(app, 'package-lock.json'));
// @prisma/client 의 선택적 peer(prisma CLI, typescript — lock 에 devOptional)는 런타임에 불필요
// → --omit=optional 로 함께 제외 (런타임 의존성 중 optional 전용 패키지는 없음)
run('npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund', { cwd: app });

// 4) Prisma 클라이언트 + 현재 OS 용 쿼리 엔진 (postinstall 생성물)
if (!existsSync('node_modules/.prisma/client')) run('npx prisma generate');
cpSync('node_modules/.prisma', join(app, 'node_modules', '.prisma'), { recursive: true });

// 4-1) 용량 정리: Prisma 런타임에 포함된 다른 DB(Postgres/MySQL 등)용 WASM 엔진과 소스맵 제거.
//      생성된 클라이언트는 runtime/library.js + 네이티브 쿼리 엔진만 사용 (패키지 스모크 테스트로 검증)
const prismaRuntime = join(app, 'node_modules', '@prisma', 'client', 'runtime');
let removed = 0;
for (const f of readdirSync(prismaRuntime)) {
  if (/^query_(engine|compiler)_bg\./.test(f) || f.endsWith('.map')) {
    removed += statSync(join(prismaRuntime, f)).size;
    rmSync(join(prismaRuntime, f));
  }
}
console.log(`[package] Prisma 미사용 엔진/소스맵 정리: ${(removed / 1048576).toFixed(1)} MB`);

// 5) 빈 템플릿 DB (스키마만)
const templateDb = join(app, 'template.db');
run('npx prisma db push --skip-generate', {
  env: { ...process.env, DATABASE_URL: `file:${templateDb.replace(/\\/g, '/')}` },
});
rmSync(`${templateDb}-journal`, { force: true });

// 6) Node 런타임 동봉
mkdirSync(join(out, 'node'), { recursive: true });
copyFileSync(process.execPath, join(out, 'node', isWin ? 'node.exe' : 'node'));

// 7) 실행기 + 안내문
copyFileSync('installer/icon.ico', join(out, 'icon.ico'));
writeFileSync(
  join(out, 'MiniCuePilot.cmd'),
  crlf(`@echo off
rem Mini CuePilot launcher
chcp 65001 >nul
title Mini CuePilot v${version}
cd /d "%~dp0"
set "CUEPILOT_DATA_DIR=%LOCALAPPDATA%\\MiniCuePilot"
set "CUEPILOT_OPEN_BROWSER=1"
"%~dp0node\\node.exe" "%~dp0app\\dist\\server\\index.mjs"
if errorlevel 1 pause
`),
);
if (!isWin) {
  const sh = join(out, 'start.sh');
  writeFileSync(
    sh,
    `#!/bin/sh
cd "$(dirname "$0")"
export CUEPILOT_DATA_DIR="\${CUEPILOT_DATA_DIR:-\${XDG_DATA_HOME:-$HOME/.local/share}/MiniCuePilot}"
export CUEPILOT_OPEN_BROWSER="\${CUEPILOT_OPEN_BROWSER:-1}"
exec ./node/node app/dist/server/index.mjs
`,
  );
  chmodSync(sh, 0o755);
}
// 메모장에서 한글이 깨지지 않도록 UTF-8 BOM
writeFileSync(join(out, '사용법.txt'), '﻿' + crlf(readFileSync('installer/README-WINDOWS.txt', 'utf8').replaceAll('{{VERSION}}', version)));

console.log(`\n[package] 완료 → ${out}`);
