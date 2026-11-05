// vMix · OBS 어댑터: 가짜 서버(프로토콜 문서 기준)로 컷·탈리·인증 확인
import { createHash } from 'node:crypto';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { readDeviceSettings, resolveDevices } from '../src/server/devices/config';
import { DeviceManager } from '../src/server/devices/manager';
import { ObsAdapter, obsAuth } from '../src/server/devices/obs';
import { parseVmixTally, VmixAdapter } from '../src/server/devices/vmix';
import { SECRET_MASK } from '../src/shared/devices';

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

/** 가짜 vMix: 입력 tally 를 들고 있다가 PreviewInput/Cut 에 반응 */
function fakeVmix(inputs = 10) {
  const state = { program: 1, preview: 2, received: [] as string[], subscribed: new Set<Socket>() };
  const tally = () => Array.from({ length: inputs }, (_, i) => (i + 1 === state.program ? '1' : i + 1 === state.preview ? '2' : '0')).join('');
  const push = () => state.subscribed.forEach((s) => s.write(`TALLY OK ${tally()}\r\n`));
  const server: Server = createServer((sock) => {
    sock.on('error', () => {});
    sock.write('VERSION OK 27.0.0.49\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        state.received.push(line);
        if (line === 'SUBSCRIBE TALLY') {
          state.subscribed.add(sock);
          sock.write('SUBSCRIBE OK TALLY\r\n');
        } else if (line === 'TALLY') sock.write(`TALLY OK ${tally()}\r\n`);
        else if (line.startsWith('FUNCTION PreviewInput Input=')) {
          const n = Number(line.split('=')[1]);
          if (n > inputs) sock.write('FUNCTION ER Input not found\r\n');
          else {
            state.preview = n;
            sock.write('FUNCTION OK Completed\r\n');
            push();
          }
        } else if (line === 'FUNCTION Cut' || line === 'FUNCTION Transition1') {
          [state.program, state.preview] = [state.preview, state.program];
          sock.write('FUNCTION OK Completed\r\n');
          push();
        }
      }
    });
  });
  return { server, state, push };
}

const listen = (server: Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));

describe('vMix', () => {
  it('parseVmixTally: 0 꺼짐 / 1 PGM / 2 PVW (입력 1번부터)', () => {
    expect(parseVmixTally('0121')).toEqual({ program: [2, 4], preview: [3] });
  });

  it('연결 → 탈리를 CAM 번호로, 컷 → PreviewInput + Cut, PPT 송출은 카메라 아님', async () => {
    const fake = fakeVmix();
    const port = await listen(fake.server);
    cleanups.push(() => new Promise((r) => fake.server.close(r)));
    // CAM1 = 입력 3, CAM2 = 입력 1, CAM3 = 입력 2
    const vmix = new VmixAdapter({ host: '127.0.0.1', port, camInputs: [3, 1, 2] });
    cleanups.push(() => vmix.disconnect());
    await vmix.connect();
    await until(() => vmix.status().programInput !== null);
    expect(vmix.status()).toMatchObject({ mode: 'vmix', connected: true, model: 'vMix 27.0.0.49', programInput: 2, previewInput: 3, onAirInputs: [2] });

    await vmix.setPreview(1);
    await vmix.cut();
    await until(() => vmix.status().programInput === 1);
    expect(fake.state.received).toContain('FUNCTION PreviewInput Input=3');
    expect(fake.state.received).toContain('FUNCTION Cut');

    await vmix.setPreview(3);
    await vmix.autoTransition();
    expect(fake.state.received).toContain('FUNCTION Transition1');

    // 운영자가 vMix 에서 직접 입력 7 (PPT) 로 컷
    fake.state.program = 7;
    fake.push();
    await until(() => vmix.status().onAirInputs?.length === 0);
    expect(vmix.status().programInput).toBeNull();
  });

  it('vMix 오류 응답은 명령 실패로, 매핑 없는 카메라는 보내기 전에 오류', async () => {
    const fake = fakeVmix(4);
    const port = await listen(fake.server);
    cleanups.push(() => new Promise((r) => fake.server.close(r)));
    const vmix = new VmixAdapter({ host: '127.0.0.1', port, camInputs: [1, 9] });
    cleanups.push(() => vmix.disconnect());
    await vmix.connect();
    await expect(vmix.setPreview(2)).rejects.toThrow('Input not found');
    await expect(vmix.setPreview(5)).rejects.toThrow('VMIX_CAM_INPUTS');
    expect(vmix.capabilities().cameras).toEqual([1, 2]);
  });

  it('vMix 가 꺼졌다 켜지면 다시 연결', async () => {
    const fake = fakeVmix();
    const port = await listen(fake.server);
    cleanups.push(() => new Promise((r) => fake.server.close(r)));
    const vmix = new VmixAdapter({ host: '127.0.0.1', port, camInputs: [1, 2], retryMs: 30 });
    cleanups.push(() => vmix.disconnect());
    await vmix.connect();
    await until(() => vmix.status().programInput === 1);
    fake.state.subscribed.forEach((s) => s.destroy());
    await until(() => !vmix.status().connected);
    expect(vmix.status().lastError).toContain('끊김');
    await until(() => vmix.status().connected && vmix.status().programInput === 1);
  });
});

