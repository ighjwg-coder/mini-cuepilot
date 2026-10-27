// 제어 PIN (다른 기기에서 GO·편집·장비 설정을 할 때). 이 브라우저에만 기억한다.
const KEY = 'camcue.pin.v1';

export function getPin(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setPin(pin: string | null) {
  try {
    if (pin) localStorage.setItem(KEY, pin);
    else localStorage.removeItem(KEY);
  } catch {
    // 개인정보 보호 모드 등 — 이번 화면에서만 사용
  }
}

/** PIN 입력 창. 입력하면 저장하고 true */
export function askPin(reason: string): boolean {
  const pin = prompt(`${reason}\n\n제어 PIN 을 입력하세요 (캠큐 PC 의 config.env → CAMCUE_PIN)`, '');
  if (!pin) return false;
  setPin(pin.trim());
  return true;
}
