import { useEffect, useRef } from 'react';
import {
  cueDurationMs,
  cueElapsedMs,
  currentAct,
  currentCue,
  isAutoTransition,
  isStandby,
  upcoming,
  type UpcomingCue,
} from '@shared/engine';
import type { ShowSnapshot } from '@shared/protocol';
import type { Act, Cue, Service } from '@shared/types';
import { AtemBadge, CamClients, ConnectionBadge, TimecodeBadge } from '../components/StatusBadges';
import { TopBar } from '../components/TopBar';
import { MODE_LABEL, SHOT_LABEL, cameraColor, formatClock } from '../lib/format';
import { useShow, useTicker } from '../lib/useShow';

/** 입력 필드에 포커스가 있을 때는 단축키 무시 */
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export function DirectorPage() {
  const show = useShow('director');
  const { service, snapshot, command } = show;
  useTicker(100);

  // 단축키: Space=GO, Backspace=BACK, H=HOLD
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        command({ command: 'GO' });
      } else if (e.code === 'Backspace') {
        e.preventDefault();
        command({ command: 'BACK' });
      } else if (e.code === 'KeyH') {
        e.preventDefault();
        command({ command: 'HOLD' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [command]);

  const now = show.serverNow();
  const state = snapshot?.state;

  return (
    <div className="director">
      <TopBar>
        <span className="muted">{service ? `${service.date ?? ''} ${service.title}` : '로드된 예배 없음'}</span>
        <TimecodeBadge snapshot={snapshot} />
        <AtemBadge snapshot={snapshot} />
        <CamClients clients={show.clients} />
        <ConnectionBadge connected={show.connected} />
      </TopBar>

      <main className="director-main">
        {!service || !state ? (
          <p className="muted">
            로드된 예배가 없습니다. <a href="/">홈</a>에서 예배를 “라이브로 열기” 하세요.
          </p>
        ) : (
          <LivePanel service={service} snapshot={snapshot!} now={now} onCommand={command} />
        )}
      </main>

      <aside className="director-side">
        {service && state && (
          <RunSheet service={service} snapshot={snapshot!} onJump={(actIndex, cueIndex) => command({ command: 'JUMP', actIndex, cueIndex })} />
        )}
      </aside>
    </div>
  );
}

function LivePanel({
  service,
  snapshot,
  now,
  onCommand,
}: {
  service: Service;
  snapshot: ShowSnapshot;
  now: number;
  onCommand: ReturnType<typeof useShow>['command'];
}) {
  const { state, tally } = snapshot;
  const act = currentAct(service, state);
  const cue = currentCue(service, state);
  const next = upcoming(service, state, now, 1)[0] ?? null;
  const standby = isStandby(state);

  const duration = act && cue ? cueDurationMs(act, state.cueIndex) : null;
  const elapsed = cueElapsedMs(state, now);
  const remaining = duration != null ? duration - elapsed : null;
  const autoNext = !standby && isAutoTransition(service, { actIndex: state.actIndex, cueIndex: state.cueIndex });
  const nextAct = next ? service.acts[next.actIndex] : null;

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
      <div className="transport" onMouseDown={(e) => e.preventDefault()}>
        <button onClick={() => onCommand({ command: 'BACK' })}>
          ◀ BACK <kbd>Backspace</kbd>
        </button>
        <button className={`hold ${state.held ? 'active' : ''}`} onClick={() => onCommand({ command: 'HOLD' })}>
          {state.held ? '▶ RESUME' : '❚❚ HOLD'} <kbd>H</kbd>
        </button>
        <button className="go" onClick={() => onCommand({ command: 'GO' })} disabled={!next}>
          GO ▶ <kbd style={{ color: '#d1fae5' }}>Space</kbd>
        </button>
      </div>

      <div>
        <div className="row muted" style={{ marginBottom: 6, fontSize: 12 }}>
          탈리 ({tally.source === 'atem' ? 'ATEM 실제 상태' : '엔진 추정'}) <span className="spacer" />
          <button
            className="danger"
            onClick={() => confirm('진행을 STANDBY 로 초기화할까요?') && onCommand({ command: 'RESET' })}
          >
            RESET
          </button>
        </div>
        <div className="tally-grid">
          {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
            <div key={n} className={tally.program === n ? 'pgm' : tally.preview === n ? 'pvw' : ''}>
              <span style={{ color: cameraColor(n) }}>CAM {n}</span>
              <small>{tally.program === n ? 'PGM' : tally.preview === n ? 'PVW' : ' '}</small>
            </div>
          ))}
        </div>
      </div>
    </>
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
      {cue.note && <div className="note">{cue.note}</div>}
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
  onJump,
}: {
  service: Service;
  snapshot: ShowSnapshot;
  onJump: (actIndex: number, cueIndex: number) => void;
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
        큐를 <b>더블클릭</b>하면 바로 그 큐로 이동(JUMP)
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
                onDoubleClick={() => onJump(a, c)}
                title="더블클릭: 이 큐로 이동"
              >
                <span className="muted mono">{c + 1}</span>
                <span className="cam-chip" style={{ background: cameraColor(cue.camera) }}>
                  {cue.camera}
                </span>
                <b>{cue.shotSize}</b>
                <span>
                  {cue.section && <span className="sec">[{cue.section}] </span>}
                  {cue.note}
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
