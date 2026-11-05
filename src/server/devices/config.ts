// 장비 설정 읽기·검증·저장
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DEVICE_DEFAULTS, DEVICE_KEYS, SWITCHER_KINDS, TALLY_SOURCES, type DeviceKey, type DeviceSettings, type SwitcherKind, type TallySourceKind } from '../../shared/devices';
import { parseAtemHost, type AtemConfig } from '../atem';
import { parseTakeTemplate, type IkegamiOptions } from './ikegami';
import type { Parity } from './serial';

/** 환경변수 → 설정값 (없는 키는 기본값). SWITCHER 가 없으면 v0.0.2 이전과 같이 ATEM_HOST 로 동작 */
export function readDeviceSettings(env: NodeJS.ProcessEnv = process.env): DeviceSettings {
  const out = { ...DEVICE_DEFAULTS };
  for (const k of Object.keys(DEVICE_KEYS) as DeviceKey[]) {
    const v = env[k];
    if (v !== undefined) out[k] = v.trim();
  }
  return out;
}

export interface ResolvedDevices {
  switcher:
    | { kind: 'none' }
    | { kind: 'atem'; atem: AtemConfig; me: number; tallyOnly: boolean }
    | { kind: 'vmix'; host: string; port?: number; camInputs: number[]; tallyOnly: boolean }
    | { kind: 'obs'; host: string; port?: number; password: string; camScenes: string[]; tallyOnly: boolean }
    | ({ kind: 'ikegami'; port: string; baudRate: number; parity: Parity } & Pick<IkegamiOptions, 'pgmOutput' | 'camInputs' | 'takeTemplate'>)
    | { kind: 'gpi'; cutOutputs: number[]; pulseMs: number };
  gpi:
    | { kind: 'none' }
    | {
        kind: 'mock' | 'real';
        host: string;
        port?: number;
        unitId: number;
        diFunction: 1 | 2;
        diAddress: number;
        doAddress: number;
        pollMs: number;
      };
  tally: { source: TallySourceKind; inputs: number[]; invert: boolean };
  errors: string[];
}

