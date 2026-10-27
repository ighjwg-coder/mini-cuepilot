import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEVICE_DEFAULTS } from '../src/shared/devices';
import { readDeviceSettings, resolveDevices, updateConfigFile } from '../src/server/devices/config';
import { MockGpi, ModbusGpi, onAirFromInputs, programFromInputs } from '../src/server/devices/gpi';
import { GpiSwitcherAdapter } from '../src/server/devices/gpiSwitcher';
import { encodeTake, IkegamiRouterAdapter, parseHex, parseTakeTemplate, toHex } from '../src/server/devices/ikegami';
import { DeviceManager } from '../src/server/devices/manager';
import { ModbusTcpClient } from '../src/server/devices/modbus';
import { MockSerialLink } from '../src/server/devices/serial';
import { ShowRuntime } from '../src/server/runtime';
import { ManualTimecodeSource } from '../src/server/timecode';
import { executeAtemAction } from '../src/server/atem/types';
import { sampleService } from './fixtures';

const until = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ─────────────────────────────────────────────
describe('이케가미 명령 템플릿', () => {
  it('16진수 + 자리표시를 바이트로 변환', () => {
    const t = parseTakeTemplate('02 {OUT0} {IN0} {SUM}');
    // OUT 1 → 0, IN 5 → 4, SUM = 02+00+04 = 06
    expect(toHex(encodeTake(t, 5, 1))).toBe('02 00 04 06');
    expect(toHex(encodeTake(parseTakeTemplate('0x81, {IN}, {OUT}, {XOR}'), 3, 10))).toBe('81 03 0A 88');
  });

  it('SUM 은 하위 8비트', () => {
    expect(toHex(encodeTake(parseTakeTemplate('FF FF {SUM}'), 1, 1))).toBe('FF FF FE');
  });

  it('잘못된 토큰·범위 오류', () => {
    expect(() => parseTakeTemplate('')).toThrow(/비어/);
    expect(() => parseTakeTemplate('02 ZZ')).toThrow(/"ZZ"/);
    expect(() => parseTakeTemplate('{CAM}')).toThrow();
    expect(() => encodeTake(parseTakeTemplate('{IN}'), 300, 1)).toThrow(/범위/);
  });

  it('parseHex / toHex', () => {
    expect(toHex(parseHex('2 0a ff'))).toBe('02 0A FF');
    expect(() => parseHex('  ')).toThrow();
    expect(() => parseHex('0g')).toThrow(/16진수/);
  });
});

