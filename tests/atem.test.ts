import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAtemAction } from '../src/shared/atemAction';
import {
  DisabledAtemAdapter,
  MockAtemAdapter,
  RealAtemAdapter,
  createAtemAdapter,
  executeAtemAction,
  parseAtemHost,
} from '../src/server/atem';
import { ShowRuntime } from '../src/server/runtime';
import { ManualTimecodeSource } from '../src/server/timecode';
import { sampleService } from './fixtures';

describe('ATEM_HOST 해석 / 어댑터 선택', () => {
  it.each([
    [undefined, { kind: 'disabled' }],
    ['', { kind: 'disabled' }],
    ['  ', { kind: 'disabled' }],
    ['mock', { kind: 'mock' }],
    ['MOCK', { kind: 'mock' }],
    ['192.168.10.240', { kind: 'real', host: '192.168.10.240' }],
    ['192.168.10.240:9911', { kind: 'real', host: '192.168.10.240', port: 9911 }],
    ['atem.local', { kind: 'real', host: 'atem.local' }],
  ])('%s', (raw, expected) => {
    expect(parseAtemHost(raw)).toEqual(expected);
  });

  it('createAtemAdapter', () => {
    expect(createAtemAdapter('')).toBeInstanceOf(DisabledAtemAdapter);
    expect(createAtemAdapter('mock')).toBeInstanceOf(MockAtemAdapter);
    const real = createAtemAdapter('10.0.0.1', { ATEM_ME: '2' });
    expect(real).toBeInstanceOf(RealAtemAdapter);
    expect(real.status()).toMatchObject({ mode: 'real', host: '10.0.0.1', connected: false });
  });
});

describe('MockAtemAdapter + executeAtemAction', () => {
  let atem: MockAtemAdapter;
  beforeEach(async () => {
    atem = new MockAtemAdapter();
    await atem.connect();
  });

  const exec = (camera: number, action: string) => executeAtemAction(atem, camera, parseAtemAction(action)!);

  it('cut: PVW 에 올리고 CUT → PGM 전환', async () => {
    await exec(4, 'cut');
    expect(atem.log).toEqual([{ op: 'setPreview', input: 4 }, { op: 'cut' }]);
    expect(atem.status()).toMatchObject({ programInput: 4, previewInput: 1 });
  });

  it('auto: 트랜지션 시간 후 PGM 전환', async () => {
    vi.useFakeTimers();
    const slow = new MockAtemAdapter({ transitionMs: 1000 });
    await slow.connect();
    await executeAtemAction(slow, 3, { kind: 'auto' });
    expect(slow.status().programInput).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(slow.status()).toMatchObject({ programInput: 3, previewInput: 1 });
    vi.useRealTimers();
  });

  it('macro:n 은 0부터 인덱스로 변환', async () => {
    await exec(1, 'macro:1');
    await exec(1, 'macro:12');
    expect(atem.log).toEqual([
      { op: 'macro', index: 0 },
      { op: 'macro', index: 11 },
    ]);
    expect(atem.status().programInput).toBe(1); // PGM 변화 없음
  });

  it('dsk:n:on/off 는 0부터 키어로 변환', async () => {
    await exec(1, 'dsk:2:on');
    expect(atem.dskOnAir).toEqual([false, true, false, false]);
    await exec(1, 'dsk:2:off');
    expect(atem.dskOnAir[1]).toBe(false);
  });

  it('미연결 시 명령은 예외', async () => {
    atem.simulateDisconnect();
    await expect(exec(1, 'cut')).rejects.toThrow('연결되지 않음');
    expect(atem.status()).toMatchObject({ connected: false, programInput: null, lastError: 'mock: 연결 끊김' });
  });

  it('존재하지 않는 입력/키어는 예외', async () => {
    await expect(exec(99, 'cut')).rejects.toThrow('입력 99');
    await expect(exec(1, 'dsk:9:on')).rejects.toThrow('DSK');
  });

  it('상태 변경 구독', async () => {
    const seen: (number | null)[] = [];
    const off = atem.onStatus((s) => seen.push(s.programInput));
    await exec(5, 'cut');
    off();
    await exec(6, 'cut');
    expect(seen.at(-1)).toBe(5);
  });
});

