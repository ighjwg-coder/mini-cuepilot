import { describe, expect, it } from 'vitest';
import {
  cameraView,
  cueDurationMs,
  cueElapsedMs,
  cueTimecodes,
  currentCue,
  initialState,
  reconcile,
  reduce,
  upcoming,
  type EngineEvent,
  type EngineState,
} from '../src/shared/engine';
import type { Service } from '../src/shared/types';
import { act, cue, sampleService } from './fixtures';

const svc = sampleService();

/** 이벤트 시퀀스를 적용하고 최종 상태와 누적 effects 반환 */
function run(service: Service, events: EngineEvent[], from: EngineState = initialState()) {
  let state = from;
  const effects = [];
  for (const e of events) {
    const r = reduce(service, state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const pos = (s: EngineState) => [s.actIndex, s.cueIndex];
const cueId = (service: Service, s: EngineState) => currentCue(service, s)?.id ?? null;

describe('기본 / MANUAL 모드', () => {
  it('STANDBY에서 GO → 첫 큐 ON AIR, ATEM cut 효과', () => {
    const r = reduce(svc, initialState(), { type: 'GO', now: 1000 });
    expect(pos(r.state)).toEqual([0, 0]);
    expect(r.state.cueStartedAt).toBe(1000);
    expect(r.state.programCamera).toBe(1);
    expect(r.effects).toEqual([{ type: 'ATEM', cueId: 'w-v1-a', camera: 1, action: { kind: 'cut' } }]);
  });

  it('MANUAL Act에서는 GO 를 눌러야만 다음 큐', () => {
    const start = run(svc, [{ type: 'JUMP', now: 0, actIndex: 1, cueIndex: 0 }]).state;
    // durationSec(30s)이 지나도 TICK 으로는 진행되지 않음
    const ticked = run(svc, [{ type: 'TICK', now: 60_000 }], start).state;
    expect(cueId(svc, ticked)).toBe('p-1');
    const went = run(svc, [{ type: 'GO', now: 61_000 }], ticked).state;
    expect(cueId(svc, went)).toBe('p-2');
  });

  it('Act 마지막 큐에서 GO → 빈 Act를 건너뛰고 다음 Act 첫 큐', () => {
    const s = run(svc, [
      { type: 'JUMP', now: 0, actIndex: 1, cueIndex: 1 },
      { type: 'GO', now: 1 },
    ]).state;
    expect(cueId(svc, s)).toBe('s-1');
    expect(pos(s)).toEqual([3, 0]);
  });

  it('마지막 큐에서 GO 는 아무 일도 하지 않음', () => {
    const start = run(svc, [{ type: 'JUMP', now: 0, actIndex: 3, cueIndex: 2 }]).state;
    const r = reduce(svc, start, { type: 'GO', now: 5 });
    expect(r.state).toBe(start);
    expect(r.effects).toEqual([]);
  });

  it('JUMP 범위 밖이면 무시', () => {
    const r = reduce(svc, initialState(), { type: 'JUMP', now: 0, actIndex: 2, cueIndex: 0 });
    expect(r.state).toEqual(initialState());
  });

  it('빈 서비스에서 GO 는 STANDBY 유지', () => {
    const empty: Service = { id: 'e', title: 'e', date: null, acts: [act({ id: 'a', cues: [] })] };
    expect(reduce(empty, initialState(), { type: 'GO', now: 0 }).state).toEqual(initialState());
  });

  it('RESET → STANDBY', () => {
    const s = run(svc, [{ type: 'GO', now: 0 }, { type: 'RESET' }]).state;
    expect(s).toEqual(initialState());
  });
});

describe('BACK', () => {
  it('이전 큐로 돌아가며 해당 큐의 ATEM 액션을 다시 보냄', () => {
    const s = run(svc, [{ type: 'JUMP', now: 0, actIndex: 1, cueIndex: 1 }]).state;
    const r = reduce(svc, s, { type: 'BACK', now: 10 });
    expect(cueId(svc, r.state)).toBe('p-1');
    expect(r.state.cueStartedAt).toBe(10);
    expect(r.state.lastTransition).toEqual({ kind: 'back', at: 10 });
    expect(r.effects).toEqual([{ type: 'ATEM', cueId: 'p-1', camera: 2, action: { kind: 'cut' } }]);
  });

  it('Act 첫 큐에서 BACK → 이전(비어있지 않은) Act의 마지막 큐', () => {
    const s = run(svc, [
      { type: 'JUMP', now: 0, actIndex: 3, cueIndex: 0 },
      { type: 'BACK', now: 1 },
    ]).state;
    expect(cueId(svc, s)).toBe('p-2');
  });

  it('첫 큐 / STANDBY 에서 BACK 은 무시', () => {
    expect(reduce(svc, initialState(), { type: 'BACK', now: 0 }).state).toEqual(initialState());
    const first = run(svc, [{ type: 'GO', now: 0 }]).state;
    expect(reduce(svc, first, { type: 'BACK', now: 1 }).state).toBe(first);
  });

  it('BACK 으로 TIMECODE Act를 벗어나면 타임코드 소스 정지 효과', () => {
    const s = run(svc, [{ type: 'JUMP', now: 0, actIndex: 3, cueIndex: 0 }]).state;
    const r = reduce(svc, s, { type: 'BACK', now: 1 });
    expect(r.effects[0]).toEqual({ type: 'TIMECODE_STOP' });
  });
});

describe('SECTION 모드', () => {
  // 120BPM 4/4 → 1마디 2000ms
  it('마디 수 → 길이 계산', () => {
    expect(cueDurationMs(svc.acts[0], 0)).toBe(4000);
    expect(cueDurationMs(svc.acts[0], 2)).toBe(8000);
  });

  it('섹션 안에서는 BPM·마디 기준으로 자동 진행', () => {
    const s0 = run(svc, [{ type: 'GO', now: 0 }]).state;
    expect(cueId(svc, reduce(svc, s0, { type: 'TICK', now: 3999 }).state)).toBe('w-v1-a');
    const r = reduce(svc, s0, { type: 'TICK', now: 4000 });
    expect(cueId(svc, r.state)).toBe('w-v1-b');
    expect(r.state.lastTransition?.kind).toBe('auto');
    expect(r.effects).toEqual([{ type: 'ATEM', cueId: 'w-v1-b', camera: 2, action: { kind: 'cut' } }]);
  });

  it('섹션 마지막 큐에서는 시간이 지나도 다음 섹션으로 자동 전환하지 않음 (수동 트리거 대기)', () => {
    const s = run(svc, [
      { type: 'GO', now: 0 },
      { type: 'TICK', now: 4000 },
      { type: 'TICK', now: 100_000 },
    ]).state;
    expect(cueId(svc, s)).toBe('w-v1-b');
  });

  it('GO = 다음 섹션 시작 트리거, 이후 그 섹션도 자동 진행', () => {
    const s = run(svc, [
      { type: 'GO', now: 0 },
      { type: 'TICK', now: 4000 },
      { type: 'GO', now: 9000 },
    ]).state;
    expect(cueId(svc, s)).toBe('w-ch-a');
    const r = reduce(svc, s, { type: 'TICK', now: 9000 + 8000 });
    expect(cueId(svc, r.state)).toBe('w-ch-b');
    expect(r.effects[0]).toMatchObject({ camera: 1, action: { kind: 'auto' } });
  });

  it('섹션 도중 GO → 남은 큐를 건너뛰고 다음 섹션으로 (섹션 전환)', () => {
    const s = run(svc, [
      { type: 'GO', now: 0 },
      { type: 'GO', now: 1000 },
    ]).state;
    expect(cueId(svc, s)).toBe('w-ch-a');
  });

  it('TICK 이 늦게 와도 박자 기준 시각을 유지 (누적 드리프트 없음)', () => {
    const s0 = run(svc, [{ type: 'GO', now: 0 }]).state;
    const r = reduce(svc, s0, { type: 'TICK', now: 4250 });
    expect(r.state.cueStartedAt).toBe(4000);
  });

  it('지연된 TICK 한 번에 여러 큐를 넘기면 모든 ATEM 효과를 순서대로 냄', () => {
    const service: Service = {
      ...svc,
      acts: [
        act({
          id: 'x',
          mode: 'SECTION',
          bpm: 60,
          cues: [
            cue({ id: 'a', camera: 1, section: 'V1', bars: 1 }),
            cue({ id: 'b', camera: 2, section: 'V1', bars: 1 }),
            cue({ id: 'c', camera: 3, section: 'V1', bars: 1 }),
          ],
        }),
      ],
    };
    const s0 = run(service, [{ type: 'GO', now: 0 }]).state;
    const r = reduce(service, s0, { type: 'TICK', now: 8500 }); // 1마디 = 4000ms
    expect(cueId(service, r.state)).toBe('c');
    expect(r.state.cueStartedAt).toBe(8000);
    expect(r.effects.map((e) => (e.type === 'ATEM' ? e.cueId : e.type))).toEqual(['b', 'c']);
  });

  it('섹션 블록 마지막 → 다음 Act 로 GO', () => {
    const s = run(svc, [
      { type: 'JUMP', now: 0, actIndex: 0, cueIndex: 2 },
      { type: 'GO', now: 1 },
    ]).state;
    expect(cueId(svc, s)).toBe('p-1');
  });

  it('마디 정보가 없는 섹션 큐는 GO 로 한 큐씩 진행', () => {
    const service: Service = {
      ...svc,
      acts: [
        act({
          id: 'x',
          mode: 'SECTION',
          bpm: 120,
          cues: [
            cue({ id: 'a', camera: 1, section: 'V1' }),
            cue({ id: 'b', camera: 2, section: 'V1' }),
            cue({ id: 'c', camera: 3, section: 'CH' }),
          ],
        }),
      ],
    };
    const s = run(service, [
      { type: 'GO', now: 0 },
      { type: 'TICK', now: 999_999 },
      { type: 'GO', now: 1_000_000 },
    ]).state;
    expect(cueId(service, s)).toBe('b');
  });

  it('BPM 이 없으면 자동 진행하지 않음', () => {
    const service: Service = { ...svc, acts: [{ ...svc.acts[0], bpm: null }] };
    const s = run(service, [
      { type: 'GO', now: 0 },
      { type: 'TICK', now: 999_999 },
    ]).state;
    expect(cueId(service, s)).toBe('w-v1-a');
  });
});

describe('HOLD', () => {
  it('HOLD 중에는 SECTION 자동 진행이 멈추고, 해제 시 남은 시간부터 이어감', () => {
    const s = run(svc, [
      { type: 'GO', now: 0 },
      { type: 'HOLD', now: 1000 },
      { type: 'TICK', now: 10_000 },
    ]).state;
    expect(s.held).toBe(true);
    expect(cueId(svc, s)).toBe('w-v1-a');
    expect(cueElapsedMs(s, 10_000)).toBe(1000);

    const released = run(svc, [{ type: 'HOLD', now: 10_000 }], s).state;
    expect(released.held).toBe(false);
    expect(released.cueStartedAt).toBe(9000); // 9초 HOLD 만큼 뒤로 밀림
    expect(cueId(svc, reduce(svc, released, { type: 'TICK', now: 12_999 }).state)).toBe('w-v1-a');
    expect(cueId(svc, reduce(svc, released, { type: 'TICK', now: 13_000 }).state)).toBe('w-v1-b');
  });

  it('HOLD on/off 명시 지정은 멱등', () => {
    const s = run(svc, [{ type: 'GO', now: 0 }, { type: 'HOLD', now: 5, on: true }]).state;
    const again = reduce(svc, s, { type: 'HOLD', now: 10, on: true });
    expect(again.state).toBe(s);
  });

  it('HOLD 중에도 GO/BACK 은 동작하고 HOLD 는 유지 (새 큐 타이머도 멈춤)', () => {
    const s = run(svc, [
      { type: 'GO', now: 0 },
      { type: 'HOLD', now: 100 },
      { type: 'GO', now: 500 },
    ]).state;
    expect(cueId(svc, s)).toBe('w-ch-a');
    expect(s.held).toBe(true);
    expect(cueElapsedMs(s, 50_000)).toBe(0);
    const released = run(svc, [{ type: 'HOLD', now: 50_000 }], s).state;
    expect(cueElapsedMs(released, 51_000)).toBe(1000);
  });

  it('HOLD 중에는 타임코드가 들어와도 진행하지 않음', () => {
    const s = run(svc, [
      { type: 'JUMP', now: 0, actIndex: 3, cueIndex: 0 },
      { type: 'HOLD', now: 0 },
      { type: 'TIMECODE', now: 50_000, seconds: 50 },
    ]).state;
    expect(cueId(svc, s)).toBe('s-1');
    expect(s.timecodeSec).toBe(50);
  });
});

describe('TIMECODE 모드', () => {
  it('tcInSec 우선, 없으면 durationSec 누적', () => {
    expect(cueTimecodes(svc.acts[3])).toEqual([0, 10, 45]);
  });

  it('Act 진입 시 타임코드 소스 시작 효과', () => {
    const r = reduce(svc, initialState(), { type: 'JUMP', now: 0, actIndex: 3, cueIndex: 0 });
    expect(r.effects[0]).toEqual({ type: 'TIMECODE_START', actId: 'sermon' });
  });

  it('타임코드에 따라 자동 진행, 중간 큐를 건너뛰면 마지막 대상 큐만 ATEM 전송', () => {
    const s0 = run(svc, [{ type: 'JUMP', now: 0, actIndex: 3, cueIndex: 0 }]).state;
    const r1 = reduce(svc, s0, { type: 'TIMECODE', now: 9_000, seconds: 9.9 });
    expect(cueId(svc, r1.state)).toBe('s-1');
    const r2 = reduce(svc, r1.state, { type: 'TIMECODE', now: 10_000, seconds: 10 });
    expect(cueId(svc, r2.state)).toBe('s-2');
    expect(r2.state.lastTransition?.kind).toBe('timecode');

    const jump = reduce(svc, s0, { type: 'TIMECODE', now: 50_000, seconds: 50 });
    expect(cueId(svc, jump.state)).toBe('s-3');
    expect(jump.effects).toEqual([{ type: 'ATEM', cueId: 's-3', camera: 3, action: { kind: 'dsk', keyer: 1, onAir: true } }]);
    expect(jump.state.cueStartedAt).toBe(45_000); // 타임코드 기준 시작 시각
  });

  it('타임코드는 뒤로 가지 않음 (수동 GO 선행 허용)', () => {
    const s = run(svc, [
      { type: 'JUMP', now: 0, actIndex: 3, cueIndex: 0 },
      { type: 'GO', now: 1000 },
      { type: 'TIMECODE', now: 2000, seconds: 2 },
    ]).state;
    expect(cueId(svc, s)).toBe('s-2');
  });

  it('TIMECODE 가 아닌 Act에서는 타임코드 무시', () => {
    const s = run(svc, [{ type: 'GO', now: 0 }, { type: 'TIMECODE', now: 1, seconds: 999 }]).state;
    expect(cueId(svc, s)).toBe('w-v1-a');
    expect(s.timecodeSec).toBeNull();
  });

  it('dsk 액션은 PGM 카메라를 바꾸지 않음', () => {
    const s = run(svc, [
      { type: 'JUMP', now: 0, actIndex: 3, cueIndex: 1 },
      { type: 'TIMECODE', now: 1, seconds: 46 },
    ]).state;
    expect(cueId(svc, s)).toBe('s-3');
    expect(s.programCamera).toBe(2);
  });
});

describe('예측 / CueScreen', () => {
  it('SECTION 블록 안 큐의 카운트다운은 정확(exact)', () => {
    const s = run(svc, [{ type: 'GO', now: 0 }]).state;
    const up = upcoming(svc, s, 1000);
    expect(up[0]).toMatchObject({ cue: { id: 'w-v1-b' }, etaMs: 3000, exact: true, cuesAway: 1 });
    // 다음 섹션은 수동 트리거 → 최소 추정치
    expect(up[1]).toMatchObject({ cue: { id: 'w-ch-a' }, etaMs: 7000, exact: false });
  });

  it('카메라별 다음 차례', () => {
    const s = run(svc, [{ type: 'GO', now: 0 }]).state;
    const v1 = cameraView(svc, s, 0, 1);
    expect(v1.onAir).toBe(true);
    expect(v1.current?.id).toBe('w-v1-a');
    expect(v1.next?.cue.id).toBe('w-ch-b');
    expect(v1.next?.cuesAway).toBe(3);

    const v3 = cameraView(svc, s, 0, 3);
    expect(v3.onAir).toBe(false);
    expect(v3.current).toBeNull();
    expect(v3.next).toMatchObject({ cue: { id: 'w-ch-a' }, etaMs: 8000 });
    expect(v3.afterNext?.cue.id).toBe('p-2');
  });

  it('길이를 모르는 큐 뒤의 ETA 는 null', () => {
    const s = run(svc, [{ type: 'JUMP', now: 0, actIndex: 1, cueIndex: 1 }]).state;
    expect(upcoming(svc, s, 0)[0].etaMs).toBeNull();
  });

  it('STANDBY 에서는 첫 큐가 다음, ETA 없음', () => {
    const up = upcoming(svc, initialState(), 0);
    expect(up[0]).toMatchObject({ cue: { id: 'w-v1-a' }, etaMs: null, cuesAway: 1 });
    expect(up).toHaveLength(9);
  });

  it('HOLD 중 카운트다운은 멈추고 exact=false', () => {
    const s = run(svc, [{ type: 'GO', now: 0 }, { type: 'HOLD', now: 1000 }]).state;
    const a = upcoming(svc, s, 2000)[0];
    const b = upcoming(svc, s, 9000)[0];
    expect(a.etaMs).toBe(3000);
    expect(b.etaMs).toBe(3000);
    expect(a.exact).toBe(false);
  });
});

describe('reconcile (편집 중 서비스 갱신)', () => {
  it('큐 순서가 바뀌어도 같은 큐 id 위치를 유지', () => {
    const s = run(svc, [{ type: 'JUMP', now: 0, actIndex: 1, cueIndex: 1 }]).state;
    const edited: Service = structuredClone(svc);
    edited.acts[1].cues.reverse();
    const r = reconcile(svc, edited, s);
    expect(cueId(edited, r)).toBe('p-2');
    expect(r.cueIndex).toBe(0);
  });

  it('현재 큐가 삭제되면 같은 Act 안 가까운 큐로', () => {
    const s = run(svc, [{ type: 'JUMP', now: 0, actIndex: 1, cueIndex: 1 }]).state;
    const edited: Service = structuredClone(svc);
    edited.acts[1].cues.pop();
    expect(cueId(edited, reconcile(svc, edited, s))).toBe('p-1');
  });

  it('Act가 삭제되면 STANDBY', () => {
    const s = run(svc, [{ type: 'JUMP', now: 0, actIndex: 1, cueIndex: 1 }]).state;
    const edited: Service = structuredClone(svc);
    edited.acts.splice(1, 1);
    expect(reconcile(svc, edited, s).actIndex).toBe(-1);
  });
});
