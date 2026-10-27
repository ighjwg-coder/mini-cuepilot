// 카메라맨용 CueScreen (/cam/:n)
// 한눈에: ① 상태 띠(ON AIR / 다음 차례 / 대기) + 카운트다운 → ② 내 샷 → ③ 메모 카드 → ④ 그 다음
// 색 약속: 빨강 = ON AIR 전용. 차례가 다가오면 흰색 → 노랑 → 주황으로만 바뀌고 5초 전부터 흔들린다.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import { cameraView, cueDurationMs, cueElapsedMs, currentAct, type UpcomingCue } from '@shared/engine';
import { parseNote } from '@shared/note';
import { MAX_CAMERA, MIN_CAMERA, type Cue } from '@shared/types';
import { SHOT_LABEL, cameraColor, formatClock } from '../lib/format';
import { useShow, useTicker } from '../lib/useShow';
import { useWakeLock } from '../lib/useWakeLock';
import { canSetOrientation, inApp, setOrientation, vibrate } from '../lib/appBridge';
import { loadCueSettings, saveCueSettings, type CueSettings } from '../lib/cueSettings';
import './cuescreen.css';

/** 이 시간(ms) 안으로 들어오면 색이 변하기 시작 */
const URGENT_FROM_MS = 10_000;
/** 이 시간(ms) 안이면 흔들림 */
const SHAKE_FROM_MS = 5_000;
/**
 * GO 직후 이 시간(ms) 동안은 실제 탈리가 따라오는 중으로 본다.
 * (캠큐는 GO 즉시 큐를 넘기지만 실제 탈리는 스위처를 거쳐 조금 늦게 들어온다)
 */
const SWITCH_GRACE_MS = 1500;

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

type Phase = 'onair' | 'next' | 'standby' | 'idle' | 'offline';

