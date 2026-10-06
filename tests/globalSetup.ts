// 테스트용 SQLite 템플릿 DB 생성 (스키마만). 각 테스트 파일은 이 파일을 복사해 독립 DB 로 사용한다.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const TEMPLATE_DIR = resolve('node_modules/.cache/mini-cuepilot-test');

export default function setup() {
  rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  mkdirSync(TEMPLATE_DIR, { recursive: true });
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: `file:${resolve(TEMPLATE_DIR, 'template.db')}` },
    stdio: 'pipe',
  });
}