describe('ShowRuntime + Mock ATEM 통합', () => {
  let atem: MockAtemAdapter;
  let runtime: ShowRuntime;
  const errors: string[] = [];

  beforeEach(async () => {
    errors.length = 0;
    atem = new MockAtemAdapter();
    await atem.connect();
    runtime = new ShowRuntime({ atem, timecode: new ManualTimecodeSource(), log: (m) => errors.push(m) });
    runtime.load(sampleService());
  });
  afterEach(() => runtime.stop());

  it('GO → 스위처 PGM 전환 + 다음 큐 카메라 PVW 준비, 탈리는 ATEM 기준', async () => {
    runtime.command({ command: 'GO' });
    await runtime.idle();
    expect(atem.log).toEqual([{ op: 'setPreview', input: 1 }, { op: 'cut' }, { op: 'setPreview', input: 2 }]);
    expect(runtime.tally()).toEqual({ program: 1, preview: 2, source: 'atem' });
  });

  it('AUTO 큐 뒤에는 PVW 자동 준비를 하지 않음 (트랜지션 중 PVW 변경 방지)', async () => {
    runtime.command({ command: 'JUMP', actIndex: 0, cueIndex: 3 }); // w-ch-b: auto
    await runtime.idle();
    expect(atem.log).toEqual([{ op: 'setPreview', input: 1 }, { op: 'auto' }]);
  });

  it('BACK → 이전 큐 카메라로 다시 전환', async () => {
    runtime.command({ command: 'GO' });
    runtime.command({ command: 'GO' }); // 섹션 점프 → w-ch-a (CAM3)
    runtime.command({ command: 'BACK' }); // w-v1-b (CAM2)
    await runtime.idle();
    expect(atem.status().programInput).toBe(2);
  });

  it('TIMECODE 진행 중 dsk 액션은 PGM 유지', async () => {
    runtime.command({ command: 'JUMP', actIndex: 3, cueIndex: 1 });
    await runtime.idle();
    expect(atem.status().programInput).toBe(2);
    runtime.command({ command: 'JUMP', actIndex: 3, cueIndex: 2 });
    await runtime.idle();
    expect(atem.dskOnAir[0]).toBe(true);
    expect(atem.status().programInput).toBe(2);
  });

  it('ATEM 연결이 끊겨도 큐 진행은 계속되고 탈리는 엔진 추정으로 전환', async () => {
    atem.simulateDisconnect();
    runtime.command({ command: 'GO' });
    runtime.command({ command: 'GO' });
    await runtime.idle();
    expect(runtime.state).toMatchObject({ actIndex: 0, cueIndex: 2 });
    expect(atem.log).toEqual([]); // 미연결 중 명령은 보내지 않음
    expect(runtime.tally()).toMatchObject({ program: 3, source: 'engine' });
    expect(runtime.snapshot().atem).toMatchObject({ connected: false, lastError: 'mock: 연결 끊김' });
    expect(errors).toEqual([]);
  });

  it('ATEM 명령 실패는 로그만 남기고 다음 명령/진행은 계속', async () => {
    atem.failNext('스위처 거부');
    runtime.command({ command: 'GO' });
    runtime.command({ command: 'GO' });
    await runtime.idle();
    expect(errors[0]).toContain('ATEM 명령 실패');
    expect(runtime.state.cueIndex).toBe(2);
    expect(atem.status().programInput).toBe(3); // 두 번째 GO 는 정상 송출
  });

  it('하드웨어 패널에서 직접 전환해도 탈리는 실제 PGM 을 따름 + state 이벤트 발생', async () => {
    const programs: (number | null)[] = [];
    runtime.on('state', (s) => programs.push(s.tally.program));
    atem.simulatePanelCut(7);
    expect(runtime.tally().program).toBe(7);
    expect(programs).toContain(7);
  });

  it('SECTION 자동 진행도 ATEM 으로 송출', async () => {
    vi.useFakeTimers({ now: 0 });
    const rt = new ShowRuntime({ atem, timecode: new ManualTimecodeSource(), tickMs: 20 });
    rt.load(sampleService());
    rt.start();
    rt.command({ command: 'GO' });
    vi.advanceTimersByTime(4020);
    vi.useRealTimers();
    await rt.idle();
    expect(atem.status().programInput).toBe(2);
    rt.stop();
  });
});

describe('RealAtemAdapter (장비 없음)', () => {
  it('연결 대상이 없어도 예외로 앱을 멈추지 않고 미연결 상태만 보고, 명령은 거부', async () => {
    const real = new RealAtemAdapter({ host: '127.0.0.1', port: 9 });
    await real.connect().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    expect(real.status()).toMatchObject({ mode: 'real', connected: false, programInput: null });
    await expect(real.cut()).rejects.toThrow('ATEM 미연결');
    await real.disconnect();
  }, 10_000);
});
