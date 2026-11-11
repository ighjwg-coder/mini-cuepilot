// 이케가미 DVF-130 (MuPS 프레임) 랜 탈리 — 읽기 전용.
//
// 프레임 ETHER 단자의 TCP 3004 는 원래 터치 화면(GUI)이 쓰는 통신이다. 현장 캡처로 확인한 규칙:
//   메시지 머리 = 39 32 [보내는 쪽 ID] [받는 쪽 ID] [명령] … (프레임 ID = 0xFF, 터치 화면 = 0x50)
//   5C 감시 요청: [블록] [공간] [개수] + (주소 2바이트, 워드 수 2바이트) × 개수 → 프레임이 DC 로 확인
//   5D 값 알림:   [블록] [공간] [개수] + (주소, 워드 수, 값 …) × 개수 → 받은 쪽이 DD [블록] 으로 응답해야 다음 알림이 온다
//   감시 목록이 새로 등록되면 그 범위의 현재 값을 보내 주고, 그 뒤에는 바뀔 때만 보낸다. 15초 동안 신호가 없으면 연결을 끊는다.
//   공간 0, 주소 0xE012 = 송출 탈리 (비트 k = 링크 k+1 송출 중, 링크 1~16). AUTO 중에는 두 링크가 같이 켜진다.
//   프레임은 접속을 한 번에 하나만 받는다 → 터치 화면이 붙어 있으면 거부된다 (버튼 컷은 다른 경로라 영향 없음).
// 명령(컷)은 보내지 않는다. 캠큐 GO 는 큐만 넘기고, 컷은 패널에서 한다.
import { Socket } from 'node:net';
import type { AtemStatus, SwitcherCaps } from '../../shared/protocol';
import { camerasFrom, type AtemAdapter } from '../atem/types';

export const IKEGAMI_LAN_PORT = 3004;
export const IKEGAMI_FRAME_ID = 0xff;
export const IKEGAMI_TALLY_ADDR = 0xe012;

const MAGIC0 = 0x39;
const MAGIC1 = 0x32;
const CMD_WATCH = 0x5c;
const CMD_WATCH_ACK = 0xdc;
const CMD_NOTIFY = 0x5d;
const CMD_NOTIFY_ACK = 0xdd;

export interface IkegamiLanOptions {
  host: string;
  port?: number;
  /** 캠큐 쪽 ID (터치 화면 0x50 과 겹치지 않게 기본 0x51) */
  myId?: number;
  /** camLinks[i] = CAM(i+1) 이 들어간 스위처 링크 번호 (0 = 없음) */
  camLinks: number[];
  /** 링크 번호 → 이름 (카메라 외 소스를 "지금 송출: PPT" 처럼 보여 줄 때) */
  names?: Record<number, string>;
  retryMs?: number;
  heartbeatMs?: number;
  /** 접속 후 감시 요청 확인을 기다리는 시간 */
  replyTimeoutMs?: number;
}

/** 감시 요청: 블록 0, 공간 0 */
export function watchMessage(myId: number, entries: Array<[number, number]>): Buffer {
  const b = Buffer.alloc(8 + 4 * entries.length);
  b.set([MAGIC0, MAGIC1, myId, IKEGAMI_FRAME_ID, CMD_WATCH, 0x00, 0x00, entries.length]);
  entries.forEach(([addr, words], i) => {
    b.writeUInt16BE(addr, 8 + 4 * i);
    b.writeUInt16BE(words, 10 + 4 * i);
  });
  return b;
}

// 접속할 때마다 목록을 한 번 바꿔 보내야 프레임이 현재 값을 다시 보내 준다 (같은 목록이면 확인만 함)
const WATCH_PRIME: Array<[number, number]> = [[IKEGAMI_TALLY_ADDR, 1]];
const WATCH_MAIN: Array<[number, number]> = [[0xe000, 72]];

/** 프레임이 보내는 메시지 머리 (39 32 FF) */
const FRAME_HEADER = Buffer.from([MAGIC0, MAGIC1, IKEGAMI_FRAME_ID]);
/** 알 수 없는 데이터는 다음 메시지 머리 앞까지 건너뛴다 (못 찾으면 끝 2바이트는 남김 — 머리가 잘려 왔을 수 있음) */
const skipLength = (buf: Buffer) => {
  const i = buf.indexOf(FRAME_HEADER, 1);
  return i > 0 ? i : Math.max(1, buf.length - 2);
};

