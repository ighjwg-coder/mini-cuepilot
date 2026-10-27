// 에디터 문서 편집 연산 (불변, 순수 함수). 웹 에디터에서 사용하고 Vitest 로 검증한다.
import type { Act, Cue, Service } from './types';

export type IdGen = () => string;

/** 비보안 컨텍스트(LAN HTTP)에서는 crypto.randomUUID 가 없으므로 폴백 */
export const defaultIdGen: IdGen = () => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export function newCue(id: IdGen, base: Partial<Cue> = {}): Cue {
  return {
    camera: 1,
    shotSize: 'MS',
    note: '',
    durationSec: null,
    section: null,
    bars: null,
    tcInSec: null,
    atemAction: 'cut',
    ...base,
    id: id(),
  };
}

export function newAct(id: IdGen, base: Partial<Act> = {}): Act {
  return { title: '새 순서', mode: 'MANUAL', bpm: null, beatsPerBar: 4, cues: [], ...base, id: id() };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function arrayMove<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = [...arr];
  const [item] = out.splice(from, 1);
  out.splice(clamp(to, 0, out.length), 0, item);
  return out;
}

const mapAct = (s: Service, actIndex: number, fn: (a: Act) => Act): Service => ({
  ...s,
  acts: s.acts.map((a, i) => (i === actIndex ? fn(a) : a)),
});

export const ops = {
  updateService: (s: Service, patch: Partial<Pick<Service, 'title' | 'date'>>): Service => ({ ...s, ...patch }),

  addAct: (s: Service, id: IdGen, base?: Partial<Act>): Service => ({ ...s, acts: [...s.acts, newAct(id, base)] }),

  updateAct: (s: Service, actIndex: number, patch: Partial<Omit<Act, 'id' | 'cues'>>): Service =>
    mapAct(s, actIndex, (a) => ({ ...a, ...patch })),

  moveAct: (s: Service, from: number, to: number): Service => ({ ...s, acts: arrayMove(s.acts, from, to) }),

  deleteAct: (s: Service, actIndex: number): Service => ({ ...s, acts: s.acts.filter((_, i) => i !== actIndex) }),

  /** 새 큐 추가. 직전 큐의 섹션/마디 수를 이어받아 연속 입력을 빠르게 */
  addCue: (s: Service, actIndex: number, id: IdGen, at?: number): Service =>
    mapAct(s, actIndex, (a) => {
      const pos = at ?? a.cues.length;
      const prev = a.cues[pos - 1];
      const cue = newCue(id, prev ? { section: prev.section, bars: prev.bars, camera: prev.camera } : {});
      const cues = [...a.cues];
      cues.splice(pos, 0, cue);
      return { ...a, cues };
    }),

  updateCue: (s: Service, actIndex: number, cueIndex: number, patch: Partial<Omit<Cue, 'id'>>): Service =>
    mapAct(s, actIndex, (a) => ({ ...a, cues: a.cues.map((c, i) => (i === cueIndex ? { ...c, ...patch } : c)) })),

  moveCue: (s: Service, actIndex: number, from: number, to: number): Service =>
    mapAct(s, actIndex, (a) => ({ ...a, cues: arrayMove(a.cues, from, to) })),

  /** 다른 Act 의 끝으로 이동 */
  moveCueToAct: (s: Service, fromAct: number, cueIndex: number, toAct: number): Service => {
    if (fromAct === toAct) return s;
    const cue = s.acts[fromAct].cues[cueIndex];
    if (!cue) return s;
    return {
      ...s,
      acts: s.acts.map((a, i) => {
        if (i === fromAct) return { ...a, cues: a.cues.filter((_, j) => j !== cueIndex) };
        if (i === toAct) return { ...a, cues: [...a.cues, cue] };
        return a;
      }),
    };
  },

  duplicateCue: (s: Service, actIndex: number, cueIndex: number, id: IdGen): Service =>
    mapAct(s, actIndex, (a) => {
      const src = a.cues[cueIndex];
      if (!src) return a;
      const cues = [...a.cues];
      cues.splice(cueIndex + 1, 0, { ...src, id: id() });
      return { ...a, cues };
    }),

  deleteCue: (s: Service, actIndex: number, cueIndex: number): Service =>
    mapAct(s, actIndex, (a) => ({ ...a, cues: a.cues.filter((_, i) => i !== cueIndex) })),

  /** 여러 큐 한꺼번에 고치기 (일괄 편집) */
  updateCues: (s: Service, ids: ReadonlySet<string>, patch: Partial<Omit<Cue, 'id'>>): Service => ({
    ...s,
    acts: s.acts.map((a) => (a.cues.some((c) => ids.has(c.id)) ? { ...a, cues: a.cues.map((c) => (ids.has(c.id) ? { ...c, ...patch } : c)) } : a)),
  }),

  deleteCues: (s: Service, ids: ReadonlySet<string>): Service => ({
    ...s,
    acts: s.acts.map((a) => (a.cues.some((c) => ids.has(c.id)) ? { ...a, cues: a.cues.filter((c) => !ids.has(c.id)) } : a)),
  }),

  /**
   * 실제 걸린 시간(초)으로 MANUAL 순서의 큐 길이 채우기.
   * overwrite=false 면 길이가 비어 있는 큐만. 반환: 새 문서와 바뀐 큐 수
   */
  fillDurations: (s: Service, measured: Record<string, number>, overwrite: boolean): { service: Service; changed: number } => {
    let changed = 0;
    const acts = s.acts.map((a) => {
      if (a.mode !== 'MANUAL') return a;
      return {
        ...a,
        cues: a.cues.map((c) => {
          const sec = measured[c.id];
          if (sec == null || sec <= 0 || (!overwrite && c.durationSec != null)) return c;
          const rounded = Math.max(1, Math.round(sec));
          if (rounded === c.durationSec) return c;
          changed++;
          return { ...c, durationSec: rounded };
        }),
      };
    });
    return { service: { ...s, acts }, changed };
  },
};
