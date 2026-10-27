// ShowRuntime: 엔진(순수 함수)을 실제 시간·ATEM·타임코드 소스에 연결하는 상태 보관자.
import { EventEmitter } from 'node:events';
import {
  cueElapsedMs,
  currentAct,
  currentCue,
  isStandby,
  initialState,
  reconcile,
  reduce,
  upcoming,
  type EngineEffect,
  type EngineEvent,
  type CueRef,
  type EngineState,
} from '../shared/engine';
import type { CommandLogEntry, ShowCommand, ShowSnapshot, Tally } from '../shared/protocol';
import type { Service } from '../shared/types';
import { FULL_CAPS, executeAtemAction, type AtemAdapter } from './atem/types';
import type { TallyInput } from './devices/manager';
import type { TimecodeSource } from './timecode';

export interface RuntimeOptions {
  atem: AtemAdapter;
  timecode: TimecodeSource;
  /** 실제 탈리 신호(GPI). active() 일 때 스위처 보고값보다 우선 */
  tallyInput?: TallyInput;
  now?: () => number;
  /** SECTION 자동 진행 판정 주기(ms) */
  tickMs?: number;
  /**
   * CUT 후 다음 큐 카메라를 PVW 에 미리 올림.
   * AUTO 는 트랜지션 진행 중 PVW 를 바꾸면 전환 대상이 바뀔 수 있어 제외한다.
   */
  autoPreview?: boolean;
  /**
   * GO·BACK 연타 방지(ms). 이 시간 안에 다시 들어온 GO/BACK 은 무시한다.
   * 두 번 눌러 큐가 두 칸 넘어가고 컷이 연달아 나가는 사고 방지. 0 = 끔
   */
  stepLockMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

/** 디렉터 화면에 보여 줄 스위처 명령 기록 수 */
const COMMAND_LOG_LIMIT = 12;

/** 큐 이동 기록 (진행 기록 파일용) */
export interface TransitionRecord {
  at: number;
  kind: string;
  actTitle: string;
  cueNumber: number;
  camera: number;
  shotSize: string;
  note: string;
  rehearsal: boolean;
  silent: boolean;
}

interface RuntimeEvents {
  state: [ShowSnapshot];
  service: [Service | null];
  transition: [TransitionRecord];
  command: [CommandLogEntry];
}

export class ShowRuntime extends EventEmitter<RuntimeEvents> {
  private _service: Service | null = null;
  private _state: EngineState = initialState();
  private timer: NodeJS.Timeout | null = null;
  private atemQueue: Promise<void> = Promise.resolve();
  private readonly unsubs: Array<() => void> = [];
  private readonly now: () => number;
  private readonly opts: Required<Omit<RuntimeOptions, 'now' | 'tallyInput'>>;
  private readonly tallyInput: TallyInput | undefined;
  private lastStepAt = -Infinity;
  private commandLog: CommandLogEntry[] = [];
  private commandSeq = 0;
  private rehearsal = false;
  /** 큐 id → GO 로 넘어가기까지 실제 걸린 시간(ms). 리허설·본 진행 모두 기록 (MANUAL 큐 길이 채우기용) */
  private readonly measured = new Map<string, number>();

  constructor(options: RuntimeOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.tallyInput = options.tallyInput;
    this.opts = {
      tickMs: 20,
      autoPreview: true,
      stepLockMs: 0,
      log: (msg, err) => console.error(`[runtime] ${msg}`, err ?? ''),
      ...options,
    };
    this.unsubs.push(
      this.opts.timecode.onTimecode((seconds) => this.apply({ type: 'TIMECODE', now: this.now(), seconds })),
      this.opts.atem.onStatus(() => this.emitState()),
    );
    if (this.tallyInput) this.unsubs.push(this.tallyInput.onChange(() => this.emitState()));
  }

  get service() {
    return this._service;
  }

