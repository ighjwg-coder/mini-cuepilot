// 장비 연결 관리: 설정 → 스위처 어댑터 + GPI 모듈 + 탈리 입력 구성.
// 장비 연결 화면에서 설정을 저장하면 프로그램을 다시 시작하지 않고 바로 다시 연결한다.
import type { DeviceSettings, DevicesSnapshot, SerialLogEntry } from '../../shared/devices';
import type { Tally } from '../../shared/protocol';
import { DisabledAtemAdapter, MockAtemAdapter, RealAtemAdapter, type AtemAdapter } from '../atem';
import { readDeviceSettings, resolveDevices, updateConfigFile, type ResolvedDevices } from './config';
import { DisabledGpi, MockGpi, ModbusGpi, onAirFromInputs, type GpiModule } from './gpi';
import { GpiSwitcherAdapter } from './gpiSwitcher';
import { IkegamiRouterAdapter, parseHex } from './ikegami';
import { MockSerialLink, NodeSerialLink, type Parity, type SerialLink } from './serial';
import { SwitchableAdapter } from './switchable';

/** 실제 탈리 신호 (GPI 입력) — ShowRuntime 이 스위처 보고값보다 우선해서 쓴다 */
export interface TallyInput {
  /** 지금 이 입력을 탈리 기준으로 써야 하는가 (설정 + 연결 상태) */
  active(): boolean;
  /** 탈리가 켜진 카메라 전부 (작은 번호부터) */
  onAir(): number[];
  onChange(listener: () => void): () => void;
}

export interface DeviceManagerOptions {
  env?: NodeJS.ProcessEnv;
  /** 설정 저장 파일. null 이면 저장하지 않음 (테스트) */
  configPath: string | null;
  serialFactory?: (path: string, opts: { baudRate: number; parity: Parity }) => SerialLink;
  gpiFactory?: (cfg: Exclude<ResolvedDevices['gpi'], { kind: 'none' }>, diCount: number) => GpiModule;
  atemFactory?: (cfg: Extract<ResolvedDevices['switcher'], { kind: 'atem' }>) => AtemAdapter;
  log?: (msg: string, err?: unknown) => void;
}

const LOG_LIMIT = 300;

