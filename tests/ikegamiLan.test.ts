// 이케가미 랜 탈리: 현장 캡처에서 확인한 프레임 동작을 흉내 낸 가짜 프레임으로 시험
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAtemAdapter, TallyOnlyAdapter } from '../src/server/atem';
import { readDeviceSettings, resolveDevices } from '../src/server/devices/config';
import { DeviceManager } from '../src/server/devices/manager';
import { IkegamiLanAdapter, linksFromMask, parseLinkNames, takeMessage, watchMessage } from '../src/server/devices/ikegamiLan';
import { ShowRuntime } from '../src/server/runtime';
import { ManualTimecodeSource } from '../src/server/timecode';

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/**
 * 가짜 프레임: 감시 목록은 ID 별로 기억 (연결이 끊겨도 유지), 목록이 바뀌면 그 범위의 현재 값을 보냄,
 * 알림은 DD 응답을 받아야 다음 것을 보냄, 접속은 한 번에 하나
 */
function fakeFrame() {
  const regs = new Map<number, number>();
  for (let a = 0xe000; a < 0xe048; a++) regs.set(a, 0);
  regs.set(0xe012, 0x0200); // PPT 송출 중
  const lists = new Map<number, string>();
  const st = { watches: 0, acks: 0, conns: 0, sock: null as Socket | null, peer: 0, queue: [] as Buffer[], waiting: false, mute: false };
  const send = () => {
    if (st.waiting || !st.queue.length || !st.sock) return;
    st.waiting = true;
    st.sock.write(st.queue.shift()!);
  };
  const notify = (dst: number, space: number, items: Array<[number, number[]]>) => {
    const parts = [Buffer.from([0x39, 0x32, 0xff, dst, 0x5d, 0x00, space, items.length])];
    for (const [a, words] of items) {
      const h = Buffer.alloc(4 + 2 * words.length);
      h.writeUInt16BE(a, 0);
      h.writeUInt16BE(words.length, 2);
      words.forEach((w, i) => h.writeUInt16BE(w, 4 + 2 * i));
      parts.push(h);
    }
    st.queue.push(Buffer.concat(parts));
    send();
  };
  const server: Server = createServer((sock) => {
    if (st.sock) return sock.destroy(); // 한 대만
    st.sock = sock;
    st.conns++;
    st.queue = [];
    st.waiting = false;
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('close', () => {
      if (st.sock === sock) st.sock = null;
    });
    sock.on('data', (d: Buffer) => {
      if (st.mute) return; // 랜선이 빠진 것처럼 아무 응답도 안 함
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 6) {
        const cmd = buf[4];
        if (cmd === 0xdd) {
          st.acks++;
          buf = buf.subarray(6);
          st.waiting = false;
          send();
          continue;
        }
        if (cmd === 0x5c) {
          const n = buf[7];
          const len = 8 + 4 * n;
          if (buf.length < len) break;
          const msg = buf.subarray(0, len);
          buf = buf.subarray(len);
          st.watches++;
          st.peer = msg[2];
          sock.write(Buffer.from([0x39, 0x32, 0xff, st.peer, 0xdc, msg[5], msg[6], msg[7]]));
          const key = msg.subarray(8).toString('hex');
          if (lists.get(st.peer) !== key) {
            lists.set(st.peer, key);
            const items: Array<[number, number[]]> = [];
            for (let k = 0; k < n; k++) {
              const a = msg.readUInt16BE(8 + 4 * k);
              const c = msg.readUInt16BE(10 + 4 * k);
              items.push([a, Array.from({ length: c }, (_, i) => regs.get(a + i) ?? 0)]);
            }
            notify(st.peer, 0, items);
          }
          continue;
        }
        buf = Buffer.alloc(0);
      }
    });
  });
  const set = (mask: number) => {
    regs.set(0xe012, mask);
    notify(st.peer, 0, [[0xe012, [mask]]]);
  };
  return { server, st, set, notify, regs, lists };
}
const listen = (server: Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
const CAMS = [1, 2, 3, 4, 12, 13, 14, 15];

describe('이케가미 랜 탈리 · 메시지', () => {
  it('감시 요청 형식 (현장 캡처와 같은 바이트)', () => {
    expect(watchMessage(0x51, [[0xe000, 72]]).toString('hex')).toBe('3932' + '51ff' + '5c000001' + 'e0000048');
  });
  it('값 알림 분해 · 덜 온 메시지는 기다림', () => {
    const full = Buffer.from('3932ff505d000001e14100060006' + '00d400d400d400000006', 'hex');
    expect(takeMessage(full.subarray(0, 10))).toBeNull();
    expect(takeMessage(full)).toMatchObject({ len: full.length, cmd: 0x5d, block: 0, space: 0, items: [{ addr: 0xe141, words: [6, 0xd4, 0xd4, 0xd4, 0, 6] }] });
  });
  it('알 수 없는 데이터는 다음 메시지 머리까지만 건너뜀 (뒤에 붙은 알림은 살림)', () => {
    const notify = Buffer.from('3932ff515d000001e0120001' + '0001', 'hex');
    const junk = Buffer.concat([Buffer.from('00112233', 'hex'), notify]);
    expect(takeMessage(junk)).toMatchObject({ len: 4, bad: true });
    const unknown = Buffer.concat([Buffer.from('3932ff517f0000', 'hex'), notify]); // 모르는 명령 7F
    const m = takeMessage(unknown)!;
    expect(m).toMatchObject({ len: 7, bad: true });
    expect(takeMessage(unknown.subarray(m.len))).toMatchObject({ cmd: 0x5d, items: [{ addr: 0xe012, words: [1] }] });
    expect(takeMessage(Buffer.from('aabbccdd3932', 'hex'))).toMatchObject({ len: 4, bad: true }); // 머리가 잘려 왔을 수 있어 끝 2바이트는 남김
  });
  it('탈리 비트 → 링크 번호, 이름 표', () => {
    expect(linksFromMask(0x0003)).toEqual([1, 2]);
    expect(linksFromMask(0x4800)).toEqual([12, 15]);
    expect(parseLinkNames('6=X2, 10 = PPT')).toEqual({ 6: 'X2', 10: 'PPT' });
    expect(() => parseLinkNames('17=X')).toThrow('1~16');
  });
});

describe('이케가미 랜 탈리 · 가짜 프레임', () => {
  it('접속하면 현재 송출(PPT)을 받고, 바뀔 때마다 카메라 번호로', async () => {
    const f = fakeFrame();
    const port = await listen(f.server);
    cleanups.push(() => new Promise((r) => f.server.close(r)));
    const lan = new IkegamiLanAdapter({ host: '127.0.0.1', port, camLinks: CAMS, names: { 6: 'X2', 10: 'PPT' } });
    cleanups.push(() => lan.disconnect());
    await lan.connect();
    await until(() => lan.status().connected);
    expect(lan.status()).toMatchObject({ mode: 'ikegami-lan', tallyOnly: true, programInput: null, onAirInputs: [], onAirLabels: ['PPT'] });

    f.set(0x0001); // C1
    await until(() => lan.status().programInput === 1);
    f.set(0x0003); // AUTO 중 C1 + C2
    f.set(0x0002);
    f.set(0x0800); // 링크 12 = CAM5 (ENG1)
    await until(() => lan.status().programInput === 5);
    expect(f.st.acks).toBeGreaterThanOrEqual(5); // 알림마다 응답해야 다음 알림이 옴
    f.set(0x0020); // 링크 6 = X2
    await until(() => lan.status().onAirLabels?.[0] === 'X2');
    expect(lan.status().onAirInputs).toEqual([]);
    f.set(0x0000); // 링크 17 이상 등 모르는 소스
    await until(() => lan.status().onAirLabels?.length === 0);
  });

  it('다시 접속해도(같은 목록이 기억돼 있어도) 현재 값을 다시 받음', async () => {
    const f = fakeFrame();
    const port = await listen(f.server);
    cleanups.push(() => new Promise((r) => f.server.close(r)));
    const lan = new IkegamiLanAdapter({ host: '127.0.0.1', port, camLinks: CAMS, retryMs: 30 });
    cleanups.push(() => lan.disconnect());
    await lan.connect();
    await until(() => lan.status().connected);
    f.regs.set(0xe012, 0x0004); // 연결이 끊긴 사이 C3 로 바뀜 (알림 없음)
    f.st.sock!.destroy();
    await until(() => f.st.conns === 2 && lan.status().programInput === 3);
  });

  it('터치 화면(0x50)·다른 공간 알림이 섞여도 응답하고 무시', async () => {
    const f = fakeFrame();
    const port = await listen(f.server);
    cleanups.push(() => new Promise((r) => f.server.close(r)));
    const lan = new IkegamiLanAdapter({ host: '127.0.0.1', port, camLinks: CAMS });
    cleanups.push(() => lan.disconnect());
    await lan.connect();
    await until(() => lan.status().connected);
    const acks = f.st.acks;
    f.notify(0x50, 0, [[0xe140, [1, 9, 0xd4, 0xd4, 0xd4, 1]]]);
    f.notify(0x50, 1, [[0xe012, [0x0001]]]); // 다른 공간의 같은 주소는 탈리 아님
    f.set(0x0002);
    await until(() => lan.status().programInput === 2);
    expect(f.st.acks - acks).toBe(3);
  });

  it('10초마다 보내는 감시 요청 (연결 유지)', async () => {
    const f = fakeFrame();
    const port = await listen(f.server);
    cleanups.push(() => new Promise((r) => f.server.close(r)));
    const lan = new IkegamiLanAdapter({ host: '127.0.0.1', port, camLinks: CAMS, heartbeatMs: 40 });
    cleanups.push(() => lan.disconnect());
    await lan.connect();
    await until(() => f.st.watches >= 5);
  });

  it('프레임이 응답을 멈추면(랜선 빠짐 등) 옛 탈리를 버리고 다시 연결', async () => {
    const f = fakeFrame();
    const port = await listen(f.server);
    cleanups.push(() => new Promise((r) => f.server.close(r)));
    const lan = new IkegamiLanAdapter({ host: '127.0.0.1', port, camLinks: CAMS, heartbeatMs: 40, retryMs: 30 });
    cleanups.push(() => lan.disconnect());
    const seen: Array<ReturnType<typeof lan.status>> = [];
    lan.onStatus((s) => seen.push(s));
    await lan.connect();
    await until(() => lan.status().connected);
    f.set(0x0001);
    await until(() => lan.status().programInput === 1);
    f.st.mute = true; // 감시 요청 확인(DC)이 더는 안 옴
    await until(() => seen.some((s) => s.lastError?.includes('응답 없음')));
    expect(seen.find((s) => s.lastError?.includes('응답 없음'))).toMatchObject({ connected: false, programInput: null, onAirInputs: undefined });
    f.st.mute = false;
    await until(() => f.st.conns >= 2 && lan.status().programInput === 1);
  });

  it('프레임이 거부하면(터치 화면이 붙어 있음) 알기 쉬운 안내 + 다시 시도', async () => {
    const f = fakeFrame();
    const port = await listen(f.server);
    await new Promise((r) => f.server.close(r)); // 빈 포트 → 연결 거부
    const lan = new IkegamiLanAdapter({ host: '127.0.0.1', port, camLinks: CAMS, retryMs: 30 });
    cleanups.push(() => lan.disconnect());
    await expect(lan.connect()).rejects.toThrow();
    expect(lan.status()).toMatchObject({ connected: false });
    expect(lan.status().lastError).toContain('터치 화면');
  });

  it('탈리 값을 받기 전에는 연결 안 됨으로 보고 (카메라 외 소스로 잘못 보이지 않게)', async () => {
    const server = createServer((sock) => sock.on('error', () => {}).resume()); // 받기만 하고 아무 응답 없는 서버
    const port = await listen(server);
    cleanups.push(() => new Promise((r) => server.close(r)));
    const lan = new IkegamiLanAdapter({ host: '127.0.0.1', port, camLinks: CAMS, replyTimeoutMs: 60_000 });
    cleanups.push(() => lan.disconnect());
    await lan.connect();
    expect(lan.status()).toMatchObject({ connected: false, model: 'Ikegami 랜 탈리 · 첫 송출 정보를 기다리는 중' });
  });
});

describe('이케가미 랜 탈리 · 설정 · 런타임', () => {
  it('SWITCHER=ikegami-lan 해석', () => {
    const r = resolveDevices(
      readDeviceSettings({ SWITCHER: 'ikegami-lan', IKEGAMI_LAN_HOST: '192.168.1.59', IKEGAMI_LAN_CAM_LINKS: '1,2,3,4,12,13,14,15', IKEGAMI_LAN_NAMES: '6=X2,10=PPT' }),
    );
    expect(r.errors).toEqual([]);
    expect(r.switcher).toEqual({ kind: 'ikegami-lan', host: '192.168.1.59', camLinks: CAMS, names: { 6: 'X2', 10: 'PPT' }, myId: 0x51 });
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'ikegami-lan' })).errors[0]).toContain('IKEGAMI_LAN_HOST');
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'ikegami-lan', IKEGAMI_LAN_HOST: 'x', IKEGAMI_LAN_CAM_LINKS: '1,17' })).errors[0]).toContain('0~16');
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'ikegami-lan', IKEGAMI_LAN_HOST: 'x', IKEGAMI_LAN_ID: '0x50' })).errors[0]).toContain('0x50');
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'ikegami-lan', IKEGAMI_LAN_HOST: 'x', IKEGAMI_LAN_NAMES: 'PPT' })).errors[0]).toContain('IKEGAMI_LAN_NAMES');
  });

  it('mock → 컷을 보내지 않는 가상 스위처', async () => {
    const dm = new DeviceManager({ env: { SWITCHER: 'ikegami-lan', IKEGAMI_LAN_HOST: 'mock' }, configPath: null });
    cleanups.push(() => dm.stop());
    await dm.start();
    await until(() => dm.switcher.status().connected);
    expect(dm.switcher.status()).toMatchObject({ mode: 'mock', tallyOnly: true });
    await expect(dm.testTake(1)).rejects.toThrow('탈리만'); // 장비 연결 화면의 시험 컷도 보내지 않음
  });

  it('런타임: 실제 탈리 + 카메라 외 소스 이름, 컷 명령은 보내지 않음', async () => {
    const f = fakeFrame();
    const port = await listen(f.server);
    cleanups.push(() => new Promise((r) => f.server.close(r)));
    const lan = new IkegamiLanAdapter({ host: '127.0.0.1', port, camLinks: CAMS, names: { 10: 'PPT' } });
    cleanups.push(() => lan.disconnect());
    await lan.connect();
    await until(() => lan.status().connected);
    const rt = new ShowRuntime({ atem: lan, timecode: new ManualTimecodeSource(), log: () => {} });
    cleanups.push(() => rt.stop());
    expect(rt.tally()).toMatchObject({ program: null, onAir: [], source: 'atem', onAirLabels: ['PPT'] });
    f.set(0x1000); // 링크 13 = CAM6
    await until(() => rt.tally().program === 6);
    expect(rt.tally().onAirLabels).toBeUndefined();
    expect(rt.snapshot().atem.tallyOnly).toBe(true);
  });

  it('TallyOnlyAdapter 로 감싼 mock 은 상태만 전달', () => {
    const t = new TallyOnlyAdapter(new MockAtemAdapter({ transitionMs: 0, latencyMs: 0 }));
    expect(t.status().tallyOnly).toBe(true);
  });
});
