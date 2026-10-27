// 최소 Modbus TCP 클라이언트 — GPI 입력/출력 모듈(Advantech ADAM-6000, Moxa ioLogik 등) 용.
// 사용 함수: 01 Read Coils, 02 Read Discrete Inputs, 05 Write Single Coil.
// 요청은 한 번에 하나씩 순서대로 보낸다 (저가 모듈은 동시 요청을 잘 처리하지 못함).
import { Socket } from 'node:net';

export class ModbusError extends Error {}

export interface ModbusTcpOptions {
  host: string;
  port?: number;
  unitId?: number;
  timeoutMs?: number;
}

const EXCEPTIONS: Record<number, string> = {
  1: '지원하지 않는 함수',
  2: '잘못된 주소',
  3: '잘못된 값',
  4: '장치 오류',
  6: '장치 사용 중',
};

export class ModbusTcpClient {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private tid = 0;
  private pending: { tid: number; resolve: (pdu: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ModbusTcpOptions) {}

  get connected() {
    return this.socket !== null && !this.socket.destroyed && !this.socket.connecting;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.close();
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ModbusError(`연결 시간 초과 (${this.opts.host})`));
      }, this.opts.timeoutMs ?? 2000);
      socket.setNoDelay(true);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      // 연결 뒤에도 오류(모듈 재부팅·랜선 분리 → ECONNRESET 등)를 항상 받아야 한다.
      // 처리하지 않은 소켓 오류는 프로세스 전체를 멈추게 한다. 정리는 이어서 오는 'close' 에서
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(new ModbusError(`연결 실패: ${err.message}`));
      });
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
        this.failPending(new ModbusError('연결 끊김'));
      });
      socket.connect(this.opts.port ?? 502, this.opts.host);
    });
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.failPending(new ModbusError('연결 종료'));
  }

  /** 함수 01/02: 비트 count 개 읽기 */
  async readBits(fc: 1 | 2, address: number, count: number): Promise<boolean[]> {
    const pdu = await this.request(Buffer.from([fc, address >> 8, address & 0xff, count >> 8, count & 0xff]));
    const byteCount = pdu[1];
    if (pdu.length < 2 + byteCount || byteCount < Math.ceil(count / 8)) throw new ModbusError('응답 길이 오류');
    return Array.from({ length: count }, (_, i) => ((pdu[2 + (i >> 3)] >> (i & 7)) & 1) === 1);
  }

  /** 함수 05: 코일 하나 쓰기 */
  async writeCoil(address: number, on: boolean): Promise<void> {
    await this.request(Buffer.from([5, address >> 8, address & 0xff, on ? 0xff : 0x00, 0x00]));
  }

  private request(pdu: Buffer): Promise<Buffer> {
    const run = () =>
      new Promise<Buffer>((resolve, reject) => {
        if (!this.socket || !this.connected) return reject(new ModbusError('연결되지 않음'));
        this.tid = (this.tid + 1) & 0xffff;
        const header = Buffer.alloc(7);
        header.writeUInt16BE(this.tid, 0);
        header.writeUInt16BE(0, 2);
        header.writeUInt16BE(pdu.length + 1, 4);
        header.writeUInt8(this.opts.unitId ?? 1, 6);
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new ModbusError('응답 시간 초과'));
          // 응답이 늦게 와서 다음 요청과 섞이지 않도록 연결을 새로 맺게 함
          this.close();
        }, this.opts.timeoutMs ?? 2000);
        this.pending = { tid: this.tid, resolve, reject, timer };
        this.socket.write(Buffer.concat([header, pdu]));
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 7) {
      const len = this.buffer.readUInt16BE(4);
      if (this.buffer.length < 6 + len) return;
      const frame = this.buffer.subarray(0, 6 + len);
      this.buffer = this.buffer.subarray(6 + len);
      const tid = frame.readUInt16BE(0);
      const pdu = frame.subarray(7);
      const p = this.pending;
      if (!p || p.tid !== tid) continue;
      clearTimeout(p.timer);
      this.pending = null;
      if (pdu[0] & 0x80) p.reject(new ModbusError(`장치 오류 응답: ${EXCEPTIONS[pdu[1]] ?? `코드 ${pdu[1]}`}`));
      else p.resolve(pdu);
    }
  }

  private failPending(err: Error) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.reject(err);
  }
}