export class DeviceManager {
  readonly switcher: SwitchableAdapter;
  readonly tallyInput: TallyInput;
  private gpi: GpiModule = new DisabledGpi();
  private settings: DeviceSettings;
  private resolved: ResolvedDevices;
  private serialLog: SerialLogEntry[] = [];
  private logSeq = 0;
  private gpiUnsub: () => void = () => {};
  private tallyListeners = new Set<() => void>();
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly opts: DeviceManagerOptions) {
    this.env = opts.env ?? process.env;
    this.settings = readDeviceSettings(this.env);
    this.resolved = resolveDevices(this.settings);
    this.switcher = new SwitchableAdapter(new DisabledAtemAdapter());
    const self = this;
    this.tallyInput = {
      active: () => self.resolved.tally.source === 'gpi' && self.gpi.status().connected,
      onAir: () => onAirFromInputs(self.gpi.status().inputs, self.resolved.tally.inputs, self.resolved.tally.invert),
      onChange: (l) => {
        self.tallyListeners.add(l);
        return () => self.tallyListeners.delete(l);
      },
    };
  }

  get config() {
    return this.resolved;
  }

  /** 현재 GPI 모듈 (테스트·가상 모듈 조작용) */
  get gpiModule() {
    return this.gpi;
  }

  /** 설정대로 장비 구성 후 연결 시작. 연결 실패는 상태로만 보고하고 예외를 던지지 않는다 */
  async start() {
    await this.build();
  }

  async stop() {
    this.gpiUnsub();
    await this.switcher.disconnect().catch(() => {});
    await this.gpi.disconnect().catch(() => {});
  }

  /** 설정 변경: 파일 저장 → 환경변수 반영 → 장비 다시 연결 */
  async apply(updates: Partial<DeviceSettings>) {
    const next = { ...this.settings };
    for (const [k, v] of Object.entries(updates)) {
      if (!(k in next)) throw new Error(`알 수 없는 설정: ${k}`);
      if (typeof v !== 'string') throw new Error(`${k}: 문자열이어야 합니다`);
      if (/[\r\n]/.test(v)) throw new Error(`${k}: 줄바꿈은 넣을 수 없습니다`);
      next[k as keyof DeviceSettings] = v.trim();
    }
    const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => this.settings[k as keyof DeviceSettings] !== v));
    if (this.opts.configPath && Object.keys(changed).length) updateConfigFile(this.opts.configPath, changed);
    for (const [k, v] of Object.entries(next)) this.env[k] = v;
    this.settings = next;
    this.resolved = resolveDevices(next);
    await this.build();
  }

  snapshot(tally: Tally): DevicesSnapshot {
    return {
      settings: { ...this.settings },
      configPath: this.opts.configPath,
      errors: [...this.resolved.errors],
      switcher: this.switcher.status(),
      gpi: this.gpi.status(),
      tally,
    };
  }

  logAfter(afterId: number): SerialLogEntry[] {
    return this.serialLog.filter((e) => e.id > afterId);
  }

  /** RS-422 로 임의 바이트 전송 (16진수 문자열) */
  async sendSerial(hex: string) {
    const inner = this.switcher.current;
    if (!(inner instanceof IkegamiRouterAdapter)) throw new Error('SWITCHER=ikegami 일 때만 보낼 수 있습니다');
    if (!inner.status().connected) throw new Error('포트가 열려 있지 않습니다');
    await inner.sendRaw(parseHex(hex));
  }

  /** 시험 컷: 지정 카메라를 바로 PGM 으로 (스위처 종류와 무관) */
  async testTake(camera: number) {
    const inner = this.switcher.current;
    if (!inner.status().connected) throw new Error('스위처가 연결되어 있지 않습니다');
    if (inner instanceof IkegamiRouterAdapter || inner instanceof GpiSwitcherAdapter) return inner.take(camera);
    await inner.setPreview(camera);
    await inner.cut();
  }

  async pulse(channel: number) {
    await this.gpi.pulse(channel, Number(this.settings.GPI_PULSE_MS) || 200);
  }

  setMockInput(channel: number, on: boolean) {
    if (!(this.gpi instanceof MockGpi)) throw new Error('가상 GPI 모듈(GPI_HOST=mock)일 때만 조작할 수 있습니다');
    this.gpi.setInput(channel, on);
  }

  private async build() {
    const cfg = this.resolved;

    // 1) GPI 모듈 (스위처가 GPI 를 쓸 수 있으므로 먼저)
    this.gpiUnsub();
    await this.gpi.disconnect().catch(() => {});
    const diCount = Math.max(8, ...cfg.tally.inputs);
    this.gpi = cfg.gpi.kind === 'none' ? new DisabledGpi() : (this.opts.gpiFactory ?? defaultGpi)(cfg.gpi, diCount);
    this.gpiUnsub = this.gpi.onChange(() => this.tallyListeners.forEach((l) => l()));
    this.gpi.connect().catch((err) => this.opts.log?.('GPI 모듈 연결 실패', err));

    // 2) 스위처
    const sw = cfg.switcher;
    let adapter: AtemAdapter;
    switch (sw.kind) {
      case 'none':
        adapter = new DisabledAtemAdapter();
        break;
      case 'atem':
        adapter = (this.opts.atemFactory ?? defaultAtem)(sw);
        break;
      case 'ikegami': {
        const link = sw.port.toLowerCase() === 'mock' ? new MockSerialLink() : (this.opts.serialFactory ?? defaultSerial)(sw.port, sw);
        adapter = new IkegamiRouterAdapter({ link, ...sw, log: (dir, text) => this.pushLog(dir, text) });
        if (link instanceof MockSerialLink) this.pushLog('info', '가상 포트(mock): 보낸 바이트만 기록하고 응답은 없습니다');
        break;
      }
      case 'gpi':
        adapter = new GpiSwitcherAdapter({ gpi: this.gpi, cutOutputs: sw.cutOutputs, pulseMs: sw.pulseMs });
        break;
    }
    await this.switcher.replace(adapter);
    this.switcher.connect().catch((err) => this.opts.log?.('스위처 연결 실패 — 장비 없이 계속 진행합니다', err));
    this.tallyListeners.forEach((l) => l());
  }

  private pushLog(dir: SerialLogEntry['dir'], text: string) {
    this.serialLog.push({ id: ++this.logSeq, at: Date.now(), dir, text });
    if (this.serialLog.length > LOG_LIMIT) this.serialLog.splice(0, this.serialLog.length - LOG_LIMIT);
  }
}

function defaultSerial(path: string, opts: { baudRate: number; parity: Parity }): SerialLink {
  return new NodeSerialLink(path, opts);
}

function defaultGpi(cfg: Exclude<ResolvedDevices['gpi'], { kind: 'none' }>, diCount: number): GpiModule {
  if (cfg.kind === 'mock') return new MockGpi(Math.max(16, diCount));
  return new ModbusGpi({ ...cfg, diCount });
}

function defaultAtem(cfg: Extract<ResolvedDevices['switcher'], { kind: 'atem' }>): AtemAdapter {
  switch (cfg.atem.kind) {
    case 'disabled':
      return new DisabledAtemAdapter();
    case 'mock':
      return new MockAtemAdapter({ transitionMs: 1000, latencyMs: 5 });
    case 'real':
      return new RealAtemAdapter({ host: cfg.atem.host, port: cfg.atem.port, mixEffect: cfg.me - 1 });
  }
}
