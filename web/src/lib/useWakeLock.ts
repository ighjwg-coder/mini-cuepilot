// 화면 꺼짐 방지.
// 1순위: Screen Wake Lock API (보안 컨텍스트 = HTTPS 또는 localhost 에서만 제공)
// 2순위: 음소거 무한 반복 비디오 재생 (NoSleep 방식) — LAN HTTP 접속 시 폴백. 사용자 탭 이후에만 재생 가능
import { useCallback, useEffect, useRef, useState } from 'react';

export type WakeLockMode = 'off' | 'wakelock' | 'video' | 'unsupported';

function createKeepAwakeVideo(): HTMLVideoElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.captureStream !== 'function') return null;
  // 프레임이 계속 바뀌어야 일부 브라우저가 "재생 중"으로 인식
  let flip = false;
  const timer = setInterval(() => {
    flip = !flip;
    ctx.fillStyle = flip ? '#000' : '#010101';
    ctx.fillRect(0, 0, 2, 2);
  }, 1000);
  const video = document.createElement('video');
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.srcObject = canvas.captureStream(1);
  Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none', bottom: '0', left: '0' });
  video.addEventListener('emptied', () => clearInterval(timer));
  document.body.appendChild(video);
  return video;
}

export function useWakeLock() {
  const [mode, setMode] = useState<WakeLockMode>('off');
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const wanted = useRef(false);

  const acquire = useCallback(async () => {
    wanted.current = true;
    if ('wakeLock' in navigator && window.isSecureContext) {
      try {
        sentinel.current = await navigator.wakeLock.request('screen');
        sentinel.current.addEventListener('release', () => {
          sentinel.current = null;
          if (document.visibilityState !== 'visible') setMode('off');
        });
        setMode('wakelock');
        return;
      } catch {
        // 배터리 절약 모드 등으로 거부 → 비디오 폴백
      }
    }
    try {
      video.current ??= createKeepAwakeVideo();
      if (!video.current) return setMode('unsupported');
      await video.current.play();
      setMode('video');
    } catch {
      setMode('unsupported');
    }
  }, []);

  // 탭 전환/화면 잠금 후 돌아오면 Wake Lock 은 자동 해제되므로 재요청
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wanted.current && !sentinel.current) acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      sentinel.current?.release().catch(() => {});
      if (video.current) {
        video.current.srcObject = null;
        video.current.remove();
      }
    };
  }, [acquire]);

  return { mode, acquire };
}
