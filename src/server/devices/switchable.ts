// 실행 중에 스위처 종류를 바꿀 수 있게 하는 대리 어댑터.
// ShowRuntime 은 이 객체 하나만 알고, 장비 연결 화면에서 설정을 저장하면 안쪽 어댑터만 교체된다.
import type { AtemStatus } from '../../shared/protocol';
import { FULL_CAPS, type AtemAdapter } from '../atem/types';

export class SwitchableAdapter implements AtemAdapter {
  private listeners = new Set<(s: AtemStatus) => void>();
  private unsubInner: () => void;

  constructor(private inner: AtemAdapter) {
    this.unsubInner = inner.onStatus(() => this.emit());
  }

  get current() {
    return this.inner;
  }

  /** 기존 어댑터 연결을 끊고 새 어댑터로 교체 (연결은 호출 측에서) */
  async replace(next: AtemAdapter) {
    const prev = this.inner;
    this.unsubInner();
    this.inner = next;
    this.unsubInner = next.onStatus(() => this.emit());
    await prev.disconnect().catch(() => {});
    this.emit();
  }

  status() {
    return this.inner.status();
  }
  capabilities() {
    return this.inner.capabilities?.() ?? FULL_CAPS;
  }
  onStatus(listener: (s: AtemStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  connect() {
    return this.inner.connect();
  }
  disconnect() {
    return this.inner.disconnect();
  }
  setPreview(input: number) {
    return this.inner.setPreview(input);
  }
  cut() {
    return this.inner.cut();
  }
  autoTransition() {
    return this.inner.autoTransition();
  }
  runMacro(index: number) {
    return this.inner.runMacro(index);
  }
  setDownstreamKeyOnAir(keyer: number, onAir: boolean) {
    return this.inner.setDownstreamKeyOnAir(keyer, onAir);
  }

  private emit() {
    const s = this.inner.status();
    for (const l of this.listeners) l(s);
  }
}
