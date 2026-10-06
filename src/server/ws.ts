// WebSocket 허브: /ws 경로. 런타임 상태를 모든 클라이언트에 브로드캐스트하고 디렉터 명령을 받는다.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { MAX_CAMERA, MIN_CAMERA } from '../shared/types';
import type { ClientRole, ConnectedClient, ServerMessage } from '../shared/protocol';
import { commandSchema } from '../shared/schema';
import type { ShowRuntime } from './runtime';

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    role: z.enum(['director', 'cam', 'editor', 'viewer']),
    camera: z.number().int().min(MIN_CAMERA).max(MAX_CAMERA).optional(),
  }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);

interface ClientInfo extends ConnectedClient {
  socket: WebSocket;
}

/** 명령(GO/BACK/HOLD...)을 보낼 수 있는 역할 */
const COMMAND_ROLES: ReadonlySet<ClientRole> = new Set(['director']);

export function attachWebSocket(server: Server, runtime: ShowRuntime) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, ClientInfo>();
  let seq = 0;

  const send = (socket: WebSocket, msg: ServerMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const socket of clients.keys()) if (socket.readyState === WebSocket.OPEN) socket.send(data);
  };
  const broadcastClients = () =>
    broadcast({ type: 'clients', clients: [...clients.values()].map(({ id, role, camera }) => ({ id, role, camera })) });

  const onState = (snapshot: ReturnType<ShowRuntime['snapshot']>) => broadcast({ type: 'state', ...snapshot });
  const onService = (service: ShowRuntime['service']) => broadcast({ type: 'service', service });
  runtime.on('state', onState);
  runtime.on('service', onService);

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws') return; // 다른 업그레이드(Vite HMR 등)는 건드리지 않음
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (socket) => {
    const info: ClientInfo = { id: ++seq, role: 'viewer', camera: null, socket };
    clients.set(socket, info);
    send(socket, { type: 'service', service: runtime.service });
    send(socket, { type: 'state', ...runtime.snapshot() });
    broadcastClients();

    socket.on('message', (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: 'error', message: 'JSON 형식이 아닙니다' });
      }
      const type = (json as { type?: unknown })?.type;
      if (type === 'command') {
        if (!COMMAND_ROLES.has(info.role)) return send(socket, { type: 'error', message: '디렉터만 명령을 보낼 수 있습니다' });
        const cmd = commandSchema.safeParse(json);
        if (!cmd.success) return send(socket, { type: 'error', message: '잘못된 명령' });
        return runtime.command(cmd.data);
      }
      const msg = clientMessageSchema.safeParse(json);
      if (!msg.success) return send(socket, { type: 'error', message: '알 수 없는 메시지' });
      if (msg.data.type === 'ping') {
        return send(socket, { type: 'pong', t: msg.data.t, serverTime: Date.now() });
      }
      if (msg.data.type === 'hello') {
        info.role = msg.data.role;
        info.camera = msg.data.role === 'cam' ? (msg.data.camera ?? null) : null;
        broadcastClients();
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      broadcastClients();
    });
  });

  // 끊긴 연결 정리 (폰 화면 잠금/와이파이 전환 대비)
  const alive = new WeakSet<WebSocket>();
  wss.on('connection', (socket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
  });
  const heartbeat = setInterval(() => {
    for (const socket of clients.keys()) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, 15_000);

  return {
    clientCount: () => clients.size,
    close: async () => {
      clearInterval(heartbeat);
      runtime.off('state', onState);
      runtime.off('service', onService);
      server.off('upgrade', onUpgrade);
      for (const socket of clients.keys()) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
