// 카메라맨용 CueScreen (/cam/:n) — 다크 고정, 큰 글씨, 탈리 테두리, 화면 꺼짐 방지
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { cameraView, cueDurationMs, cueElapsedMs, currentAct, type UpcomingCue } from '@shared/engine';
import { MAX_CAMERA, MIN_CAMERA, type Cue } from '@shared/types';
import { SHOT_LABEL, cameraColor, formatClock } from '../lib/format';
import { useShow, useTicker } from '../lib/useShow';
import { useWakeLock } from '../lib/useWakeLock';
import './cuescreen.css';

export function CueScreenPage() {
  const n = Number(useParams().n);
  if (!Number.isInteger(n) || n < MIN_CAMERA || n > MAX_CAMERA) {
    return (
      <div className="cs cs-invalid">
        카메라 번호는 {MIN_CAMERA}~{MAX_CAMERA} 입니다. 예: <b>/cam/1</b>
      </div>
    );
  }
  return <CueScreen camera={n} />;
}

function CueScreen({ camera }: { camera: number }) {
  const { connected, service, snapshot, serverNow } = useShow('cam', camera);
  const wake = useWakeLock();
  const [started, setStarted] = useState(false);
  useTicker(100);

  useEffect(() => {
    document.title = `CAM ${camera} · CueScreen`;
  }, [camera]);

  const now = serverNow();
  const state = snapshot?.state;
  const view = service && state ? cameraView(service, state, now, camera) : null;
  const tally = snapshot?.tally;
  const onAir = tally ? tally.program === camera : false;
  const onPreview = !onAir && tally?.preview === camera;

  // ON AIR 진입 시 진동 (안드로이드)
  const wasOnAir = useRef(false);
  useEffect(() => {
    // 진동은 사용자가 화면을 한 번 탭한 뒤에만 허용됨
    if (onAir && !wasOnAir.current && started) navigator.vibrate?.(200);
    wasOnAir.current = onAir;
  }, [onAir, started]);

  const start = () => {
    setStarted(true);
    wake.acquire();
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  const act = service && state ? currentAct(service, state) : null;
  const status = onAir ? 'onair' : onPreview ? 'preview' : 'standby';

  // ON AIR 중인 내 큐의 남은 시간
  let liveRemaining: number | null = null;
  if (view?.current && act && state) {
    const dur = cueDurationMs(act, state.cueIndex);
    liveRemaining = dur != null ? dur - cueElapsedMs(state, now) : null;
  }

  // 큰 화면에 보여줄 샷: ON AIR 이면 지금 샷, 아니면 다음 내 샷
  const mainCue: Cue | null = view?.current ?? view?.next?.cue ?? null;
  const upcomingCue: UpcomingCue | null = view?.current ? view.next : (view?.afterNext ?? null);

  return (
    <div className={`cs cs-${status}`} style={{ ['--cam' as string]: cameraColor(camera) }}>
      <div className="cs-tally" aria-hidden />

      <header className="cs-header">
        <span className="cs-cam">CAM {camera}</span>
        <span className={`cs-status ${status}`}>{onAir ? 'ON AIR' : onPreview ? 'PREVIEW' : 'STANDBY'}</span>
      </header>

      <main className="cs-main">
        {!service ? (
          <div className="cs-empty">로드된 행사가 없습니다</div>
        ) : mainCue ? (
          <>
            <div className="cs-label">{view?.current ? '지금 내 샷' : '다음 내 샷'}</div>
            <div className="cs-shot">
              {mainCue.shotSize}
              <span className="cs-shot-ko">{SHOT_LABEL[mainCue.shotSize]}</span>
            </div>
            {mainCue.note && <div className="cs-note">{mainCue.note}</div>}
            {view?.current ? (
              liveRemaining != null && <div className="cs-countdown">남은 시간 {formatClock(liveRemaining)}</div>
            ) : (
              view?.next && <Countdown next={view.next} />
            )}
          </>
        ) : (
          <div className="cs-empty">이 행사에 남은 CAM {camera} 큐가 없습니다</div>
        )}
      </main>

      <footer className="cs-footer">
        {upcomingCue && (
          <div className="cs-after">
            <span className="cs-label">그 다음</span> <b>{upcomingCue.cue.shotSize}</b> {upcomingCue.cue.note}
            <span className="cs-dim"> · {etaText(upcomingCue)}</span>
          </div>
        )}
        <div className="cs-meta">
          <span>{act ? act.title : (service?.title ?? '')}</span>
          {state?.held && <span className="cs-hold">HOLD</span>}
          <span className="cs-spacer" />
          <span className={connected ? 'cs-ok' : 'cs-bad'}>{connected ? '● 연결됨' : '● 재연결 중'}</span>
          <span className="cs-dim">{wakeLabel(wake.mode)}</span>
        </div>
      </footer>

      {!started && (
        <button className="cs-start" onClick={start}>
          <span className="cs-cam" style={{ fontSize: '14vmin' }}>
            CAM {camera}
          </span>
          <span>화면을 탭해서 시작</span>
          <small>화면 꺼짐 방지 · 전체 화면</small>
        </button>
      )}
    </div>
  );
}

function etaText(u: UpcomingCue): string {
  if (u.etaMs == null) return u.cuesAway === 1 ? '바로 다음 큐' : `큐 ${u.cuesAway}개 후`;
  return u.exact ? formatClock(u.etaMs) : `≈ ${formatClock(u.etaMs)}+`;
}

function Countdown({ next }: { next: UpcomingCue }) {
  const soon = next.exact && next.etaMs != null && next.etaMs <= 5000;
  return (
    <div className={`cs-countdown ${soon ? 'soon' : ''}`}>
      <span className="cs-label">내 차례까지</span>{' '}
      {next.etaMs == null ? (
        <span>{next.cuesAway === 1 ? '바로 다음 큐' : `큐 ${next.cuesAway}개 후`}</span>
      ) : (
        <span className="cs-mono">
          {next.exact ? '' : '≈ '}
          {formatClock(next.etaMs)}
          {!next.exact && <small> (수동 GO 포함)</small>}
        </span>
      )}
    </div>
  );
}

function wakeLabel(mode: ReturnType<typeof useWakeLock>['mode']) {
  switch (mode) {
    case 'wakelock':
      return '화면 유지 ON';
    case 'video':
      return '화면 유지 ON(호환)';
    case 'unsupported':
      return '화면 유지 불가 — 자동 잠금 해제 필요';
    default:
      return '';
  }
}