/** 가짜 OBS (obs-websocket v5) */
async function fakeObs(password?: string) {
  const state = { program: 'CAM 1', preview: 'CAM 2', studio: true, requests: [] as Array<{ type: string; data?: any }> };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const clients = new Set<WebSocket>();
  const event = (eventType: string, eventData: object) =>
    clients.forEach((c) => c.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 4, eventData } })));
  wss.on('connection', (ws) => {
    const salt = 'c2FsdA==';
    const challenge = 'Y2hhbGxlbmdl';
    ws.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1, ...(password ? { authentication: { salt, challenge } } : {}) } }));
    ws.on('message', (raw) => {
      const { op, d } = JSON.parse(raw.toString());
      if (op === 1) {
        if (password && d.authentication !== obsAuth(password, salt, challenge)) return ws.close(4009, 'Authentication failed.');
        clients.add(ws);
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (op !== 6) return;
      state.requests.push({ type: d.requestType, data: d.requestData });
      let responseData: object = {};
      let ok = true;
      switch (d.requestType) {
        case 'GetCurrentProgramScene':
          responseData = { currentProgramSceneName: state.program };
          break;
        case 'GetStudioModeEnabled':
          responseData = { studioModeEnabled: state.studio };
          break;
        case 'GetCurrentPreviewScene':
          if (!state.studio) ok = false;
          else responseData = { currentPreviewSceneName: state.preview };
          break;
        case 'SetCurrentPreviewScene':
          state.preview = d.requestData.sceneName;
          event('CurrentPreviewSceneChanged', { sceneName: state.preview });
          break;
        case 'SetCurrentProgramScene':
          if (d.requestData.sceneName === 'NOPE') ok = false;
          else {
            state.program = d.requestData.sceneName;
            event('CurrentProgramSceneChanged', { sceneName: state.program });
          }
          break;
        case 'TriggerStudioModeTransition':
          [state.program, state.preview] = [state.preview, state.program];
          event('CurrentProgramSceneChanged', { sceneName: state.program });
          event('CurrentPreviewSceneChanged', { sceneName: state.preview });
          break;
      }
      ws.send(
        JSON.stringify({
          op: 7,
          d: { requestType: d.requestType, requestId: d.requestId, requestStatus: ok ? { result: true, code: 100 } : { result: false, code: 600, comment: 'No source was found' }, responseData },
        }),
      );
    });
  });
  const port = (wss.address() as AddressInfo).port;
  cleanups.push(() => new Promise((r) => wss.close(r)));
  return { port, state, event, wss };
}

