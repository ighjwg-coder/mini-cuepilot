import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { isCamCueRunning, listenWithFallback } from '../src/server/listen';

const err = (code: string) => Object.assign(new Error(code), { code });

describe('listenWithFallback (포트 자동 선택)', () => {
  it('원래 포트가 되면 그대로', async () => {
    const r = await listenWithFallback(async (p) => p, 3000);
    expect(r).toEqual({ port: 3000, failed: [] });
  });

  it('Windows 예약 포트(EACCES)·사용 중(EADDRINUSE)이면 다음 후보로', async () => {
    const tried: number[] = [];
    const r = await listenWithFallback(
      async (p) => {
        tried.push(p);
        if (p === 3000) throw err('EACCES');
        if (p === 8090) throw err('EADDRINUSE');
        return p;
      },
      3000,
      { candidates: [8090, 8080] },
    );
    expect(tried).toEqual([3000, 8090, 8080]);
    expect(r).toEqual({ port: 8080, failed: [{ port: 3000, code: 'EACCES' }, { port: 8090, code: 'EADDRINUSE' }] });
  });

  it('후보가 모두 막히면 OS 가 고른 포트(0)', async () => {
    const r = await listenWithFallback(async (p) => (p === 0 ? 51234 : Promise.reject(err('EACCES'))), 3000, { candidates: [8090] });
    expect(r.port).toBe(51234);
    expect(r.failed.map((f) => f.port)).toEqual([3000, 8090]);
  });

  it('다른 종류의 에러는 바로 던짐', async () => {
    await expect(listenWithFallback(async () => Promise.reject(err('EINVAL')), 3000)).rejects.toThrow('EINVAL');
  });

  it('shouldStop 이 true 면 중단 (이미 실행 중인 CamCue 감지용)', async () => {
    await expect(
      listenWithFallback(async () => Promise.reject(err('EADDRINUSE')), 3000, { shouldStop: async () => true }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('실제 소켓: 점유된 포트를 피해 바인딩', async () => {
    // 앱과 같은 주소(0.0.0.0)로 점유해야 함. Windows 는 [::] 와 0.0.0.0 이 같은 포트를 동시에 바인딩할 수 있음
    const blocker = net.createServer().listen(0, '0.0.0.0');
    await new Promise((r) => blocker.once('listening', r));
    const busy = (blocker.address() as net.AddressInfo).port;
    const server = net.createServer();
    const listen = (p: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '0.0.0.0', () => {
          server.off('error', reject);
          resolve((server.address() as net.AddressInfo).port);
        });
      });
    const r = await listenWithFallback(listen, busy, { candidates: [] });
    expect(r.port).not.toBe(busy);
    expect(r.failed).toEqual([{ port: busy, code: 'EADDRINUSE' }]);
    server.close();
    blocker.close();
  });
});

describe('isCamCueRunning', () => {
  it('응답 없는 포트는 false', async () => {
    const s = net.createServer().listen(0);
    await new Promise((r) => s.once('listening', r));
    const port = (s.address() as net.AddressInfo).port;
    s.close();
    expect(await isCamCueRunning(port, 300)).toBe(false);
  });
});
