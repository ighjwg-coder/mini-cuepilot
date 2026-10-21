// 안드로이드 CamCue 앱(WebView)이 넣어 주는 연결 객체. 브라우저에서 열면 없음.
// 앱이 화면 꺼짐 방지·전체 화면을 직접 처리하므로 "탭해서 시작" 단계가 필요 없다.
interface CamCueAppBridge {
  /** 진동 패턴(ms) — "200" 또는 "100,80,100" (진동,쉼,진동…) */
  vibrate(pattern: string): void;
  /** 앱 버전 */
  version(): string;
}

const bridge = (globalThis as { CamCueApp?: CamCueAppBridge }).CamCueApp;

export const inApp = bridge !== undefined;

export function appVersion(): string | null {
  try {
    return bridge?.version() ?? null;
  } catch {
    return null;
  }
}

/** 앱이면 앱 진동, 브라우저면 Vibration API (안드로이드 크롬, 탭 이후에만 동작) */
export function vibrate(pattern: number[]) {
  if (bridge) {
    try {
      bridge.vibrate(pattern.join(','));
    } catch {
      // 구버전 앱 등 — 무시
    }
    return;
  }
  navigator.vibrate?.(pattern);
}
