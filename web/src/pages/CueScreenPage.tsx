// 카메라맨용 CueScreen (/cam/:n)
// 한눈에: ① 상태 띠(ON AIR / 다음 차례 / 대기) + 카운트다운 → ② 내 샷 → ③ 메모 카드 → ④ 그 다음
// 내 차례가 다가오면 카운트다운·메모가 흰색 → 노랑 → 빨강으로 바뀌고 5초 전부터 흔들린다.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import { cameraView, cueDurationMs, cueElapsedMs, currentAct, type UpcomingCue } from '@shared/engine';
import { parseNote } from '@shared/note';
import { MAX_CAMERA, MIN_CAMERA, type Cue } from '@shared/types';
import { SHOT_LABEL, cameraColor, formatClock } from '../lib/format';
import { useShow, useTicker } from '../lib/useShow';
import { useWakeLock } from '../lib/useWakeLock';
import { inApp, vibrate } from '../lib/appBridge';
import './cuescreen.css';

/** 이 시간(ms) 안으로 들어오면 색이 변하기 시작 */
const URGENT_FROM_MS = 10_000;
/** 이 시간(ms) 안이면 흔들림 */
const SHAKE_FROM_MS = 5_000;

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

type Phase = 'onair' | 'next' | 'standby' | 'idle';

