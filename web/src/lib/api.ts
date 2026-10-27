import type { ServiceInput } from '@shared/schema';
import type { Service, ServiceSummary } from '@shared/types';
import type { DeviceSettings, DevicesSnapshot, SerialLogEntry } from '@shared/devices';
import type { ShowCommand, ShowSnapshot } from '@shared/protocol';
import { askPin, getPin, setPin } from './pin';

/** 서버 오류 (status 409 = 다른 곳에서 먼저 저장 등) */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const pin = getPin();
  if (pin) headers['x-camcue-pin'] = encodeURIComponent(pin);
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // 제어 권한이 없는 기기: PIN 을 물어보고 한 번 다시 시도
    if (res.status === 403 && err.code === 'PIN_REQUIRED' && !retried) {
      if (pin) setPin(null);
      if (askPin(err.error ?? '제어 권한이 필요합니다')) return request(method, url, body, extraHeaders, true);
    }
    throw new ApiError(res.status, err.error ?? `HTTP ${res.status}`, err.code);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface ServerInfo {
  lanUrls: string[];
  /** 안드로이드 앱 설치 파일 동봉 여부 */
  apk: boolean;
  /** 이 기기에서 제어(GO·편집·장비 설정)할 수 있는가 */
  canControl: boolean;
  pinEnabled: boolean;
}

export const api = {
  info: () => request<ServerInfo>('GET', '/api/info'),
  listServices: () => request<ServiceSummary[]>('GET', '/api/services'),
  getService: (id: string) => request<Service>('GET', `/api/services/${id}`),
  createService: (title: string, date: string | null) => request<Service>('POST', '/api/services', { title, date }),
  /** base = 불러올 때의 updatedAt. 그 사이 다른 곳에서 저장했으면 409 */
  saveService: (id: string, input: ServiceInput | Service, base?: string) =>
    request<Service>('PUT', `/api/services/${id}`, input, base ? { 'x-camcue-base': base } : {}),
  duplicateService: (id: string, title: string, date: string | null) => request<Service>('POST', `/api/services/${id}/duplicate`, { title, date }),
  deleteService: (id: string) => request<void>('DELETE', `/api/services/${id}`),
  importService: (json: unknown) => request<Service>('POST', '/api/import', json),
  exportUrl: (id: string) => `/api/services/${id}/export`,
  show: () => request<ShowSnapshot & { service: Service | null }>('GET', '/api/show'),
  /** 이미 라이브인 행사는 진행 위치 유지. restart = 처음(STANDBY)부터 */
  loadShow: (serviceId: string, restart = false) => request<ShowSnapshot>('POST', '/api/show/load', { serviceId, restart }),
  command: (cmd: ShowCommand) => request<ShowSnapshot>('POST', '/api/show/command', cmd),
  // 장비 연결
  devices: () => request<DevicesSnapshot>('GET', '/api/devices'),
  saveDeviceSettings: (settings: Partial<DeviceSettings>) => request<DevicesSnapshot>('PUT', '/api/devices/settings', settings),
  serialPorts: () => request<{ ports: Array<{ path: string; manufacturer: string | null }> }>('GET', '/api/devices/serial-ports'),
  serialLog: (after: number) => request<{ entries: SerialLogEntry[] }>('GET', `/api/devices/serial-log?after=${after}`),
  sendSerial: (hex: string) => request<DevicesSnapshot>('POST', '/api/devices/serial/send', { hex }),
  testTake: (camera: number) => request<DevicesSnapshot>('POST', '/api/devices/test-take', { camera }),
  pulseGpi: (channel: number) => request<DevicesSnapshot>('POST', '/api/devices/gpi/pulse', { channel }),
  mockGpiInput: (channel: number, on: boolean) => request<DevicesSnapshot>('POST', '/api/devices/gpi/mock-input', { channel, on }),
};

/**
 * [라이브로 열기]: 이미 라이브인 행사면 진행 위치를 그대로 두고, 다른 행사가 진행 중이면 확인 후 교체.
 * 열었으면 true
 */
export async function openLive(serviceId: string): Promise<boolean> {
  const show = await api.show().catch(() => null);
  if (show?.service && show.serviceId !== serviceId && show.state.actIndex >= 0) {
    const ok = confirm(`지금 "${show.service.title}" 이(가) 진행 중입니다.\n이 행사로 바꾸면 처음(STANDBY)부터 시작하고, 모든 카메라맨 화면이 바뀝니다.\n바꿀까요?`);
    if (!ok) return false;
  }
  await api.loadShow(serviceId);
  return true;
}
