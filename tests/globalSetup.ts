// 테스트용 SQLite 템플릿 DB 생성 (스키마만). 각 테스트 파일은 이 파일을 복사해 독립 DB 로 사용한다.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const TEMPLATE_DIR = resolve('node_modules/.cache/mini-cuepilot-test');

export default function setup() {
  rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  mkdirSync(TEMPLATE_DIR, { recursive: true });
  // npx 는 Windows 에서 .cmd 라 셸 없이 실행 불가 → prisma CLI 를 현재 node 로 직접 실행 (OS 무관)
  execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: `file:${resolve(TEMPLATE_DIR, 'template.db').replace(/\\/g, '/')}` },
    stdio: 'pipe',
  });
}