// ─────────────────────────────────────────────
describe('장비 설정 해석', () => {
  it('SWITCHER 미설정 → v0.0.2 처럼 ATEM_HOST 사용', () => {
    const r = resolveDevices(readDeviceSettings({ ATEM_HOST: 'mock' }));
    expect(r.switcher).toEqual({ kind: 'atem', atem: { kind: 'mock' }, me: 1 });
    expect(r.gpi).toEqual({ kind: 'none' });
    expect(r.tally.source).toBe('switcher');
    expect(r.errors).toEqual([]);
  });

  it('ikegami: 포트·매핑·템플릿', () => {
    const r = resolveDevices(
      readDeviceSettings({ SWITCHER: 'ikegami', IKEGAMI_PORT: 'COM3', IKEGAMI_CAM_INPUTS: '3, 5,7', IKEGAMI_PGM_OUT: '2', IKEGAMI_TAKE: '02 {IN}' }),
    );
    expect(r.errors).toEqual([]);
    expect(r.switcher).toMatchObject({ kind: 'ikegami', port: 'COM3', baudRate: 38400, parity: 'odd', pgmOutput: 2, camInputs: [3, 5, 7] });
  });

  it('잘못된 값은 오류 목록 + 해당 장비만 꺼짐', () => {
    const r = resolveDevices(readDeviceSettings({ SWITCHER: 'ikegami', IKEGAMI_TAKE: '02 ZZ', TALLY_SOURCE: 'gpi' }));
    expect(r.switcher.kind).toBe('none');
    expect(r.errors.join('\n')).toMatch(/IKEGAMI_PORT/);
    expect(r.errors.join('\n')).toMatch(/IKEGAMI_TAKE/);
    expect(r.errors.join('\n')).toMatch(/TALLY_SOURCE=gpi/);
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'sony' })).errors[0]).toMatch(/SWITCHER=sony/);
    expect(resolveDevices(readDeviceSettings({ GPI_HOST: '10.0.0.5', GPI_TALLY_INPUTS: '1,x' })).errors[0]).toMatch(/GPI_TALLY_INPUTS/);
  });

  it('GPI 호스트 / 포트 / mock', () => {
    expect(resolveDevices(readDeviceSettings({ GPI_HOST: '10.0.0.5:5020' })).gpi).toMatchObject({ kind: 'real', host: '10.0.0.5', port: 5020, diFunction: 2 });
    expect(resolveDevices(readDeviceSettings({ GPI_HOST: 'mock', TALLY_SOURCE: 'gpi', GPI_TALLY_INVERT: '1' }))).toMatchObject({
      gpi: { kind: 'mock' },
      tally: { source: 'gpi', invert: true, inputs: [1, 2, 3, 4, 5, 6, 7, 8] },
      errors: [],
    });
  });

  it('입력 상태 → ON AIR 카메라 (매핑·반전)', () => {
    const inputs = [false, false, true, false];
    expect(programFromInputs(inputs, [1, 2, 3, 4], false)).toBe(3);
    expect(programFromInputs(inputs, [4, 3], false)).toBe(2);
    expect(programFromInputs(inputs, [0, 1], false)).toBe(null);
    // 반전: 꺼진 입력이 ON AIR — 첫 번째로 꺼진 채널의 카메라
    expect(programFromInputs([true, false, true], [1, 2, 3], true)).toBe(2);
    expect(programFromInputs(null, [1], false)).toBe(null);
  });

  it('여러 카메라가 동시에 켜지면 전부 ON AIR (디졸브·키)', () => {
    expect(onAirFromInputs([true, false, true, false], [1, 2, 3, 4], false)).toEqual([1, 3]);
    expect(onAirFromInputs([false, true, true], [3, 2], false)).toEqual([1, 2]);
    expect(onAirFromInputs([true, true], [1, 2], true)).toEqual([]);
    expect(onAirFromInputs(null, [1], false)).toEqual([]);
    expect(programFromInputs([false, true, true], [3, 2], false)).toBe(1);
  });
});

describe('설정 파일 저장', () => {
  let dir: string;
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'camcue-cfg-'))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('값 교체 · 주석 해제 · 없는 키 추가, 나머지 줄 유지', () => {
    const p = join(dir, 'config.env');
    writeFileSync(p, '# 설명\nPORT=38080\nATEM_HOST=mock\n# IKEGAMI_PORT=COM3\n');
    updateConfigFile(p, { ATEM_HOST: '', IKEGAMI_PORT: 'COM5', SWITCHER: 'ikegami' });
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('# 설명\nPORT=38080\nATEM_HOST=\nIKEGAMI_PORT=COM5\n');
    expect(text).toMatch(/SWITCHER=ikegami\n$/);
    // $ 같은 특수문자도 그대로
    updateConfigFile(p, { IKEGAMI_TAKE: '02 {IN} $1' });
    expect(readFileSync(p, 'utf8')).toContain('IKEGAMI_TAKE=02 {IN} $1');
    expect(() => updateConfigFile(p, { ATEM_HOST: 'a\nPORT=1' })).toThrow(/줄바꿈/);
  });
});

