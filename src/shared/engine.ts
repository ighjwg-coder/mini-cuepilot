// 큐 진행 엔진 — 부수효과 없는 순수 함수 모음.
// 시간(now)은 항상 이벤트로 주입되고, ATEM 제어·타임코드 소스 제어는 effects 로만 표현된다.
// 서버(ShowRuntime)가 effects 를 실제 장비/클락에 적용한다.

import { parseAtemAction, switchesProgram, type AtemAction } from './atemAction';
import type { Act, Cue, Service } from './types';

export interface EngineState {
  /** 현재 ON AIR 큐 위치. 시작 전(STANDBY)은 -1 / -1 */
  actIndex: number;
  cueIndex: number;
  /** 현재 큐가 시작된 시각(ms). HOLD 해제 시 HOLD 시간만큼 뒤로 밀린다 */
  cueStartedAt: number | null;
  held: boolean;
  holdStartedAt: number | null;
  /** 엔진이 추정하는 PGM 카메라 (cut/auto 큐가 마지막으로 보낸 카메라) */
  programCamera: number | null;
  /** 현재 Act에서 마지막으로 받은 타임코드(초) */
  timecodeSec: number | null;
  lastTransition: { kind: TransitionKind; at: number } | null;
}

export type TransitionKind = 'go' | 'back' | 'auto' | 'timecode' | 'jump';

export type EngineEvent =
  | { type: 'GO'; now: number }
  | { type: 'BACK'; now: number }
  | { type: 'HOLD'; now: number; on?: boolean }
  | { type: 'TICK'; now: number }
  | { type: 'TIMECODE'; now: number; seconds: number }
  | { type: 'JUMP'; now: number; actIndex: number; cueIndex: number }
  | { type: 'RESET' };

export type EngineEffect =
  | { type: 'ATEM'; cueId: string; camera: number; action: AtemAction }
  | { type: 'TIMECODE_START'; actId: string }
  | { type: 'TIMECODE_STOP' };

export interface EngineResult {
  state: EngineState;
  effects: EngineEffect[];
}

export const initialState = (): EngineState => ({
  actIndex: -1,
  cueIndex: -1,
  cueStartedAt: null,
  held: false,
  holdStartedAt: null,
  programCamera: null,
  timecodeSec: null,
  lastTransition: null,
});

// ───────────────────────── 조회 헬퍼 ─────────────────────────

export interface CueRef {
  actIndex: number;
  cueIndex: number;
}

export function isStandby(state: EngineState): boolean {
  return state.actIndex < 0 || state.cueIndex < 0;
}

export function currentAct(service: Service, state: EngineState): Act | null {
  return service.acts[state.actIndex] ?? null;
}

export function currentCue(service: Service, state: EngineState): Cue | null {
  return currentAct(service, state)?.cues[state.cueIndex] ?? null;
}

export function cueAt(service: Service, ref: CueRef | null): Cue | null {
  return ref ? (service.acts[ref.actIndex]?.cues[ref.cueIndex] ?? null) : null;
}

/** 다음 큐 위치 (빈 Act 건너뜀). 없으면 null */
export function nextRef(service: Service, ref: CueRef): CueRef | null {
  if (ref.actIndex >= 0) {
    const act = service.acts[ref.actIndex];
    if (act && ref.cueIndex + 1 < act.cues.length) return { actIndex: ref.actIndex, cueIndex: ref.cueIndex + 1 };
  }
  for (let a = Math.max(ref.actIndex + 1, 0); a < service.acts.length; a++) {
    if (service.acts[a].cues.length > 0) return { actIndex: a, cueIndex: 0 };
  }
  return null;
}

/** 이전 큐 위치 (빈 Act 건너뜀). 없으면 null */
export function prevRef(service: Service, ref: CueRef): CueRef | null {
  if (ref.actIndex < 0) return null;
  if (ref.cueIndex > 0) return { actIndex: ref.actIndex, cueIndex: ref.cueIndex - 1 };
  for (let a = ref.actIndex - 1; a >= 0; a--) {
    const n = service.acts[a].cues.length;
    if (n > 0) return { actIndex: a, cueIndex: n - 1 };
  }
  return null;
}

/** TIMECODE 모드용 큐 진입 시각(초). tcInSec 우선, 없으면 앞 큐 durationSec 누적 */
export function cueTimecodes(act: Act): number[] {
  const out: number[] = [];
  let cursor = 0;
  for (const cue of act.cues) {
    const tc = cue.tcInSec ?? cursor;
    out.push(tc);
    cursor = tc + (cue.durationSec ?? 0);
  }
  return out;
}