function CueScreen({ camera }: { camera: number }) {
  const { connected, service, snapshot, serverNow } = useShow('cam', camera);
  const wake = useWakeLock();
  // 앱에서는 화면 유지·전체 화면을 앱이 처리 → 바로 시작
  const [started, setStarted] = useState(inApp);
  const [settings, setSettings] = useState<CueSettings>(loadCueSettings);
  const [showSettings, setShowSettings] = useState(false);
  useTicker(100);

  useEffect(() => {
    document.title = `CAM ${camera} · CueScreen`;
  }, [camera]);

  useEffect(() => {
    saveCueSettings(settings);
    setOrientation(settings.orientation);
  }, [settings]);

  const now = serverNow();
  const state = snapshot?.state;
  const view = service && state ? cameraView(service, state, now, camera) : null;
  const tally = snapshot?.tally;
  const switcherMode = snapshot?.atem.mode;
  const act = service && state ? currentAct(service, state) : null;

  // ── 탈리 판단 ──
  const onAirCams = tally ? (tally.onAir ?? (tally.program === null ? [] : [tally.program])) : [];
  /** 스위처·GPI 가 알려 준 실제 탈리인가 (아니면 큐 진행 기준 추정) */
  const realTally = tally?.source === 'gpi' || tally?.source === 'atem';
  /** 스위처를 쓰도록 설정했는데 연결이 끊겨 큐 기준으로 추정 중 */
  const estimated = tally?.source === 'engine' && switcherMode !== undefined && switcherMode !== 'disabled';
  const sinceSwitch = state?.lastTransition ? now - state.lastTransition.at : Infinity;
  const switching = sinceSwitch < SWITCH_GRACE_MS;
  const isCurrent = !!view?.current;
  const tallyOn = onAirCams.includes(camera);
  /** 내 큐로 막 넘어왔고 실제 탈리가 따라오는 중 */
  const pending = realTally && isCurrent && !tallyOn && switching;
  const onAir = connected && (tallyOn || pending);
  /** 큐와 상관없이 실제로 송출 중 (패널에서 수동 컷) */
  const manualOnAir = connected && realTally && tallyOn && !isCurrent && !switching;
  /** 큐로는 내 차례인데 실제로는 송출되지 않음 */
  const notOnAir = connected && realTally && isCurrent && !tallyOn && !switching;
  // 실제 스위처 PVW 를 아는 경우(ATEM)만 PVW 표시. GPI·이케가미 모드의 "PVW" 는 캠큐 내부 값이라 표시하지 않는다
  const showPvw = connected && !onAir && tally?.preview === camera && (switcherMode === 'real' || switcherMode === 'mock');

  // ON AIR 중인 내 큐의 남은 시간
  let liveRemaining: number | null = null;
  if (view?.current && act && state) {
    const dur = cueDurationMs(act, state.cueIndex);
    liveRemaining = dur != null ? dur - cueElapsedMs(state, now) : null;
  }

  const next = view?.next ?? null;
  const mainCue: Cue | null = view?.current ?? next?.cue ?? null;
  const upcomingCue: UpcomingCue | null = view?.current ? next : (view?.afterNext ?? null);

  const phase: Phase = !connected
    ? 'offline'
    : onAir
      ? 'onair'
      : !service || !mainCue
        ? 'idle'
        : notOnAir
          ? 'standby'
          : next?.cuesAway === 1
            ? 'next'
            : 'standby';

  // 긴박도 0~1: 카운트다운이 10초 안으로 들어오면 증가 (수동 GO 가 낀 ≈ 예상 시간도 포함).
  // 시간을 모르는 바로 다음 차례는 0.45(노랑)
  const eta = !view?.current && next && next.etaMs != null && (next.exact || next.cuesAway === 1) ? next.etaMs : null;
  let urgency = 0;
  if ((phase === 'next' || phase === 'standby') && !notOnAir) {
    if (eta != null && eta <= URGENT_FROM_MS) urgency = 1 - Math.max(0, eta) / URGENT_FROM_MS;
    else if (phase === 'next') urgency = 0.45;
  }
  const shaking = !notOnAir && eta != null && eta <= SHAKE_FROM_MS && eta > 0;
  const urgentColor = urgencyColor(urgency);
  /** 예상 시간이 지났는데 아직 GO 가 안 됨 (수동 진행) */
  const waitingGo = next != null && next.etaMs != null && next.etaMs <= 0 && !next.exact;

  // ── 진동 ──
  // ON AIR 순간 진동은 카메라가 흔들릴 수 있어 설정에서 켠 경우만. 예고 진동은 정확한 시간일 때만
  const wasOnAir = useRef(false);
  useEffect(() => {
    if (tallyOn && !wasOnAir.current && started && settings.vibrate === 'all') vibrate([400]);
    wasOnAir.current = tallyOn;
  }, [tallyOn, started, settings.vibrate]);
  const nextId = next?.cue.id ?? null;
  const exactEta = next?.exact ? eta : null;
  const warned = useRef<string | null>(null);
  useEffect(() => {
    if (!started || settings.vibrate === 'off' || exactEta == null || nextId == null) return;
    if (exactEta <= 3000 && exactEta > 0 && warned.current !== nextId) {
      warned.current = nextId;
      vibrate([120, 100, 120]);
    }
  }, [exactEta, nextId, started, settings.vibrate]);

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
    filter: settings.brightness < 100 ? `brightness(${settings.brightness / 100})` : undefined,
  } as CSSProperties;

  const mainLabel = view?.current ? (notOnAir ? '큐상 지금 내 차례 · 실제 송출 아님' : '지금 내 샷') : manualOnAir ? '다음 큐에서 찍을 샷' : '다음 내 샷';

  return (
    <div className={`cs cs-${phase} ${showPvw ? 'cs-pvw' : ''} ${settings.blink ? '' : 'cs-noblink'}`} style={style}>
      <div className="cs-tally" aria-hidden />

      <header className="cs-header">
        <span className="cs-cam">CAM {camera}</span>
        {showPvw && <span className="cs-pvw-tag">PVW</span>}
        {estimated && connected && <span className="cs-estimate">탈리 추정</span>}
        <span className="cs-spacer" />
        {state?.held && <span className="cs-hold">HOLD</span>}
        <span className={`cs-conn ${connected ? 'ok' : 'bad'}`}>{connected ? '●' : '● 재연결 중'}</span>
        <button className="cs-gear" onClick={() => setShowSettings(true)} aria-label="화면 설정">
          ⚙
        </button>
      </header>

      {/* ① 상태 띠 + 카운트다운 */}
      <section className={`cs-band ${shaking ? 'cs-shake' : ''}`}>
        {phase === 'onair' && (
          <>
            <span className="cs-band-title">● ON AIR</span>
            {liveRemaining != null && <span className="cs-band-time cs-mono">{formatClock(liveRemaining)}</span>}
          </>
        )}
        {phase === 'standby' && notOnAir && <span className="cs-band-title">큐상 내 차례 · 송출 아님</span>}
        {(phase === 'next' || phase === 'standby') && !notOnAir && next && (
          <>
            <span className="cs-band-title">{phase === 'next' ? '▶ 다음이 내 차례' : '대기'}</span>
            <span className="cs-band-time">
              {waitingGo ? (
                <span>GO 대기</span>
              ) : next.etaMs != null ? (
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
        {phase === 'offline' && <span className="cs-band-title">연결 끊김 — 탈리 정보 없음</span>}
      </section>
      {phase !== 'onair' && phase !== 'offline' && next && next.etaMs != null && !next.exact && !notOnAir && (
        <div className="cs-band-sub">{waitingGo ? '예상 시간이 지났습니다 — 디렉터 GO 를 기다리는 중' : '수동 GO 포함 예상 시간'}</div>
      )}
      {phase === 'onair' && (
        <div className="cs-band-sub">
          {manualOnAir ? '수동 컷 — 큐와 별개로 송출 중' : liveRemaining != null ? '이 샷 남은 시간' : '다음 GO 까지 유지'}
        </div>
      )}
      {notOnAir && <div className="cs-band-sub">패널에서 다른 카메라로 컷됨 — 디렉터 확인</div>}

      {/* ② 내 샷 + ③ 메모 */}
      <main className="cs-main">
        {mainCue && note && (
          <>
            <div className="cs-label">{mainLabel}</div>
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
        {!mainCue && manualOnAir && <div className="cs-label">큐에 없는 송출 — 수동 컷</div>}
      </main>

      {/* ④ 그 다음 */}
      <footer className="cs-footer">
        {upcomingCue && (
          <div className="cs-after">
            <span className="cs-label">그 다음</span> <b>{upcomingCue.cue.shotSize}</b> <AfterNote note={upcomingCue.cue.note} />
            <span className="cs-dim"> · {etaText(upcomingCue)}</span>
          </div>
        )}
        <div className="cs-meta">
          <span>{act ? act.title : (service?.title ?? '')}</span>
          <span className="cs-spacer" />
          <span className="cs-dim">{inApp ? '앱 · 화면 유지 ON' : wakeLabel(wake.mode)}</span>
        </div>
      </footer>

      {phase === 'offline' && (
        <div className="cs-offline-cover">
          <b>연결 끊김</b>
          <span>지금 탈리를 알 수 없습니다</span>
          <small>자동으로 다시 연결하는 중… 카메라 위 탈리 램프를 보세요</small>
        </div>
      )}

      {showSettings && <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}

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

function SettingsPanel({ settings, onChange, onClose }: { settings: CueSettings; onChange: (s: CueSettings) => void; onClose: () => void }) {
  const set = (patch: Partial<CueSettings>) => onChange({ ...settings, ...patch });
  return (
    <div className="cs-settings" onClick={onClose}>
      <div className="cs-settings-box" onClick={(e) => e.stopPropagation()}>
        <h2>화면 설정</h2>
        <Choice
          label="진동"
          value={settings.vibrate}
          options={[
            ['off', '끔'],
            ['warn', '3초 전 예고만'],
            ['all', '예고 + ON AIR'],
          ]}
          onChange={(v) => set({ vibrate: v })}
          help="폰을 카메라에 붙였다면 ON AIR 진동은 끄세요 (망원에서 화면이 흔들릴 수 있음)"
        />
        <Choice
          label="밝기"
          value={String(settings.brightness)}
          options={[
            ['100', '100%'],
            ['70', '70%'],
            ['45', '45%'],
            ['25', '25%'],
          ]}
          onChange={(v) => set({ brightness: Number(v) })}
          help="어두운 예배당에서는 낮추세요"
        />
        <Choice
          label="ON AIR 깜빡임"
          value={settings.blink ? 'on' : 'off'}
          options={[
            ['on', '켬'],
            ['off', '끔'],
          ]}
          onChange={(v) => set({ blink: v === 'on' })}
        />
        {canSetOrientation() && (
          <Choice
            label="화면 방향"
            value={settings.orientation}
            options={[
              ['auto', '자동 회전'],
              ['portrait', '세로 고정'],
              ['landscape', '가로 고정'],
            ]}
            onChange={(v) => set({ orientation: v })}
          />
        )}
        <button className="cs-settings-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  help,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
  help?: string;
}) {
  return (
    <div className="cs-choice">
      <div className="cs-choice-label">{label}</div>
      <div className="cs-choice-row">
        {options.map(([v, text]) => (
          <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
      {help && <div className="cs-choice-help">{help}</div>}
    </div>
  );
}

function AfterNote({ note }: { note: string }) {
  const n = parseNote(note);
  return n.important ? <span className="cs-after-important">⚠ {n.text}</span> : <span>{n.text}</span>;
}

/** 0 = 흰색 → 0.5 = 노랑 → 1 = 주황. 빨강은 ON AIR 전용이라 쓰지 않는다 */
function urgencyColor(u: number): string {
  const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const white = [255, 255, 255];
  const yellow = [250, 204, 21];
  const orange = [255, 140, 26];
  const c = u <= 0.5 ? lerp(white, yellow, u / 0.5) : lerp(yellow, orange, (u - 0.5) / 0.5);
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