// ─────────────────────────────────────────────
describe('IkegamiRouterAdapter (가상 포트)', () => {
  const make = (takeTemplate = '02 {OUT} {IN} {SUM}') => {
    const link = new MockSerialLink((tx) => Buffer.from([0x06, tx[0]]));
    const logs: Array<[string, string]> = [];
    const a = new IkegamiRouterAdapter({ link, pgmOutput: 1, camInputs: [11, 12, 0, 14], takeTemplate, log: (d, t) => logs.push([d, t]) });
    return { link, a, logs };
  };

  it('큐 컷 → PGM 출력 크로스포인트 명령 전송 + 상태', async () => {
    const { link, a, logs } = make();
    await a.connect();
    await executeAtemAction(a, 2, { kind: 'cut' });
    expect(toHex(link.written[0])).toBe('02 01 0C 0F');
    expect(a.status()).toMatchObject({ mode: 'ikegami', connected: true, programInput: 2 });
    // AUTO 도 라우터에서는 컷
    await executeAtemAction(a, 4, { kind: 'auto' });
    expect(toHex(link.written[1])).toBe('02 01 0E 11');
    expect(a.status().programInput).toBe(4);
    await until(() => logs.some(([d]) => d === 'rx'));
    expect(logs.find(([d]) => d === 'rx')![1]).toBe('06 02');
  });

  it('매핑 없는 카메라·템플릿 미설정·매크로는 오류', async () => {
    const { a } = make();
    await a.connect();
    await expect(a.setPreview(3)).rejects.toThrow(/CAM 3/);
    await expect(a.runMacro()).rejects.toThrow(/매크로/);
    const empty = make('');
    await empty.a.connect();
    await empty.a.setPreview(1);
    await expect(empty.a.cut()).rejects.toThrow(/IKEGAMI_TAKE/);
    expect(empty.link.written).toHaveLength(0);
  });

  it('포트 분리 시 미연결 표시 후 재시도로 복구', async () => {
    const link = new MockSerialLink();
    const a = new IkegamiRouterAdapter({ link, pgmOutput: 1, camInputs: [1], takeTemplate: '00', retryMs: 20 });
    await a.connect();
    link.simulateUnplug();
    expect(a.status().connected).toBe(false);
    expect(a.status().lastError).toMatch(/끊김/);
    await until(() => a.status().connected);
    await a.disconnect();
  });
});

describe('GpiSwitcherAdapter', () => {
  it('카메라별 출력 채널로 펄스', async () => {
    const gpi = new MockGpi();
    await gpi.connect();
    const a = new GpiSwitcherAdapter({ gpi, cutOutputs: [5, 6], pulseMs: 100 });
    await executeAtemAction(a, 2, { kind: 'cut' });
    expect(gpi.pulses).toEqual([{ channel: 6, ms: 100 }]);
    expect(a.status()).toMatchObject({ mode: 'gpi', connected: true, programInput: 2 });
    await a.setPreview(3);
    await expect(a.cut()).rejects.toThrow(/CAM 3/);
  });
});

