import { randomUUID } from 'node:crypto';
import { copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { TEMPLATE_DIR } from '../globalSetup';

/** 템플릿 DB 를 복사한 독립 SQLite DB 의 PrismaClient */
export function createTestDb() {
  const file = resolve(TEMPLATE_DIR, `${randomUUID()}.db`);
  copyFileSync(resolve(TEMPLATE_DIR, 'template.db'), file);
  const prisma = new PrismaClient({ datasourceUrl: `file:${file.replace(/\\/g, '/')}` });
  return {
    prisma,
    async cleanup() {
      await prisma.$disconnect();
      rmSync(file, { force: true });
    },
  };
}
