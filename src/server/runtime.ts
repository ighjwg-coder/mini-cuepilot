// ShowRuntime: 엔진(순수 함수)을 실제 시간·ATEM·타임코드 소스에 연결하는 상태 보관자.
import { EventEmitter } from 'node:events';
import {
  currentAct,
  initialState,
  reconcile,
  reduce,
  upcoming,
  type EngineEffect,
  type EngineEvent,
  type EngineState,
} from '../shared/engine';
import type { ShowCommand, ShowSnapshot, Tally } from '../shared/protocol';
import type { Service } from '../shared/types';
import { executeAtemAction, type AtemAdapter } from './atem/types';
import type { TimecodeSource } from './timecode';

export interface RuntimeOptions {
  atem: AtemAdapter;
  timecode: TimecodeSource;
  now?: () => number;
  /** SECTION 자동 진행 판정 주기(ms) */
  tickMs?: number;
  /**
   * CUT 후 다음 큐 카메라를 PVW 에 미리 올림.
   * AUTO 는 트랜지션 진행 중 PVW 를 바꾸면 전환 대상이 바뀔 수 있어 제외한다.
   */
  autoPreview?: boolean;
  log?: (msg: string, err?: unknown) => void;
}

interface RuntimeEvents {
  state: [ShowSnapshot];
  service: [Service | null];
}

export class ShowRuntime extends EventEmitter<RuntimeEvents> {
  private _service: Service | null = null;
  private _state: EngineState = initialState();
  private timer: NodeJS.Timeout | null = null;
  private atemQueue: Promise<void> = Promise.resolve();
  private readonly unsubs: Array<() => void> = [];
  private readonly now: () => number;
  private readonly opts: Required<Omit<RuntimeOptions, 'now'>>;

  constructor(options: RuntimeOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.opts = {
      tickMs: 20,
      autoPreview: true,
      log: (msg, err) => console.error(`[runtime] ${msg}`, err ?? ''),
      ...options,
    };
    this.unsubs.push(
      this.opts.timecode.onTimecode((seconds) => this.apply({ type: 'TIMECODE', now: this.now(), seconds })),
      this.opts.atem.onStatus(() => this.emitState()),
    );
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

  /** 라이브 대상 행사 교체 → STANDBY 로 초기화 */
  load(service: Service | null) {
    this.opts.timecode.stop();
    this._service = service;
    this._state = initialState();
    this.emit('service', service);
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
    switch (cmd.command) {
      case 'GO':
        return this.apply({ type: 'GO', now });
      case 'BACK':
        return this.apply({ type: 'BACK', now });
      case 'HOLD':
        return this.apply({ type: 'HOLD', now, on: cmd.on });
      case 'RESET':
        return this.apply({ type: 'RESET' });
      case 'JUMP':
        return this.apply({ type: 'JUMP', now, actIndex: cmd.actIndex, cueIndex: cmd.cueIndex });
    }
  }

  /** 대기 중인 ATEM 명령이 모두 끝날 때까지 (테스트용) */
  idle(): Promise<void> {
    return this.atemQueue;
  }

  tally(): Tally {
    const atem = this.opts.atem.status();
    if (atem.connected) return { program: atem.programInput, preview: atem.previewInput, source: 'atem' };
    const next = this._service ? upcoming(this._service, this._state, this.now(), 1)[0] : undefined;
    return { program: this._state.programCamera, preview: next?.cue.camera ?? null, source: 'engine' };
  }

  snapshot(): ShowSnapshot {
    return {
      serviceId: this._service?.id ?? null,
      state: this._state,
      tally: this.tally(),
      atem: this.opts.atem.status(),
      timecode: { running: this.opts.timecode.running, source: this.opts.timecode.name },
      serverTime: this.now(),
    };
  }

  private apply(event: EngineEvent) {
    if (!this._service) return;
    const { state, effects } = reduce(this._service, this._state, event);
    if (state === this._state && effects.length === 0) return;
    this._state = state;
    this.runEffects(effects);
    this.emitState();
  }

  private runEffects(effects: EngineEffect[]) {
    let switched = false;
    for (const e of effects) {
      if (e.type === 'TIMECODE_STOP') this.opts.timecode.stop();
      else if (e.type === 'TIMECODE_START') this.opts.timecode.start();
      else {
        switched = e.action.kind === 'cut' ? true : e.action.kind === 'auto' ? false : switched;
        this.enqueueAtem(`큐 ${e.cueId} (${e.action.kind}, CAM ${e.camera})`, () =>
          executeAtemAction(this.opts.atem, e.camera, e.action),
        );
      }
    }
    if (switched && this.opts.autoPreview && this._service) {
      const next = upcoming(this._service, this._state, this.now(), 1)[0];
      if (next) this.enqueueAtem(`PVW 준비 CAM ${next.cue.camera}`, () => this.opts.atem.setPreview(next.cue.camera));
    }
  }

  /** ATEM 명령은 순서 보장을 위해 직렬 큐로 실행. 실패해도 쇼 진행은 계속된다 */
  private enqueueAtem(label: string, fn: () => Promise<void>) {
    this.atemQueue = this.atemQueue.then(async () => {
      if (!this.opts.atem.status().connected) return;
      try {
        await fn();
      } catch (err) {
        this.opts.log(`ATEM 명령 실패: ${label}`, err);
      }
    });
  }

  private emitState() {
    this.emit('state', this.snapshot());
  }
}
