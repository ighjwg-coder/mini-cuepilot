// 실제 ATEM 스위처 어댑터 (atem-connection).
// atem-connection 은 connect() 이후 연결이 끊기면 스스로 재접속을 시도한다.
// 연결 실패/끊김은 예외로 앱을 멈추지 않고 status() 로만 노출한다.
import type { Atem } from 'atem-connection';
import type { TallyBySourceProps } from 'atem-connection/dist/commands/TallyBySourceCommand';
import type { AtemStatus } from '../../shared/protocol';
import type { AtemAdapter } from './types';

/** ATEM 소스별 탈리(TlSr)에서 PGM 에 나가는 입력 번호 (디졸브 중이면 두 입력 모두) */
export function programSources(props: TallyBySourceProps): number[] {
  return Object.entries(props)
    .filter(([, t]) => t?.program)
    .map(([src]) => Number(src))
    .sort((a, b) => a - b);
}

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
  /** 스위처가 보내 준 소스별 탈리 (아직 못 받았으면 null) */
  private onAir: number[] | null = null;

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
      ...(this.connected && this.onAir ? { onAirInputs: this.onAir } : {}),
    };
  }

  onStatus(listener: (s: AtemStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect() {
    if (this.atem) return;
    // 라이브러리는 필요할 때만 로드 (mock/disabled 모드에서는 워커 스레드를 띄우지 않음)
    const { Atem, Commands } = await import('atem-connection');
    const atem = new Atem();
    this.atem = atem;

    atem.on('connected', () => {
      this.connected = true;
      this.lastError = null;
      this.emit();
    });
    atem.on('disconnected', () => {
      this.connected = false;
      this.onAir = null;
      this.lastError = '연결 끊김 — 자동 재접속 시도 중';
      this.emit();
    });
    atem.on('error', (msg) => {
      this.lastError = String(msg);
      this.emit();
    });
    // 소스별 탈리: 디졸브·키·PIP 로 여러 입력이 동시에 나가는 것까지 스위처 기준으로 받는다
    atem.on('receivedCommands', (cmds) => {
      const tally = cmds.find((c): c is InstanceType<typeof Commands.TallyBySourceCommand> => c instanceof Commands.TallyBySourceCommand);
      if (!tally) return;
      this.onAir = programSources(tally.properties);
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
    this.onAir = null;
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
