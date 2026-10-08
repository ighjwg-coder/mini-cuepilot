import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '../src/shared/protocol';
import type { Service } from '../src/shared/types';
import { buildApp } from '../src/server/app';
import { DisabledAtemAdapter } from '../src/server/atem';
import { ServiceRepo } from '../src/server/repo';
import { ShowRuntime } from '../src/server/runtime';
import { sampleServiceInput } from '../src/server/sampleService';
import { ManualTimecodeSource } from '../src/server/timecode';
import { createTestDb } from './helpers/db';

const db = createTestDb();
const repo = new ServiceRepo(db.prisma);
const runtime = new ShowRuntime({ atem: new DisabledAtemAdapter(), timecode: new ManualTimecodeSource() });
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = await buildApp({ repo, runtime });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  runtime.stop();
  await app.close();
  await db.cleanup();
});

/** 메시지를 순서대로 기다릴 수 있는 WS 클라이언트 */
async function connect() {
  const ws = new WebSocket(`ws://${baseUrl}/ws`);
  const inbox: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d) => {
    inbox.push(JSON.parse(d.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  const next = async <T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) => {
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type && pred(m as Extract<ServerMessage, { type: T }>));
      if (i >= 0) return inbox.splice(0, i + 1).at(-1) as Extract<ServerMessage, { type: T }>;
      await new Promise<void>((r, j) => {
        const t = setTimeout(() => j(new Error(`timeout waiting ${type}`)), 2000);
        waiters.push(() => (clearTimeout(t), r()));
      });
    }
  };
  return { ws, next, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe('REST API', () => {
  let svc: Service;

  it('예배 생성/목록/조회', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/import', payload: sampleServiceInput });
    expect(res.statusCode).toBe(201);
    svc = res.json();
    const list = (await app.inject('/api/services')).json();
    expect(list.map((s: { id: string }) => s.id)).toContain(svc.id);
    expect((await app.inject(`/api/services/${svc.id}`)).json().acts).toHaveLength(5);
    expect((await app.inject('/api/services/none')).statusCode).toBe(404);
  });

  it('빈 예배 생성', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/services', payload: { title: '새 예배', date: '2026-10-18' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ title: '새 예배', acts: [] });
  });

  it('검증 실패 400 + 메시지', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/services/${svc.id}`,
      payload: { title: 'x', acts: [{ title: 'a', cues: [{ camera: 0, shotSize: 'WS' }] }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('acts.0.cues.0.camera');
  });

  it('내보내기 → 가져오기', async () => {
    const res = await app.inject(`/api/services/${svc.id}/export`);
    expect(res.headers['content-disposition']).toContain('attachment');
    const file = res.json();
    expect(file.format).toBe('camcue/service@1');
    const imported = await app.inject({ method: 'POST', url: '/api/import', payload: file });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().acts[4].cues).toHaveLength(6);
    const bad = await app.inject({ method: 'POST', url: '/api/import', payload: { hello: 1 } });
    expect(bad.statusCode).toBe(400);
  });

  it('라이브 로드 + HTTP 명령', async () => {
    const load = await app.inject({ method: 'POST', url: '/api/show/load', payload: { serviceId: svc.id } });
    expect(load.json().serviceId).toBe(svc.id);
    const go = await app.inject({ method: 'POST', url: '/api/show/command', payload: { command: 'GO' } });
    expect(go.json().state).toMatchObject({ actIndex: 0, cueIndex: 0 });
    const bad = await app.inject({ method: 'POST', url: '/api/show/command', payload: { command: 'FLY' } });
    expect(bad.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/show/command', payload: { command: 'RESET' } });
  });

  it('라이브 중 저장하면 런타임에 반영', async () => {
    const current = (await app.inject(`/api/services/${svc.id}`)).json() as Service;
    current.acts[0].title = '찬양 1 (수정)';
    const res = await app.inject({ method: 'PUT', url: `/api/services/${svc.id}`, payload: current });
    expect(res.statusCode).toBe(200);
    expect(runtime.service!.acts[0].title).toBe('찬양 1 (수정)');
  });
});

describe('WebSocket', () => {
  it('접속 시 service + state 스냅샷 수신, 디렉터 GO 가 모든 클라이언트에 브로드캐스트', async () => {
    const director = await connect();
    const cam = await connect();
    expect((await director.next('service')).service?.id).toBe(runtime.service!.id);
    await director.next('state');
    await cam.next('state');

    director.send({ type: 'hello', role: 'director' });
    cam.send({ type: 'hello', role: 'cam', camera: 3 });
    const clients = await director.next('clients', (m) => m.clients.some((c) => c.role === 'cam' && c.camera === 3));
    expect(clients.clients.some((c) => c.role === 'director')).toBe(true);

    director.send({ type: 'command', command: 'GO' });
    const s = await cam.next('state', (m) => m.state.cueIndex === 0);
    expect(s.tally.program).toBe(5);

    director.send({ type: 'command', command: 'HOLD' });
    expect((await cam.next('state', (m) => m.state.held)).state.held).toBe(true);

    director.ws.close();
    cam.ws.close();
  });

  it('카메라 클라이언트의 명령은 거부', async () => {
    const cam = await connect();
    cam.send({ type: 'hello', role: 'cam', camera: 1 });
    cam.send({ type: 'command', command: 'GO' });
    expect((await cam.next('error')).message).toContain('디렉터');
    cam.ws.close();
  });

  it('ping → pong (시간 동기화)', async () => {
    const c = await connect();
    c.send({ type: 'ping', t: 123 });
    const pong = await c.next('pong');
    expect(pong.t).toBe(123);
    expect(Math.abs(pong.serverTime - Date.now())).toBeLessThan(1000);
    c.send({ type: 'nonsense' });
    await c.next('error');
    c.ws.close();
  });
});
