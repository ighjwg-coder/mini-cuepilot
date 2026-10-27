// v0.0.7 운영 안전장치: 컷 없는 이동, GO 연타 방지, 명령 기준 탈리, 명령 기록, 위치 복원, 제어 권한
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cameraView, goTarget, initialState, reduce, upcoming } from '../src/shared/engine';
import { DisabledAtemAdapter, MockAtemAdapter } from '../src/server/atem';
import { buildApp } from '../src/server/app';
import { createAccessPolicy, isLoopback } from '../src/server/access';
import { MockGpi } from '../src/server/devices/gpi';
import { GpiSwitcherAdapter } from '../src/server/devices/gpiSwitcher';
import { createLiveStateWriter, readLiveState } from '../src/server/liveState';
import { ServiceRepo } from '../src/server/repo';
import { ShowRuntime } from '../src/server/runtime';
import { sampleServiceInput } from '../src/server/sampleService';
import { ManualTimecodeSource } from '../src/server/timecode';
import type { Cue, Service } from '../src/shared/types';
import { act, cue, sampleService } from './fixtures';
import { createTestDb } from './helpers/db';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('엔진: 컷 없는 이동 · GO 대상 · 먼 큐', () => {
  const svc = sampleService();

  it('silent BACK/JUMP 는 위치만 옮기고 스위처 효과·송출 카메라는 그대로', () => {
    let s = reduce(svc, initialState(), { type: 'JUMP', now: 0, actIndex: 1, cueIndex: 1 }).state;
    expect(s.programCamera).toBe(3);
    const back = reduce(svc, s, { type: 'BACK', now: 1, silent: true });
    expect(back.effects).toEqual([]);
    expect([back.state.actIndex, back.state.cueIndex]).toEqual([1, 0]);
    expect(back.state.programCamera).toBe(3);
    s = back.state;
    const jump = reduce(svc, s, { type: 'JUMP', now: 2, actIndex: 0, cueIndex: 2, silent: true });
    expect(jump.effects.filter((e) => e.type === 'ATEM')).toEqual([]);
    expect(jump.state.cueIndex).toBe(2);
  });

  it('goTarget: SECTION 자동 구간이면 NEXT(바로 다음)가 아니라 다음 섹션 첫 큐', () => {
    const s = reduce(svc, initialState(), { type: 'GO', now: 0 }).state; // V1 첫 큐
    expect(upcoming(svc, s, 0, 1)[0].cue.id).toBe('w-v1-b');
    const t = goTarget(svc, s)!;
    expect(svc.acts[t.actIndex].cues[t.cueIndex].id).toBe('w-ch-a');
    expect(reduce(svc, s, { type: 'GO', now: 1 }).state.cueIndex).toBe(t.cueIndex);
  });

  it('cameraView: 다음 내 큐가 50큐 넘게 뒤여도 찾는다', () => {
    const cues: Cue[] = [cue({ camera: 4 })];
    for (let i = 0; i < 60; i++) cues.push(cue({ camera: 1 + (i % 3) }));
    const far = cue({ camera: 4 });
    cues.push(far);
    const s: Service = { id: 'x', title: 'x', date: null, acts: [act({ id: 'a', cues })] };
    let st = reduce(s, initialState(), { type: 'GO', now: 0 }).state;
    st = reduce(s, st, { type: 'GO', now: 1 }).state;
    expect(cameraView(s, st, 2, 4).next?.cue.id).toBe(far.id);
  });
});

