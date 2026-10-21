// WebSocket 메시지 프로토콜 (서버 ↔ 클라이언트)
import type { EngineState } from './engine';
import type { Service } from './types';

export type ClientRole = 'director' | 'cam' | 'editor' | 'viewer';

export type ShowCommand =
  | { command: 'GO' }
  | { command: 'BACK' }
  | { command: 'HOLD'; on?: boolean }
  | { command: 'RESET' }
  | { command: 'JUMP'; actIndex: number; cueIndex: number };

/**
 * 스위처(영상 전환 장비) 연결 상태. 이름은 v0.0.1 호환을 위해 AtemStatus 유지.
 *   disabled: 제어 안 함 / mock: 가상 ATEM / real: 실제 ATEM
 *   ikegami: 이케가미 라우터(RS-422) / gpi: GPI 모듈 접점 출력으로 컷
 */
export interface AtemStatus {
  mode: 'disabled' | 'mock' | 'real' | 'ikegami' | 'gpi';
  host: string | null;
  connected: boolean;
  model: string | null;
  programInput: number | null;
  previewInput: number | null;
  lastError: string | null;
}

export interface Tally {
  program: number | null;
  preview: number | null;
  /**
   * atem: 스위처가 보고한 상태 (ATEM·이케가미 등, 이름은 호환 유지)
   * gpi: GPI 모듈로 읽은 실제 탈리 신호
   * engine: 장비 미연결 시 큐 진행 기준 추정값
   */
  source: 'atem' | 'gpi' | 'engine';
}

export interface ShowSnapshot {
  serviceId: string | null;
  state: EngineState;
  tally: Tally;
  atem: AtemStatus;
  timecode: { running: boolean; source: string };
  serverTime: number;
}

export interface ConnectedClient {
  id: number;
  role: ClientRole;
  camera: number | null;
}

export type ClientMessage =
  | { type: 'hello'; role: ClientRole; camera?: number }
  | ({ type: 'command' } & ShowCommand)
  | { type: 'ping'; t: number };

export type ServerMessage =
  | { type: 'service'; service: Service | null }
  | ({ type: 'state' } & ShowSnapshot)
  | { type: 'clients'; clients: ConnectedClient[] }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'error'; message: string };