export interface IkegamiNotifyItem {
  addr: number;
  words: number[];
}

/** 받은 바이트에서 메시지 하나를 꺼낸다. 덜 왔으면 null, 알 수 없는 데이터면 bad + 건너뛸 길이 */
export function takeMessage(
  buf: Buffer,
): null | { len: number; cmd: number; block?: number; space?: number; items?: IkegamiNotifyItem[]; bad?: boolean } {
  if (buf.length < 6) return null;
  if (buf[0] !== MAGIC0 || buf[1] !== MAGIC1) return { len: skipLength(buf), cmd: -1, bad: true };
  const cmd = buf[4];
  if (cmd === CMD_WATCH_ACK) return buf.length < 8 ? null : { len: 8, cmd };
  if (cmd === CMD_NOTIFY) {
    if (buf.length < 8) return null;
    const block = buf[5];
    const space = buf[6];
    const count = buf[7];
    let pos = 8;
    const items: IkegamiNotifyItem[] = [];
    for (let k = 0; k < count; k++) {
      if (buf.length < pos + 4) return null;
      const addr = buf.readUInt16BE(pos);
      const n = buf.readUInt16BE(pos + 2);
      if (buf.length < pos + 4 + 2 * n) return null;
      const words: number[] = [];
      for (let w = 0; w < n; w++) words.push(buf.readUInt16BE(pos + 4 + 2 * w));
      items.push({ addr, words });
      pos += 4 + 2 * n;
    }
    return { len: pos, cmd, block, space, items };
  }
  return { len: skipLength(buf), cmd, bad: true };
}

/** 탈리 비트 → 송출 중인 링크 번호 (1~16) */
export const linksFromMask = (mask: number) => Array.from({ length: 16 }, (_, k) => k + 1).filter((link) => (mask >> (link - 1)) & 1);

/** "6=X2, 10=PPT" → { 6: 'X2', 10: 'PPT' } (형식 오류는 throw) */
export function parseLinkNames(raw: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,2})\s*=\s*(.+)$/.exec(part);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 16) throw new Error(`"${part}" — "링크번호=이름" 형식, 링크는 1~16`);
    out[Number(m[1])] = m[2].trim();
  }
  return out;
}

export class IkegamiLanAdapter implements AtemAdapter {
  private socket: Socket | null = null;
  private tcpUp = false;
  private gotReply = false;
  private mask: number | null = null;
  private lastError: string | null = null;
  private buf = Buffer.alloc(0);
  private listeners = new Set<(s: AtemStatus) => void>();
  private retry: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private replyTimer: NodeJS.Timeout | null = null;
  private wanted = false;
  /** 직전 감시 요청 뒤로 프레임에서 받은 게 있는지 (프레임은 감시 요청마다 1초 안에 확인을 보냄 — 현장 캡처 278건 모두) */
  private rxSinceBeat = false;

  constructor(private readonly opts: IkegamiLanOptions) {}

  private get port() {
    return this.opts.port ?? IKEGAMI_LAN_PORT;
  }

  private get myId() {
    return this.opts.myId ?? 0x51;
  }

  private camOf(link: number): number | null {
    const i = this.opts.camLinks.indexOf(link);
    return link > 0 && i >= 0 ? i + 1 : null;
  }

  /** 탈리 값을 받기 전에는 연결 안 됨으로 보고 → 캠큐는 추정 표시를 유지 ("카메라 외 소스" 로 잘못 보이지 않게) */
  status(): AtemStatus {
    const known = this.tcpUp && this.mask !== null;
    const links = known ? linksFromMask(this.mask!) : [];
    const cams = links.map((l) => this.camOf(l)).filter((c): c is number => c !== null);
    const others = links.filter((l) => this.camOf(l) === null).map((l) => this.opts.names?.[l] ?? `링크 ${l}`);
    return {
      mode: 'ikegami-lan',
      host: `${this.opts.host}:${this.port}`,
      connected: known,
      model: !this.tcpUp ? null : known ? 'Ikegami 랜 탈리 · 송출 정보 받는 중' : 'Ikegami 랜 탈리 · 첫 송출 정보를 기다리는 중',
      programInput: known ? (cams[0] ?? null) : null,
      previewInput: null,
      lastError: this.lastError,
      tallyOnly: true,
      onAirInputs: known ? cams : undefined,
      onAirLabels: known ? others : undefined,
    };
  }