describe('ShowRuntime: 연타 방지 · 명령 기록 · 위치 복원', () => {
  afterEach(() => vi.useRealTimers());

  it('stepLockMs 안의 두 번째 GO 는 무시, 지나면 다시 받음', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const rt = new ShowRuntime({ atem: new DisabledAtemAdapter(), timecode: new ManualTimecodeSource(), stepLockMs: 500 });
    rt.load(sampleService());
    rt.command({ command: 'JUMP', actIndex: 1, cueIndex: 0 });
    rt.command({ command: 'GO' });
    rt.command({ command: 'GO' }); // 연타
    expect(rt.state.cueIndex).toBe(1);
    vi.advanceTimersByTime(600);
    rt.command({ command: 'BACK' });
    expect(rt.state.cueIndex).toBe(0);
    rt.command({ command: 'BACK', silent: true }); // 컷 없는 이동은 잠금 대상 아님 (맨 앞이라 이동 없음)
    rt.stop();
  });

  it('GPI 접점 컷의 송출 값은 source=command (실측 아님), 컷 실패는 기록에 남는다', async () => {
    const gpi = new MockGpi();
    await gpi.connect();
    const sw = new GpiSwitcherAdapter({ gpi, cutOutputs: [1, 2], pulseMs: 1 });
    const rt = new ShowRuntime({ atem: sw, timecode: new ManualTimecodeSource(), log: () => {} });
    rt.load(sampleService());
    rt.command({ command: 'JUMP', actIndex: 1, cueIndex: 0 }); // CAM 2
    await rt.idle();
    expect(rt.tally()).toMatchObject({ program: 2, source: 'command' });
    rt.command({ command: 'GO' }); // CAM 3 — 출력 채널 없음
    await rt.idle();
    const log = rt.snapshot().commandLog;
    expect(log.at(-1)).toMatchObject({ result: 'failed' });
    expect(log.at(-1)!.error).toMatch(/CAM 3/);
    expect(sw.status().lastError).toMatch(/CAM 3/); // 장비 상태에도 표시
    expect(rt.snapshot().switcherCaps).toEqual({ cameras: [1, 2], transition: false, macro: false, dsk: false });
    rt.stop();
  });

  it('스위처 미연결로 못 보낸 컷은 skipped 로 기록', async () => {
    const atem = new MockAtemAdapter({ transitionMs: 0, latencyMs: 0 }); // connect 안 함
    const rt = new ShowRuntime({ atem, timecode: new ManualTimecodeSource(), log: () => {} });
    rt.load(sampleService());
    rt.command({ command: 'GO' });
    await rt.idle();
    expect(rt.snapshot().commandLog.at(-1)).toMatchObject({ result: 'skipped' });
    rt.stop();
  });

  it('load(service, resumeAt) 은 그 위치로 컷 없이 시작', async () => {
    const atem = new MockAtemAdapter({ transitionMs: 0, latencyMs: 0 });
    await atem.connect();
    const rt = new ShowRuntime({ atem, timecode: new ManualTimecodeSource() });
    rt.load(sampleService(), { actIndex: 1, cueIndex: 1 });
    await rt.idle();
    expect([rt.state.actIndex, rt.state.cueIndex]).toEqual([1, 1]);
    expect(atem.log.filter((l) => l.op === 'cut' || l.op === 'auto')).toEqual([]);
    rt.stop();
  });
});

describe('라이브 위치 파일', () => {
  const dir = mkdtempSync(join(tmpdir(), 'camcue-live-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('저장 → 읽기, 깨진 파일은 무시', () => {
    const path = join(dir, 'live-state.json');
    expect(readLiveState(path)).toBeNull();
    const write = createLiveStateWriter(path);
    write('svc-1', { actIndex: 2, cueIndex: 5 }, 123);
    expect(readLiveState(path)).toEqual({ serviceId: 'svc-1', position: { actIndex: 2, cueIndex: 5 }, savedAt: 123 });
    write('svc-1', null, 456);
    expect(readLiveState(path)?.position).toBeNull();
  });
});

describe('제어 권한', () => {
  it('이 PC(loopback)는 항상, 다른 기기는 PIN 이 맞을 때만', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('192.168.0.20')).toBe(false);
    const none = createAccessPolicy('');
    expect(none.canControl('192.168.0.20', '1234')).toBe(false);
    const pin = createAccessPolicy('1234');
    expect(pin.canControl('192.168.0.20', '1234')).toBe(true);
    expect(pin.canControl('192.168.0.20', '9999')).toBe(false);
    expect(pin.canControl('192.168.0.20', undefined)).toBe(false);
  });
});