// ─────────────────────────────────────────────
/** 테스트용 Modbus TCP 서버 (함수 01/02/05) */
function fakeModbus(state: { inputs: boolean[]; coils: boolean[]; exception?: number }) {
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 7 && buf.length >= 6 + buf.readUInt16BE(4)) {
        const len = buf.readUInt16BE(4);
        const frame = buf.subarray(0, 6 + len);
        buf = buf.subarray(6 + len);
        const pdu = frame.subarray(7);
        const fc = pdu[0];
        let resp: Buffer;
        if (state.exception) resp = Buffer.from([fc | 0x80, state.exception]);
        else if (fc === 1 || fc === 2) {
          const addr = pdu.readUInt16BE(1);
          const count = pdu.readUInt16BE(3);
          const src = fc === 2 ? state.inputs : state.coils;
          const bytes = Buffer.alloc(Math.ceil(count / 8));
          for (let i = 0; i < count; i++) if (src[addr + i]) bytes[i >> 3] |= 1 << (i & 7);
          resp = Buffer.concat([Buffer.from([fc, bytes.length]), bytes]);
        } else if (fc === 5) {
          state.coils[pdu.readUInt16BE(1)] = pdu[3] === 0xff;
          resp = Buffer.from(pdu);
        } else resp = Buffer.from([fc | 0x80, 1]);
        const head = Buffer.from(frame.subarray(0, 7));
        head.writeUInt16BE(resp.length + 1, 4);
        sock.write(Buffer.concat([head, resp]));
      }
    });
  });
  return {
    server,
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port))),
    close: () => {
      sockets.forEach((s) => s.destroy());
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('Modbus TCP', () => {
  const state = { inputs: Array.from({ length: 16 }, () => false), coils: Array.from({ length: 16 }, () => false), exception: 0 };
  const srv = fakeModbus(state);
  let port: number;
  beforeAll(async () => (port = await srv.listen()));
  afterAll(() => srv.close());
  afterEach(() => {
    state.exception = 0;
    state.inputs.fill(false);
  });

  it('입력 읽기 · 코일 쓰기 · 오류 응답', async () => {
    const c = new ModbusTcpClient({ host: '127.0.0.1', port });
    await c.connect();
    state.inputs[2] = true;
    state.inputs[9] = true;
    const bits = await c.readBits(2, 0, 12);
    expect(bits.map((b, i) => (b ? i : -1)).filter((i) => i >= 0)).toEqual([2, 9]);
    expect(await c.readBits(2, 2, 1)).toEqual([true]);
    // 동시 요청도 순서대로 처리
    const [a, b] = await Promise.all([c.readBits(2, 0, 4), c.writeCoil(3, true)]);
    expect(a).toEqual([false, false, true, false]);
    expect(b).toBeUndefined();
    expect(state.coils[3]).toBe(true);
    state.exception = 2;
    await expect(c.readBits(2, 0, 4)).rejects.toThrow(/잘못된 주소/);
    c.close();
  });

  it('연결 실패는 예외', async () => {
    const c = new ModbusTcpClient({ host: '127.0.0.1', port: 1, timeoutMs: 500 });
    await expect(c.connect()).rejects.toThrow(/연결/);
  });

  it('ModbusGpi: 폴링으로 입력 변화 감지 + 펄스', async () => {
    const gpi = new ModbusGpi({ host: '127.0.0.1', port, unitId: 1, diFunction: 2, diAddress: 0, diCount: 8, doAddress: 0, pollMs: 10 });
    let changes = 0;
    gpi.onChange(() => changes++);
    await gpi.connect();
    await until(() => gpi.status().connected);
    expect(gpi.status().inputs).toEqual(Array(8).fill(false));
    state.inputs[1] = true;
    await until(() => gpi.status().inputs?.[1] === true);
    expect(changes).toBeGreaterThanOrEqual(2);
    await gpi.pulse(4, 20);
    expect(state.coils[3]).toBe(false); // 켰다가 다시 끔
    await gpi.disconnect();
    expect(gpi.status().connected).toBe(false);
  });

  it('ModbusGpi: 켜진 채 남은 컷 출력은 연결되면 끈다', async () => {
    state.coils[1] = true; // 이전 실행에서 끄지 못하고 남은 출력 (채널 2)
    state.coils[6] = true; // 컷 출력이 아닌 채널은 건드리지 않음
    const gpi = new ModbusGpi({
      host: '127.0.0.1',
      port,
      unitId: 1,
      diFunction: 2,
      diAddress: 0,
      diCount: 8,
      doAddress: 0,
      pollMs: 10,
      resetOutputs: [1, 2],
    });
    await gpi.connect();
    await until(() => gpi.status().connected);
    expect(state.coils[1]).toBe(false);
    expect(state.coils[6]).toBe(true);
    await gpi.disconnect();
    state.coils.fill(false);
  });
});

// ─────────────────────────────────────────────
describe('DeviceManager + 실제 탈리 신호', () => {
  let dir: string;
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'camcue-dev-'))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('설정 저장 → 이케가미(가상 포트)로 전환 → 시험 컷 · 송수신 기록', async () => {
    const configPath = join(dir, 'config.env');
    writeFileSync(configPath, 'PORT=38080\nATEM_HOST=mock\n');
    const env: NodeJS.ProcessEnv = { ATEM_HOST: 'mock' };
    const m = new DeviceManager({ env, configPath });
    await m.start();
    await until(() => m.switcher.status().connected);
    expect(m.switcher.status().mode).toBe('mock');

    await m.apply({ SWITCHER: 'ikegami', IKEGAMI_PORT: 'mock', IKEGAMI_TAKE: 'AA {IN}', IKEGAMI_CAM_INPUTS: '7,8' });
    await until(() => m.switcher.status().connected);
    expect(m.switcher.status().mode).toBe('ikegami');
    expect(env.SWITCHER).toBe('ikegami');
    expect(readFileSync(configPath, 'utf8')).toMatch(/SWITCHER=ikegami/);

    await m.testTake(2);
    expect(m.switcher.status().programInput).toBe(2);
    await m.sendSerial('01 02');
    expect(m.logAfter(0).filter((e) => e.dir === 'tx').map((e) => e.text)).toEqual(['AA 08', '01 02']);
    await expect(m.apply({ NOPE: '1' } as never)).rejects.toThrow(/알 수 없는/);
    await m.stop();
  });

  it('TALLY_SOURCE=gpi → 런타임 탈리는 GPI 실측값 (스위처 보고값보다 우선)', async () => {
    const env: NodeJS.ProcessEnv = { ATEM_HOST: 'mock', GPI_HOST: 'mock', TALLY_SOURCE: 'gpi', GPI_TALLY_INPUTS: '3,4,5' };
    const m = new DeviceManager({ env, configPath: null });
    const runtime = new ShowRuntime({ atem: m.switcher, timecode: new ManualTimecodeSource(), tallyInput: m.tallyInput });
    runtime.load(sampleService());
    await m.start();
    await until(() => m.gpiModule.status().connected && m.switcher.status().connected);
    expect(runtime.tally()).toMatchObject({ source: 'gpi', program: null });

    const sources: string[] = [];
    runtime.on('state', (s) => sources.push(`${s.tally.source}:${s.tally.program}`));
    m.setMockInput(4, true); // DI 4 = CAM 2
    expect(runtime.tally()).toMatchObject({ source: 'gpi', program: 2, onAir: [2] });
    expect(sources.at(-1)).toBe('gpi:2');

    // 디졸브 중: CAM 2 와 CAM 3 이 동시에 ON AIR — 둘 다 탈리, PVW 는 그 둘이 아닌 값
    m.setMockInput(5, true); // DI 5 = CAM 3
    expect(runtime.tally()).toMatchObject({ source: 'gpi', program: 2, onAir: [2, 3] });
    expect(runtime.tally().preview === 2 || runtime.tally().preview === 3).toBe(false);
    m.setMockInput(4, false);
    expect(runtime.tally()).toMatchObject({ program: 3, onAir: [3] });

    // 설정에서 탈리 기준을 스위처로 바꾸면 ATEM(가상) 보고값
    await m.apply({ TALLY_SOURCE: 'switcher' });
    await until(() => m.switcher.status().connected);
    expect(runtime.tally().source).toBe('atem');
    expect(() => m.setMockInput(1, true)).not.toThrow();
    await m.apply({ GPI_HOST: '' });
    expect(() => m.setMockInput(1, true)).toThrow(/가상 GPI/);
    runtime.stop();
    await m.stop();
  });

  it('기본값 정의가 설정 키 전체를 포함', () => {
    expect(Object.keys(readDeviceSettings({}))).toEqual(Object.keys(DEVICE_DEFAULTS));
  });
});

