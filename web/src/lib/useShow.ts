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

/** 서버 응답 확인 주기 */
const PING_MS = 2000;
/** 이 시간 동안 서버에서 아무 것도 못 받으면 끊긴 것으로 본다 */
const STALE_MS = 5000;

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
    let watchTimer: ReturnType<typeof setInterval> | undefined;

    const scheduleReconnect = (delay: number) => {
      clearTimeout(reconnectTimer);
      if (!disposed) reconnectTimer = setTimeout(open, delay);
    };

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      let lastRx = Date.now();
      // 접속 시도 자체가 멈춰 있는 경우(와이파이 불안정)도 새로 시도
      const connectTimer = setTimeout(() => ws.readyState !== WebSocket.OPEN && drop(1000), STALE_MS);

      const ping = () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));

      // 연결이 끊긴 것: 이 소켓은 버리고 새로 연결. 와이파이 전환 등으로 연결이 "반쯤 죽으면"
      // 브라우저가 한참 동안 끊김을 모르므로, 서버 응답(pong)이 끊기는 것으로 직접 판단한다.
      const drop = (delay: number) => {
        clearTimeout(connectTimer);
        clearInterval(pingTimer);
        clearInterval(watchTimer);
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          // 이미 닫힘
        }
        if (wsRef.current === ws) setConnected(false);
        scheduleReconnect(delay);
      };

      ws.onopen = () => {
        clearTimeout(connectTimer);
        retry = 0;
        lastRx = Date.now();
        setConnected(true);
        ws.send(JSON.stringify({ type: 'hello', role, camera }));
        offsetRef.current.rtt = Infinity; // 재접속 시 다시 측정
        ping();
        pingTimer = setInterval(ping, PING_MS);
        watchTimer = setInterval(() => {
          if (Date.now() - lastRx > STALE_MS) drop(0);
        }, 1000);
      };
      ws.onmessage = (ev) => {
        lastRx = Date.now();
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
      ws.onclose = () => drop(Math.min(5000, 300 * 2 ** retry++));
      ws.onerror = () => drop(Math.min(5000, 300 * 2 ** retry++));
    };

    open();
    // 폰이 잠금에서 돌아오면 즉시 재접속 시도
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wsRef.current?.readyState !== WebSocket.OPEN) {
        retry = 0;
        clearInterval(pingTimer);
        clearInterval(watchTimer);
        const old = wsRef.current;
        if (old) {
          old.onopen = old.onmessage = old.onclose = old.onerror = null;
          old.close();
        }
        scheduleReconnect(0);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      clearInterval(watchTimer);
      document.removeEventListener('visibilitychange', onVisible);
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      }
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
