// 장비 연결 설정 (서버·웹 공용)
// 값은 config.env(설치판) / .env(개발) 의 KEY=VALUE 로 저장되고, 장비 연결 화면에서 바꿀 수 있다.
import type { AtemStatus, Tally } from './protocol';

export const SWITCHER_KINDS = ['atem', 'ikegami', 'gpi', 'none'] as const;
export type SwitcherKind = (typeof SWITCHER_KINDS)[number];

export const TALLY_SOURCES = ['switcher', 'gpi'] as const;
export type TallySourceKind = (typeof TALLY_SOURCES)[number];

/** 설정 키 → 설명. 장비 연결 화면과 config.env 안내문이 같은 정의를 쓴다 */
export const DEVICE_KEYS = {
  SWITCHER: '스위처 종류: atem / ikegami / gpi / none',
  ATEM_HOST: 'ATEM IP (mock = 가상 스위처, 비움 = 사용 안 함)',
  ATEM_ME: '제어할 ATEM M/E 번호 (보통 1)',
  IKEGAMI_PORT: 'RS-422 변환기 COM 포트 (예: COM3, mock = 가상 포트)',
  IKEGAMI_BAUD: '통신 속도 (매뉴얼 기준 38400)',
  IKEGAMI_PARITY: '패리티: odd / even / none (매뉴얼 기준 odd)',
  IKEGAMI_PGM_OUT: '송출(PGM)로 쓰는 라우터 출력 번호',
  IKEGAMI_CAM_INPUTS: 'CAM1, CAM2 … 순서대로 라우터 입력 번호 (쉼표 구분)',
  IKEGAMI_TAKE: '크로스포인트 전환 명령 (16진수 + {IN} {OUT} 등 자리표시)',
  TALLY_SOURCE: '탈리 기준: switcher (스위처 보고값) / gpi (GPI 모듈 실측)',
  GPI_HOST: 'GPI 모듈(Modbus TCP) IP[:포트] (mock = 가상 모듈, 비움 = 사용 안 함)',
  GPI_UNIT: 'Modbus 유닛 ID (보통 1)',
  GPI_DI_FC: '입력 읽기 함수: 2 (Discrete Inputs) / 1 (Coils)',
  GPI_DI_ADDR: '입력 시작 주소 (0부터, 모듈 설명서 기준)',
  GPI_DO_ADDR: '출력(코일) 시작 주소 (0부터)',
  GPI_TALLY_INPUTS: 'CAM1, CAM2 … 순서대로 탈리 입력 채널 번호 (1부터, 0 = 없음)',
  GPI_TALLY_INVERT: '1 = 입력이 꺼질 때를 ON AIR 로 판단 (배선에 따라)',
  GPI_CUT_OUTPUTS: 'SWITCHER=gpi 일 때 CAM1, CAM2 … 순서대로 펄스를 낼 출력 채널 (1부터)',
  GPI_PULSE_MS: '출력 펄스 길이(ms)',
  GPI_POLL_MS: '입력 읽기 주기(ms)',
} as const;
export type DeviceKey = keyof typeof DEVICE_KEYS;
export type DeviceSettings = Record<DeviceKey, string>;

export const DEVICE_DEFAULTS: DeviceSettings = {
  SWITCHER: 'atem',
  ATEM_HOST: '',
  ATEM_ME: '1',
  IKEGAMI_PORT: '',
  IKEGAMI_BAUD: '38400',
  IKEGAMI_PARITY: 'odd',
  IKEGAMI_PGM_OUT: '1',
  IKEGAMI_CAM_INPUTS: '1,2,3,4,5,6,7,8',
  IKEGAMI_TAKE: '',
  TALLY_SOURCE: 'switcher',
  GPI_HOST: '',
  GPI_UNIT: '1',
  GPI_DI_FC: '2',
  GPI_DI_ADDR: '0',
  GPI_DO_ADDR: '0',
  GPI_TALLY_INPUTS: '1,2,3,4,5,6,7,8',
  GPI_TALLY_INVERT: '0',
  GPI_CUT_OUTPUTS: '1,2,3,4,5,6,7,8',
  GPI_PULSE_MS: '200',
  GPI_POLL_MS: '50',
};

export interface GpiStatus {
  /** mock: 가상 모듈 / real: 실제 모듈 / disabled: 미사용 */
  mode: 'disabled' | 'mock' | 'real';
  host: string | null;
  connected: boolean;
  lastError: string | null;
  /** 읽은 입력 채널 상태 (index 0 = 채널 1). 미연결이면 null */
  inputs: boolean[] | null;
}

export interface SerialLogEntry {
  id: number;
  at: number;
  dir: 'tx' | 'rx' | 'info' | 'error';
  /** tx/rx: 16진수 바이트, info/error: 메시지 */
  text: string;
}

export interface DevicesSnapshot {
  settings: DeviceSettings;
  /** 설정을 저장할 파일 경로 (안내용) */
  configPath: string | null;
  /** 설정 해석 오류 (잘못된 값이면 해당 장비는 꺼진 상태로 동작) */
  errors: string[];
  switcher: AtemStatus;
  gpi: GpiStatus;
  tally: Tally;
}
