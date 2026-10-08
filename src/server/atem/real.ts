// 실제 ATEM 스위처 어댑터 (atem-connection).
// atem-connection 은 connect() 이후 연결이 끊기면 스스로 재접속을 시도한다.
// 연결 실패/끊김은 예외로 앱을 멈추지 않고 status() 로만 노출한다.
import type { Atem } from 'atem-connection';
import type { AtemStatus } from '../../shared/protocol';
import type { AtemAdapter } from './types';

export interface RealAtemOptions {
  host: string;
  port?: number;
  /** 제어할 M/E 버스 (0부터). 기본 M/E 1 */
  mixEffect?: number;
}

export class RealAtemAdapter implements AtemAdapter {
  private atem: Atem | null = null;
  private connected = false;
  private lastError: string | null = null;
  private listeners = new Set<(s: AtemStatus) => void>();
  private readonly me: number;

  constructor(private readonly opts: RealAtemOptions) {
    this.me = opts.mixEffect ?? 0;
  }

  status(): AtemStatus {
    const me = this.connected ? this.atem?.state?.video.mixEffects[this.me] : undefined;
    return {
      mode: 'real',
      host: this.opts.port ? `${this.opts.host}:${this.opts.port}` : this.opts.host,
      connected: this.connected,
      model: (this.connected && this.atem?.state?.info.productIdentifier) || null,
      programInput: me?.programInput ?? null,
      previewInput: me?.previewInput ?? null,
      lastError: this.lastError,
    };
  }

  onStatus(listener: (s: AtemStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect() {
    if (this.atem) return;
    // 라이브러리는 필요할 때만 로드 (mock/disabled 모드에서는 워커 스레드를 띄우지 않음)
    const { Atem } = await import('atem-connection');
    const atem = new Atem();
    this.atem = atem;

    atem.on('connected', () => {
      this.connected = true;
      this.lastError = null;
      this.emit();
    });
    atem.on('disconnected', () => {
      this.connected = false;
      this.lastError = '연결 끊김 — 자동 재접속 시도 중';
      this.emit();
    });
    atem.on('error', (msg) => {
      this.lastError = String(msg);
      this.emit();
    });
    atem.on('stateChanged', (_state, paths) => {
      if (paths.some((p) => p.startsWith('video.mixEffects') || p.startsWith('info'))) this.emit();
    });

    try {
      await atem.connect(this.opts.host, this.opts.port);
    } catch (err) {
      this.lastError = `연결 실패: ${(err as Error).message}`;
      this.emit();
      throw err;
    }
  }

  async disconnect() {
    const atem = this.atem;
    this.atem = null;
    this.connected = false;
    this.emit();
    if (atem) await atem.destroy().catch(() => {});
  }

  async setPreview(input: number) {
    await this.ready().changePreviewInput(input, this.me);
  }

  async cut() {
    await this.ready().cut(this.me);
  }

  async autoTransition() {
    await this.ready().autoTransition(this.me);
  }

  async runMacro(index: number) {
    await this.ready().macroRun(index);
  }

  async setDownstreamKeyOnAir(keyer: number, onAir: boolean) {
    await this.ready().setDownstreamKeyOnAir(onAir, keyer);
  }

  private ready(): Atem {
    if (!this.atem || !this.connected) throw new Error('ATEM 미연결');
    return this.atem;
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }
}
