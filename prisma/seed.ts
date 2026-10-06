// 샘플 예배 시드. 같은 제목의 예배가 있으면 건너뛴다 (--force 시 재생성)
import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { ServiceRepo } from '../src/server/repo';
import { SAMPLE_SERVICE_TITLE, sampleServiceInput } from '../src/server/sampleService';

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.DATABASE_URL ??= 'file:./dev.db';

const prisma = new PrismaClient();
const repo = new ServiceRepo(prisma);
const force = process.argv.includes('--force');

const existing = await prisma.service.findMany({ where: { title: SAMPLE_SERVICE_TITLE }, select: { id: true } });
if (existing.length && !force) {
  console.log(`[seed] "${SAMPLE_SERVICE_TITLE}" 이미 존재 — 건너뜀 (재생성: npm run db:seed -- --force)`);
} else {
  for (const { id } of existing) await repo.remove(id);
  const s = await repo.create(sampleServiceInput);
  const cues = s.acts.reduce((n, a) => n + a.cues.length, 0);
  console.log(`[seed] "${s.title}" 생성: Act ${s.acts.length}개, Cue ${cues}개 (id=${s.id})`);
}
await prisma.$disconnect();
