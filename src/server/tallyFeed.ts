// 기기용 탈리 통로 — M5StickC Plus 같은 작은 탈리 램프가 자기 카메라 상태만 가볍게 받는다.
//   GET /api/tally?cam=N          → 지금 상태 한 번 (JSON)
//   GET /api/tally/stream?cam=N   → 바뀔 때마다 한 줄 (text/event-stream)
//       data: v=1&cam=1&st=pgm&real=1&rh=0&shot=MS&next=WS&in=3&now=
// 폰 화면(/ws)은 큐시트 전체를 받지만 작은 기기는 메모리가 적어 이 형식(URL 인코딩 한 줄)만 받는다.
// 기기는 HTTP/1.0 으로 요청한다 → Node 가 chunked 로 나누지 않아 받은 그대로 한 줄씩 읽으면 된다.
// 연결 확인용으로 몇 초마다 주석 줄(": ka")을 보낸다. 기기는 한동안 아무것도 안 오면 끊긴 것으로 본다.
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { cameraView } from '../shared/engine';
import { isRealTally, type ShowSnapshot } from '../shared/protocol';
import { MAX_CAMERA, MIN_CAMERA, type Service } from '../shared/types';
import type { ShowRuntime } from './runtime';

export interface DeviceTally {
  cam: number;
  /** pgm = 내 카메라 송출 중 · pvw = PVW (스위처가 실제 PVW 를 알려 줄 때만) · off = 그 외 */
  st: 'pgm' | 'pvw' | 'off';
  /** 스위처·GPI 가 알려 준 실제 탈리인가 (false 면 큐 진행·캠큐 명령 기준 추정) */
  real: boolean;
  /** 리허설 모드 */
  rh: boolean;
  /** 지금 큐가 내 카메라 큐면 그 샷 (MS 등), 아니면 '' */
  shot: string;
  /** 다음 내 샷 (없으면 '') */
  next: string;
  /** 다음 내 큐까지 몇 큐 남았는지 (1 = 바로 다음, 없으면 -1) */
  in: number;
  /** 내가 송출 중이 아닐 때 지금 나가는 것 ("CAM 2", "PPT", "카메라 외 소스") */
  now: string;
}

/** 실제 스위처 PVW 를 아는 모드 (CueScreen 과 같은 기준) */
const PVW_MODES: ReadonlySet<string> = new Set(['real', 'mock', 'vmix', 'obs']);

export function deviceTally(snapshot: ShowSnapshot, service: Service | null, cam: number): DeviceTally {
  const { tally, atem, rehearsal, state } = snapshot;
  const onAir = tally.onAir ?? (tally.program === null ? [] : [tally.program]);
  const mine = onAir.includes(cam);
  const pvw = !mine && atem.connected && PVW_MODES.has(atem.mode) && tally.preview === cam;
  const real = isRealTally(tally);
  const view = service ? cameraView(service, state, snapshot.serverTime, cam) : null;
  const others = [...onAir.filter((n) => n !== cam).map((n) => `CAM ${n}`), ...(tally.onAirLabels ?? [])];
  return {
    cam,
    st: mine ? 'pgm' : pvw ? 'pvw' : 'off',
    real,
    rh: rehearsal,
    shot: view?.current?.shotSize ?? '',
    next: view?.next?.cue.shotSize ?? '',
    in: view?.next?.cuesAway ?? -1,
    now: mine ? '' : others.join(' + ') || (real && !rehearsal ? '카메라 외 소스' : ''),
  };
}

/** 기기로 보내는 한 줄 (application/x-www-form-urlencoded) */
export function encodeDeviceTally(t: DeviceTally): string {
  return new URLSearchParams({
    v: '1',
    cam: String(t.cam),
    st: t.st,
    real: t.real ? '1' : '0',
    rh: t.rh ? '1' : '0',
    shot: t.shot,
    next: t.next,
    in: String(t.in),
    now: t.now,
  }).toString();
}

const camOf = (query: unknown): number | null => {
  const n = Number((query as { cam?: unknown } | undefined)?.cam);
  return Number.isInteger(n) && n >= MIN_CAMERA && n <= MAX_CAMERA ? n : null;
};

interface StreamClient {
  cam: number;
  res: ServerResponse;
  last: string;
}

export function registerTallyRoutes(app: FastifyInstance, runtime: ShowRuntime, opts: { keepAliveMs?: number } = {}) {
  const badCam = { error: `cam: ${MIN_CAMERA}~${MAX_CAMERA} 사이의 카메라 번호가 필요합니다 (예: /api/tally?cam=1)` };
  const clients = new Set<StreamClient>();

  const write = (c: StreamClient, chunk: string) => {
    if (c.res.writableEnded || c.res.destroyed) return clients.delete(c);
    c.res.write(chunk);
  };
  const push = (snapshot: ShowSnapshot = runtime.snapshot()) => {
    for (const c of clients) {
      const line = encodeDeviceTally(deviceTally(snapshot, runtime.service, c.cam));
      if (line === c.last) continue; // 바뀐 것만 보낸다
      c.last = line;
      write(c, `data: ${line}\n\n`);
    }
  };
  const onService = () => push();
  runtime.on('state', push);
  runtime.on('service', onService);
  const keepAlive = setInterval(() => {
    for (const c of clients) write(c, ': ka\n\n');
  }, opts.keepAliveMs ?? 4000);
  keepAlive.unref();
  app.addHook('onClose', async () => {
    clearInterval(keepAlive);
    runtime.off('state', push);
    runtime.off('service', onService);
    for (const c of clients) c.res.end();
    clients.clear();
  });

  app.get('/api/tally', async (req, reply) => {
    const cam = camOf(req.query);
    if (cam === null) return reply.status(400).send(badCam);
    return deviceTally(runtime.snapshot(), runtime.service, cam);
  });

  app.get('/api/tally/stream', (req, reply) => {
    const cam = camOf(req.query);
    if (cam === null) return reply.status(400).send(badCam);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.socket?.setNoDelay(true);
    const c: StreamClient = { cam, res, last: encodeDeviceTally(deviceTally(runtime.snapshot(), runtime.service, cam)) };
    clients.add(c);
    res.on('error', () => clients.delete(c));
    req.raw.on('close', () => clients.delete(c));
    res.write(`retry: 2000\ndata: ${c.last}\n\n`);
  });

  return { clientCount: () => clients.size };
}