/** 설정 해석. 잘못된 값은 errors 에 담고 해당 장비만 꺼진 것으로 처리 (프로그램은 계속 실행) */
export function resolveDevices(s: DeviceSettings): ResolvedDevices {
  const errors: string[] = [];
  const int = (key: DeviceKey, min: number, max: number): number => {
    const n = Number(s[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key}=${s[key]} — ${min}~${max} 사이 정수여야 합니다`);
      return Number(DEVICE_DEFAULTS[key]);
    }
    return n;
  };
  const list = (key: DeviceKey, max: number): number[] => {
    if (!s[key]) return [];
    const parts = s[key].split(/[\s,]+/).filter(Boolean).map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > max)) {
      errors.push(`${key}=${s[key]} — 0~${max} 사이 숫자를 쉼표로 구분해 주세요`);
      return [];
    }
    return parts;
  };

  const flag = (key: DeviceKey) => s[key] === '1' || s[key].toLowerCase() === 'true';
  /** "mock" / IP / IP:포트 */
  const hostPort = (key: DeviceKey): { host: string; port?: number } | null => {
    if (s[key].toLowerCase() === 'mock') return { host: 'mock' };
    const m = /^([^\s:]+)(?::(\d{1,5}))?$/.exec(s[key]);
    if (!m) {
      errors.push(`${key}=${s[key]} — IP 또는 IP:포트 형식이어야 합니다`);
      return null;
    }
    return { host: m[1], ...(m[2] ? { port: Number(m[2]) } : {}) };
  };

  // ── 스위처 ──
  let kind = s.SWITCHER.toLowerCase() as SwitcherKind;
  if (!SWITCHER_KINDS.includes(kind)) {
    errors.push(`SWITCHER=${s.SWITCHER} — ${SWITCHER_KINDS.join(' / ')} 중 하나여야 합니다`);
    kind = 'none';
  }
  let switcher: ResolvedDevices['switcher'] = { kind: 'none' };
  if (kind === 'atem') {
    const me = int('ATEM_ME', 1, 8);
    switcher = { kind: 'atem', atem: parseAtemHost(s.ATEM_HOST), me, tallyOnly: flag('ATEM_TALLY_ONLY') };
  } else if (kind === 'vmix') {
    if (!s.VMIX_HOST) errors.push('VMIX_HOST — vMix 가 켜진 PC 의 IP 를 지정해 주세요 (같은 PC 면 127.0.0.1, 시험용 mock)');
    else {
      const hp = hostPort('VMIX_HOST');
      if (hp) switcher = { kind: 'vmix', ...hp, camInputs: list('VMIX_CAM_INPUTS', 1000), tallyOnly: flag('VMIX_TALLY_ONLY') };
    }
  } else if (kind === 'obs') {
    if (!s.OBS_HOST) errors.push('OBS_HOST — OBS 가 켜진 PC 의 IP 를 지정해 주세요 (같은 PC 면 127.0.0.1, 시험용 mock)');
    else {
      const hp = hostPort('OBS_HOST');
      const camScenes = s.OBS_CAM_SCENES.split(',').map((x) => x.trim());
      const named = camScenes.filter(Boolean);
      if (new Set(named).size !== named.length) errors.push('OBS_CAM_SCENES — 같은 장면 이름이 두 카메라에 지정되어 있습니다');
      if (hp) switcher = { kind: 'obs', ...hp, password: s.OBS_PASSWORD, camScenes, tallyOnly: flag('OBS_TALLY_ONLY') };
    }
  } else if (kind === 'ikegami') {
    const parity = s.IKEGAMI_PARITY.toLowerCase();
    if (!['odd', 'even', 'none'].includes(parity)) errors.push(`IKEGAMI_PARITY=${s.IKEGAMI_PARITY} — odd / even / none`);
    if (s.IKEGAMI_TAKE) {
      try {
        parseTakeTemplate(s.IKEGAMI_TAKE);
      } catch (err) {
        errors.push(`IKEGAMI_TAKE — ${(err as Error).message}`);
      }
    }
    if (!s.IKEGAMI_PORT) errors.push('IKEGAMI_PORT — COM 포트를 지정해 주세요 (예: COM3, 시험용 mock)');
    else
      switcher = {
        kind: 'ikegami',
        port: s.IKEGAMI_PORT,
        baudRate: int('IKEGAMI_BAUD', 1200, 921600),
        parity: (['odd', 'even', 'none'].includes(parity) ? parity : 'odd') as Parity,
        pgmOutput: int('IKEGAMI_PGM_OUT', 1, 255),
        camInputs: list('IKEGAMI_CAM_INPUTS', 255),
        takeTemplate: s.IKEGAMI_TAKE,
      };
  } else if (kind === 'gpi') {
    switcher = { kind: 'gpi', cutOutputs: list('GPI_CUT_OUTPUTS', 64), pulseMs: int('GPI_PULSE_MS', 20, 5000) };
    if (!s.GPI_HOST) errors.push('SWITCHER=gpi — GPI_HOST(모듈 IP)를 지정해 주세요');
  }

  // ── GPI 모듈 ──
  let gpi: ResolvedDevices['gpi'] = { kind: 'none' };
  if (s.GPI_HOST) {
    const fc = int('GPI_DI_FC', 1, 2) as 1 | 2;
    const common = {
      unitId: int('GPI_UNIT', 0, 255),
      diFunction: fc,
      diAddress: int('GPI_DI_ADDR', 0, 65535),
      doAddress: int('GPI_DO_ADDR', 0, 65535),
      pollMs: int('GPI_POLL_MS', 10, 5000),
    };
    const hp = hostPort('GPI_HOST');
    if (hp) gpi = hp.host === 'mock' ? { kind: 'mock', host: 'mock', ...common } : { kind: 'real', ...hp, ...common };
  }

  // ── 탈리 ──
  let source = s.TALLY_SOURCE.toLowerCase() as TallySourceKind;
  if (!TALLY_SOURCES.includes(source)) {
    errors.push(`TALLY_SOURCE=${s.TALLY_SOURCE} — ${TALLY_SOURCES.join(' / ')} 중 하나여야 합니다`);
    source = 'switcher';
  }
  if (source === 'gpi' && gpi.kind === 'none') errors.push('TALLY_SOURCE=gpi — GPI_HOST(모듈 IP)를 지정해 주세요');
  return { switcher, gpi, tally: { source, inputs: list('GPI_TALLY_INPUTS', 64), invert: flag('GPI_TALLY_INVERT') }, errors };
}

/**
 * 설정 파일의 키 값을 바꿔 저장. 주석 처리된 같은 키(# KEY=)가 있으면 그 줄을 살려서 바꾸고,
 * 없으면 파일 끝에 추가. 다른 줄(주석·PORT 등)은 그대로 둔다.
 */
export function updateConfigFile(path: string, updates: Partial<Record<string, string>>): void {
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const added: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (/[\r\n]/.test(value)) throw new Error(`${key}: 줄바꿈은 넣을 수 없습니다`);
    const line = `${key}=${value}`;
    const active = new RegExp(`^${key}=.*$`, 'm');
    const commented = new RegExp(`^#\\s*${key}=.*$`, 'm');
    if (active.test(text)) text = text.replace(active, () => line);
    else if (commented.test(text)) text = text.replace(commented, () => line);
    else added.push(line);
  }
  if (added.length) {
    if (text && !text.endsWith('\n')) text += '\n';
    text += `\n# 장비 연결 화면에서 저장한 값\n${added.join('\n')}\n`;
  }
  writeFileSync(path, text, 'utf8');
}
