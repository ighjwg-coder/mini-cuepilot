import { MockAtemAdapter } from './mock';
import { RealAtemAdapter } from './real';
import { DisabledAtemAdapter, type AtemAdapter } from './types';

export * from './mock';
export * from './real';
export * from './types';

export type AtemConfig = { kind: 'disabled' } | { kind: 'mock' } | { kind: 'real'; host: string; port?: number };

/**
 * ATEM_HOST 해석
 *   (빈 값)            → disabled (ATEM 없이 큐 진행만)
 *   mock               → 가상 스위처
 *   192.168.10.240     → 실제 장비 (기본 포트 9910)
 *   192.168.10.240:9910
 */
export function parseAtemHost(raw: string | undefined): AtemConfig {
  const v = raw?.trim() ?? '';
  if (!v) return { kind: 'disabled' };
  if (v.toLowerCase() === 'mock') return { kind: 'mock' };
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(v)!;
  return m[2] ? { kind: 'real', host: m[1], port: Number(m[2]) } : { kind: 'real', host: m[1] };
}

export function createAtemAdapter(raw: string | undefined, env: { ATEM_ME?: string } = process.env): AtemAdapter {
  const cfg = parseAtemHost(raw);
  switch (cfg.kind) {
    case 'disabled':
      return new DisabledAtemAdapter();
    case 'mock':
      return new MockAtemAdapter({ transitionMs: 1000, latencyMs: 5 });
    case 'real': {
      const me = Number(env.ATEM_ME ?? 1);
      return new RealAtemAdapter({ host: cfg.host, port: cfg.port, mixEffect: Number.isInteger(me) && me >= 1 ? me - 1 : 0 });
    }
  }
}
