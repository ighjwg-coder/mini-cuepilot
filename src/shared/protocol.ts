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

export interface AtemStatus {
  /** disabled: ATEM_HOST 미설정 / mock: 가상 장비 / real: 실제 장비 */
  mode: 'disabled' | 'mock' | 'real';
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
  /** atem: 실제(또는 mock) 스위처 상태 / engine: 미연결 시 엔진 추정값 */
  source: 'atem' | 'engine';
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
