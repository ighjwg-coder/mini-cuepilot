// 타임코드 소스 인터페이스.
// MVP 는 내부 시뮬레이션 클락만 제공한다. 실제 LTC/MTC 수신기를 붙일 때는
// 같은 인터페이스를 구현해 index.ts 에서 교체하면 엔진/런타임 수정 없이 동작한다.

export interface TimecodeSource {
  readonly name: string;
  readonly running: boolean;
  /** Act 진입 시 호출 (TIMECODE_START effect). 시뮬레이션 클락은 0초부터 시작 */
  start(): void;
  /** Act 이탈 시 호출 (TIMECODE_STOP effect) */
  stop(): void;
  /** 타임코드(초) 수신 구독. 해제 함수 반환 */
  onTimecode(listener: (seconds: number) => void): () => void;
}

export class SimulatedTimecodeSource implements TimecodeSource {
  readonly name = 'simulated';
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private listeners = new Set<(seconds: number) => void>();

  constructor(
    private readonly intervalMs = 100,
    private readonly now: () => number = Date.now,
  ) {}

  get running() {
    return this.timer !== null;
  }

  start() {
    this.stop();
    this.startedAt = this.now();
    this.emit();
    this.timer = setInterval(() => this.emit(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onTimecode(listener: (seconds: number) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    const seconds = (this.now() - this.startedAt) / 1000;
    for (const l of this.listeners) l(seconds);
  }
}

/** 테스트/외부 연동용: 타임코드를 직접 밀어 넣는 소스 */
export class ManualTimecodeSource implements TimecodeSource {
  readonly name = 'manual';
  running = false;
  private listeners = new Set<(seconds: number) => void>();

  start() {
    this.running = true;
  }
  stop() {
    this.running = false;
  }
  onTimecode(listener: (seconds: number) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  push(seconds: number) {
    if (!this.running) return;
    for (const l of this.listeners) l(seconds);
  }
}
