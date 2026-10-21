// 이케가미 MuPS 라우터 (MUPS-FRM45 등) RS-422 제어.
//
// 매뉴얼(NN-8324276R p.11) 기준: 422 포트 4개, 크로스포인트 제어·LOCK·이름 조회 지원,
// Sony DVS/BVS · GVG-200 편집기 프로토콜, 38400bps 8bit 1stop ODD.
// 프로토콜 명령 바이트는 매뉴얼에 없으므로 IKEGAMI_TAKE 템플릿으로 지정한다
// (이케가미/시공사에서 받은 명령 형식을 그대로 입력 → 프로그램 수정 없이 반영).
//
// 라우터에는 PVW·믹스가 없으므로
//   setPreview = 다음 카메라 기억만 / cut·auto = PGM 출력의 크로스포인트 전환 / 매크로·DSK = 미지원
import type { AtemStatus } from '../../shared/protocol';
import type { AtemAdapter } from '../atem/types';
import type { SerialLink } from './serial';

/** 템플릿 자리표시 (모두 1바이트) */
export const TAKE_PLACEHOLDERS = ['{IN}', '{IN0}', '{OUT}', '{OUT0}', '{SUM}', '{XOR}'] as const;

type Token = { kind: 'byte'; value: number } | { kind: 'in' | 'in0' | 'out' | 'out0' | 'sum' | 'xor' };

/**
 * 템플릿 해석. 예) "02 {OUT0} {IN0} {SUM}"
 *   16진수 바이트(00~FF), {IN}/{OUT} = 1부터 번호, {IN0}/{OUT0} = 0부터 번호,
 *   {SUM} = 앞 바이트 합의 하위 8비트, {XOR} = 앞 바이트 XOR
 */
export function parseTakeTemplate(raw: string): Token[] {
  const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) throw new Error('명령 템플릿이 비어 있습니다');
  return parts.map((p) => {
    const lower = p.toLowerCase();
    switch (lower) {
      case '{in}':
        return { kind: 'in' };
      case '{in0}':
        return { kind: 'in0' };
      case '{out}':
        return { kind: 'out' };
      case '{out0}':
        return { kind: 'out0' };
      case '{sum}':
        return { kind: 'sum' };
      case '{xor}':
        return { kind: 'xor' };
    }
    const hex = lower.replace(/^0x/, '');
    if (!/^[0-9a-f]{1,2}$/.test(hex)) throw new Error(`명령 템플릿 해석 실패: "${p}" (16진수 바이트 또는 ${TAKE_PLACEHOLDERS.join(' ')})`);
    return { kind: 'byte', value: parseInt(hex, 16) };
  });
}

export function encodeTake(tokens: Token[], input: number, output: number): Buffer {
  const bytes: number[] = [];
  for (const t of tokens) {
    let v: number;
    switch (t.kind) {
      case 'byte':
        v = t.value;
        break;
      case 'in':
        v = input;
        break;
      case 'in0':
        v = input - 1;
        break;
      case 'out':
        v = output;
        break;
      case 'out0':
        v = output - 1;
        break;
      case 'sum':
        v = bytes.reduce((a, b) => a + b, 0) & 0xff;
        break;
      case 'xor':
        v = bytes.reduce((a, b) => a ^ b, 0);
        break;
    }
    if (v < 0 || v > 0xff) throw new Error(`번호가 1바이트 범위를 벗어남 (입력 ${input}, 출력 ${output})`);
    bytes.push(v);
  }
  return Buffer.from(bytes);
}

/** "02 0a ff" ↔ Buffer */
export function toHex(buf: Buffer): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
export function parseHex(raw: string): Buffer {
  const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) throw new Error('보낼 바이트가 없습니다');
  return Buffer.from(
    parts.map((p) => {
      const h = p.toLowerCase().replace(/^0x/, '');
      if (!/^[0-9a-f]{1,2}$/.test(h)) throw new Error(`16진수가 아닙니다: "${p}"`);
      return parseInt(h, 16);
    }),
  );
}

export interface IkegamiOptions {
  link: SerialLink;
  /** PGM 으로 쓰는 라우터 출력 번호 */
  pgmOutput: number;
  /** camInputs[i] = CAM(i+1) 이 들어가는 라우터 입력 번호 */
  camInputs: number[];
  /** 크로스포인트 전환 명령 템플릿 (빈 문자열이면 컷 시 오류 안내) */
  takeTemplate: string;
  /** 송수신 기록 (장비 연결 화면 모니터) */
  log?: (dir: 'tx' | 'rx' | 'info' | 'error', text: string) => void;
  /** 열기 실패·분리 시 재시도 간격 */
  retryMs?: number;
}

