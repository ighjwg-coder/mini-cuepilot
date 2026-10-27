import { useEffect, useRef, useState } from 'react';
import {
  cueAt,
  cueDurationMs,
  cueElapsedMs,
  currentAct,
  currentCue,
  goTarget,
  isAutoTransition,
  isStandby,
  upcoming,
  type UpcomingCue,
} from '@shared/engine';
import { parseNote } from '@shared/note';
import type { ConnectedClient, ShowSnapshot } from '@shared/protocol';
import type { Act, Cue, Service } from '@shared/types';
import { AtemBadge, CamClients, ConnectionBadge, TimecodeBadge, camCounts } from '../components/StatusBadges';
import { TopBar } from '../components/TopBar';
import { MODE_LABEL, SHOT_LABEL, cameraColor, formatClock } from '../lib/format';
import { askPin } from '../lib/pin';
import { useShow, useTicker } from '../lib/useShow';

/** 명령 실패 알림을 이 시간(ms) 동안 크게 보여 준다 */
const ALERT_MS = 15_000;

/** 입력 필드에 포커스가 있을 때는 단축키 무시 */
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export function DirectorPage() {
  const [reconnectKey, setReconnectKey] = useState(0);
  const show = useShow('director', undefined, reconnectKey);
  const { service, snapshot } = show;
  /** 켜면 BACK·JUMP 가 컷 없이 큐 위치만 옮긴다 (위치 맞추기용) */
  const [cueOnly, setCueOnly] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  useTicker(100);

  const canControl = show.connected && show.access?.canControl !== false;
  const command: typeof show.command = (cmd) => {
    if (!show.connected) {
      setHint('서버 연결이 끊겨 명령을 보내지 못했습니다');
      return false;
    }
    if (show.access?.canControl === false) {
      setHint(show.access.reason ?? '이 기기에서는 제어할 수 없습니다');
      return false;
    }
    return show.command(cmd);
  };
  const commandRef = useRef(command);
  commandRef.current = command;
  const cueOnlyRef = useRef(cueOnly);
  cueOnlyRef.current = cueOnly;

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 4000);
    return () => clearTimeout(t);
  }, [hint]);

  // 단축키: Space=GO, Shift+Backspace=BACK (실수 방지), H=HOLD
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const run = commandRef.current;
      if (e.code === 'Space') {
        e.preventDefault();
        run({ command: 'GO' });
      } else if (e.code === 'Backspace') {
        e.preventDefault();
        if (e.shiftKey) run({ command: 'BACK', silent: cueOnlyRef.current });
        else setHint('BACK 은 Shift + Backspace 입니다 (실수로 이전 카메라로 컷되지 않도록)');
      } else if (e.code === 'KeyH') {
        e.preventDefault();
        run({ command: 'HOLD' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const now = show.serverNow();
  const state = snapshot?.state;
  const enterPin = () => {
    if (askPin(show.access?.reason ?? '제어 PIN')) setReconnectKey((k) => k + 1);
  };

  return (
    <div className="director">
      <TopBar>
        <span className="muted">{service ? `${service.date ?? ''} ${service.title}` : '로드된 행사 없음'}</span>
        <TimecodeBadge snapshot={snapshot} />
        <AtemBadge snapshot={snapshot} />
        <CamClients clients={show.clients} expected={expectedCameras(service, snapshot)} />
        <ConnectionBadge connected={show.connected} />
      </TopBar>

      <main className="director-main">
        {!show.connected && <div className="director-alert">⚠️ 서버 연결 끊김 — 지금 누르는 GO 는 전달되지 않습니다. 다시 연결하는 중…</div>}
        {show.connected && show.access?.canControl === false && (
          <div className="director-alert">
            🔒 {show.access.reason}{' '}
            <button className="primary" onClick={enterPin}>
              PIN 입력
            </button>
          </div>
        )}
        {hint && <div className="director-hint">{hint}</div>}
        {!service || !state ? (
          <p className="muted">
            로드된 행사가 없습니다. <a href="/">홈</a>에서 행사를 “라이브로 열기” 하세요.
          </p>
        ) : (
          <LivePanel
            service={service}
            snapshot={snapshot!}
            now={now}
            onCommand={command}
            canControl={canControl}
            cueOnly={cueOnly}
            onCueOnly={setCueOnly}
            clients={show.clients}
          />
        )}
      </main>

      <aside className="director-side">
        {service && state && (
          <RunSheet
            service={service}
            snapshot={snapshot!}
            cueOnly={cueOnly}
            onJump={(actIndex, cueIndex, silent) => command({ command: 'JUMP', actIndex, cueIndex, silent })}
          />
        )}
      </aside>
    </div>
  );
}

/** 접속해 있어야 할 카메라: 스위처로 컷할 수 있는 카메라, 모르면 이 행사에 나오는 카메라 */
function expectedCameras(service: Service | null, snapshot: ShowSnapshot | null): number[] {
  const caps = snapshot?.switcherCaps?.cameras;
  if (caps && caps.length) return caps;
  const used = new Set(service?.acts.flatMap((a) => a.cues.map((c) => c.camera)) ?? []);
  return [...used].sort((a, b) => a - b);
}

function LivePanel({
  service,
  snapshot,
  now,
  onCommand,
  canControl,
  cueOnly,
  onCueOnly,
  clients,
}: {
  service: Service;
  snapshot: ShowSnapshot;
  now: number;
  onCommand: ReturnType<typeof useShow>['command'];
  canControl: boolean;
  cueOnly: boolean;
  onCueOnly: (v: boolean) => void;
  clients: ConnectedClient[];
}) {
  const { state, tally } = snapshot;
  const onAir = tally.onAir ?? (tally.program === null ? [] : [tally.program]);
  // GO 직후에는 실제 탈리가 스위처를 거쳐 조금 늦게 들어오므로, 큐와 다름 경고는 잠시 뒤부터
  const settled = !state.lastTransition || now - state.lastTransition.at > 1500;
  const switcherDown = snapshot.atem.mode !== 'disabled' && !snapshot.atem.connected;
  const act = currentAct(service, state);
  const cue = currentCue(service, state);
  const next = upcoming(service, state, now, 1)[0] ?? null;
  const standby = isStandby(state);

  const duration = act && cue ? cueDurationMs(act, state.cueIndex) : null;
  const elapsed = cueElapsedMs(state, now);
  const remaining = duration != null ? duration - elapsed : null;
  const autoNext = !standby && isAutoTransition(service, { actIndex: state.actIndex, cueIndex: state.cueIndex });
  const nextAct = next ? service.acts[next.actIndex] : null;
  // GO 를 누르면 실제로 갈 큐 (SECTION 자동 구간에서는 다음 섹션 첫 큐로 건너뜀)
  const target = goTarget(service, state);
  const targetCue = cueAt(service, target);
  const skipsAhead = !!target && !!next && (target.actIndex !== next.actIndex || target.cueIndex !== next.cueIndex);
  // 최근 명령 실패·미전송
  const log = snapshot.commandLog ?? [];
  const recentProblem = [...log].reverse().find((e) => e.result !== 'ok' && now - e.at < ALERT_MS);
  // 카메라맨 화면 접속 상태: 같은 번호 2대 이상 / 접속 안 한 카메라
  const counts = camCounts(clients);
  const expected = expectedCameras(service, snapshot);
  const dupCams = [...counts.entries()].filter(([, n]) => n > 1).map(([c, n]) => `CAM ${c} ×${n}`);
  const missingCams = expected.filter((c) => !counts.has(c)).map((c) => `CAM ${c}`);

  return (
    <>
      <div className={`cue-card live ${state.held ? 'held' : ''}`}>
        <div className="label">
          {standby ? 'STANDBY' : 'ON AIR'} {state.held && <span style={{ color: 'var(--hold)' }}>· HOLD</span>}
        </div>
        {cue && act ? (
          <>
            <CueHeadline cue={cue} />
            <div className="meta">
              <span className="badge">{act.title}</span>
              <span className="badge">{MODE_LABEL[act.mode]}</span>
              {act.mode === 'SECTION' && act.bpm && <span className="badge mono">{act.bpm} BPM</span>}
              {cue.section && <span className="badge">{cue.section}</span>}
              <span className="badge mono">{cue.atemAction}</span>
              <span className="badge muted">
                큐 {state.cueIndex + 1}/{act.cues.length}
              </span>
            </div>
            <div className="timer">
              <div className="big mono">{remaining != null ? formatClock(remaining) : formatClock(elapsed)}</div>
              <div className="muted">{remaining != null ? '남음' : '경과'}</div>
            </div>
            {duration != null && (
              <div className="progress">
                <div style={{ width: `${Math.min(100, (elapsed / duration) * 100)}%` }} />
              </div>
            )}
          </>
        ) : (
          <div className="note muted">GO(Space)를 누르면 첫 큐가 송출됩니다.</div>
        )}
      </div>

      <div className="cue-card next">
        <div className="label">
          NEXT {next && <NextEta next={next} auto={autoNext} />}
          {next && nextAct && next.actIndex !== state.actIndex && <> · 다음 순서: {nextAct.title}</>}
        </div>
        {skipsAhead && targetCue && (
          <div className="go-skip">
            ⏭ 지금 GO 를 누르면 자동 진행을 건너뛰고 <b>{targetCue.section ?? '다음 섹션'}</b> 첫 큐(CAM {targetCue.camera})로 갑니다
          </div>
        )}
        {next ? (
          <>
            <CueHeadline cue={next.cue} />
            {next.cue.section && <span className="badge">{next.cue.section}</span>}
          </>
        ) : (
          <div className="note muted">마지막 큐입니다.</div>
        )}
      </div>

      {/* 마우스 클릭으로 버튼이 포커스를 가지면 Space 가 버튼 클릭까지 일으켜 GO 가 두 번 나가므로 포커스 방지 */}
      {recentProblem && (
        <div className="director-alert">
          ⚠️ {recentProblem.result === 'skipped' ? '컷 못 보냄' : '컷 실패'}: {recentProblem.label}
          {recentProblem.error ? ` — ${recentProblem.error}` : ''} · 큐는 넘어갔지만 송출은 바뀌지 않았을 수 있습니다
        </div>
      )}

      <div className="transport" onMouseDown={(e) => e.preventDefault()}>
        <button onClick={() => onCommand({ command: 'BACK', silent: cueOnly })} disabled={!canControl}>
          ◀ BACK{cueOnly ? ' (큐만)' : ''} <kbd>Shift+⌫</kbd>
        </button>
        <button className={`hold ${state.held ? 'active' : ''}`} onClick={() => onCommand({ command: 'HOLD' })} disabled={!canControl}>
          {state.held ? '▶ RESUME' : '❚❚ HOLD'} <kbd>H</kbd>
        </button>
        <button className="go" onClick={() => onCommand({ command: 'GO' })} disabled={!targetCue || !canControl}>
          GO ▶{targetCue && <span className="go-target"> CAM {targetCue.camera}{targetCue.section ? ` · ${targetCue.section}` : ''}</span>}{' '}
          <kbd style={{ color: '#d1fae5' }}>Space</kbd>
        </button>
      </div>
      <label className={`cue-only ${cueOnly ? 'on' : ''}`}>
        <input type="checkbox" checked={cueOnly} onChange={(e) => onCueOnly(e.target.checked)} />
        <span>
          <b>큐만 이동 (컷 없음)</b> — BACK·JUMP 가 스위처를 건드리지 않고 큐 위치만 맞춥니다. 패널이 앞서 나갔거나 위치를 되돌릴 때 사용
          {' '}(<kbd>Shift</kbd>+더블클릭도 컷 없이 이동)
        </span>
      </label>

      <div>
        <div className="row muted" style={{ marginBottom: 6, fontSize: 12 }}>
          탈리 (
          {tally.source === 'gpi'
            ? 'GPI 실제 신호'
            : tally.source === 'atem'
              ? '스위처 상태'
              : tally.source === 'command'
                ? '캠큐가 보낸 컷 기준 — 패널 수동 컷은 반영 안 됨'
                : '큐 진행 추정'}
          ) <span className="spacer" />
          <button
            className="danger"
            disabled={!canControl}
            onClick={() => confirm('진행을 STANDBY 로 초기화할까요?') && onCommand({ command: 'RESET' })}
          >
            RESET
          </button>
        </div>
        {switcherDown && (
          <div className="switcher-down">
            ⚠️ 스위처 연결 끊김 — GO 를 눌러도 컷이 나가지 않고 큐만 넘어갑니다. 카메라맨 폰 탈리는 큐 기준 추정입니다.
          </div>
        )}
        {settled && tally.source === 'gpi' && state.programCamera !== null && !onAir.includes(state.programCamera) && (
          <div className="tally-mismatch">
            ⚠️ 실제 송출 {onAir.length ? onAir.map((n) => `CAM ${n}`).join(' + ') : '없음'} — 큐는 CAM {state.programCamera}
          </div>
        )}
        {(dupCams.length > 0 || missingCams.length > 0) && (
          <div className="cam-warn">
            📱 {dupCams.length > 0 && <>같은 번호 화면 여러 대: <b>{dupCams.join(', ')}</b> — 번호를 잘못 고른 폰이 있는지 확인. </>}
            {missingCams.length > 0 && <>접속 안 함: {missingCams.join(', ')}</>}
          </div>
        )}
        <div className="tally-grid">
          {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
            <div key={n} className={onAir.includes(n) ? 'pgm' : tally.preview === n ? 'pvw' : ''}>
              <span style={{ color: cameraColor(n) }}>CAM {n}</span>
              <small>{onAir.includes(n) ? 'PGM' : tally.preview === n ? 'PVW' : ' '}</small>
            </div>
          ))}
        </div>
        {log.length > 0 && <CommandLog log={log} now={now} />}
      </div>
    </>
  );
}

