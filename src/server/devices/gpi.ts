// GPI 입력/출력 모듈.
//  - 입력: 스위처·라우터의 탈리 접점(GPI OUT)을 읽어 실제 송출 카메라 판단
//  - 출력: 스위처·라우터의 GPI IN 에 접점 펄스를 줘서 컷 실행 (SWITCHER=gpi)
// 실제 모듈은 Modbus TCP, mock 은 장비 연결 화면에서 입력을 직접 켜고 끄는 가상 모듈.
import type { GpiStatus } from '../../shared/devices';
import { ModbusTcpClient } from './modbus';

export interface GpiModule {
  status(): GpiStatus;
  /** 입력 상태·연결 상태가 바뀔 때 */
  onChange(listener: () => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** 출력 채널(1부터)을 ms 동안 켰다 끔 */
  pulse(channel: number, ms: number): Promise<void>;
}

abstract class BaseGpi implements GpiModule {
  protected listeners = new Set<() => void>();
  abstract status(): GpiStatus;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract pulse(channel: number, ms: number): Promise<void>;
  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected emit() {
    for (const l of this.listeners) l();
  }
}

export class DisabledGpi extends BaseGpi {
  status(): GpiStatus {
    return { mode: 'disabled', host: null, connected: false, lastError: null, inputs: null };
  }
  async connect() {}
  async disconnect() {}
  async pulse() {
    throw new Error('GPI 모듈 미사용 (GPI_HOST 비어 있음)');
  }
}

/** 가상 모듈: 입력 16채널. 장비 연결 화면이나 테스트에서 setInput 으로 조작 */
export class MockGpi extends BaseGpi {
  readonly inputs: boolean[];
  readonly pulses: Array<{ channel: number; ms: number }> = [];
  private connected = false;

  constructor(channels = 16) {
    super();
    this.inputs = Array.from({ length: channels }, () => false);
  }

  status(): GpiStatus {
    return { mode: 'mock', host: 'mock', connected: this.connected, lastError: null, inputs: this.connected ? [...this.inputs] : null };
  }
  async connect() {
    this.connected = true;
    this.emit();
  }
  async disconnect() {
    this.connected = false;
    this.emit();
  }
  setInput(channel: number, on: boolean) {
    if (channel < 1 || channel > this.inputs.length) throw new Error(`가상 GPI: 입력 ${channel} 없음`);
    this.inputs[channel - 1] = on;
    this.emit();
  }
  async pulse(channel: number, ms: number) {
    if (!this.connected) throw new Error('가상 GPI: 연결되지 않음');
    this.pulses.push({ channel, ms });
  }
}

export interface ModbusGpiOptions {
  host: string;
  port?: number;
  unitId: number;
  /** 입력 읽기 함수 코드 (2 = Discrete Inputs, 1 = Coils) */
  diFunction: 1 | 2;
  diAddress: number;
  /** 읽을 입력 채널 수 */
  diCount: number;
  doAddress: number;
  pollMs: number;
  /** 연결 실패 시 재시도 간격 */
  retryMs?: number;
}

export class ModbusGpi extends BaseGpi {
  private readonly client: ModbusTcpClient;
  private inputs: boolean[] | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: ModbusGpiOptions) {
    super();
    this.client = new ModbusTcpClient({ host: opts.host, port: opts.port, unitId: opts.unitId, timeoutMs: 1500 });
  }

  status(): GpiStatus {
    return {
      mode: 'real',
      host: this.opts.port ? `${this.opts.host}:${this.opts.port}` : this.opts.host,
      connected: this.client.connected && this.inputs !== null,
      lastError: this.lastError,
      inputs: this.inputs ? [...this.inputs] : null,
    };
  }

  /** 백그라운드 폴링 시작. 연결 실패는 status 로만 노출하고 계속 재시도 */
  async connect() {
    if (this.running) return;
    this.running = true;
    await this.loop();
  }

  async disconnect() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.client.close();
    this.inputs = null;
    this.emit();
  }

  async pulse(channel: number, ms: number) {
    if (!this.client.connected) throw new Error('GPI 모듈 미연결');
    const addr = this.opts.doAddress + channel - 1;
    await this.client.writeCoil(addr, true);
    await new Promise((r) => setTimeout(r, ms));
    await this.client.writeCoil(addr, false);
  }

  private async loop() {
    if (!this.running) return;
    let delay = this.opts.pollMs;
    try {
      await this.client.connect();
      const bits = await this.client.readBits(this.opts.diFunction, this.opts.diAddress, this.opts.diCount);
      const changed = !this.inputs || this.lastError !== null || bits.some((b, i) => b !== this.inputs![i]);
      this.inputs = bits;
      this.lastError = null;
      if (changed) this.emit();
    } catch (err) {
      const msg = (err as Error).message;
      const changed = this.inputs !== null || this.lastError !== msg;
      this.inputs = null;
      this.lastError = msg;
      delay = this.opts.retryMs ?? 2000;
      if (changed) this.emit();
    }
    if (this.running) this.timer = setTimeout(() => void this.loop(), delay);
  }
}

/**
 * 입력 채널 상태 → ON AIR 카메라 전부 (작은 번호부터).
 * tallyInputs[i] = CAM(i+1) 의 입력 채널(1부터, 0 = 없음). 디졸브·키로 여러 대가 동시에 켜질 수 있다.
 */
export function onAirFromInputs(inputs: boolean[] | null, tallyInputs: number[], invert: boolean): number[] {
  if (!inputs) return [];
  const cams: number[] = [];
  for (let cam = 1; cam <= tallyInputs.length; cam++) {
    const ch = tallyInputs[cam - 1];
    if (!ch || ch > inputs.length) continue;
    if (inputs[ch - 1] !== invert) cams.push(cam);
  }
  return cams;
}

/** 입력 채널 상태 → 대표 ON AIR 카메라 (여러 대면 가장 작은 번호) */
export function programFromInputs(inputs: boolean[] | null, tallyInputs: number[], invert: boolean): number | null {
  return onAirFromInputs(inputs, tallyInputs, invert)[0] ?? null;
}
