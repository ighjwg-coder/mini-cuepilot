// v0.0.7 준비·비상 대비: 리허설 모드, 실제 시간 측정, 진행 기록, DB 백업, 일괄 편집
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ops } from '../src/shared/editorOps';
import { MockAtemAdapter, DisabledAtemAdapter } from '../src/server/atem';
import { buildApp } from '../src/server/app';
import { backupDb } from '../src/server/bootstrap';
import { createRunLogger, listRunLogs } from '../src/server/runLog';
import { ShowRuntime, type TransitionRecord } from '../src/server/runtime';
import { ServiceRepo } from '../src/server/repo';
import { ManualTimecodeSource } from '../src/server/timecode';
import { sampleService } from './fixtures';
import { createTestDb } from './helpers/db';

const tmp = mkdtempSync(join(tmpdir(), 'camcue-prep-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

describe('리허설 모드', () => {
  it('큐는 진행하지만 스위처에는 아무것도 보내지 않고, 탈리는 큐 기준', async () => {
    const atem = new MockAtemAdapter({ transitionMs: 0, latencyMs: 0 });
    await atem.connect();
    const rt = new ShowRuntime({ atem, timecode: new ManualTimecodeSource() });
    rt.load(sampleService());
    rt.command({ command: 'REHEARSAL', on: true });
    rt.command({ command: 'JUMP', actIndex: 1, cueIndex: 0 });
    await rt.idle();
    expect(atem.log).toEqual([]);
    expect(rt.snapshot().rehearsal).toBe(true);
    expect(rt.tally()).toMatchObject({ source: 'engine', program: 2 });
    rt.command({ command: 'REHEARSAL', on: false });
    rt.command({ command: 'GO' });
    await rt.idle();
    expect(atem.log.some((l) => l.op === 'cut')).toBe(true);
    rt.stop();
  });
});

describe('실제 걸린 시간 측정', () => {
  it('GO 로 넘어갈 때만 기록 (HOLD 시간 제외), BACK·JUMP 는 제외', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const rt = new ShowRuntime({ atem: new DisabledAtemAdapter(), timecode: new ManualTimecodeSource() });
    rt.load(sampleService());
    const records: TransitionRecord[] = [];
    rt.on('transition', (r) => records.push(r));
    rt.command({ command: 'JUMP', actIndex: 1, cueIndex: 0 });
    vi.advanceTimersByTime(12_000);
    rt.command({ command: 'HOLD' });
    vi.advanceTimersByTime(5_000);
    rt.command({ command: 'HOLD' });
    vi.advanceTimersByTime(3_000);
    rt.command({ command: 'GO' });
    vi.advanceTimersByTime(4_000);
    rt.command({ command: 'BACK' });
    expect(rt.measuredDurations()).toEqual({ 'p-1': 15 });
    expect(records.map((r) => r.kind)).toEqual(['jump', 'go', 'back']);
    expect(records[1]).toMatchObject({ actTitle: sampleService().acts[1].title, cueNumber: 2, rehearsal: false });
    rt.stop();
  });

  it('fillDurations: MANUAL 순서만, overwrite=false 면 빈 칸만', () => {
    const svc = sampleService();
    const manual = svc.acts[1];
    const measured = { [manual.cues[0].id]: 41.6, [manual.cues[1].id]: 7.2, [svc.acts[0].cues[0].id]: 9 };
    const keep = ops.fillDurations(svc, measured, false);
    expect(keep.service.acts[1].cues[0].durationSec).toBe(manual.cues[0].durationSec); // 이미 30s → 유지
    expect(keep.service.acts[1].cues[1].durationSec).toBe(7);
    expect(keep.service.acts[0]).toBe(svc.acts[0]); // SECTION 은 그대로
    const all = ops.fillDurations(svc, measured, true);
    expect(all.service.acts[1].cues[0].durationSec).toBe(42);
    expect(all.changed).toBe(2);
  });
});

describe('일괄 편집', () => {
  it('updateCues / deleteCues', () => {
    const svc = sampleService();
    const ids = new Set([svc.acts[0].cues[0].id, svc.acts[1].cues[1].id]);
    const up = ops.updateCues(svc, ids, { camera: 4, shotSize: 'BS' });
    expect(up.acts[0].cues[0]).toMatchObject({ camera: 4, shotSize: 'BS' });
    expect(up.acts[1].cues[1]).toMatchObject({ camera: 4, shotSize: 'BS' });
    expect(up.acts[1].cues[0]).toEqual(svc.acts[1].cues[0]);
    const del = ops.deleteCues(svc, ids);
    expect(del.acts[0].cues).toHaveLength(svc.acts[0].cues.length - 1);
    expect(del.acts[1].cues).toHaveLength(svc.acts[1].cues.length - 1);
  });
});

describe('진행 기록 CSV', () => {
  it('날짜별 파일, BOM+헤더 한 번, 쉼표·따옴표 처리, 성공 명령은 생략', () => {
    const dir = join(tmp, 'logs');
    const log = createRunLogger(dir, () => '주일 2부');
    const at = new Date(2026, 9, 25, 11, 2, 3).getTime();
    log.transition({ at, kind: 'go', actTitle: '찬양', cueNumber: 3, camera: 2, shotSize: 'CU', note: '보컬, "고음"', rehearsal: true, silent: false });
    log.command({ id: 1, at, result: 'ok', label: 'x', error: null });
    log.command({ id: 2, at, result: 'failed', label: 'CAM 5 CUT', error: '출력 없음' });
    const files = listRunLogs(dir);
    expect(files.map((f) => f.name)).toEqual(['run-2026-10-25.csv']);
    const text = readFileSync(join(dir, files[0].name), 'utf8');
    expect(text.startsWith('﻿시각,')).toBe(true);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('11:02:03,GO,주일 2부,찬양,3,CAM 2,CU,"보컬, ""고음""",리허설');
    expect(lines[2]).toContain('컷 실패');
  });

  it('/api/logs 목록·내려받기, 잘못된 이름은 404', async () => {
    const db = createTestDb();
    const rt = new ShowRuntime({ atem: new DisabledAtemAdapter(), timecode: new ManualTimecodeSource() });
    const app = await buildApp({ repo: new ServiceRepo(db.prisma), runtime: rt, logDir: join(tmp, 'logs') });
    expect((await app.inject({ url: '/api/logs' })).json()[0].name).toBe('run-2026-10-25.csv');
    const dl = await app.inject({ url: '/api/logs/run-2026-10-25.csv' });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain('run-2026-10-25.csv');
    expect((await app.inject({ url: '/api/logs/..%2Fconfig.env' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/show/measured' })).json()).toEqual({});
    rt.stop();
    await app.close();
    await db.cleanup();
  });
});

describe('DB 자동 백업', () => {
  it('시작할 때 복사, 최근 keep 개만 보관, DB 없으면 null', () => {
    const dir = join(tmp, 'data');
    const db = join(tmp, 'camcue.db');
    expect(backupDb(db, dir)).toBeNull();
    writeFileSync(db, 'sqlite');
    for (let i = 0; i < 5; i++) backupDb(db, dir, 3, new Date(2026, 9, 20 + i, 9, 0));
    const names = readdirSync(dir).sort();
    expect(names).toEqual(['camcue-2026-10-22_0900.db', 'camcue-2026-10-23_0900.db', 'camcue-2026-10-24_0900.db']);
    expect(existsSync(join(dir, names[0]))).toBe(true);
  });
});