function CommandLog({ log, now }: { log: ShowSnapshot['commandLog']; now: number }) {
  const mark = { ok: '✓', failed: '✕', skipped: '–' } as const;
  return (
    <details className="cmd-log">
      <summary>스위처 명령 기록 (최근 {log.length})</summary>
      {[...log].reverse().map((e) => (
        <div key={e.id} className={`cmd-log-row ${e.result}`}>
          <span className="mono">{formatClock(now - e.at)} 전</span> <b>{mark[e.result]}</b> {e.label}
          {e.error && <span className="muted"> — {e.error}</span>}
        </div>
      ))}
    </details>
  );
}

function CueHeadline({ cue }: { cue: Cue }) {
  return (
    <>
      <div className="headline">
        <span className="cam" style={{ color: cameraColor(cue.camera) }}>
          CAM {cue.camera}
        </span>
        <span className="shot">{cue.shotSize}</span>
        <span className="muted">{SHOT_LABEL[cue.shotSize]}</span>
      </div>
      {cue.note && <NoteText note={cue.note} className="note" />}
    </>
  );
}

function NextEta({ next, auto }: { next: UpcomingCue; auto: boolean }) {
  if (auto && next.etaMs != null) return <span className="mono"> · 자동 전환 {formatClock(next.etaMs)}</span>;
  return <span> · 수동 GO 대기</span>;
}