describe('REST: 다시 열기 · 복제 · 저장 충돌 · 권한', () => {
  const db = createTestDb();
  const repo = new ServiceRepo(db.prisma);
  const runtime = new ShowRuntime({ atem: new DisabledAtemAdapter(), timecode: new ManualTimecodeSource() });
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ repo, runtime, access: createAccessPolicy('4321') });
  });
  afterAll(async () => {
    runtime.stop();
    await app.close();
    await db.cleanup();
  });

  it('라이브 중인 같은 행사를 다시 열면 진행 위치 유지, restart 면 처음부터', async () => {
    const s = await repo.create(sampleServiceInput);
    await app.inject({ method: 'POST', url: '/api/show/load', payload: { serviceId: s.id } });
    runtime.command({ command: 'GO' });
    runtime.command({ command: 'GO' });
    const pos = runtime.state.cueIndex;
    expect(pos).toBeGreaterThanOrEqual(0);
    await app.inject({ method: 'POST', url: '/api/show/load', payload: { serviceId: s.id } });
    expect(runtime.state.cueIndex).toBe(pos);
    await app.inject({ method: 'POST', url: '/api/show/load', payload: { serviceId: s.id, restart: true } });
    expect(runtime.state.cueIndex).toBe(-1);
  });

  it('행사 복제: 새 id, 같은 순서·큐', async () => {
    const s = await repo.create(sampleServiceInput);
    const res = await app.inject({ method: 'POST', url: `/api/services/${s.id}/duplicate`, payload: { title: '다음 주', date: '2026-11-01' } });
    expect(res.statusCode).toBe(201);
    const copy = res.json() as Service;
    expect(copy.id).not.toBe(s.id);
    expect(copy.title).toBe('다음 주');
    expect(copy.date).toBe('2026-11-01');
    expect(copy.acts.map((a) => a.cues.length)).toEqual(s.acts.map((a) => a.cues.length));
    expect(copy.acts[0].id).not.toBe(s.acts[0].id);
  });

  it('불러온 뒤 다른 곳에서 먼저 저장했으면 409, base 없이 저장하면 덮어씀', async () => {
    const s = await repo.create(sampleServiceInput);
    const base = s.updatedAt!;
    await new Promise((r) => setTimeout(r, 5));
    const first = await app.inject({ method: 'PUT', url: `/api/services/${s.id}`, headers: { 'x-camcue-base': base }, payload: { ...s, title: 'A' } });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({ method: 'PUT', url: `/api/services/${s.id}`, headers: { 'x-camcue-base': base }, payload: { ...s, title: 'B' } });
    expect(stale.statusCode).toBe(409);
    const force = await app.inject({ method: 'PUT', url: `/api/services/${s.id}`, payload: { ...s, title: 'B' } });
    expect(force.statusCode).toBe(200);
    expect(force.json().title).toBe('B');
  });

  it('다른 기기의 바꾸는 요청은 PIN 필요, 읽기는 누구나', async () => {
    const remote = '192.168.0.31';
    const denied = await app.inject({ method: 'POST', url: '/api/show/command', remoteAddress: remote, payload: { command: 'GO' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('PIN_REQUIRED');
    const ok = await app.inject({ method: 'POST', url: '/api/show/command', remoteAddress: remote, headers: { 'x-camcue-pin': '4321' }, payload: { command: 'HOLD' } });
    expect(ok.statusCode).toBe(200);
    const read = await app.inject({ method: 'GET', url: '/api/show', remoteAddress: remote });
    expect(read.statusCode).toBe(200);
    const info = await app.inject({ method: 'GET', url: '/api/info', remoteAddress: remote });
    expect(info.json()).toMatchObject({ canControl: false, pinEnabled: true });
    await flush();
  });
});