/** BPM·마디 수 → ms */
export function barsToMs(bars: number, bpm: number, beatsPerBar: number): number {
  return (bars * beatsPerBar * 60_000) / bpm;
}

/** 큐 길이(ms). 알 수 없으면 null */
export function cueDurationMs(act: Act, cueIndex: number): number | null {
  const cue = act.cues[cueIndex];
  if (!cue) return null;
  if (act.mode === 'SECTION' && cue.bars != null && cue.bars > 0 && act.bpm != null && act.bpm > 0) {
    return barsToMs(cue.bars, act.bpm, act.beatsPerBar || 4);
  }
  if (act.mode === 'TIMECODE' && cueIndex + 1 < act.cues.length) {
    const tcs = cueTimecodes(act);
    return Math.max(0, (tcs[cueIndex + 1] - tcs[cueIndex]) * 1000);
  }
  return cue.durationSec != null && cue.durationSec > 0 ? cue.durationSec * 1000 : null;
}

/**
 * ref 큐 → 다음 큐 전환이 엔진에 의해 자동으로 일어나는가.
 * SECTION: 같은 섹션이 연속되고 길이가 정해진 경우 / TIMECODE: 같은 Act 안
 */
export function isAutoTransition(service: Service, ref: CueRef): boolean {
  const act = service.acts[ref.actIndex];
  if (!act) return false;
  const cue = act.cues[ref.cueIndex];
  const next = act.cues[ref.cueIndex + 1];
  if (!cue || !next) return false;
  if (act.mode === 'SECTION') {
    return cue.section != null && next.section === cue.section && cueDurationMs(act, ref.cueIndex) != null;
  }
  if (act.mode === 'TIMECODE') return true;
  return false;
}

/** 현재 큐 경과 시간(ms). HOLD 중에는 멈춰 있다 */
export function cueElapsedMs(state: EngineState, now: number): number {
  if (state.cueStartedAt == null) return 0;
  const ref = state.held && state.holdStartedAt != null ? state.holdStartedAt : now;
  return Math.max(0, ref - state.cueStartedAt);
}

// ───────────────────────── 리듀서 ─────────────────────────

function goLive(
  service: Service,
  state: EngineState,
  target: CueRef,
  now: number,
  kind: TransitionKind,
  startedAt: number = now,
): EngineResult {
  const act = service.acts[target.actIndex];
  const cue = act.cues[target.cueIndex];
  const effects: EngineEffect[] = [];
  const actChanged = target.actIndex !== state.actIndex;

  if (actChanged) {
    const prevAct = currentAct(service, state);
    if (prevAct?.mode === 'TIMECODE') effects.push({ type: 'TIMECODE_STOP' });
    if (act.mode === 'TIMECODE') effects.push({ type: 'TIMECODE_START', actId: act.id });
  }

  const action = parseAtemAction(cue.atemAction);
  if (action) effects.push({ type: 'ATEM', cueId: cue.id, camera: cue.camera, action });

  return {
    state: {
      ...state,
      actIndex: target.actIndex,
      cueIndex: target.cueIndex,
      cueStartedAt: startedAt,
      holdStartedAt: state.held ? now : null,
      programCamera: switchesProgram(action) ? cue.camera : state.programCamera,
      timecodeSec: actChanged ? null : state.timecodeSec,
      lastTransition: { kind, at: now },
    },
    effects,
  };
}

const noop = (state: EngineState): EngineResult => ({ state, effects: [] });

/** SECTION 모드에서 GO가 향할 위치: 현재 섹션 블록 다음 블록의 첫 큐 */
function nextSectionStart(service: Service, ref: CueRef): CueRef | null {
  const act = service.acts[ref.actIndex];
  const section = act.cues[ref.cueIndex].section;
  if (section == null) return nextRef(service, ref);
  for (let i = ref.cueIndex + 1; i < act.cues.length; i++) {
    if (act.cues[i].section !== section) return { actIndex: ref.actIndex, cueIndex: i };
  }
  return nextRef(service, { actIndex: ref.actIndex, cueIndex: act.cues.length - 1 });
}

