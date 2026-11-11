// 기기용 탈리 통로 (M5StickC Plus 탈리 램프 등)
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { DisabledAtemAdapter, MockAtemAdapter } from '../src/server/atem';
import { ShowRuntime } from '../src/server/runtime';
import { deviceTally, encodeDeviceTally, registerTallyRoutes } from '../src/server/tallyFeed';
import { ManualTimecodeSource } from '../src/server/timecode';
import type { ShowSnapshot } from '../src/shared/protocol';
import { sampleService } from './fixtures';

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function mockRuntime() {
  const atem = new MockAtemAdapter({ transitionMs: 0, latencyMs: 0 });
  await atem.connect();
  const runtime = new ShowRuntime({ atem, timecode: new ManualTimecodeSource(), log: () => {} });
  cleanups.push(() => runtime.stop());
  runtime.load(sampleService());
  return runtime;
}

describe('기기용 탈리 · 상태 계산', () => {
  it('ATEM(가상): GO 뒤 CAM1 송출 · CAM2 PVW · 다음 내 샷과 남은 큐 수', async () => {
    const runtime = await mockRuntime();
    runtime.command({ command: 'GO' });
    await runtime.idle();
    const snap = runtime.snapshot();
    expect(deviceTally(snap, runtime.service, 1)).toEqual({ cam: 1, st: 'pgm', real: true, rh: false, shot: 'MS', next: 'MS', in: 3, now: '' });
    expect(deviceTally(snap, runtime.service, 2)).toMatchObject({ st: 'pvw', shot: '', next: 'MS', in: 1, now: 'CAM 1' });
    expect(deviceTally(snap, runtime.service, 3)).toMatchObject({ st: 'off', in: 2, now: 'CAM 1' });
    expect(deviceTally(snap, runtime.service, 8)).toMatchObject({ st: 'off', next: '', in: -1 });
  });

  it('스위처 없음: 큐 기준 추정 (real=0), PVW 는 표시하지 않음', () => {
    const runtime = new ShowRuntime({ atem: new DisabledAtemAdapter(), timecode: new ManualTimecodeSource(), log: () => {} });
    cleanups.push(() => runtime.stop());
    runtime.load(sampleService());
    expect(deviceTally(runtime.snapshot(), runtime.service, 1)).toMatchObject({ st: 'off', real: false, now: '' });
    runtime.command({ command: 'GO' });
    expect(deviceTally(runtime.snapshot(), runtime.service, 1)).toMatchObject({ st: 'pgm', real: false });
    expect(deviceTally(runtime.snapshot(), runtime.service, 2)).toMatchObject({ st: 'off', now: 'CAM 1' });
  });

  it('카메라 외 소스: 이름을 알면 이름, 모르면 "카메라 외 소스"', () => {
    const runtime = new ShowRuntime({ atem: new DisabledAtemAdapter(), timecode: new ManualTimecodeSource(), log: () => {} });
    cleanups.push(() => runtime.stop());
    const base = runtime.snapshot();
    const snap = (labels?: string[]): ShowSnapshot => ({
      ...base,
      tally: { program: null, preview: null, onAir: [], source: 'atem', ...(labels ? { onAirLabels: labels } : {}) },
      atem: { ...base.atem, mode: 'ikegami-lan', connected: true },
    });
    expect(deviceTally(snap(['PPT']), null, 1)).toMatchObject({ st: 'off', real: true, now: 'PPT', next: '', in: -1 });
    expect(deviceTally(snap(), null, 1)).toMatchObject({ now: '카메라 외 소스' });
  });

  it('한 줄 형식: URL 인코딩 (한글·공백·+ 도 안전하게)', () => {
    const line = encodeDeviceTally({ cam: 2, st: 'off', real: true, rh: false, shot: '', next: 'MS', in: 1, now: 'CAM 1 + 카메라 외 소스' });
    expect(line).toMatch(/^v=1&cam=2&st=off&real=1&rh=0&shot=&next=MS&in=1&now=CAM\+1\+%2B\+/);
    expect(new URLSearchParams(line).get('now')).toBe('CAM 1 + 카메라 외 소스');
  });
});

describe('기기용 탈리 · HTTP', () => {
  async function serve(keepAliveMs?: number) {
    const runtime = await mockRuntime();
    const app = Fastify() as unknown as FastifyInstance;
    const feed = registerTallyRoutes(app, runtime, { keepAliveMs });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    return { runtime, app, feed, port: (app.server.address() as AddressInfo).port };
  }

  it('HTTP/1.0 스트림: chunked 없이 한 줄씩 · 바뀔 때만 · 연결 확인 줄 · 끊으면 정리', async () => {
    const { runtime, feed, port } = await serve(40);
    const sock = connect(port, '127.0.0.1');
    cleanups.push(() => sock.destroy());
    let raw = '';
    sock.on('data', (d: Buffer) => (raw += d.toString('utf8')));
    sock.write('GET /api/tally/stream?cam=2 HTTP/1.0\r\nHost: camcue\r\n\r\n');
    await until(() => raw.includes('data: '));
    const [head, body] = raw.split('\r\n\r\n');
    expect(head).toMatch(/^HTTP\/1\.1 200/);
    expect(head.toLowerCase()).toContain('content-type: text/event-stream');
    expect(head.toLowerCase()).not.toContain('transfer-encoding');
    // 가상 ATEM 은 PGM 1 · PVW 2 로 시작
    expect(body).toBe('retry: 2000\ndata: v=1&cam=2&st=pvw&real=1&rh=0&shot=&next=MS&in=2&now=CAM+1\n\n');

    runtime.command({ command: 'JUMP', actIndex: 0, cueIndex: 1 }); // CAM2 큐로
    await runtime.idle();
    await until(() => /data: v=1&cam=2&st=pgm&real=1&rh=0&shot=MS&next=MS&in=\d+&now=\n\n/.test(raw));
    const count = () => raw.split('data: ').length - 1;
    const before = count();
    runtime.emit('state', runtime.snapshot()); // 같은 상태면 다시 보내지 않음
    await until(() => raw.includes(': ka\n\n'));
    expect(count()).toBe(before);

    expect(feed.clientCount()).toBe(1);
    sock.destroy();
    await until(() => feed.clientCount() === 0);
  });

  it('한 번 조회 · 잘못된 카메라 번호는 400', async () => {
    const { app } = await serve();
    const ok = await app.inject({ method: 'GET', url: '/api/tally?cam=3' });
    expect(ok.json()).toEqual({ cam: 3, st: 'off', real: true, rh: false, shot: '', next: 'MS', in: 3, now: 'CAM 1' });
    expect((await app.inject({ method: 'GET', url: '/api/tally?cam=9' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/tally/stream?cam=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/tally/stream' })).statusCode).toBe(400);
  });

  it('캠큐 서버(buildApp)에 연결되어 있음', async () => {
    const runtime = await mockRuntime();
    const app = await buildApp({ repo: {} as never, runtime });
    cleanups.push(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/api/tally?cam=3' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cam: 3, st: 'off' });
  });
});
