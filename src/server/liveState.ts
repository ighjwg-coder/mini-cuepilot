// 라이브 진행 위치 저장/복원.
// 서버가 재시작돼도(비정상 종료·PC 재부팅) 진행 중이던 행사와 큐 위치로 컷 없이 돌아온다.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { CueRef } from '../shared/engine';

export interface SavedLiveState {
  serviceId: string;
  /** STANDBY 면 null */
  position: CueRef | null;
  savedAt: number;
}

/** 이보다 오래된 위치는 복원하지 않는다 (지난주 예배 중간에서 시작하지 않도록) — 행사만 다시 연다 */
export const RESUME_POSITION_MS = 3 * 60 * 60 * 1000;

export function readLiveState(path: string): SavedLiveState | null {
  try {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<SavedLiveState>;
    if (typeof j.serviceId !== 'string' || typeof j.savedAt !== 'number') return null;
    const p = j.position;
    const position =
      p && Number.isInteger(p.actIndex) && Number.isInteger(p.cueIndex) && p.actIndex >= 0 && p.cueIndex >= 0 ? p : null;
    return { serviceId: j.serviceId, position, savedAt: j.savedAt };
  } catch {
    return null;
  }
}

/** 바뀐 경우에만 기록 (임시 파일에 쓰고 바꿔치기 — 쓰는 중 꺼져도 파일이 깨지지 않게) */
export function createLiveStateWriter(path: string) {
  let last = '';
  return (serviceId: string | null, position: CueRef | null, now = Date.now()) => {
    if (!serviceId) return;
    const key = `${serviceId}:${position?.actIndex ?? -1}:${position?.cueIndex ?? -1}`;
    if (key === last) return;
    last = key;
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ serviceId, position, savedAt: now } satisfies SavedLiveState), 'utf8');
      renameSync(tmp, path);
    } catch {
      // 저장 실패해도 진행에는 영향 없음
    }
  };
}
