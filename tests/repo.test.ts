import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseImport, serviceInputSchema, toExportFile } from '../src/shared/schema';
import { ConflictError, ServiceRepo } from '../src/server/repo';
import { sampleServiceInput } from '../src/server/sampleService';
import { createTestDb } from './helpers/db';

const db = createTestDb();
const repo = new ServiceRepo(db.prisma);
afterAll(() => db.cleanup());

describe('ServiceRepo', () => {
  let id: string;

  beforeAll(async () => {
    id = (await repo.create(sampleServiceInput)).id;
  });

  it('샘플 예배 생성 및 순서 보존 조회', async () => {
    const s = (await repo.get(id))!;
    expect(s.acts.map((a) => a.title)).toEqual(sampleServiceInput.acts.map((a) => a.title));
    expect(s.acts[0].cues.map((c) => c.note)).toEqual(sampleServiceInput.acts[0].cues.map((c) => c.note));
    expect(s.acts[0]).toMatchObject({ mode: 'SECTION', bpm: 128, beatsPerBar: 4 });
  });

  it('목록 요약', async () => {
    const list = await repo.list();
    const item = list.find((x) => x.id === id)!;
    expect(item.actCount).toBe(5);
    expect(item.cueCount).toBe(sampleServiceInput.acts.reduce((n, a) => n + a.cues.length, 0));
  });

  it('저장: id 보존 + 순서 변경 + 추가 + 삭제 + Act 간 이동', async () => {
    const s = (await repo.get(id))!;
    const [a0, a1, ...rest] = s.acts;
    const moved = a0.cues[0];
    const input = serviceInputSchema.parse({
      ...s,
      title: '수정된 예배',
      acts: [
        { ...a1, cues: [...a1.cues].reverse() },
        { ...a0, cues: [...a0.cues.slice(1, 3), { camera: 7, shotSize: 'ECU', note: '새 큐' }] },
        { ...rest[0], cues: [...rest[0].cues, moved] },
      ],
    });
    const saved = (await repo.save(id, input))!;
    expect(saved.title).toBe('수정된 예배');
    expect(saved.acts.map((a) => a.id)).toEqual([a1.id, a0.id, rest[0].id]);
    expect(saved.acts[0].cues.map((c) => c.id)).toEqual([...a1.cues].reverse().map((c) => c.id));
    expect(saved.acts[1].cues).toHaveLength(3);
    expect(saved.acts[1].cues[2]).toMatchObject({ camera: 7, shotSize: 'ECU', atemAction: 'cut' });
    expect(saved.acts[2].cues.at(-1)!.id).toBe(moved.id);
    expect(await db.prisma.act.count({ where: { serviceId: id } })).toBe(3);
  });

  it('다른 예배의 id 로 저장하면 ConflictError', async () => {
    const other = await repo.create({ title: '다른 예배', date: null, acts: [{ title: 'x', mode: 'MANUAL', bpm: null, beatsPerBar: 4, cues: [] }] });
    const s = (await repo.get(id))!;
    const input = serviceInputSchema.parse({ ...s, acts: [{ ...s.acts[0], id: other.acts[0].id }] });
    await expect(repo.save(id, input)).rejects.toBeInstanceOf(ConflictError);
  });

  it('없는 예배 저장/삭제', async () => {
    expect(await repo.save('nope', serviceInputSchema.parse({ title: 'x' }))).toBeNull();
    expect(await repo.remove('nope')).toBe(false);
  });

  it('JSON 내보내기 → 가져오기 왕복 (id 재발급, 내용 동일)', async () => {
    const original = (await repo.get(id))!;
    const file = JSON.parse(JSON.stringify(toExportFile(original)));
    expect(JSON.stringify(file)).not.toContain(original.acts[0].id);
    const imported = await repo.create(parseImport(file));
    expect(imported.id).not.toBe(original.id);
    const strip = (s: typeof original) => s.acts.map(({ id: _a, cues, ...a }) => ({ ...a, cues: cues.map(({ id: _c, ...c }) => c) }));
    expect(strip(imported)).toEqual(strip(original));
  });

  it('삭제 시 Act/Cue cascade', async () => {
    const s = await repo.create(sampleServiceInput);
    expect(await repo.remove(s.id)).toBe(true);
    expect(await db.prisma.act.count({ where: { serviceId: s.id } })).toBe(0);
    expect(await db.prisma.cue.count({ where: { actId: s.acts[0].id } })).toBe(0);
  });
});

describe('입력 검증', () => {
  it('정규화: 섹션 대문자, 빈 섹션 → null, atemAction 소문자', () => {
    const s = serviceInputSchema.parse({
      title: 't',
      acts: [{ title: 'a', cues: [{ camera: 1, shotSize: 'WS', section: 'ch', atemAction: 'DSK:1:ON' }, { camera: 2, shotSize: 'MS', section: '' }] }],
    });
    expect(s.acts[0].mode).toBe('MANUAL');
    expect(s.acts[0].cues[0]).toMatchObject({ section: 'CH', atemAction: 'dsk:1:on', note: '', durationSec: null });
    expect(s.acts[0].cues[1].section).toBeNull();
  });

  it.each([
    [{ camera: 9, shotSize: 'WS' }, 'camera'],
    [{ camera: 1, shotSize: 'XL' }, 'shotSize'],
    [{ camera: 1, shotSize: 'WS', atemAction: 'fade' }, 'atemAction'],
    [{ camera: 1, shotSize: 'WS', section: '1A' }, 'section'],
    [{ camera: 1, shotSize: 'WS', bars: -1 }, 'bars'],
  ])('잘못된 큐 거부 %#', (cue, field) => {
    const r = serviceInputSchema.safeParse({ title: 't', acts: [{ title: 'a', cues: [cue] }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain(field);
  });

  it('가져오기는 래퍼 없는 서비스 객체도 허용', () => {
    expect(parseImport({ title: 'bare', acts: [] }).title).toBe('bare');
    expect(() => parseImport({ format: 'mini-cuepilot/service@1', service: {} })).toThrow();
  });
});