  onStatus(listener: (s: AtemStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capabilities(): SwitcherCaps {
    return { cameras: camerasFrom(this.opts.camLinks), transition: false, macro: false, dsk: false };
  }

  connect(): Promise<void> {
    this.wanted = true;
    return this.open();
  }

  async disconnect() {
    this.wanted = false;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    this.tcpUp = false;
    this.mask = null;
    s?.end();
    s?.destroy();
    this.emit();
  }

  // 탈리만 읽으므로 명령은 보내지 않는다 (런타임도 tallyOnly 면 보내지 않음)
  async setPreview() {}
  async cut() {}
  async autoTransition() {}
  async runMacro() {}
  async setDownstreamKeyOnAir() {}

  private clearTimers() {
    for (const t of [this.retry, this.heartbeat, this.replyTimer]) if (t) clearTimeout(t);
    this.retry = this.heartbeat = this.replyTimer = null;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      this.buf = Buffer.alloc(0);
      this.gotReply = false;
      this.rxSinceBeat = false;
      let settled = false;
      let silent = false;
      socket.setNoDelay(true);
      socket.on('data', (d: Buffer) => this.onData(socket, d));
      socket.once('connect', () => {
        this.tcpUp = true;
        this.lastError = null;
        socket.write(watchMessage(this.myId, WATCH_PRIME));
        socket.write(watchMessage(this.myId, WATCH_MAIN));
        this.heartbeat = setInterval(() => {
          // 한 주기 동안 확인이 없음 = 랜선 빠짐·프레임 꺼짐 등 → 옛 탈리를 계속 보여 주지 않게 끊고 다시 연결
          if (!this.rxSinceBeat) {
            silent = true;
            socket.destroy();
            return;
          }
          this.rxSinceBeat = false;
          socket.write(watchMessage(this.myId, WATCH_MAIN));
        }, this.opts.heartbeatMs ?? 10_000);
        this.replyTimer = setTimeout(() => {
          if (this.gotReply || this.socket !== socket) return;
          this.lastError = '프레임 응답 없음 — 다시 시도 중';
          socket.destroy();
        }, this.opts.replyTimeoutMs ?? 5_000);
        this.emit();
        settled = true;
        resolve();
      });
      socket.on('error', (err: NodeJS.ErrnoException) => {
        this.lastError =
          err.code === 'ECONNREFUSED'
            ? '프레임이 접속을 거부했습니다 — 프레임은 한 대만 받습니다. 터치 화면 랜선을 빼 두면 연결됩니다 (방금 끊겼다면 잠시 뒤 자동으로 붙음)'
            : `프레임 연결 실패 (${this.opts.host}:${this.port}): ${err.message}`;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.heartbeat) clearInterval(this.heartbeat);
        if (this.replyTimer) clearTimeout(this.replyTimer);
        this.heartbeat = this.replyTimer = null;
        const was = this.tcpUp && this.gotReply;
        this.tcpUp = false;
        this.mask = null;
        if (this.wanted && silent) this.lastError = '프레임 응답 없음 (랜선·프레임 확인) — 다시 연결 중';
        else if (this.wanted && was) this.lastError = '프레임 연결 끊김 — 다시 시도 중';
        this.emit();
        this.scheduleRetry();
      });
      socket.connect(this.port, this.opts.host);
    });
  }

  private onData(socket: Socket, chunk: Buffer) {
    this.gotReply = true;
    this.rxSinceBeat = true;
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const m = takeMessage(this.buf);
      if (!m) return;
      this.buf = this.buf.subarray(m.len);
      if (m.bad) continue; // 알 수 없는 데이터는 버리고 다음 메시지부터
      if (m.cmd !== CMD_NOTIFY) continue;
      // 터치 화면 앞(0x50) 알림이 섞여 와도 응답은 해야 다음 알림이 온다
      socket.write(Buffer.from([MAGIC0, MAGIC1, this.myId, IKEGAMI_FRAME_ID, CMD_NOTIFY_ACK, m.block ?? 0]));
      if (m.space !== 0) continue;
      for (const it of m.items ?? []) {
        if (IKEGAMI_TALLY_ADDR >= it.addr && IKEGAMI_TALLY_ADDR < it.addr + it.words.length) {
          const v = it.words[IKEGAMI_TALLY_ADDR - it.addr];
          if (v !== this.mask) {
            this.mask = v;
            this.emit();
          }
        }
      }
    }
  }

  private scheduleRetry() {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted && !this.socket) this.open().catch(() => this.emit());
    }, this.opts.retryMs ?? 5000);
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }
}
