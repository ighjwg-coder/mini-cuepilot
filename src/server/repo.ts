// Prisma 저장소: 도메인 모델(Service/Act/Cue) ↔ SQLite
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { ServiceInput } from '../shared/schema';
import type { AdvanceMode, Service, ServiceSummary, ShotSize } from '../shared/types';

const include = {
  acts: { orderBy: { order: 'asc' }, include: { cues: { orderBy: { order: 'asc' } } } },
} satisfies Prisma.ServiceInclude;

type ServiceRow = Prisma.ServiceGetPayload<{ include: typeof include }>;

function toDomain(row: ServiceRow): Service {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    acts: row.acts.map((a) => ({
      id: a.id,
      title: a.title,
      mode: a.mode as AdvanceMode,
      bpm: a.bpm,
      beatsPerBar: a.beatsPerBar,
      cues: a.cues.map((c) => ({
        id: c.id,
        camera: c.camera,
        shotSize: c.shotSize as ShotSize,
        note: c.note,
        durationSec: c.durationSec,
        section: c.section,
        bars: c.bars,
        tcInSec: c.tcInSec,
        atemAction: c.atemAction,
      })),
    })),
  };
}

export class ConflictError extends Error {}

export class ServiceRepo {
  constructor(private readonly db: PrismaClient) {}

  async list(): Promise<ServiceSummary[]> {
    const rows = await this.db.service.findMany({
      orderBy: [{ date: 'desc' }, { updatedAt: 'desc' }],
      include: { acts: { select: { _count: { select: { cues: true } } } } },
    });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.date,
      actCount: r.acts.length,
      cueCount: r.acts.reduce((n, a) => n + a._count.cues, 0),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async get(id: string): Promise<Service | null> {
    const row = await this.db.service.findUnique({ where: { id }, include });
    return row ? toDomain(row) : null;
  }

  /** 가장 최근에 수정된 행사 (서버 시작 시 기본 로드) */
  async latest(): Promise<Service | null> {
    const row = await this.db.service.findFirst({ orderBy: { updatedAt: 'desc' }, include });
    return row ? toDomain(row) : null;
  }

  /** 새 행사 생성. 입력의 id 는 무시하고 전부 새로 발급 (가져오기에도 사용) */
  async create(input: ServiceInput): Promise<Service> {
    const row = await this.db.service.create({
      data: {
        title: input.title,
        date: input.date,
        acts: {
          create: input.acts.map(({ id: _a, cues, ...act }, order) => ({
            ...act,
            order,
            cues: { create: cues.map(({ id: _c, ...cue }, cueOrder) => ({ ...cue, order: cueOrder })) },
          })),
        },
      },
      include,
    });
    return toDomain(row);
  }

  /**
   * 행사 전체 저장 (에디터). id 가 있는 Act/Cue 는 갱신, 없으면 생성, 빠진 것은 삭제.
   * id 를 보존해야 라이브 중 편집해도 진행 위치(현재 큐)가 유지된다.
   */
  async save(id: string, input: ServiceInput): Promise<Service | null> {
    const existing = await this.db.service.findUnique({
      where: { id },
      select: { acts: { select: { id: true, cues: { select: { id: true } } } } },
    });
    if (!existing) return null;

    const ownActIds = new Set(existing.acts.map((a) => a.id));
    const ownCueIds = new Set(existing.acts.flatMap((a) => a.cues.map((c) => c.id)));

    // 다른 행사 소유의 id 를 넘기면 거부 (덮어쓰기 방지)
    const foreignActIds = input.acts.map((a) => a.id).filter((x): x is string => !!x && !ownActIds.has(x));
    const foreignCueIds = input.acts
      .flatMap((a) => a.cues.map((c) => c.id))
      .filter((x): x is string => !!x && !ownCueIds.has(x));
    const [actClash, cueClash] = await Promise.all([
      foreignActIds.length ? this.db.act.count({ where: { id: { in: foreignActIds } } }) : 0,
      foreignCueIds.length ? this.db.cue.count({ where: { id: { in: foreignCueIds } } }) : 0,
    ]);
    if (actClash || cueClash) throw new ConflictError('다른 행사에 속한 Act/Cue id 가 포함되어 있습니다');

    const acts = input.acts.map((a) => ({ ...a, id: a.id ?? randomUUID(), cues: a.cues.map((c) => ({ ...c, id: c.id ?? randomUUID() })) }));
    const keepActIds = acts.map((a) => a.id);
    const keepCueIds = acts.flatMap((a) => a.cues.map((c) => c.id));

    await this.db.$transaction(async (tx) => {
      await tx.service.update({ where: { id }, data: { title: input.title, date: input.date } });
      await tx.cue.deleteMany({ where: { act: { serviceId: id }, id: { notIn: keepCueIds } } });
      await tx.act.deleteMany({ where: { serviceId: id, id: { notIn: keepActIds } } });
      for (const [order, { cues, ...act }] of acts.entries()) {
        const data = { title: act.title, mode: act.mode, bpm: act.bpm, beatsPerBar: act.beatsPerBar, order };
        await tx.act.upsert({ where: { id: act.id }, create: { ...data, id: act.id, serviceId: id }, update: data });
      }
      for (const act of acts) {
        for (const [order, { id: cueId, ...cue }] of act.cues.entries()) {
          const data = { ...cue, order, actId: act.id };
          await tx.cue.upsert({ where: { id: cueId }, create: { ...data, id: cueId }, update: data });
        }
      }
    });
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const r = await this.db.service.deleteMany({ where: { id } });
    return r.count > 0;
  }
}
