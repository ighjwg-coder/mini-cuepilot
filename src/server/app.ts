// Fastify 앱 조립: REST API + WebSocket + (빌드된) 웹 정적 파일
import { createReadStream, existsSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { commandSchema, formatZodError, parseImport, serviceInputSchema, toExportFile } from '../shared/schema';
import { APP_NAME, APP_VERSION } from '../shared/version';
import type { DeviceManager } from './devices/manager';
import { listSerialPorts } from './devices/serial';
import { ConflictError, type ServiceRepo } from './repo';
import type { ShowRuntime } from './runtime';
import { attachWebSocket } from './ws';

export interface AppDeps {
  repo: ServiceRepo;
  runtime: ShowRuntime;
  /** 장비 연결 화면 API. 없으면 /api/devices 미제공 (테스트) */
  devices?: DeviceManager;
  /** 안드로이드 앱 APK 경로. 파일이 있으면 /app 으로 내려받기 제공 */
  apkPath?: string;
  /** vite build 결과물 경로. 존재하면 정적 서빙 + SPA fallback */
  webDir?: string;
  /** true = 전체 요청 로그, { level } = 지정 수준 이상만 */
  logger?: boolean | { level: string };
  /** 지정 시 HTTPS 로 서비스 (폰에서 Wake Lock API 사용 가능) */
  https?: { key: Buffer; cert: Buffer };
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, formatZodError(r.error));
  return r.data;
}

