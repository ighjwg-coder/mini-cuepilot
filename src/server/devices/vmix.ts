// vMix TCP API (기본 포트 8099) 제어·탈리.
//
// vMix 매뉴얼 "TCP API" 기준:
//   연결하면 "VERSION OK x.x" 한 줄을 보내 온다.
//   "FUNCTION 이름 인자" → "FUNCTION OK …" / "FUNCTION ER …"
//   "SUBSCRIBE TALLY" 후 바뀔 때마다 "TALLY OK 0121…" (입력 1번부터 한 글자씩, 0 = 꺼짐 / 1 = PGM / 2 = PVW)
//   "XML 길이" 응답은 뒤에 그 길이만큼 본문이 붙는다 (여기서는 요청하지 않지만 받으면 건너뜀)
//
// 입력 번호는 vMix 화면의 입력 순서 번호다. vMix 에서 입력 순서를 바꾸면 VMIX_CAM_INPUTS 도 맞춰야 한다.
// 컷 = PreviewInput 후 Cut, AUTO = PreviewInput 후 Transition1 (vMix 에 설정된 1번 트랜지션 종류·길이).
import { Socket } from 'node:net';
import type { AtemStatus, SwitcherCaps } from '../../shared/protocol';
import { camerasFrom, type AtemAdapter } from '../atem/types';

export const VMIX_DEFAULT_PORT = 8099;

export interface VmixOptions {
  host: string;
  port?: number;
  /** camInputs[i] = CAM(i+1) 이 들어간 vMix 입력 번호 (0 = 없음) */
  camInputs: number[];
  retryMs?: number;
  /** FUNCTION 응답 대기 시간 */
  timeoutMs?: number;
}

/** "TALLY OK 0121" 의 숫자 부분 → PGM/PVW 입력 번호 (1부터) */
export function parseVmixTally(digits: string): { program: number[]; preview: number[] } {
  const program: number[] = [];
  const preview: number[] = [];
  [...digits].forEach((c, i) => {
    if (c === '1') program.push(i + 1);
    else if (c === '2') preview.push(i + 1);
  });
  return { program, preview };
}

export class VmixAdapter implements AtemAdapter {
  private socket: Socket | null = null;
  private connected = false;
  private version: string | null = null;
  private lastError: string | null = null;
  private programInputs: number[] = [];
  private previewInputs: number[] = [];
  private buf = Buffer.alloc(0);
  private skipBytes = 0;
  private pending: Array<{ resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private listeners = new Set<(s: AtemStatus) => void>();
  private retry: NodeJS.Timeout | null = null;
  private wanted = false;

  constructor(private readonly opts: VmixOptions) {}

  private get port() {
    return this.opts.port ?? VMIX_DEFAULT_PORT;
  }

  /** vMix 입력 번호 → 카메라 번호 (카메라가 아니면 null) */
  private camOf(input: number): number | null {
    const i = this.opts.camInputs.indexOf(input);
    return input > 0 && i >= 0 ? i + 1 : null;
  }

  status(): AtemStatus {
    const cams = this.programInputs.map((n) => this.camOf(n)).filter((n): n is number => n !== null);
    const pvw = this.previewInputs.map((n) => this.camOf(n)).find((n) => n !== null) ?? null;
    return {
      mode: 'vmix',
      host: `${this.opts.host}:${this.port}`,
      connected: this.connected,
      model: this.connected ? `vMix${this.version ? ` ${this.version}` : ''}` : null,
      programInput: this.connected ? (cams[0] ?? null) : null,
      previewInput: this.connected ? pvw : null,
      lastError: this.lastError,
      onAirInputs: this.connected ? [...new Set(cams)].sort((a, b) => a - b) : undefined,
    };
  }

  onStatus(listener: (s: AtemStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capabilities(): SwitcherCaps {
    return { cameras: camerasFrom(this.opts.camInputs), transition: true, macro: false, dsk: false };
  }

  connect(): Promise<void> {
    this.wanted = true;
    return this.open();
  }

  async disconnect() {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.destroy();
    this.socket = null;
    this.drop(new Error('연결 종료'));
    this.emit();
  }

  async setPreview(camera: number) {
    await this.fn(`PreviewInput Input=${this.input(camera)}`);
  }

  async cut() {
    await this.fn('Cut');
  }

  async autoTransition() {
    await this.fn('Transition1');
  }

  async runMacro() {
    throw new Error('vMix 모드에서는 매크로를 지원하지 않습니다');
  }

  async setDownstreamKeyOnAir() {
    throw new Error('vMix 모드에서는 DSK 를 지원하지 않습니다');
  }

  private input(camera: number) {
    const n = this.opts.camInputs[camera - 1];
    if (!n) throw new Error(`CAM ${camera} 의 vMix 입력 번호가 설정되지 않았습니다 (VMIX_CAM_INPUTS)`);
    return n;
  }

  private fn(command: string): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.connected) return Promise.reject(new Error('vMix 에 연결되어 있지 않습니다'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`vMix 응답 없음: ${command}`));
      }, this.opts.timeoutMs ?? 3000);
      this.pending.push({ resolve, reject, timer });
      socket.write(`FUNCTION ${command}\r\n`);
    });
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      this.buf = Buffer.alloc(0);
      this.skipBytes = 0;
      let settled = false;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 5000);
      socket.on('data', (d: Buffer) => this.onData(d));
      socket.once('connect', () => {
        this.connected = true;
        this.lastError = null;
        socket.write('SUBSCRIBE TALLY\r\nTALLY\r\n');
        this.emit();
        settled = true;
        resolve();
      });
      socket.on('error', (err) => {
        this.lastError = `vMix 연결 실패 (${this.opts.host}:${this.port}): ${err.message}`;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        const was = this.connected;
        this.connected = false;
        this.drop(new Error('vMix 연결 끊김'));
        if (was && this.wanted) this.lastError = 'vMix 연결 끊김 — 재시도 중';
        this.emit();
        this.scheduleRetry();
      });
      socket.connect(this.port, this.opts.host);
    });
  }

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.skipBytes > 0) {
        const n = Math.min(this.skipBytes, this.buf.length);
        this.buf = this.buf.subarray(n);
        this.skipBytes -= n;
        if (this.skipBytes > 0) return;
      }
      const end = this.buf.indexOf('\r\n');
      if (end < 0) return;
      const line = this.buf.subarray(0, end).toString('utf8');
      this.buf = this.buf.subarray(end + 2);
      this.onLine(line);
    }
  }

  private onLine(line: string) {
    const [head, status, ...rest] = line.split(' ');
    const body = rest.join(' ');
    switch (head) {
      case 'VERSION':
        this.version = body || null;
        this.emit();
        return;
      case 'TALLY':
        if (status === 'OK') {
          const t = parseVmixTally(body.trim());
          this.programInputs = t.program;
          this.previewInputs = t.preview;
          this.emit();
        }
        return;
      case 'FUNCTION': {
        const p = this.pending.shift();
        if (!p) return;
        clearTimeout(p.timer);
        if (status === 'OK') p.resolve();
        else p.reject(new Error(`vMix 오류: ${body || line}`));
        return;
      }
      case 'XML':
        this.skipBytes = Number(status) || 0;
        return;
    }
  }

  private drop(err: Error) {
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private scheduleRetry() {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted && !this.connected) this.open().catch(() => this.emit());
    }, this.opts.retryMs ?? 3000);
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }
}