function CueScreen({ camera }: { camera: number }) {
  const { connected, service, snapshot, serverNow } = useShow('cam', camera);
  const wake = useWakeLock();
  // 앱에서는 화면 유지·전체 화면을 앱이 처리 → 바로 시작
  const [started, setStarted] = useState(inApp);
  useTicker(100);

  useEffect(() => {
    document.title = `CAM ${camera} · CueScreen`;
  }, [camera]);

  const now = serverNow();
  const state = snapshot?.state;
  const view = service && state ? cameraView(service, state, now, camera) : null;
  const tally = snapshot?.tally;
  // 디졸브·키로 두 대가 동시에 나갈 때도 둘 다 ON AIR (GPI 실측 탈리)
  const onAir = tally ? (tally.onAir ?? [tally.program]).includes(camera) : false;
  const onPreview = !onAir && tally?.preview === camera;
  const act = service && state ? currentAct(service, state) : null;

  // ON AIR 중인 내 큐의 남은 시간
  let liveRemaining: number | null = null;
  if (view?.current && act && state) {
    const dur = cueDurationMs(act, state.cueIndex);
    liveRemaining = dur != null ? dur - cueElapsedMs(state, now) : null;
  }

  const next = view?.next ?? null;
  const mainCue: Cue | null = view?.current ?? next?.cue ?? null;
  const upcomingCue: UpcomingCue | null = view?.current ? next : (view?.afterNext ?? null);

  const phase: Phase = !service || !mainCue ? 'idle' : onAir ? 'onair' : next?.cuesAway === 1 ? 'next' : 'standby';

  // 긴박도 0~1: 카운트다운이 10초 안으로 들어오면 증가 (수동 GO 가 낀 ≈ 예상 시간도 포함).
  // 시간을 모르는 바로 다음 차례는 0.45(노랑)
  const eta = !view?.current && next && next.etaMs != null && (next.exact || next.cuesAway === 1) ? next.etaMs : null;
  let urgency = 0;
  if (phase === 'next' || phase === 'standby') {
    if (eta != null && eta <= URGENT_FROM_MS) urgency = 1 - Math.max(0, eta) / URGENT_FROM_MS;
    else if (phase === 'next') urgency = 0.45;
  }
  const shaking = eta != null && eta <= SHAKE_FROM_MS && eta > 0;
  const urgentColor = urgencyColor(urgency);

  // ── 진동 ──
  const wasOnAir = useRef(false);
  useEffect(() => {
    if (onAir && !wasOnAir.current && started) vibrate([400]);
    wasOnAir.current = onAir;
  }, [onAir, started]);
  const nextId = next?.cue.id ?? null;
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (!started || eta == null || nextId == null) return;
    if (eta <= 3000 && eta > 0 && warned.current !== nextId) {
      warned.current = nextId;
      vibrate([120, 100, 120]);
    }
  }, [eta, nextId, started]);

  const start = () => {
    setStarted(true);
    wake.acquire();
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  const note = mainCue ? parseNote(mainCue.note) : null;
  const style = {
    '--cam': cameraColor(camera),
    '--urgent': urgentColor,
    '--shake': `${(0.4 + urgency * 1.2).toFixed(2)}vmin`,
  } as CSSProperties;

  return (
    <div className={`cs cs-${phase} ${onPreview ? 'cs-pvw' : ''}`} style={style}>
      <div className="cs-tally" aria-hidden />

      <header className="cs-header">
        <span className="cs-cam">CAM {camera}</span>
        {onPreview && <span className="cs-pvw-tag">PVW</span>}
        <span className="cs-spacer" />
        {state?.held && <span className="cs-hold">HOLD</span>}
        <span className={`cs-conn ${connected ? 'ok' : 'bad'}`}>{connected ? '●' : '● 재연결 중'}</span>
      </header>

      {/* ① 상태 띠 + 카운트다운 */}
      <section className={`cs-band ${shaking ? 'cs-shake' : ''}`}>
        {phase === 'onair' && (
          <>
            <span className="cs-band-title">● ON AIR</span>
            {liveRemaining != null && <span className="cs-band-time cs-mono">{formatClock(liveRemaining)}</span>}
          </>
        )}
        {(phase === 'next' || phase === 'standby') && next && (
          <>
            <span className="cs-band-title">{phase === 'next' ? '▶ 다음이 내 차례' : '대기'}</span>
            <span className="cs-band-time">
              {next.etaMs != null ? (
                <span className="cs-mono">
                  {next.exact ? '' : '≈'}
                  {formatClock(next.etaMs)}
                </span>
              ) : (
                <span>{next.cuesAway === 1 ? 'GO 하면 바로' : `큐 ${next.cuesAway}개 후`}</span>
              )}
            </span>
          </>
        )}
        {phase === 'idle' && <span className="cs-band-title">{service ? `남은 CAM ${camera} 큐 없음` : '로드된 행사 없음'}</span>}
      </section>
      {phase !== 'onair' && next && next.etaMs != null && !next.exact && <div className="cs-band-sub">수동 GO 포함 예상 시간</div>}
      {phase === 'onair' && <div className="cs-band-sub">{liveRemaining != null ? '이 샷 남은 시간' : '다음 GO 까지 유지'}</div>}

      {/* ② 내 샷 + ③ 메모 */}
      <main className="cs-main">
        {mainCue && note && (
          <>
            <div className="cs-label">{view?.current ? '지금 내 샷' : '다음 내 샷'}</div>
            <div className="cs-shot">
              {mainCue.shotSize}
              <span className="cs-shot-ko">{SHOT_LABEL[mainCue.shotSize]}</span>
            </div>
            {note.text && (
              <div className={`cs-note ${note.important ? 'important' : ''} ${shaking ? 'cs-shake' : ''}`}>
                {note.important && <span className="cs-note-mark">⚠ 중요</span>}
                {note.text}
              </div>
            )}
          </>
        )}
      </main>

      {/* ④ 그 다음 */}
      <footer className="cs-footer">
        {upcomingCue && (
          <div className="cs-after">
            <span className="cs-label">그 다음</span> <b>{upcomingCue.cue.shotSize}</b>{' '}
            <AfterNote note={upcomingCue.cue.note} />
            <span className="cs-dim"> · {etaText(upcomingCue)}</span>
          </div>
        )}
        <div className="cs-meta">
          <span>{act ? act.title : (service?.title ?? '')}</span>
          <span className="cs-spacer" />
          <span className="cs-dim">{inApp ? '앱 · 화면 유지 ON' : wakeLabel(wake.mode)}</span>
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

function AfterNote({ note }: { note: string }) {
  const n = parseNote(note);
  return n.important ? <span className="cs-after-important">⚠ {n.text}</span> : <span>{n.text}</span>;
}

/** 0 = 흰색 → 0.5 = 노랑 → 1 = 빨강 */
function urgencyColor(u: number): string {
  const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const white = [255, 255, 255];
  const yellow = [250, 204, 21];
  const red = [255, 40, 40];
  const c = u <= 0.5 ? lerp(white, yellow, u / 0.5) : lerp(yellow, red, (u - 0.5) / 0.5);
  return `rgb(${c.join(',')})`;
}

function etaText(u: UpcomingCue): string {
  if (u.etaMs == null) return u.cuesAway === 1 ? '바로 다음 큐' : `큐 ${u.cuesAway}개 후`;
  return u.exact ? formatClock(u.etaMs) : `≈ ${formatClock(u.etaMs)}+`;
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
