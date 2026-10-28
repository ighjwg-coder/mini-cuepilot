// WebSocket 메시지 프로토콜 (서버 ↔ 클라이언트)
import type { EngineState } from './engine';
import type { Service } from './types';

export type ClientRole = 'director' | 'cam' | 'editor' | 'viewer';

export type ShowCommand =
  | { command: 'GO' }
  | { command: 'BACK'; silent?: boolean }
  | { command: 'HOLD'; on?: boolean }
  | { command: 'RESET' }
  /** silent = 큐 위치만 옮기고 스위처 컷은 보내지 않음 (위치 복구용) */
  | { command: 'JUMP'; actIndex: number; cueIndex: number; silent?: boolean }
  /** 리허설 모드: 큐는 진행하지만 스위처에는 아무 명령도 보내지 않음 (예배 전 송출 중 연습) */
  | { command: 'REHEARSAL'; on: boolean };

/**
 * 스위처(영상 전환 장비) 연결 상태. 이름은 v0.0.1 호환을 위해 AtemStatus 유지.
 *   disabled: 제어 안 함 / mock: 가상 ATEM / real: 실제 ATEM
 *   vmix: vMix(TCP API) / obs: OBS Studio(obs-websocket v5)
 *   ikegami: 이케가미 라우터(RS-422) / gpi: GPI 모듈 접점 출력으로 컷
 */
export interface AtemStatus {
  mode: 'disabled' | 'mock' | 'real' | 'vmix' | 'obs' | 'ikegami' | 'gpi';
  host: string | null;
  connected: boolean;
  model: string | null;
  programInput: number | null;
  previewInput: number | null;
  lastError: string | null;
  /** 탈리만 읽고 GO 해도 컷을 보내지 않음 (단순 탈리) */
  tallyOnly?: boolean;
  /**
   * 스위처가 알려 준 "지금 송출에 나가는 입력" 전부 (작은 번호부터). 디졸브 중이나 키·PIP 로 두 대가 같이 나가면 둘 다.
   * 모르는 장비(이케가미·GPI 컷)는 없음 → programInput 하나로 판단
   */
  onAirInputs?: number[];
}

export interface Tally {
  program: number | null;
  preview: number | null;
  /**
   * 지금 송출에 나가고 있는 카메라 전부 (작은 번호부터).
   * 디졸브 중이나 키·PIP 로 두 대가 동시에 나갈 때 GPI 실측 탈리는 여러 대가 켜진다.
   * 그 외 기준은 program 한 대뿐이다.
   */
  onAir: number[];
  /**
   * atem: 스위처가 보고한 실제 상태 (ATEM)
   * gpi: GPI 모듈로 읽은 실제 탈리 신호
   * command: 캠큐가 보낸 전환 명령 기준 (GPI 접점 컷·이케가미 라우터 — 패널 수동 컷은 모름)
   * engine: 장비 미연결 시 큐 진행 기준 추정값
   */
  source: 'atem' | 'gpi' | 'command' | 'engine';
}

/** 실제 탈리인가 (아니면 추정값) */
export const isRealTally = (t: Pick<Tally, 'source'> | null | undefined) => t?.source === 'atem' || t?.source === 'gpi';

/** 스위처로 보낸 명령 결과 (디렉터 화면 알림용) */
export interface CommandLogEntry {
  id: number;
  at: number;
  /** ok: 보냄 / failed: 장비 오류 / skipped: 스위처 미연결로 못 보냄 */
  result: 'ok' | 'failed' | 'skipped';
  label: string;
  error: string | null;
}

/** 현재 스위처로 할 수 있는 것 (에디터 경고·디렉터 표시용) */
export interface SwitcherCaps {
  /** 컷할 수 있는 카메라 번호. null = 제한 없음 */
  cameras: number[] | null;
  /** AUTO(믹스) 트랜지션. false 면 AUTO 큐도 하드 컷 */
  transition: boolean;
  macro: boolean;
  dsk: boolean;
}

export interface ShowSnapshot {
  serviceId: string | null;
  state: EngineState;
  tally: Tally;
  atem: AtemStatus;
  timecode: { running: boolean; source: string };
  serverTime: number;
  /** 최근 스위처 명령 결과 (새 것이 뒤) */
  commandLog: CommandLogEntry[];
  switcherCaps: SwitcherCaps;
  /** 리허설 모드 (컷 안 보냄, 탈리는 큐 기준) */
  rehearsal: boolean;
}

export interface ConnectedClient {
  id: number;
  role: ClientRole;
  camera: number | null;
}

export type ClientMessage =
  | { type: 'hello'; role: ClientRole; camera?: number; pin?: string }
  | ({ type: 'command' } & ShowCommand)
  | { type: 'ping'; t: number };

export type ServerMessage =
  | { type: 'service'; service: Service | null }
  | ({ type: 'state' } & ShowSnapshot)
  | { type: 'clients'; clients: ConnectedClient[] }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'error'; message: string }
  /** hello 응답: 이 연결로 진행 명령(GO 등)을 보낼 수 있는가 */
  | { type: 'access'; canControl: boolean; reason: string | null };
