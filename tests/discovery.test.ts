import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app';
import { DisabledAtemAdapter } from '../src/server/atem';
import { DISCOVERY_QUERY, discoveryInfo, startDiscoveryResponder } from '../src/server/discovery';
import { ShowRuntime } from '../src/server/runtime';
import { ManualTimecodeSource } from '../src/server/timecode';
import { APP_VERSION } from '../src/shared/version';

/** UDP 로 질의하고 응답 하나를 기다림 (없으면 null) */
function ask(port: number, text: string, timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    const t = setTimeout(() => (sock.close(), resolve(null)), timeoutMs);
    sock.on('message', (m) => {
      clearTimeout(t);
      sock.close();
      resolve(m.toString('utf8'));
    });
    sock.send(Buffer.from(text), port, '127.0.0.1');
  });
}

describe('폰 앱 자동 검색 (UDP)', () => {
  it('CAMCUE_DISCOVER 에 서버 정보로 응답, 다른 메시지는 무시', async () => {
    let port = 38080;
    const r = await startDiscoveryResponder(() => discoveryInfo(port, 'http'), 0);
    try {
      const reply = JSON.parse((await ask(r.port, DISCOVERY_QUERY))!);
      expect(reply).toMatchObject({ app: 'CamCue', version: APP_VERSION, port: 38080, proto: 'http' });
      expect(typeof reply.name).toBe('string');
      // 포트가 바뀌면 응답도 바뀜 (서버 포트 자동 변경 대응)
      port = 38090;
      expect(JSON.parse((await ask(r.port, DISCOVERY_QUERY))!).port).toBe(38090);
      expect(await ask(r.port, 'HELLO')).toBeNull();
    } finally {
      await r.close();
    }
  });
});

describe('안드로이드 앱 내려받기', () => {
  const dir = mkdtempSync(join(tmpdir(), 'camcue-apk-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new ShowRuntime({ atem: new DisabledAtemAdapter(), timecode: new ManualTimecodeSource() });

  it('APK 가 없으면 404 + info.apk=false, 있으면 내려받기', async () => {
    const apkPath = join(dir, 'camcue.apk');
    const app = await buildApp({ repo: {} as never, runtime, apkPath });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/info' })).json().apk).toBe(false);
      expect((await app.inject({ method: 'GET', url: '/app' })).statusCode).toBe(404);

      writeFileSync(apkPath, Buffer.from('PK\x03\x04fake-apk'));
      expect((await app.inject({ method: 'GET', url: '/api/info' })).json().apk).toBe(true);
      const res = await app.inject({ method: 'GET', url: '/app' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
      expect(res.headers['content-disposition']).toContain(`CamCue-v${APP_VERSION}.apk`);
      expect(res.rawPayload.subarray(0, 4).toString('latin1')).toBe('PK\x03\x04');
      expect((await app.inject({ method: 'GET', url: '/app/camcue.apk' })).statusCode).toBe(200);

      // 앱이 네트워크 스캔으로 서버를 알아보는 health 응답
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ ok: true, app: 'CamCue', version: APP_VERSION });
    } finally {
      await app.close();
      runtime.stop();
    }
  });
});