describe('OBS', () => {
  it('obsAuth: base64(sha256(base64(sha256(pw+salt)) + challenge))', () => {
    // obs-websocket 문서 방식대로 node crypto 로 직접 계산한 값과 비교
    const secret = createHash('sha256').update('pwsalt').digest('base64');
    expect(obsAuth('pw', 'salt', 'ch')).toBe(createHash('sha256').update(secret + 'ch').digest('base64'));
  });

  it('비밀번호 인증 → 장면을 CAM 으로, 스튜디오 모드 컷·AUTO', async () => {
    const fake = await fakeObs('secret');
    const obs = new ObsAdapter({ host: '127.0.0.1', port: fake.port, password: 'secret', camScenes: ['CAM 1', 'CAM 2', 'Jib'] });
    cleanups.push(() => obs.disconnect());
    await obs.connect();
    expect(obs.status()).toMatchObject({ mode: 'obs', connected: true, programInput: 1, previewInput: 2, onAirInputs: [1] });
    expect(obs.status().model).toContain('스튜디오 모드');

    await obs.setPreview(3);
    await until(() => obs.status().previewInput === 3);
    await obs.cut();
    await until(() => obs.status().programInput === 3);
    expect(fake.state.requests.map((r) => r.type)).toEqual(
      expect.arrayContaining(['SetCurrentPreviewScene', 'SetCurrentProgramScene']),
    );

    await obs.setPreview(2);
    await obs.autoTransition();
    await until(() => obs.status().programInput === 2);
    expect(fake.state.requests.some((r) => r.type === 'TriggerStudioModeTransition')).toBe(true);

    // 운영자가 OBS 에서 PPT 장면으로 전환 → 카메라 아님
    fake.event('CurrentProgramSceneChanged', { sceneName: 'PPT' });
    await until(() => obs.status().programInput === null);
    expect(obs.status().onAirInputs).toEqual([]);
  });

  it('스튜디오 모드 꺼짐: setPreview 는 기억만, 컷 = 프로그램 장면 변경', async () => {
    const fake = await fakeObs();
    fake.state.studio = false;
    const obs = new ObsAdapter({ host: '127.0.0.1', port: fake.port, camScenes: ['CAM 1', 'CAM 2'] });
    cleanups.push(() => obs.disconnect());
    await obs.connect();
    expect(obs.status()).toMatchObject({ programInput: 1, previewInput: null });
    await obs.setPreview(2);
    expect(obs.status().previewInput).toBe(2);
    expect(fake.state.requests.some((r) => r.type === 'SetCurrentPreviewScene')).toBe(false);
    await obs.autoTransition();
    await until(() => obs.status().programInput === 2);
    expect(fake.state.requests.at(-1)).toEqual({ type: 'SetCurrentProgramScene', data: { sceneName: 'CAM 2' } });
  });

  it('비밀번호 틀림 / 없음 → 알아볼 수 있는 오류', async () => {
    const fake = await fakeObs('secret');
    const wrong = new ObsAdapter({ host: '127.0.0.1', port: fake.port, password: 'nope', camScenes: ['CAM 1'], retryMs: 60_000 });
    cleanups.push(() => wrong.disconnect());
    await expect(wrong.connect()).rejects.toThrow('비밀번호가 맞지 않습니다');
    const none = new ObsAdapter({ host: '127.0.0.1', port: fake.port, camScenes: ['CAM 1'], retryMs: 60_000 });
    cleanups.push(() => none.disconnect());
    await expect(none.connect()).rejects.toThrow('OBS_PASSWORD');
  });

  it('OBS 오류 응답은 명령 실패로', async () => {
    const fake = await fakeObs();
    const obs = new ObsAdapter({ host: '127.0.0.1', port: fake.port, camScenes: ['CAM 1', 'NOPE'] });
    cleanups.push(() => obs.disconnect());
    await obs.connect();
    fake.state.studio = false;
    fake.event('StudioModeStateChanged', { studioModeEnabled: false });
    await until(() => !obs.status().model?.includes('스튜디오'));
    await obs.setPreview(2);
    await expect(obs.cut()).rejects.toThrow('No source was found');
  });
});

describe('vMix · OBS 설정', () => {
  it('SWITCHER=vmix / obs 해석', () => {
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'vmix', VMIX_HOST: '192.168.0.10:8100', VMIX_CAM_INPUTS: '3,0,5', VMIX_TALLY_ONLY: '1' })).switcher).toEqual({
      kind: 'vmix',
      host: '192.168.0.10',
      port: 8100,
      camInputs: [3, 0, 5],
      tallyOnly: true,
    });
    const obs = resolveDevices(readDeviceSettings({ SWITCHER: 'obs', OBS_HOST: '127.0.0.1', OBS_PASSWORD: 'pw', OBS_CAM_SCENES: 'Cam A, ,Jib' }));
    expect(obs.errors).toEqual([]);
    expect(obs.switcher).toEqual({ kind: 'obs', host: '127.0.0.1', password: 'pw', camScenes: ['Cam A', '', 'Jib'], tallyOnly: false });
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'obs' })).errors[0]).toContain('OBS_HOST');
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'obs', OBS_HOST: 'x', OBS_CAM_SCENES: 'A,A' })).errors[0]).toContain('같은 장면');
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'vmix', VMIX_HOST: 'a b' })).errors[0]).toContain('VMIX_HOST');
  });

  it('mock → 가상 스위처, 탈리만 읽기 → 컷 안 보냄, 비밀번호는 화면에 가림', async () => {
    const env: NodeJS.ProcessEnv = { SWITCHER: 'obs', OBS_HOST: 'mock', OBS_PASSWORD: 'pw', OBS_TALLY_ONLY: '1' };
    const dm = new DeviceManager({ env, configPath: null });
    cleanups.push(() => dm.stop());
    await dm.start();
    await until(() => dm.switcher.status().connected);
    expect(dm.switcher.status()).toMatchObject({ mode: 'mock', tallyOnly: true });
    const snap = dm.snapshot({ program: null, preview: null, onAir: [], source: 'engine' });
    expect(snap.settings.OBS_PASSWORD).toBe(SECRET_MASK);
    // 가린 값을 그대로 저장하면 비밀번호 유지, 새 값이면 교체
    await dm.apply({ ...snap.settings });
    expect(dm.config.switcher).toMatchObject({ kind: 'obs', password: 'pw' });
    await dm.apply({ OBS_PASSWORD: 'new' });
    expect(dm.config.switcher).toMatchObject({ password: 'new' });
  });
});