export class IkegamiRouterAdapter implements AtemAdapter {
  private program: number | null = null;
  private preview: number | null = null;
  private lastError: string | null = null;
  private listeners = new Set<(s: AtemStatus) => void>();
  private tokens: Token[] | null = null;
  private templateError: string | null = null;
  private retry: NodeJS.Timeout | null = null;
  private wanted = false;
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly opts: IkegamiOptions) {
    if (opts.takeTemplate.trim()) {
      try {
        this.tokens = parseTakeTemplate(opts.takeTemplate);
      } catch (err) {
        this.templateError = (err as Error).message;
      }
    }
    this.unsubs.push(
      opts.link.onData((d) => opts.log?.('rx', toHex(d))),
      opts.link.onClose((err) => {
        if (!this.wanted) return;
        this.lastError = `포트 연결 끊김${err ? `: ${err.message}` : ''} — 재시도 중`;
        opts.log?.('error', this.lastError);
        this.emit();
        this.scheduleRetry();
      }),
    );
  }

  status(): AtemStatus {
    const connected = this.opts.link.isOpen;
    return {
      mode: 'ikegami',
      host: this.opts.link.path,
      connected,
      model: connected ? `Ikegami 라우터 · PGM = OUT ${this.opts.pgmOutput}` : null,
      programInput: connected ? this.program : null,
      previewInput: connected ? this.preview : null,
      lastError: this.lastError ?? this.templateError,
    };
  }

  onStatus(listener: (s: AtemStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect() {
    this.wanted = true;
    try {
      await this.opts.link.open();
      this.lastError = null;
      this.opts.log?.('info', `${this.opts.link.path} 열림`);
      this.emit();
    } catch (err) {
      this.lastError = `포트 열기 실패 (${this.opts.link.path}): ${(err as Error).message}`;
      this.opts.log?.('error', this.lastError);
      this.emit();
      this.scheduleRetry();
      throw err;
    }
  }

  async disconnect() {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.unsubs.splice(0).forEach((u) => u());
    await this.opts.link.close();
    this.emit();
  }

  async setPreview(camera: number) {
    this.camInput(camera);
    this.preview = camera;
    this.emit();
  }

  async cut() {
    if (this.preview === null) throw new Error('전환할 카메라가 지정되지 않음');
    await this.take(this.preview);
  }

  /** 라우터에는 믹스가 없으므로 컷으로 처리 */
  async autoTransition() {
    await this.cut();
  }

  async runMacro() {
    throw new Error('이케가미 라우터 모드에서는 매크로를 지원하지 않습니다');
  }

  async setDownstreamKeyOnAir() {
    throw new Error('이케가미 라우터 모드에서는 DSK 를 지원하지 않습니다');
  }

  /** 카메라를 PGM 출력으로 전환 (장비 연결 화면의 시험 버튼도 이 경로) */
  async take(camera: number) {
    if (!this.tokens) throw new Error(this.templateError ?? '크로스포인트 명령(IKEGAMI_TAKE)이 설정되지 않았습니다');
    const input = this.camInput(camera);
    const frame = encodeTake(this.tokens, input, this.opts.pgmOutput);
    this.opts.log?.('tx', toHex(frame));
    await this.opts.link.write(frame);
    const prev = this.program;
    this.program = camera;
    if (this.preview === camera) this.preview = prev;
    this.lastError = null;
    this.emit();
  }

  /** 템플릿과 무관하게 임의 바이트 전송 (시험용) */
  async sendRaw(frame: Buffer) {
    this.opts.log?.('tx', toHex(frame));
    await this.opts.link.write(frame);
  }

  private camInput(camera: number) {
    const input = this.opts.camInputs[camera - 1];
    if (!input) throw new Error(`CAM ${camera} 의 라우터 입력 번호가 설정되지 않았습니다 (IKEGAMI_CAM_INPUTS)`);
    return input;
  }

  private scheduleRetry() {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted && !this.opts.link.isOpen) this.connect().catch(() => {});
    }, this.opts.retryMs ?? 3000);
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }
}
