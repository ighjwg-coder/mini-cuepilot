// GPI 접점으로 컷하는 스위처 어댑터 (SWITCHER=gpi).
// 스위처·라우터의 GPI IN 에 "입력 N → PGM" 동작을 지정해 두고, 카메라별 출력 채널에 펄스를 준다.
// 접점은 "눌렀다"는 신호만 보내므로 PVW·트랜지션 종류는 장비 쪽 설정을 따른다.
import type { AtemStatus } from '../../shared/protocol';
import type { AtemAdapter } from '../atem/types';
import type { GpiModule } from './gpi';

export interface GpiSwitcherOptions {
  gpi: GpiModule;
  /** cutOutputs[i] = CAM(i+1) 컷용 출력 채널(1부터, 0 = 없음) */
  cutOutputs: number[];
  pulseMs: number;
}

export class GpiSwitcherAdapter implements AtemAdapter {
  private program: number | null = null;
  private preview: number | null = null;
  private lastError: string | null = null;
  private listeners = new Set<(s: AtemStatus) => void>();
  private readonly unsub: () => void;

  constructor(private readonly opts: GpiSwitcherOptions) {
    this.unsub = opts.gpi.onChange(() => this.emit());
  }

  status(): AtemStatus {
    const g = this.opts.gpi.status();
    return {
      mode: 'gpi',
      host: g.host,
      connected: g.connected,
      model: g.connected ? 'GPI 접점 컷' : null,
      programInput: g.connected ? this.program : null,
      previewInput: g.connected ? this.preview : null,
      lastError: this.lastError ?? g.lastError,
    };
  }

  onStatus(listener: (s: AtemStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** GPI 모듈 연결은 DeviceManager 가 관리 */
  async connect() {}
  async disconnect() {
    this.unsub();
  }

  async setPreview(camera: number) {
    this.preview = camera;
    this.emit();
  }

  async cut() {
    if (this.preview === null) throw new Error('전환할 카메라가 지정되지 않음');
    await this.take(this.preview);
  }

  async autoTransition() {
    await this.cut();
  }

  async runMacro() {
    throw new Error('GPI 컷 모드에서는 매크로를 지원하지 않습니다');
  }

  async setDownstreamKeyOnAir() {
    throw new Error('GPI 컷 모드에서는 DSK 를 지원하지 않습니다');
  }

  async take(camera: number) {
    const ch = this.opts.cutOutputs[camera - 1];
    if (!ch) throw new Error(`CAM ${camera} 의 GPI 출력 채널이 설정되지 않았습니다 (GPI_CUT_OUTPUTS)`);
    try {
      await this.opts.gpi.pulse(ch, this.opts.pulseMs);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.emit();
      throw err;
    }
    const prev = this.program;
    this.program = camera;
    if (this.preview === camera) this.preview = prev;
    this.lastError = null;
    this.emit();
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }
}