// ─────────────────────────────────────────────
describe('장비 연결 API', () => {
  it('조회 · 저장 · 가상 GPI 조작 · 시험 컷 · 오류 응답', async () => {
    const { buildApp } = await import('../src/server/app');
    const env: NodeJS.ProcessEnv = { ATEM_HOST: 'mock', GPI_HOST: 'mock' };
    const m = new DeviceManager({ env, configPath: null });
    const runtime = new ShowRuntime({ atem: m.switcher, timecode: new ManualTimecodeSource(), tallyInput: m.tallyInput });
    await m.start();
    const app = await buildApp({ repo: {} as never, runtime, devices: m });
    try {
      await until(() => m.switcher.status().connected);
      let res = await app.inject({ method: 'GET', url: '/api/devices' });
      expect(res.json()).toMatchObject({ settings: { ATEM_HOST: 'mock', GPI_HOST: 'mock' }, switcher: { mode: 'mock' }, gpi: { mode: 'mock' }, errors: [] });

      res = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { TALLY_SOURCE: 'gpi', GPI_TALLY_INPUTS: '1,2' } });
      expect(res.statusCode).toBe(200);
      await until(() => m.gpiModule.status().connected);

      res = await app.inject({ method: 'POST', url: '/api/devices/gpi/mock-input', payload: { channel: 2, on: true } });
      expect(res.json().tally).toMatchObject({ source: 'gpi', program: 2 });

      await until(() => m.switcher.status().connected);
      res = await app.inject({ method: 'POST', url: '/api/devices/test-take', payload: { camera: 3 } });
      expect(res.statusCode).toBe(200);
      expect(m.switcher.status().programInput).toBe(3);

      res = await app.inject({ method: 'POST', url: '/api/devices/test-take', payload: { camera: 9 } });
      expect(res.statusCode).toBe(400);
      res = await app.inject({ method: 'POST', url: '/api/devices/serial/send', payload: { hex: '01' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/SWITCHER=ikegami/);
      res = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { SWITCHER: 1 } });
      expect(res.statusCode).toBe(400);
      res = await app.inject({ method: 'GET', url: '/api/devices/serial-log?after=0' });
      expect(res.json()).toEqual({ entries: [] });
    } finally {
      await app.close();
      runtime.stop();
      await m.stop();
    }
  });
});
