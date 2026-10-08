// /ws 실시간 연결 훅: 자동 재접속 + 서버 시각 오프셋 보정
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientRole, ConnectedClient, ServerMessage, ShowCommand, ShowSnapshot } from '@shared/protocol';
import type { Service } from '@shared/types';

export interface ShowConnection {
  connected: boolean;
  service: Service | null;
  snapshot: ShowSnapshot | null;
  clients: ConnectedClient[];
  /** 서버 기준 현재 시각(ms) */
  serverNow: () => number;
  command: (cmd: ShowCommand) => void;
  lastError: string | null;
}

export function useShow(role: ClientRole, camera?: number): ShowConnection {
  const [connected, setConnected] = useState(false);
  const [service, setService] = useState<Service | null>(null);
  const [snapshot, setSnapshot] = useState<ShowSnapshot | null>(null);
  const [clients, setClients] = useState<ConnectedClient[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const offsetRef = useRef({ offset: 0, rtt: Infinity });

  useEffect(() => {
    let disposed = false;
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      const ping = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));

      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        ws.send(JSON.stringify({ type: 'hello', role, camera }));
        offsetRef.current.rtt = Infinity; // 재접속 시 다시 측정
        ping();
        pingTimer = setInterval(ping, 5000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMessage;
        switch (msg.type) {
          case 'service':
            setService(msg.service);
            break;
          case 'state': {
            const { type: _t, ...snap } = msg;
            setSnapshot(snap);
            break;
          }
          case 'clients':
            setClients(msg.clients);
            break;
          case 'pong': {
            // RTT 가 가장 짧았던 측정값을 신뢰 (NTP 방식)
            const now = Date.now();
            const rtt = now - msg.t;
            const best = offsetRef.current;
            if (rtt <= best.rtt * 1.5 || rtt < 50) {
              offsetRef.current = { offset: msg.serverTime - (msg.t + now) / 2, rtt: Math.min(rtt, best.rtt) };
            }
            break;
          }
          case 'error':
            setLastError(msg.message);
            break;
        }
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        setConnected(false);
        if (!disposed) reconnectTimer = setTimeout(open, Math.min(5000, 300 * 2 ** retry++));
      };
      ws.onerror = () => ws.close();
    };

    open();
    // 폰이 잠금에서 돌아오면 즉시 재접속 시도
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wsRef.current?.readyState !== WebSocket.OPEN) {
        clearTimeout(reconnectTimer);
        wsRef.current?.close();
        retry = 0;
        open();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
    };
  }, [role, camera]);

  const serverNow = useCallback(() => Date.now() + offsetRef.current.offset, []);
  const command = useCallback((cmd: ShowCommand) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'command', ...cmd }));
  }, []);

  return { connected, service, snapshot, clients, serverNow, command, lastError };
}

/** 주기적으로 리렌더링해 카운트다운 갱신 */
export function useTicker(intervalMs = 100) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}
