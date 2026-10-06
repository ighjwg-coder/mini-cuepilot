// 가상 ATEM 스위처 — 실제 장비 없이 모든 로직을 검증하기 위한 mock 어댑터.
// PGM/PVW/DSK/매크로 상태를 메모리에 시뮬레이션하고, 호출 기록(log)을 남긴다.
import type { AtemStatus } from '../../shared/protocol';
import type { AtemAdapter } from './types';

export interface MockAtemOptions {
  /** AUTO 트랜지션 시간(ms). 0 이면 즉시 */
  transitionMs?: number;
  /** 각 명령 응답 지연(ms) — 네트워크 지연 흉내 */
  latencyMs?: number;
  /** connect() 시 연결 실패 흉내 */
  failConnect?: boolean;
  /** 입력 개수 (이 범위 밖 입력은 에러) */
  inputs?: number;
}

export type MockAtemCall =
  | { op: 'setPreview'; input: number }
  | { op: 'cut' }
  | { op: 'auto' }
  | { op: 'macro'; index: number }
  | { op: 'dsk'; keyer: number; onAir: boolean };

export class MockAtemAdapter implements AtemAdapter {
  readonly log: MockAtemCall[] = [];
  readonly dskOnAir: boolean[] = [false, false, false, false];
  private programInput = 1;
  private previewInput = 2;
  private connected = false;
  private lastError: string | null = null;
  private failNextCommand: string | null = null;
  private listeners = new Set<(s: AtemStatus) => void>();
  private transitionTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: MockAtemOptions = {}) {}

  status(): AtemStatus {
    return {
      mode: 'mock',
      host: 'mock',
      connected: this.connected,
      model: this.connected ? 'Mock ATEM (가상 장비)' : null,
      programInput: this.connected ? this.programInput : null,
      previewInput: this.connected ? this.previewInput : null,
      lastError: this.lastError,
    };
  }

  onStatus(listener: (s: AtemStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect() {
    await this.delay();
    if (this.opts.failConnect) {
      this.lastError = 'mock: 연결 실패 (failConnect)';
      this.emit();
      throw new Error(this.lastError);
    }
    this.connected = true;
    this.lastError = null;
    this.emit();
  }

  async disconnect() {
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.connected = false;
    this.emit();
  }

  // ── 테스트 제어 ──
  /** 케이블이 빠진 상황 흉내 */
  simulateDisconnect(reason = 'mock: 연결 끊김') {
    this.connected = false;
    this.lastError = reason;
    this.emit();
  }
  /** 다음 명령 하나를 실패시킴 */
  failNext(message = 'mock: 명령 실패') {
    this.failNextCommand = message;
  }
  /** 외부(하드웨어 패널)에서 PGM 을 바꾼 상황 흉내 */
  simulatePanelCut(input: number) {
    this.programInput = input;
    this.emit();
  }

  // ── 명령 ──
  async setPreview(input: number) {
    await this.command();
    this.assertInput(input);
    this.log.push({ op: 'setPreview', input });
    this.previewInput = input;
    this.emit();
  }

  async cut() {
    await this.command();
    this.log.push({ op: 'cut' });
    this.swap();
  }

  async autoTransition() {
    await this.command();
    this.log.push({ op: 'auto' });
    const ms = this.opts.transitionMs ?? 0;
    if (ms <= 0) return this.swap();
    if (this.transitionTimer) clearTimeout(this.transitionTimer);
    this.transitionTimer = setTimeout(() => this.swap(), ms);
  }

  async runMacro(index: number) {
    await this.command();
    if (index < 0 || index > 99) throw new Error(`mock: 매크로 인덱스 범위 밖 (${index})`);
    this.log.push({ op: 'macro', index });
  }

  async setDownstreamKeyOnAir(keyer: number, onAir: boolean) {
    await this.command();
    if (keyer < 0 || keyer >= this.dskOnAir.length) throw new Error(`mock: DSK ${keyer} 없음`);
    this.log.push({ op: 'dsk', keyer, onAir });
    this.dskOnAir[keyer] = onAir;
    this.emit();
  }

  private swap() {
    this.transitionTimer = null;
    [this.programInput, this.previewInput] = [this.previewInput, this.programInput];
    this.emit();
  }

  private assertInput(input: number) {
    const max = this.opts.inputs ?? 20;
    if (!Number.isInteger(input) || input < 1 || input > max) throw new Error(`mock: 입력 ${input} 없음`);
  }

  private async command() {
    await this.delay();
    if (!this.connected) throw new Error('mock: 연결되지 않음');
    if (this.failNextCommand) {
      const msg = this.failNextCommand;
      this.failNextCommand = null;
      this.lastError = msg;
      this.emit();
      throw new Error(msg);
    }
  }

  private delay() {
    const ms = this.opts.latencyMs ?? 0;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }
}
