// Fastify 앱 조립: REST API + WebSocket + (빌드된) 웹 정적 파일
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { commandSchema, formatZodError, parseImport, serviceInputSchema, toExportFile } from '../shared/schema';
import { ConflictError, type ServiceRepo } from './repo';
import type { ShowRuntime } from './runtime';
import { attachWebSocket } from './ws';

export interface AppDeps {
  repo: ServiceRepo;
  runtime: ShowRuntime;
  /** vite build 결과물 경로. 존재하면 정적 서빙 + SPA fallback */
  webDir?: string;
  logger?: boolean;
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

export async function buildApp({ repo, runtime, webDir, logger = false }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024 });

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
  app.get('/api/health', async () => ({ ok: true, wsClients: ws.clientCount() }));
  app.get('/api/atem', async () => runtime.snapshot().atem);

  // ── 예배(큐시트) CRUD ──
  app.get('/api/services', async () => repo.list());

  app.post('/api/services', async (req, reply) => {
    const input = parse(serviceInputSchema, { acts: [], ...(req.body as object) });
    return reply.status(201).send(await repo.create(input));
  });

  app.get<{ Params: { id: string } }>('/api/services/:id', async (req) => {
    const service = await repo.get(req.params.id);
    if (!service) throw new HttpError(404, '예배를 찾을 수 없습니다');
    return service;
  });

  app.put<{ Params: { id: string } }>('/api/services/:id', async (req) => {
    const input = parse(serviceInputSchema, req.body);
    const saved = await repo.save(req.params.id, input);
    if (!saved) throw new HttpError(404, '예배를 찾을 수 없습니다');
    runtime.updateService(saved);
    return saved;
  });

  app.delete<{ Params: { id: string } }>('/api/services/:id', async (req, reply) => {
    if (!(await repo.remove(req.params.id))) throw new HttpError(404, '예배를 찾을 수 없습니다');
    runtime.unloadIf(req.params.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/services/:id/export', async (req, reply) => {
    const service = await repo.get(req.params.id);
    if (!service) throw new HttpError(404, '예배를 찾을 수 없습니다');
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
    if (!service) throw new HttpError(404, '예배를 찾을 수 없습니다');
    runtime.load(service);
    return runtime.snapshot();
  });

  /** HTTP 명령 (Bitfocus Companion / Stream Deck 등 외부 컨트롤러 연동용) */
  app.post('/api/show/command', async (req) => {
    runtime.command(parse(commandSchema, req.body));
    return runtime.snapshot();
  });

  // ── 웹 (운영 모드) ──
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'Not Found' });
    });
  }

  return app;
}
