// 단순 탈리: 캠큐가 컷을 보내지 않고 실제 탈리만 폰에 보여 주는 운영
import { describe, expect, it } from 'vitest';
import { DisabledAtemAdapter, MockAtemAdapter, TallyOnlyAdapter } from '../src/server/atem';
import { readDeviceSettings, resolveDevices } from '../src/server/devices/config';
import { MockGpi } from '../src/server/devices/gpi';
import { ShowRuntime } from '../src/server/runtime';
import { ManualTimecodeSource } from '../src/server/timecode';
import { sampleService } from './fixtures';

describe('단순 탈리 (컷 안 보냄)', () => {
  it('ATEM_TALLY_ONLY=1 → atem 설정에 tallyOnly', () => {
    const r = resolveDevices(readDeviceSettings({ SWITCHER: 'atem', ATEM_HOST: 'mock', ATEM_TALLY_ONLY: '1' }));
    expect(r.errors).toEqual([]);
    expect(r.switcher).toMatchObject({ kind: 'atem', tallyOnly: true });
    expect(resolveDevices(readDeviceSettings({ SWITCHER: 'atem', ATEM_HOST: 'mock' })).switcher).toMatchObject({ tallyOnly: false });
  });

  it('ATEM 탈리만: GO 해도 ATEM PGM 은 그대로, 탈리는 ATEM 실제 값, 명령 기록도 남기지 않음', async () => {
    const inner = new MockAtemAdapter({ transitionMs: 0, latencyMs: 0 });
    await inner.connect();
    await inner.setPreview(4);
    await inner.cut(); // 운영자가 직접 CAM 4 로 컷한 상태
    const atem = new TallyOnlyAdapter(inner);
    const rt = new ShowRuntime({ atem, timecode: new ManualTimecodeSource(), autoPreview: true, log: () => {} });
    rt.load(sampleService());
    rt.command({ command: 'GO' });
    rt.command({ command: 'JUMP', actIndex: 1, cueIndex: 0 });
    await rt.idle();
    expect(inner.status().programInput).toBe(4);
    expect(rt.tally()).toMatchObject({ program: 4, onAir: [4], source: 'atem' });
    expect(rt.snapshot().atem.tallyOnly).toBe(true);
    expect(rt.snapshot().commandLog).toEqual([]);
    // 운영자가 패널에서 컷하면 탈리가 따라온다
    await inner.setPreview(2);
    await inner.cut();
    expect(rt.tally().program).toBe(2);
    rt.stop();
  });

  it('스위처 사용 안 함 + GPI 실측 탈리: 큐와 무관하게 실제 송출만', async () => {
    const gpi = new MockGpi();
    await gpi.connect();
    gpi.setInput(3, true);
    const rt = new ShowRuntime({
      atem: new DisabledAtemAdapter(),
      timecode: new ManualTimecodeSource(),
      tallyInput: {
        active: () => true,
        onAir: () => (gpi.status().inputs ?? []).flatMap((on, i) => (on ? [i + 1] : [])),
        onChange: () => () => {},
      },
    });
    expect(rt.tally()).toMatchObject({ program: 3, onAir: [3], source: 'gpi' });
    rt.stop();
  });
});

describe('ATEM 소스별 탈리 (디졸브 중 두 대)', () => {
  it('programSources: TlSr 에서 PGM 입력만 번호순', async () => {
    const { programSources } = await import('../src/server/atem/real');
    expect(programSources({ 5: { program: true, preview: false }, 2: { program: true, preview: true }, 3: { program: false, preview: true } })).toEqual([2, 5]);
    expect(programSources({})).toEqual([]);
  });

  it('AUTO 전환 중에는 두 카메라 모두 ON AIR, 끝나면 한 대', async () => {
    const atem = new MockAtemAdapter({ transitionMs: 80, latencyMs: 0 });
    await atem.connect();
    const rt = new ShowRuntime({ atem, timecode: new ManualTimecodeSource(), log: () => {} });
    await atem.setPreview(3);
    await atem.autoTransition();
    expect(rt.tally()).toMatchObject({ onAir: [1, 3], source: 'atem' });
    await new Promise((r) => setTimeout(r, 120));
    expect(rt.tally()).toMatchObject({ program: 3, onAir: [3] });
    rt.stop();
  });

  it('카메라 번호 범위 밖 입력(PC · 미디어)은 ON AIR 카메라로 치지 않음', async () => {
    const atem = new MockAtemAdapter({ transitionMs: 0, latencyMs: 0 });
    await atem.connect();
    const rt = new ShowRuntime({ atem, timecode: new ManualTimecodeSource(), log: () => {} });
    atem.simulatePanelCut(10);
    expect(rt.tally()).toMatchObject({ program: 10, onAir: [] });
    rt.stop();
  });
});
