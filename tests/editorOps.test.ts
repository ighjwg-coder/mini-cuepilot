import { describe, expect, it } from 'vitest';
import { defaultIdGen, ops } from '../src/shared/editorOps';
import { serviceInputSchema } from '../src/shared/schema';
import { sampleService } from './fixtures';

let n = 0;
const id = () => `new-${++n}`;
const ids = (cues: { id: string }[]) => cues.map((c) => c.id);

describe('editorOps', () => {
  const svc = sampleService();

  it('원본을 변경하지 않음(불변)', () => {
    const before = structuredClone(svc);
    ops.moveCue(svc, 0, 0, 3);
    ops.deleteAct(svc, 0);
    ops.updateCue(svc, 0, 0, { camera: 8 });
    expect(svc).toEqual(before);
  });

  it('드래그 정렬: moveCue', () => {
    const s = ops.moveCue(svc, 0, 0, 2);
    expect(ids(s.acts[0].cues)).toEqual(['w-v1-b', 'w-ch-a', 'w-v1-a', 'w-ch-b']);
    expect(ids(ops.moveCue(svc, 0, 3, 0).acts[0].cues)[0]).toBe('w-ch-b');
  });

  it('addCue: 직전 큐의 섹션/마디/카메라 상속, 위치 지정', () => {
    const s = ops.addCue(svc, 0, id);
    const added = s.acts[0].cues.at(-1)!;
    expect(added).toMatchObject({ section: 'CH', bars: 4, camera: 1, shotSize: 'MS', atemAction: 'cut' });
    const first = ops.addCue(svc, 1, id, 0).acts[1].cues[0];
    expect(first).toMatchObject({ section: null, bars: null, camera: 1 });
  });

  it('duplicate / delete / moveCueToAct', () => {
    let s = ops.duplicateCue(svc, 1, 0, id);
    expect(s.acts[1].cues).toHaveLength(3);
    expect(s.acts[1].cues[1]).toMatchObject({ camera: 2, durationSec: 30 });
    expect(s.acts[1].cues[1].id).not.toBe('p-1');
    s = ops.deleteCue(s, 1, 1);
    expect(ids(s.acts[1].cues)).toEqual(['p-1', 'p-2']);
    s = ops.moveCueToAct(s, 1, 0, 2);
    expect(ids(s.acts[1].cues)).toEqual(['p-2']);
    expect(ids(s.acts[2].cues)).toEqual(['p-1']);
    expect(ops.moveCueToAct(s, 1, 0, 1)).toBe(s);
  });

  it('Act 추가/수정/이동/삭제', () => {
    let s = ops.addAct(svc, id, { title: '광고' });
    expect(s.acts.at(-1)).toMatchObject({ title: '광고', mode: 'MANUAL', cues: [] });
    s = ops.updateAct(s, 4, { mode: 'SECTION', bpm: 90 });
    expect(s.acts[4]).toMatchObject({ mode: 'SECTION', bpm: 90 });
    s = ops.moveAct(s, 4, 0);
    expect(s.acts[0].title).toBe('광고');
    s = ops.deleteAct(s, 0);
    expect(s.acts.map((a) => a.id)).toEqual(svc.acts.map((a) => a.id));
  });

  it('편집 결과는 저장 스키마를 통과', () => {
    let s = ops.addAct(svc, id);
    s = ops.addCue(s, 4, id);
    expect(serviceInputSchema.safeParse(s).success).toBe(true);
  });

  it('defaultIdGen: UUID 형식', () => {
    expect(defaultIdGen()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