  get state() {
    return this._state;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this._service && currentAct(this._service, this._state)?.mode === 'SECTION') {
        this.apply({ type: 'TICK', now: this.now() });
      }
    }, this.opts.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.opts.timecode.stop();
    this.unsubs.splice(0).forEach((u) => u());
  }

  /**
   * 라이브 대상 행사 교체 → STANDBY 로 초기화.
   * resumeAt 을 주면 그 큐 위치로 컷 없이 이어서 시작 (서버 재시작 후 복원)
   */
  load(service: Service | null, resumeAt?: CueRef | null) {
    this.opts.timecode.stop();
    this._service = service;
    this._state = initialState();
    this.emit('service', service);
    if (service && resumeAt) {
      const r = reduce(service, this._state, { type: 'JUMP', now: this.now(), ...resumeAt, silent: true });
      this._state = r.state;
      this.runEffects(r.effects);
    }
    this.emitState();
  }

  /** 에디터 저장 반영. 같은 행사면 진행 위치 보존 */
  updateService(service: Service) {
    if (!this._service || this._service.id !== service.id) return;
    const prev = this._service;
    this._service = service;
    this._state = reconcile(prev, service, this._state);
    if (currentAct(service, this._state)?.mode !== 'TIMECODE') this.opts.timecode.stop();
    this.emit('service', service);
    this.emitState();
  }

  /** 행사 삭제 시 */
  unloadIf(serviceId: string) {
    if (this._service?.id === serviceId) this.load(null);
  }

  command(cmd: ShowCommand) {
    const now = this.now();
    // 컷이 나가는 이동(GO·BACK)은 연타를 막는다. 컷 없는 이동·HOLD·JUMP 는 그대로
    if ((cmd.command === 'GO' || (cmd.command === 'BACK' && !cmd.silent)) && this.opts.stepLockMs > 0) {
      if (now - this.lastStepAt < this.opts.stepLockMs) return;
      this.lastStepAt = now;
    }
    switch (cmd.command) {
      case 'REHEARSAL':
        if (this.rehearsal === cmd.on) return;
        this.rehearsal = cmd.on;
        return this.emitState();
      case 'GO':
        return this.apply({ type: 'GO', now });
      case 'BACK':
        return this.apply({ type: 'BACK', now, silent: cmd.silent }, cmd.silent);
      case 'HOLD':
        return this.apply({ type: 'HOLD', now, on: cmd.on });
      case 'RESET':
        return this.apply({ type: 'RESET' });
      case 'JUMP':
        return this.apply({ type: 'JUMP', now, actIndex: cmd.actIndex, cueIndex: cmd.cueIndex, silent: cmd.silent }, cmd.silent);
    }
  }

  /** 대기 중인 ATEM 명령이 모두 끝날 때까지 (테스트용) */
  idle(): Promise<void> {
    return this.atemQueue;
  }

  get isRehearsal() {
    return this.rehearsal;
  }

  /** 실제 걸린 시간(초, 0.1 단위). 큐 id → 초 */
  measuredDurations(): Record<string, number> {
    return Object.fromEntries([...this.measured].map(([id, ms]) => [id, Math.round(ms / 100) / 10]));
  }

  tally(): Tally {
    const atem = this.opts.atem.status();
    const next = () => (this._service ? upcoming(this._service, this._state, this.now(), 1)[0]?.cue.camera ?? null : null);
    const one = (n: number | null) => (n === null ? [] : [n]);
    // 리허설: 스위처와 무관하게 큐 기준 (실제 송출은 카메라 탈리 램프)
    if (this.rehearsal) return { program: this._state.programCamera, preview: next(), onAir: one(this._state.programCamera), source: 'engine' };
    // 실제 탈리 신호가 있으면 PGM 은 그 값(디졸브 중엔 여러 대), PVW 는 스위처 보고값(없으면 다음 큐)
    if (this.tallyInput?.active()) {
      const onAir = this.tallyInput.onAir();
      const program = onAir[0] ?? null;
      const preview = atem.connected && atem.previewInput !== program ? atem.previewInput : next();
      return { program, preview: preview !== null && onAir.includes(preview) ? null : preview, onAir, source: 'gpi' };
    }
    if (atem.connected) {
      // GPI 접점 컷·이케가미 라우터는 스위처 상태를 읽어 오지 못한다 → 캠큐가 보낸 명령 기준 (패널 수동 컷 모름)
      const source = atem.mode === 'gpi' || atem.mode === 'ikegami' ? 'command' : 'atem';
      return { program: atem.programInput, preview: atem.previewInput, onAir: one(atem.programInput), source };
    }
    return { program: this._state.programCamera, preview: next(), onAir: one(this._state.programCamera), source: 'engine' };
  }

  snapshot(): ShowSnapshot {
    return {
      serviceId: this._service?.id ?? null,
      state: this._state,
      tally: this.tally(),
      atem: this.opts.atem.status(),
      timecode: { running: this.opts.timecode.running, source: this.opts.timecode.name },
      serverTime: this.now(),
      commandLog: [...this.commandLog],
      switcherCaps: this.opts.atem.capabilities?.() ?? FULL_CAPS,
      rehearsal: this.rehearsal,
    };
  }

  private apply(event: EngineEvent, silent = false) {
    if (!this._service) return;
    const prev = this._state;
    const { state, effects } = reduce(this._service, prev, event);
    if (state === prev && effects.length === 0) return;
    const now = this.now();
    // GO 로 다음 큐로 넘어갈 때 실제 걸린 시간 기록 (BACK·JUMP 는 중간에 끊긴 값이라 제외)
    if (event.type === 'GO' && !isStandby(prev)) {
      const cue = currentCue(this._service, prev);
      if (cue && prev.cueStartedAt != null) this.measured.set(cue.id, cueElapsedMs(prev, now));
    }
    this._state = state;
    this.runEffects(effects);
    if (state.lastTransition && state.lastTransition !== prev.lastTransition) {
      const cue = currentCue(this._service, state);
      if (cue) {
        this.emit('transition', {
          at: now,
          kind: state.lastTransition.kind,
          actTitle: currentAct(this._service, state)?.title ?? '',
          cueNumber: state.cueIndex + 1,
          camera: cue.camera,
          shotSize: cue.shotSize,
          note: cue.note,
          rehearsal: this.rehearsal,
          silent,
        });
      }
    }
    this.emitState();
  }

  private runEffects(effects: EngineEffect[]) {
    let switched = false;
    for (const e of effects) {
      if (e.type === 'TIMECODE_STOP') this.opts.timecode.stop();
      else if (e.type === 'TIMECODE_START') this.opts.timecode.start();
      else if (this.rehearsal) {
        // 리허설: 스위처에는 아무 것도 보내지 않음
        continue;
      } else {
        // AUTO 는 트랜지션 중 PVW 를 바꾸면 안 되므로 제외. macro·dsk 도 필요 시 컷하므로 컷과 같이 취급
        switched = e.action.kind !== 'auto';
        this.enqueueAtem(`CAM ${e.camera} ${e.action.kind.toUpperCase()}${this.cueLabel(e.cueId)}`, () =>
          executeAtemAction(this.opts.atem, e.camera, e.action),
        );
      }
    }
    if (switched && this.opts.autoPreview && this._service) {
      const next = upcoming(this._service, this._state, this.now(), 1)[0];
      if (next) this.enqueueAtem(`PVW 준비 CAM ${next.cue.camera}`, () => this.opts.atem.setPreview(next.cue.camera), true);
    }
  }

  /** " · 순서이름 #3" (기록 표시용) */
  private cueLabel(cueId: string): string {
    const acts = this._service?.acts ?? [];
    for (const act of acts) {
      const i = act.cues.findIndex((c) => c.id === cueId);
      if (i >= 0) return ` · ${act.title} #${i + 1}`;
    }
    return '';
  }

  private record(result: CommandLogEntry['result'], label: string, error: string | null) {
    const entry: CommandLogEntry = { id: ++this.commandSeq, at: this.now(), result, label, error };
    this.commandLog.push(entry);
    this.emit('command', entry);
    if (this.commandLog.length > COMMAND_LOG_LIMIT) this.commandLog.splice(0, this.commandLog.length - COMMAND_LOG_LIMIT);
    this.emitState();
  }

  /** ATEM 명령은 순서 보장을 위해 직렬 큐로 실행. 실패해도 쇼 진행은 계속된다 */
  /** quiet: 성공은 기록하지 않음 (PVW 준비 등 보조 명령) */
  private enqueueAtem(label: string, fn: () => Promise<void>, quiet = false) {
    this.atemQueue = this.atemQueue.then(async () => {
      const status = this.opts.atem.status();
      if (!status.connected) {
        if (status.mode !== 'disabled') {
          this.opts.log(`스위처 미연결 — 명령을 보내지 못함: ${label}`);
          this.record('skipped', label, '스위처 미연결');
        }
        return;
      }
      try {
        await fn();
        if (!quiet) this.record('ok', label, null);
      } catch (err) {
        this.opts.log(`ATEM 명령 실패: ${label}`, err);
        this.record('failed', label, (err as Error)?.message ?? String(err));
      }
    });
  }

  private emitState() {
    this.emit('state', this.snapshot());
  }
}
