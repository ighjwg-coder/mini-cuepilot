import type { ServiceInput } from '@shared/schema';
import type { Service, ServiceSummary } from '@shared/types';
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
};
