// 제어 권한: GO·RESET·행사 편집·장비 설정은 기본적으로 서버 PC(이 컴퓨터)에서만.
// 다른 기기(노트북·태블릿)에서 제어하려면 config.env 에 CAMCUE_PIN 을 정하고 그 PIN 을 입력한다.
// 카메라맨 화면(/cam/N)은 읽기만 하므로 PIN 없이 누구나 열 수 있다.
import { timingSafeEqual } from 'node:crypto';

export interface AccessPolicy {
  /** remote: 접속한 쪽 IP, pin: 클라이언트가 보낸 PIN */
  canControl(remote: string | undefined, pin: string | undefined): boolean;
  /** 거부 이유 안내문 */
  denyReason(): string;
  readonly pinEnabled: boolean;
}

export function isLoopback(remote: string | undefined): boolean {
  if (!remote) return false;
  const a = remote.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

function samePin(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createAccessPolicy(pin: string | undefined): AccessPolicy {
  const p = pin?.trim() ?? '';
  return {
    pinEnabled: p !== '',
    canControl: (remote, given) => isLoopback(remote) || (p !== '' && given !== undefined && samePin(p, given.trim())),
    denyReason: () =>
      p !== ''
        ? '제어 PIN 이 필요합니다 (캠큐 PC 의 config.env → CAMCUE_PIN)'
        : '이 기기에서는 제어할 수 없습니다 — 캠큐 PC 에서 조작하거나, config.env 에 CAMCUE_PIN 을 정하면 다른 기기에서도 PIN 으로 제어할 수 있습니다',
  };
}

/** 모두 허용 (테스트·내부용) */
export const OPEN_ACCESS: AccessPolicy = { pinEnabled: false, canControl: () => true, denyReason: () => '' };
