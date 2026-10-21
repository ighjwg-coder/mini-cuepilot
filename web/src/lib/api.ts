import type { ServiceInput } from '@shared/schema';
import type { Service, ServiceSummary } from '@shared/types';
import type { DeviceSettings, DevicesSnapshot, SerialLogEntry } from '@shared/devices';
import type { ShowCommand, ShowSnapshot } from '@shared/protocol';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export interface ServerInfo {
  lanUrls: string[];
  /** 안드로이드 앱 설치 파일 동봉 여부 */
  apk: boolean;
}

export const api = {
  info: () => request<ServerInfo>('GET', '/api/info'),
  listServices: () => request<ServiceSummary[]>('GET', '/api/services'),
  getService: (id: string) => request<Service>('GET', `/api/services/${id}`),
  createService: (title: string, date: string | null) => request<Service>('POST', '/api/services', { title, date }),
  saveService: (id: string, input: ServiceInput | Service) => request<Service>('PUT', `/api/services/${id}`, input),
  deleteService: (id: string) => request<void>('DELETE', `/api/services/${id}`),
  importService: (json: unknown) => request<Service>('POST', '/api/import', json),
  exportUrl: (id: string) => `/api/services/${id}/export`,
  loadShow: (serviceId: string) => request<ShowSnapshot>('POST', '/api/show/load', { serviceId }),
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
