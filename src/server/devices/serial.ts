// RS-422 시리얼 연결 (USB-RS422 변환기). serialport 는 네이티브 모듈이라 필요할 때만 로드한다.

export type Parity = 'odd' | 'even' | 'none';

export interface SerialLink {
  readonly path: string;
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: Buffer): Promise<void>;
  onData(listener: (data: Buffer) => void): () => void;
  /** 열린 뒤 장치가 빠지는 등 연결이 끊긴 경우 */
  onClose(listener: (err: Error | null) => void): () => void;
}

export interface SerialPortInfo {
  path: string;
  manufacturer: string | null;
  serialNumber: string | null;
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const { SerialPort } = await import('serialport');
  const ports = await SerialPort.list();
  return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer ?? null, serialNumber: p.serialNumber ?? null }));
}

export class NodeSerialLink implements SerialLink {
  private port: import('serialport').SerialPort | null = null;
  private dataListeners = new Set<(d: Buffer) => void>();
  private closeListeners = new Set<(e: Error | null) => void>();

  constructor(
    readonly path: string,
    private readonly opts: { baudRate: number; parity: Parity },
  ) {}

  get isOpen() {
    return this.port?.isOpen ?? false;
  }

  async open() {
    if (this.isOpen) return;
    const { SerialPort } = await import('serialport');
    const port = new SerialPort({
      path: this.path,
      baudRate: this.opts.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: this.opts.parity,
      autoOpen: false,
    });
    await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
    port.on('data', (d: Buffer) => this.dataListeners.forEach((l) => l(d)));
    port.on('close', (err: Error | null) => {
      if (this.port === port) this.port = null;
      this.closeListeners.forEach((l) => l(err ?? null));
    });
    this.port = port;
  }

  async close() {
    const port = this.port;
    this.port = null;
    if (port?.isOpen) await new Promise<void>((r) => port.close(() => r()));
  }

  async write(data: Buffer) {
    const port = this.port;
    if (!port?.isOpen) throw new Error(`${this.path} 이(가) 열려 있지 않음`);
    await new Promise<void>((resolve, reject) => port.write(data, (err) => (err ? reject(err) : port.drain(() => resolve()))));
  }

  onData(listener: (d: Buffer) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: (e: Error | null) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
}

/** 가상 포트: 보낸 바이트를 기록하고, responder 가 있으면 그 응답을 돌려준다 */
export class MockSerialLink implements SerialLink {
  readonly path = 'mock';
  readonly written: Buffer[] = [];
  private open_ = false;
  private dataListeners = new Set<(d: Buffer) => void>();
  private closeListeners = new Set<(e: Error | null) => void>();

  constructor(private readonly responder?: (tx: Buffer) => Buffer | null) {}

  get isOpen() {
    return this.open_;
  }
  async open() {
    this.open_ = true;
  }
  async close() {
    this.open_ = false;
  }
  async write(data: Buffer) {
    if (!this.open_) throw new Error('가상 포트가 열려 있지 않음');
    this.written.push(Buffer.from(data));
    const reply = this.responder?.(data);
    if (reply) setTimeout(() => this.dataListeners.forEach((l) => l(reply)), 5);
  }
  onData(listener: (d: Buffer) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onClose(listener: (e: Error | null) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  /** 케이블이 빠진 상황 흉내 */
  simulateUnplug() {
    this.open_ = false;
    this.closeListeners.forEach((l) => l(new Error('가상 포트 분리')));
  }
}
