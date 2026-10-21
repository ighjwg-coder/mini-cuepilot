import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentCue } from '../src/shared/engine';
import type { ShowSnapshot } from '../src/shared/protocol';
import { DisabledAtemAdapter } from '../src/server/atem';
import { ShowRuntime } from '../src/server/runtime';
import { ManualTimecodeSource } from '../src/server/timecode';
import { sampleService } from './fixtures';

describe('ShowRuntime (ATEM 미연결)', () => {
  let runtime: ShowRuntime;
  let tc: ManualTimecodeSource;
  const svc = sampleService();
  const cueId = () => currentCue(runtime.service!, runtime.state)?.id;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    tc = new ManualTimecodeSource();
    runtime = new ShowRuntime({ atem: new DisabledAtemAdapter(), timecode: tc, tickMs: 20 });
    runtime.load(svc);
    runtime.start();
  });
  afterEach(() => {
    runtime.stop();
    vi.useRealTimers();
  });

  it('GO 후 실시간으로 SECTION 자동 진행 + state 이벤트 발생', () => {
    const snaps: ShowSnapshot[] = [];
    runtime.on('state', (s) => snaps.push(s));
    runtime.command({ command: 'GO' });
    expect(cueId()).toBe('w-v1-a');
    vi.advanceTimersByTime(3990);
    expect(cueId()).toBe('w-v1-a');
    vi.advanceTimersByTime(20);
    expect(cueId()).toBe('w-v1-b');
    expect(snaps).toHaveLength(2);
    expect(snaps[1].state.lastTransition?.kind).toBe('auto');
  });

  it('ATEM 미연결 시 탈리는 엔진 추정값(source=engine)', () => {
    runtime.command({ command: 'GO' });
    expect(runtime.tally()).toEqual({ program: 1, preview: 2, source: 'engine' });
    expect(runtime.snapshot().atem).toMatchObject({ mode: 'disabled', connected: false });
  });

  it('TIMECODE Act 진입 시 타임코드 소스 시작, 수신값으로 진행, 이탈 시 정지', () => {
    runtime.command({ command: 'JUMP', actIndex: 3, cueIndex: 0 });
    expect(tc.running).toBe(true);
    tc.push(12);
    expect(cueId()).toBe('s-2');
    expect(runtime.state.timecodeSec).toBe(12);
    runtime.command({ command: 'BACK' }); // s-1 (같은 Act)
    expect(tc.running).toBe(true);
    runtime.command({ command: 'BACK' }); // 인사말 Act 로 이탈
    expect(cueId()).toBe('p-2');
    expect(tc.running).toBe(false);
  });

  it('HOLD 중에는 자동 진행 정지', () => {
    runtime.command({ command: 'GO' });
    runtime.command({ command: 'HOLD' });
    vi.advanceTimersByTime(10_000);
    expect(cueId()).toBe('w-v1-a');
    runtime.command({ command: 'HOLD' });
    vi.advanceTimersByTime(4_000);
    expect(cueId()).toBe('w-v1-b');
  });

  it('updateService: 편집 반영 시 현재 큐 유지', () => {
    runtime.command({ command: 'JUMP', actIndex: 1, cueIndex: 1 });
    const edited = structuredClone(svc);
    edited.acts.unshift({ id: 'new', title: '새 순서', mode: 'MANUAL', bpm: null, beatsPerBar: 4, cues: [] });
    runtime.updateService(edited);
    expect(cueId()).toBe('p-2');
    expect(runtime.state.actIndex).toBe(2);
  });

  it('다른 행사 updateService 는 무시, unloadIf 로 언로드', () => {
    runtime.updateService({ ...svc, id: 'other', acts: [] });
    expect(runtime.service!.id).toBe('svc');
    runtime.unloadIf('svc');
    expect(runtime.service).toBeNull();
    runtime.command({ command: 'GO' }); // 서비스 없음 → 무시
    expect(runtime.state.actIndex).toBe(-1);
  });
});