function handleGo(service: Service, state: EngineState, now: number): EngineResult {
  if (isStandby(state)) {
    const first = nextRef(service, { actIndex: -1, cueIndex: -1 });
    return first ? goLive(service, state, first, now, 'go') : noop(state);
  }
  const ref = { actIndex: state.actIndex, cueIndex: state.cueIndex };
  const act = currentAct(service, state)!;
  // SECTION: 자동 진행 중인 섹션 블록 안이면 다음 섹션 시작으로 건너뛴다(=다음 섹션 수동 트리거)
  const inAutoBlock = act.mode === 'SECTION' && isAutoTransition(service, ref);
  const target = inAutoBlock ? nextSectionStart(service, ref) : nextRef(service, ref);
  return target ? goLive(service, state, target, now, 'go') : noop(state);
}

function handleBack(service: Service, state: EngineState, now: number): EngineResult {
  if (isStandby(state)) return noop(state);
  const target = prevRef(service, { actIndex: state.actIndex, cueIndex: state.cueIndex });
  return target ? goLive(service, state, target, now, 'back') : noop(state);
}

function handleHold(state: EngineState, now: number, on?: boolean): EngineResult {
  const want = on ?? !state.held;
  if (want === state.held) return noop(state);
  if (want) return { state: { ...state, held: true, holdStartedAt: now }, effects: [] };
  const pausedFor = state.holdStartedAt != null ? now - state.holdStartedAt : 0;
  return {
    state: {
      ...state,
      held: false,
      holdStartedAt: null,
      cueStartedAt: state.cueStartedAt != null ? state.cueStartedAt + pausedFor : null,
    },
    effects: [],
  };
}

/** SECTION 모드 자동 진행. 지연된 TICK 에서도 박자 누적 오차가 없도록 시작 시각을 이어 붙인다 */
function handleTick(service: Service, state: EngineState, now: number): EngineResult {
  if (state.held || isStandby(state)) return noop(state);
  const act = currentAct(service, state);
  if (!act || act.mode !== 'SECTION') return noop(state);

  let cur = state;
  const effects: EngineEffect[] = [];
  while (cur.cueStartedAt != null) {
    const ref = { actIndex: cur.actIndex, cueIndex: cur.cueIndex };
    if (!isAutoTransition(service, ref)) break;
    const dur = cueDurationMs(act, cur.cueIndex)!;
    const due = cur.cueStartedAt + dur;
    if (now < due) break;
    const r = goLive(service, cur, { actIndex: cur.actIndex, cueIndex: cur.cueIndex + 1 }, now, 'auto', due);
    cur = r.state;
    effects.push(...r.effects);
  }
  return { state: cur, effects };
}

/** TIMECODE 모드: 타임코드가 가리키는 큐로 전진 (후진은 하지 않음 — 수동 GO 선행 허용) */
function handleTimecode(service: Service, state: EngineState, now: number, seconds: number): EngineResult {
  if (isStandby(state)) return noop(state);
  const act = currentAct(service, state);
  if (!act || act.mode !== 'TIMECODE') return noop(state);
  const withTc = { ...state, timecodeSec: seconds };
  if (state.held) return { state: withTc, effects: [] };

  const tcs = cueTimecodes(act);
  let target = -1;
  for (let i = 0; i < tcs.length; i++) if (tcs[i] <= seconds) target = i;
  if (target <= state.cueIndex) return { state: withTc, effects: [] };

  const startedAt = now - (seconds - tcs[target]) * 1000;
  return goLive(service, withTc, { actIndex: state.actIndex, cueIndex: target }, now, 'timecode', startedAt);
}

function handleJump(service: Service, state: EngineState, now: number, ref: CueRef): EngineResult {
  if (!cueAt(service, ref)) return noop(state);
  return goLive(service, state, ref, now, 'jump');
}

export function reduce(service: Service, state: EngineState, event: EngineEvent): EngineResult {
  switch (event.type) {
    case 'GO':
      return handleGo(service, state, event.now);
    case 'BACK':
      return handleBack(service, state, event.now);
    case 'HOLD':
      return handleHold(state, event.now, event.on);
    case 'TICK':
      return handleTick(service, state, event.now);
    case 'TIMECODE':
      return handleTimecode(service, state, event.now, event.seconds);
    case 'JUMP':
      return handleJump(service, state, event.now, { actIndex: event.actIndex, cueIndex: event.cueIndex });
    case 'RESET': {
      const effects: EngineEffect[] = currentAct(service, state)?.mode === 'TIMECODE' ? [{ type: 'TIMECODE_STOP' }] : [];
      return { state: initialState(), effects };
    }
  }
}

