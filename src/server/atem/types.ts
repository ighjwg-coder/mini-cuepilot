// ATEM 어댑터 인터페이스. 실제 장비(atem-connection) / mock / disabled 가 같은 인터페이스를 구현한다.
import type { AtemAction } from '../../shared/atemAction';
import type { AtemStatus } from '../../shared/protocol';

export interface AtemAdapter {
  status(): AtemStatus;
  /** 상태(연결, PGM/PVW) 변경 구독. 해제 함수 반환 */
  onStatus(listener: (status: AtemStatus) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /** 입력 번호는 ATEM 입력 번호(1부터) 그대로 */
  setPreview(input: number): Promise<void>;
  cut(): Promise<void>;
  autoTransition(): Promise<void>;
  /** index 는 0부터 (atem-connection 규약) */
  runMacro(index: number): Promise<void>;
  /** keyer 는 0부터 (atem-connection 규약) */
  setDownstreamKeyOnAir(keyer: number, onAir: boolean): Promise<void>;
}

/**
 * 큐 하나의 atemAction 을 어댑터 호출로 변환.
 * cut/auto 는 해당 카메라를 PVW 에 올린 뒤 트랜지션 → PVW/PGM 상태가 항상 ATEM 표준 흐름과 일치.
 * macro/dsk 의 n 은 사람 기준 1부터 → atem-connection 은 0부터.
 */
export async function executeAtemAction(atem: AtemAdapter, camera: number, action: AtemAction): Promise<void> {
  switch (action.kind) {
    case 'cut':
      await atem.setPreview(camera);
      await atem.cut();
      return;
    case 'auto':
      await atem.setPreview(camera);
      await atem.autoTransition();
      return;
    case 'macro':
      await atem.runMacro(action.index - 1);
      return;
    case 'dsk':
      await atem.setDownstreamKeyOnAir(action.keyer - 1, action.onAir);
      return;
  }
}

/** ATEM_HOST 미설정 시: 아무 것도 하지 않고 상태만 'disabled' 로 보고 */
export class DisabledAtemAdapter implements AtemAdapter {
  status(): AtemStatus {
    return { mode: 'disabled', host: null, connected: false, model: null, programInput: null, previewInput: null, lastError: null };
  }
  onStatus(): () => void {
    return () => {};
  }
  async connect() {}
  async disconnect() {}
  async setPreview() {}
  async cut() {}
  async autoTransition() {}
  async runMacro() {}
  async setDownstreamKeyOnAir() {}
}