export async function buildApp({ repo, runtime, devices, apkPath, webDir, logger = false, https }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024, ...(https ? { https } : {}) }) as unknown as FastifyInstance;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof ConflictError) return reply.status(409).send({ error: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: formatZodError(err) });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: '서버 오류' });
  });

  const ws = attachWebSocket(app.server, runtime);
  app.addHook('onClose', async () => ws.close());

  // ── 상태 ──
  // app/name: 폰 앱이 네트워크 스캔으로 CamCue 서버를 알아보는 데 사용
  app.get('/api/health', async () => ({ ok: true, app: APP_NAME, name: hostname(), version: APP_VERSION, wsClients: ws.clientCount() }));
  app.get('/api/atem', async () => runtime.snapshot().atem);

  /** 폰 접속용 LAN 주소. 포트는 요청 Host 헤더 기준(개발 모드 Vite 5173 / 운영 38080 모두 대응) */
  app.get('/api/info', async (req) => {
    const port = (req.headers.host ?? '').split(':')[1] ?? '80';
    const lanUrls = Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i!.address}${port === '80' ? '' : `:${port}`}`);
    return { lanUrls, apk: apkAvailable() };
  });

  // ── 안드로이드 앱 내려받기 ──
  const apkAvailable = () => !!apkPath && existsSync(apkPath);
  const sendApk = async (_req: unknown, reply: import('fastify').FastifyReply) => {
    if (!apkAvailable()) throw new HttpError(404, '이 버전에는 안드로이드 앱 설치 파일이 들어 있지 않습니다');
    return reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-length', statSync(apkPath!).size)
      .header('content-disposition', `attachment; filename="CamCue-v${APP_VERSION}.apk"`)
      .send(createReadStream(apkPath!));
  };
  app.get('/app', sendApk);
  app.get('/app/camcue.apk', sendApk);

  // ── 행사(큐시트) CRUD ──
  app.get('/api/services', async () => repo.list());

  app.post('/api/services', async (req, reply) => {
    const input = parse(serviceInputSchema, { acts: [], ...(req.body as object) });
    return reply.status(201).send(await repo.create(input));
  });

  app.get<{ Params: { id: string } }>('/api/services/:id', async (req) => {
    const service = await repo.get(req.params.id);
    if (!service) throw new HttpError(404, '행사를 찾을 수 없습니다');
    return service;
  });

  app.put<{ Params: { id: string } }>('/api/services/:id', async (req) => {
    const input = parse(serviceInputSchema, req.body);
    const saved = await repo.save(req.params.id, input);
    if (!saved) throw new HttpError(404, '행사를 찾을 수 없습니다');
    runtime.updateService(saved);
    return saved;
  });

  app.delete<{ Params: { id: string } }>('/api/services/:id', async (req, reply) => {
    if (!(await repo.remove(req.params.id))) throw new HttpError(404, '행사를 찾을 수 없습니다');
    runtime.unloadIf(req.params.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/export', async (req, reply) => {
    const service = await repo.get(req.params.id);
    if (!service) throw new HttpError(404, '행사를 찾을 수 없습니다');
    const name = `${service.date ?? 'service'}-${service.title}`.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    return reply
      .header('content-disposition', `attachment; filename="service.json"; filename*=UTF-8''${encodeURIComponent(name)}.json`)
      .send(toExportFile(service));
  });

  app.post('/api/import', async (req, reply) => {
    let input;
    try {
      input = parseImport(req.body);
    } catch (err) {
      if (err instanceof ZodError) throw new HttpError(400, `가져오기 실패: ${formatZodError(err)}`);
      throw err;
    }
    return reply.status(201).send(await repo.create(input));
  });

  // ── 라이브 진행 ──
  app.get('/api/show', async () => ({ service: runtime.service, ...runtime.snapshot() }));

  app.post('/api/show/load', async (req) => {
    const { serviceId } = (req.body ?? {}) as { serviceId?: unknown };
    if (typeof serviceId !== 'string') throw new HttpError(400, 'serviceId 가 필요합니다');
    const service = await repo.get(serviceId);
    if (!service) throw new HttpError(404, '행사를 찾을 수 없습니다');
    runtime.load(service);
    return runtime.snapshot();
  });

  /** HTTP 명령 (Bitfocus Companion / Stream Deck 등 외부 컨트롤러 연동용) */
  app.post('/api/show/command', async (req) => {
    runtime.command(parse(commandSchema, req.body));
    return runtime.snapshot();
  });

  // ── 장비 연결 (스위처 · GPI · RS-422 시험) ──
  if (devices) registerDeviceRoutes(app, devices, runtime);

  // ── 웹 (운영 모드) ──
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'Not Found' });
    });
  }

  return app;
}

function registerDeviceRoutes(app: FastifyInstance, devices: DeviceManager, runtime: ShowRuntime) {
  const body = (req: { body: unknown }) => (req.body ?? {}) as Record<string, unknown>;
  const intField = (b: Record<string, unknown>, key: string, min: number, max: number) => {
    const n = b[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${key}: ${min}~${max} 정수가 필요합니다`);
    return n;
  };
  const wrap = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, (err as Error).message);
    }
    return devices.snapshot(runtime.tally());
  };

  app.get('/api/devices', async () => devices.snapshot(runtime.tally()));

  app.put('/api/devices/settings', async (req) => wrap(() => devices.apply(body(req) as Record<string, string>)));

  app.get('/api/devices/serial-ports', async () => {
    try {
      return { ports: await listSerialPorts() };
    } catch (err) {
      throw new HttpError(500, `COM 포트 목록을 읽지 못했습니다: ${(err as Error).message}`);
    }
  });

  app.get<{ Querystring: { after?: string } }>('/api/devices/serial-log', async (req) => ({
    entries: devices.logAfter(Number(req.query.after) || 0),
  }));

  app.post('/api/devices/serial/send', async (req) => {
    const hex = body(req).hex;
    if (typeof hex !== 'string') throw new HttpError(400, 'hex 가 필요합니다');
    return wrap(() => devices.sendSerial(hex));
  });

  app.post('/api/devices/test-take', async (req) => {
    const camera = intField(body(req), 'camera', 1, 8);
    return wrap(() => devices.testTake(camera));
  });

  app.post('/api/devices/gpi/pulse', async (req) => {
    const channel = intField(body(req), 'channel', 1, 64);
    return wrap(() => devices.pulse(channel));
  });

  app.post('/api/devices/gpi/mock-input', async (req) => {
    const b = body(req);
    const channel = intField(b, 'channel', 1, 64);
    if (typeof b.on !== 'boolean') throw new HttpError(400, 'on: true/false 가 필요합니다');
    return wrap(async () => devices.setMockInput(channel, b.on as boolean));
  });
}
