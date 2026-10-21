// 같은 Wi-Fi 의 CamCue 앱이 서버를 자동으로 찾도록 응답하는 UDP 비콘.
// 앱이 브로드캐스트로 "CAMCUE_DISCOVER" 를 보내면, 서버가 보낸 쪽으로 JSON 한 줄을 돌려준다.
//   → {"app":"CamCue","version":"0.0.4","name":"PC이름","port":38080,"proto":"http"}
// 서버 HTTP 포트가 자동 변경(38090 등)돼도 앱은 응답의 port 로 접속하므로 따로 맞출 필요가 없다.
import { createSocket, type Socket } from 'node:dgram';
import { hostname } from 'node:os';
import { APP_NAME, APP_VERSION } from '../shared/version';

export const DISCOVERY_PORT = 38089;
export const DISCOVERY_QUERY = 'CAMCUE_DISCOVER';

export interface DiscoveryInfo {
  app: string;
  version: string;
  name: string;
  port: number;
  proto: 'http' | 'https';
}

export function discoveryInfo(port: number, proto: 'http' | 'https'): DiscoveryInfo {
  return { app: APP_NAME, version: APP_VERSION, name: hostname(), port, proto };
}

export interface DiscoveryResponder {
  readonly port: number;
  close(): Promise<void>;
}

/** UDP 응답기 시작. 포트를 쓸 수 없으면 예외 (호출 측에서 경고만 하고 계속 진행) */
export function startDiscoveryResponder(info: () => DiscoveryInfo, port = DISCOVERY_PORT): Promise<DiscoveryResponder> {
  return new Promise((resolve, reject) => {
    const sock: Socket = createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg, rinfo) => {
      if (!msg.toString('utf8').startsWith(DISCOVERY_QUERY)) return;
      sock.send(Buffer.from(JSON.stringify(info())), rinfo.port, rinfo.address);
    });
    sock.once('error', reject);
    sock.bind(port, '0.0.0.0', () => {
      sock.off('error', reject);
      sock.on('error', () => {}); // 실행 중 오류는 무시 (앱은 HTTP 스캔으로도 찾음)
      resolve({
        port: sock.address().port,
        close: () => new Promise((r) => sock.close(() => r())),
      });
    });
  });
}