function RunSheet({
  service,
  snapshot,
  cueOnly,
  onJump,
}: {
  service: Service;
  snapshot: ShowSnapshot;
  cueOnly: boolean;
  onJump: (actIndex: number, cueIndex: number, silent: boolean) => void;
}) {
  const { state } = snapshot;
  const liveRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    liveRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [state.actIndex, state.cueIndex]);

  const order = (a: number, c: number) => a * 10_000 + c;
  const cur = order(state.actIndex, state.cueIndex);

  return (
    <div className="runsheet">
      <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
        큐를 <b>더블클릭</b>하면 그 큐로 이동(JUMP){cueOnly ? ' — 큐만 이동(컷 없음) 켜짐' : ' + 컷'} · <kbd>Shift</kbd>+더블클릭 = 컷 없이
      </div>
      {service.acts.map((act: Act, a) => (
        <div key={act.id}>
          <div className={`act-header ${a === state.actIndex ? 'current' : ''}`}>
            <span>
              {a + 1}. {act.title}
            </span>
            <span className="muted" style={{ fontWeight: 400 }}>
              {MODE_LABEL[act.mode]}
              {act.mode === 'SECTION' && act.bpm ? ` · ${act.bpm}` : ''}
            </span>
          </div>
          {act.cues.map((cue, c) => {
            const o = order(a, c);
            const cls = o === cur ? 'live' : o < cur ? 'past' : '';
            return (
              <div
                key={cue.id}
                ref={o === cur ? liveRef : undefined}
                className={`cue-row ${cls}`}
                onDoubleClick={(e) => onJump(a, c, cueOnly || e.shiftKey)}
                title="더블클릭: 이 큐로 이동 (Shift+더블클릭: 컷 없이)"
              >
                <span className="muted mono">{c + 1}</span>
                <span className="cam-chip" style={{ background: cameraColor(cue.camera) }}>
                  {cue.camera}
                </span>
                <b>{cue.shotSize}</b>
                <span>
                  {cue.section && <span className="sec">[{cue.section}] </span>}
                  <NoteText note={cue.note} />
                </span>
              </div>
            );
          })}
          {act.cues.length === 0 && <div className="cue-row muted">(큐 없음)</div>}
        </div>
      ))}
    </div>
  );
}

/** 메모 (중요 표시 ! 는 ⚠ 노란 글씨로) */
function NoteText({ note, className }: { note: string; className?: string }) {
  const n = parseNote(note);
  if (!n.important) return <span className={className}>{n.text}</span>;
  return (
    <span className={className} style={{ color: '#facc15', fontWeight: 700 }}>
      ⚠ {n.text}
    </span>
  );
}