/**
 * 서비스 내용이 바뀌었을 때(에디터 저장) 진행 위치를 큐 id 기준으로 보존한다.
 * 현재 큐가 삭제됐으면 같은 Act의 가까운 큐, Act까지 삭제됐으면 STANDBY.
 */
export function reconcile(oldService: Service, newService: Service, state: EngineState): EngineState {
  if (isStandby(state)) return state;
  const oldCue = currentCue(oldService, state);
  if (oldCue) {
    for (let a = 0; a < newService.acts.length; a++) {
      const c = newService.acts[a].cues.findIndex((x) => x.id === oldCue.id);
      if (c >= 0) return { ...state, actIndex: a, cueIndex: c };
    }
  }
  const oldAct = currentAct(oldService, state);
  const a = oldAct ? newService.acts.findIndex((x) => x.id === oldAct.id) : -1;
  if (a >= 0 && newService.acts[a].cues.length > 0) {
    return { ...state, actIndex: a, cueIndex: Math.min(state.cueIndex, newService.acts[a].cues.length - 1) };
  }
  return { ...initialState(), held: state.held, holdStartedAt: state.holdStartedAt };
}

// ───────────────────────── 예측(카운트다운) ─────────────────────────

export interface UpcomingCue extends CueRef {
  cue: Cue;
  /** 지금부터 이 큐가 ON AIR 될 때까지 남은 시간(ms). 길이를 모르는 큐가 사이에 있으면 null */
  etaMs: number | null;
  /** 지금부터 이 큐까지 모든 전환이 자동이면 true (정확한 카운트다운) */
  exact: boolean;
  /** 현재 큐로부터 몇 번째 큐인지 (1 = 바로 다음) */
  cuesAway: number;
}

/**
 * 현재 큐 이후 큐들의 예상 진입 시각.
 * - 수동 전환(GO)이 끼어 있으면 "즉시 GO 한다고 가정한" 최소 추정치이며 exact=false
 * - HOLD 중이면 시간이 멈춘 것으로 보고 exact=false
 * - STANDBY 상태에서는 시작 시점을 알 수 없으므로 etaMs=null
 */
export function upcoming(service: Service, state: EngineState, now: number, limit = 50): UpcomingCue[] {
  const out: UpcomingCue[] = [];
  let ref: CueRef;
  let eta: number | null;
  let exact: boolean;

  if (isStandby(state)) {
    const first = nextRef(service, { actIndex: -1, cueIndex: -1 });
    if (!first) return out;
    out.push({ ...first, cue: cueAt(service, first)!, etaMs: null, exact: false, cuesAway: 1 });
    ref = first;
    eta = null;
    exact = false;
  } else {
    ref = { actIndex: state.actIndex, cueIndex: state.cueIndex };
    const dur = cueDurationMs(service.acts[ref.actIndex], ref.cueIndex);
    eta = dur != null ? Math.max(0, dur - cueElapsedMs(state, now)) : null;
    exact = !state.held;
  }

  while (out.length < limit) {
    const next = nextRef(service, ref);
    if (!next) break;
    exact = exact && isAutoTransition(service, ref);
    out.push({ ...next, cue: cueAt(service, next)!, etaMs: eta, exact: exact && eta != null, cuesAway: out.length + 1 });
    const d = cueDurationMs(service.acts[next.actIndex], next.cueIndex);
    eta = eta != null && d != null ? eta + d : null;
    ref = next;
  }
  return out;
}

export interface CameraView {
  camera: number;
  /** 엔진 기준 이 카메라가 PGM 인가 */
  onAir: boolean;
  /** 현재 큐가 이 카메라의 큐인가 */
  isCurrentCue: boolean;
  current: Cue | null;
  next: UpcomingCue | null;
  afterNext: UpcomingCue | null;
}

/** CueScreen용: 카메라 n의 현재 샷 / 다음 샷 / 다음 차례까지 남은 시간 */
export function cameraView(service: Service, state: EngineState, now: number, camera: number): CameraView {
  const cur = currentCue(service, state);
  const mine = upcoming(service, state, now).filter((u) => u.cue.camera === camera);
  return {
    camera,
    onAir: state.programCamera === camera,
    isCurrentCue: cur?.camera === camera,
    current: cur?.camera === camera ? cur : null,
    next: mine[0] ?? null,
    afterNext: mine[1] ?? null,
  };
}
