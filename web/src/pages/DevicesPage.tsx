// 장비 연결 화면: ① 스위처 고르기 → ② 연결 설정 → ③ 실제 탈리(선택) → ④ 시험
// 설정 키(SWITCHER 등)는 화면에 드러내지 않고, 사람이 읽는 이름·설명·예시로 보여준다.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DeviceSettings, DevicesSnapshot, SerialLogEntry } from '@shared/devices';
import { TopBar } from '../components/TopBar';
import { api } from '../lib/api';
import { cameraColor } from '../lib/format';
import './devices.css';

const SWITCHERS = [
  { value: 'atem', icon: '🎛️', title: 'ATEM', desc: 'Blackmagic ATEM 스위처 (네트워크)' },
  { value: 'ikegami', icon: '🔀', title: '이케가미 라우터', desc: 'RS-422 케이블로 크로스포인트 전환' },
  { value: 'gpi', icon: '🔌', title: 'GPI 접점', desc: 'GPI 모듈 출력으로 장비 버튼 누르기' },
  { value: 'none', icon: '⏸️', title: '사용 안 함', desc: '스위처 없이 큐 진행·폰 화면만' },
] as const;

const MODE_LABEL: Record<string, string> = {
  disabled: '사용 안 함',
  mock: 'ATEM (가상 연습)',
  real: 'ATEM',
  ikegami: '이케가미 라우터',
  gpi: 'GPI 접점',
};

const MOCK = 'mock';

export function DevicesPage() {
  const [snap, setSnap] = useState<DevicesSnapshot | null>(null);
  const [form, setForm] = useState<DeviceSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [ports, setPorts] = useState<Array<{ path: string; label: string }> | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [log, setLog] = useState<SerialLogEntry[]>([]);
  const [hex, setHex] = useState('');
  const lastLogId = useRef(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // 상태 폴링 (탈리 입력 램프가 바로 보이도록 짧게)
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.devices();
        if (stop) return;
        setSnap(s);
        if (!dirtyRef.current) setForm(s.settings);
      } catch {
        // 서버 재시작 중 등 — 다음 주기에 다시 시도
      }
    };
    tick();
    const t = setInterval(tick, 400);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const loadPorts = async () => {
    setPortError(null);
    try {
      const r = await api.serialPorts();
      setPorts(r.ports.map((p) => ({ path: p.path, label: p.manufacturer ? `${p.path} — ${p.manufacturer}` : p.path })));
    } catch (e) {
      setPorts([]);
      setPortError((e as Error).message);
    }
  };

  // 이케가미를 고르면 COM 포트 목록 자동 조회
  const kind = form?.SWITCHER;
  useEffect(() => {
    if (kind === 'ikegami' && ports === null) loadPorts();
  }, [kind, ports]);

  // RS-422 송수신 기록
  const serialActive = snap?.settings.SWITCHER === 'ikegami';
  useEffect(() => {
    if (!serialActive) return;
    const t = setInterval(async () => {
      try {
        const { entries } = await api.serialLog(lastLogId.current);
        if (entries.length) {
          lastLogId.current = entries[entries.length - 1].id;
          setLog((prev) => [...prev, ...entries].slice(-200));
        }
      } catch {
        // 무시
      }
    }, 500);
    return () => clearInterval(t);
  }, [serialActive]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ok ? 2500 : 6000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!snap || !form) {
    return (
      <>
        <TopBar />
        <main className="dv">불러오는 중…</main>
      </>
    );
  }

  const set = (patch: Partial<DeviceSettings>) => {
    setForm({ ...form, ...patch });
    setDirty(true);
  };

  const run = async (okText: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'settings' in r) setSnap(r as DevicesSnapshot);
      setToast({ ok: true, text: okText });
    } catch (e) {
      setToast({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run('저장했습니다. 장비를 다시 연결합니다.', async () => {
      const r = await api.saveDeviceSettings(form);
      setDirty(false);
      setForm(r.settings);
      return r;
    });

  const sw = snap.switcher;
  const gpi = snap.gpi;
  const tallyOn = form.TALLY_SOURCE === 'gpi';
  const needGpi = tallyOn || kind === 'gpi';
  const tallyInputs = parseList(form.GPI_TALLY_INPUTS);
  const inputCount = gpi.inputs?.length ?? 16;

  return (
    <>
      <TopBar />
      <main className="dv">
        {/* ── 현재 상태 ── */}
        <section className="dv-card dv-status">
          <StatusItem
            label="스위처"
            state={sw.mode === 'disabled' ? 'off' : sw.connected ? 'ok' : 'bad'}
            value={MODE_LABEL[sw.mode] + (sw.host && sw.mode !== 'mock' && sw.host !== MOCK ? ` · ${sw.host}` : sw.host === MOCK ? ' · 가상' : '')}
            sub={sw.mode === 'disabled' ? '큐 진행만 합니다' : sw.connected ? (sw.model ?? '연결됨') : '연결 안 됨'}
            error={sw.lastError}
          />
          <StatusItem
            label="GPI 모듈"
            state={gpi.mode === 'disabled' ? 'off' : gpi.connected ? 'ok' : 'bad'}
            value={gpi.mode === 'disabled' ? '사용 안 함' : gpi.mode === 'mock' ? '가상 모듈' : (gpi.host ?? '')}
            sub={gpi.mode === 'disabled' ? '' : gpi.connected ? '입력 읽는 중' : '연결 안 됨'}
            error={gpi.lastError}
          />
          <div className="dv-status-item">
            <div className="dv-status-label">지금 송출</div>
            <div className="dv-status-value">
              <CamChip n={snap.tally.program} /> <span className="dv-muted">다음</span> <CamChip n={snap.tally.preview} />
            </div>
            <div className="dv-status-sub">
              {snap.tally.source === 'gpi' ? 'GPI 실제 신호 기준' : snap.tally.source === 'atem' ? '스위처 보고 기준' : '큐 진행 기준 (장비 미연결)'}
            </div>
          </div>
          {snap.errors.length > 0 && (
            <ul className="dv-errors">
              {snap.errors.map((e) => (
                <li key={e}>⚠️ {e}</li>
              ))}
            </ul>
          )}
        </section>

        {/* ── ① 스위처 고르기 ── */}
        <section className="dv-card">
          <StepTitle n={1} title="어떤 스위처를 쓰나요?" />
          <div className="dv-tiles" role="radiogroup">
            {SWITCHERS.map((s) => (
              <button
                key={s.value}
                role="radio"
                aria-checked={kind === s.value}
                className={`dv-tile ${kind === s.value ? 'on' : ''}`}
                onClick={() => set({ SWITCHER: s.value })}
              >
                <span className="dv-tile-icon">{s.icon}</span>
                <span className="dv-tile-title">{s.title}</span>
                <span className="dv-tile-desc">{s.desc}</span>
                {kind === s.value && <span className="dv-tile-check">✓</span>}
              </button>
            ))}
          </div>
        </section>

        {/* ── ② 연결 설정 ── */}
        {kind !== 'none' && (
          <section className="dv-card">
            <StepTitle n={2} title={`${SWITCHERS.find((s) => s.value === kind)?.title} 연결 설정`} />

            {kind === 'atem' && (
              <>
                <Toggle
                  checked={form.ATEM_HOST === MOCK}
                  onChange={(on) => set({ ATEM_HOST: on ? MOCK : '' })}
                  label="가상 스위처로 연습"
                  help="장비 없이 화면 흐름만 확인합니다. 실제 ATEM 에 연결하려면 끄세요."
                />
                {form.ATEM_HOST !== MOCK && (
                  <Field label="ATEM IP 주소" help="ATEM Setup 프로그램에서 확인 (예: 192.168.10.240). 이 PC 와 같은 네트워크여야 합니다.">
                    <input className="dv-input" value={form.ATEM_HOST} onChange={(e) => set({ ATEM_HOST: e.target.value })} placeholder="192.168.10.240" />
                  </Field>
                )}
                <Field label="M/E 번호" help="대부분 1. M/E 가 여러 개인 모델에서 다른 M/E 를 쓸 때만 바꾸세요.">
                  <Segments value={form.ATEM_ME} options={['1', '2', '3', '4']} onChange={(v) => set({ ATEM_ME: v })} />
                </Field>
              </>
            )}

            {kind === 'ikegami' && (
              <>
                <Field label="COM 포트" help="USB-RS422 변환기를 꽂으면 목록에 나타납니다. 장비 없이 연습하려면 '가상 포트'.">
                  <div className="dv-row">
                    <select
                      className="dv-input"
                      value={form.IKEGAMI_PORT}
                      onChange={(e) => set({ IKEGAMI_PORT: e.target.value })}
                    >
                      <option value="">— 선택하세요 —</option>
                      {(ports ?? []).map((p) => (
                        <option key={p.path} value={p.path}>
                          {p.label}
                        </option>
                      ))}
                      {form.IKEGAMI_PORT && form.IKEGAMI_PORT !== MOCK && !(ports ?? []).some((p) => p.path === form.IKEGAMI_PORT) && (
                        <option value={form.IKEGAMI_PORT}>{form.IKEGAMI_PORT} (지금 연결 안 됨)</option>
                      )}
                      <option value={MOCK}>가상 포트 (연습용)</option>
                    </select>
                    <button className="dv-btn" onClick={loadPorts}>
                      ↻ 다시 찾기
                    </button>
                  </div>
                  {ports && ports.length === 0 && (
                    <div className="dv-hint warn">{portError ?? 'COM 포트가 없습니다. 변환기 연결과 드라이버 설치를 확인하세요.'}</div>
                  )}
                </Field>

                <Field label="송출(PGM) 출력 번호" help="라우터에서 송출용으로 쓰는 출력(OUT) 번호. 조작 패널에서 확인하세요.">
                  <input
                    className="dv-input dv-num"
                    inputMode="numeric"
                    value={form.IKEGAMI_PGM_OUT}
                    onChange={(e) => set({ IKEGAMI_PGM_OUT: e.target.value })}
                  />
                </Field>

                <Field label="카메라별 라우터 입력 번호" help="각 카메라가 라우터의 몇 번 입력(IN)에 꽂혀 있는지. 안 쓰는 카메라는 비워 두세요.">
                  <CamGrid value={form.IKEGAMI_CAM_INPUTS} prefix="IN" onChange={(v) => set({ IKEGAMI_CAM_INPUTS: v })} />
                </Field>

                <Field
                  label="전환 명령 형식"
                  help="이케가미·시공사에서 받은 크로스포인트 명령을 넣으세요. 비워 두면 컷 명령을 보내지 않습니다."
                >
                  <input
                    className="dv-input mono"
                    value={form.IKEGAMI_TAKE}
                    onChange={(e) => set({ IKEGAMI_TAKE: e.target.value })}
                    placeholder="예) 02 {OUT0} {IN0} {SUM}"
                  />
                  <details className="dv-more">
                    <summary>작성 방법 보기</summary>
                    <ul>
                      <li>16진수 바이트를 띄어쓰기로 구분 (예: <code>02 0A FF</code>)</li>
                      <li>
                        <code>{'{IN}'}</code> <code>{'{OUT}'}</code> → 입력·출력 번호 (1부터) · <code>{'{IN0}'}</code> <code>{'{OUT0}'}</code> → 0부터
                      </li>
                      <li>
                        <code>{'{SUM}'}</code> → 앞 바이트 합(하위 8비트) · <code>{'{XOR}'}</code> → 앞 바이트 XOR
                      </li>
                    </ul>
                  </details>
                </Field>

                <details className="dv-more">
                  <summary>통신 설정 — {form.IKEGAMI_BAUD}bps · 패리티 {PARITY[form.IKEGAMI_PARITY] ?? form.IKEGAMI_PARITY} (매뉴얼 기준값)</summary>
                  <div className="dv-grid2">
                    <Field label="속도 (bps)">
                      <select className="dv-input" value={form.IKEGAMI_BAUD} onChange={(e) => set({ IKEGAMI_BAUD: e.target.value })}>
                        {['9600', '19200', '38400', '57600', '115200'].map((b) => (
                          <option key={b}>{b}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="패리티">
                      <Segments
                        value={form.IKEGAMI_PARITY}
                        options={['odd', 'even', 'none']}
                        labels={PARITY}
                        onChange={(v) => set({ IKEGAMI_PARITY: v })}
                      />
                    </Field>
                  </div>
                </details>
              </>
            )}

            {kind === 'gpi' && (
              <>
                <p className="dv-hint">
                  GPI 모듈의 출력 접점을 장비의 GPI 입력에 연결하고, 장비 쪽에 "입력 N → 송출" 동작을 지정해 두세요. 모듈 주소는 아래 ③ 에서 설정합니다.
                </p>
                <Field label="카메라별 출력 채널" help="컷할 때 펄스를 보낼 모듈 출력(DO) 번호.">
                  <CamGrid value={form.GPI_CUT_OUTPUTS} prefix="DO" onChange={(v) => set({ GPI_CUT_OUTPUTS: v })} />
                </Field>
                <Field label="펄스 길이" help="버튼을 누르고 있는 시간. 보통 100~300ms.">
                  <div className="dv-row">
                    <input className="dv-input dv-num" inputMode="numeric" value={form.GPI_PULSE_MS} onChange={(e) => set({ GPI_PULSE_MS: e.target.value })} />
                    <span className="dv-muted">ms</span>
                  </div>
                </Field>
              </>
            )}
          </section>
        )}

        {/* ── ③ 실제 탈리 ── */}
        <section className="dv-card">
          <StepTitle n={kind === 'none' ? 2 : 3} title="실제 탈리 읽기" badge="선택" />
          <Toggle
            checked={tallyOn}
            onChange={(on) => set({ TALLY_SOURCE: on ? 'gpi' : 'switcher' })}
            label="GPI 모듈로 실제 송출 신호 읽기"
            help="스위처의 탈리 접점을 읽어 폰 화면의 빨간 테두리를 실제 송출 기준으로 표시합니다. 패널에서 직접 컷해도 반영됩니다."
          />

          {needGpi && (
            <>
              <Toggle
                checked={form.GPI_HOST === MOCK}
                onChange={(on) => set({ GPI_HOST: on ? MOCK : '' })}
                label="가상 모듈로 연습"
                help="아래 채널 버튼을 눌러 신호를 직접 켜고 끌 수 있습니다."
              />
              {form.GPI_HOST !== MOCK && (
                <Field label="GPI 모듈 IP 주소" help="Modbus TCP 입력 모듈 (ADAM-6050, ioLogik E1210 등). 포트가 502 가 아니면 IP:포트.">
                  <input className="dv-input" value={form.GPI_HOST} onChange={(e) => set({ GPI_HOST: e.target.value })} placeholder="192.168.0.50" />
                </Field>
              )}
              {tallyOn && (
                <>
                  <Field label="카메라별 탈리 입력 채널" help="각 카메라의 탈리 신호가 들어오는 모듈 입력(DI) 번호.">
                    <CamGrid value={form.GPI_TALLY_INPUTS} prefix="DI" onChange={(v) => set({ GPI_TALLY_INPUTS: v })} />
                  </Field>
                  <Toggle
                    checked={form.GPI_TALLY_INVERT === '1'}
                    onChange={(on) => set({ GPI_TALLY_INVERT: on ? '1' : '0' })}
                    label="신호 반전"
                    help="배선에 따라 송출 중일 때 입력이 꺼지는 경우 켜세요. 시험 컷 후 아래 램프로 확인."
                  />
                </>
              )}
              <details className="dv-more">
                <summary>모듈 세부 설정 (설명서의 주소표를 보고 바꾸세요)</summary>
                <div className="dv-grid2">
                  <Field label="유닛 ID">
                    <input className="dv-input dv-num" value={form.GPI_UNIT} onChange={(e) => set({ GPI_UNIT: e.target.value })} />
                  </Field>
                  <Field label="입력 읽기 방식">
                    <Segments
                      value={form.GPI_DI_FC}
                      options={['2', '1']}
                      labels={{ '2': 'Discrete Input (02)', '1': 'Coil (01)' }}
                      onChange={(v) => set({ GPI_DI_FC: v })}
                    />
                  </Field>
                  <Field label="입력 시작 주소">
                    <input className="dv-input dv-num" value={form.GPI_DI_ADDR} onChange={(e) => set({ GPI_DI_ADDR: e.target.value })} />
                  </Field>
                  <Field label="출력 시작 주소">
                    <input className="dv-input dv-num" value={form.GPI_DO_ADDR} onChange={(e) => set({ GPI_DO_ADDR: e.target.value })} />
                  </Field>
                  <Field label="읽기 주기 (ms)">
                    <input className="dv-input dv-num" value={form.GPI_POLL_MS} onChange={(e) => set({ GPI_POLL_MS: e.target.value })} />
                  </Field>
                </div>
              </details>

              {gpi.mode !== 'disabled' && (
                <div className="dv-lamps-wrap">
                  <div className="dv-sub">입력 램프 {gpi.mode === 'mock' && <span className="dv-muted">— 눌러서 켜고 끄기</span>}</div>
                  <div className="dv-lamps">
                    {Array.from({ length: inputCount }, (_, i) => i + 1).map((ch) => {
                      const on = gpi.inputs?.[ch - 1] ?? false;
                      const cam = tallyInputs.indexOf(ch) + 1;
                      return (
                        <button
                          key={ch}
                          className={`dv-lamp ${on ? 'on' : ''} ${gpi.mode === 'mock' ? 'click' : ''}`}
                          disabled={gpi.mode !== 'mock' || busy}
                          onClick={() => run(`DI ${ch} ${on ? '끔' : '켬'}`, () => api.mockGpiInput(ch, !on))}
                        >
                          <b>DI {ch}</b>
                          <small style={cam ? { color: on ? '#fff' : cameraColor(cam) } : undefined}>{cam ? `CAM ${cam}` : '—'}</small>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* ── ④ 시험 ── */}
        <section className="dv-card">
          <StepTitle n={kind === 'none' ? 3 : 4} title="시험" />
          {dirty && <p className="dv-hint warn">먼저 아래 [저장]을 눌러야 바뀐 설정으로 시험됩니다.</p>}
          <div className="dv-sub">카메라 컷 — 실제 송출 화면이 바뀝니다. 행사 중에는 누르지 마세요.</div>
          <div className="dv-cams">
            {Array.from({ length: 8 }, (_, i) => i + 1).map((cam) => (
              <button
                key={cam}
                className="dv-btn dv-cam-btn"
                disabled={!sw.connected || busy}
                style={{ ['--cam' as string]: cameraColor(cam) }}
                onClick={() => confirm(`CAM ${cam} 을(를) 송출로 전환할까요?`) && run(`CAM ${cam} 전환 명령을 보냈습니다`, () => api.testTake(cam))}
              >
                CAM {cam}
              </button>
            ))}
          </div>
          {!sw.connected && <div className="dv-hint">스위처가 연결되면 누를 수 있습니다.</div>}

          {gpi.connected && (
            <>
              <div className="dv-sub" style={{ marginTop: 16 }}>
                GPI 출력 펄스
              </div>
              <div className="dv-cams">
                {Array.from({ length: 8 }, (_, i) => i + 1).map((ch) => (
                  <button key={ch} className="dv-btn" disabled={busy} onClick={() => run(`DO ${ch} 펄스를 보냈습니다`, () => api.pulseGpi(ch))}>
                    DO {ch}
                  </button>
                ))}
              </div>
            </>
          )}

          {snap.settings.SWITCHER === 'ikegami' && (
            <div style={{ marginTop: 16 }}>
              <div className="dv-row">
                <span className="dv-sub" style={{ margin: 0 }}>
                  RS-422 송수신 기록
                </span>
                <span className="dv-spacer" />
                <button className="dv-btn small" onClick={() => setLog([])}>
                  지우기
                </button>
              </div>
              <div className="dv-log mono">
                {log.length === 0 && <div className="dv-muted">아직 기록이 없습니다</div>}
                {log.map((e) => (
                  <div key={e.id} className={`dv-log-${e.dir}`}>
                    <span className="dv-muted">{new Date(e.at).toLocaleTimeString()}</span> {LOG_DIR[e.dir]} {e.text}
                  </div>
                ))}
              </div>
              <form
                className="dv-row"
                style={{ marginTop: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  run('보냈습니다', () => api.sendSerial(hex));
                }}
              >
                <input className="dv-input mono" value={hex} onChange={(e) => setHex(e.target.value)} placeholder="직접 보낼 16진수 (예: 02 00 03 05)" />
                <button type="submit" className="dv-btn" disabled={!sw.connected || busy || !hex.trim()}>
                  보내기
                </button>
              </form>
            </div>
          )}
        </section>

        {snap.configPath && <p className="dv-foot">설정 파일: {snap.configPath}</p>}

        {/* 저장 바: 바뀐 것이 있을 때만 화면 아래에 고정 */}
        {dirty && (
          <div className="dv-savebar">
            <span>바뀐 설정이 있습니다</span>
            <span className="dv-spacer" />
            <button className="dv-btn" disabled={busy} onClick={() => (setForm(snap.settings), setDirty(false))}>
              취소
            </button>
            <button className="dv-btn primary" disabled={busy} onClick={save}>
              저장하고 연결
            </button>
          </div>
        )}

        {toast && (
          <div className={`dv-toast ${toast.ok ? 'ok' : 'bad'}`} onClick={() => setToast(null)}>
            {toast.ok ? '✓' : '⚠️'} {toast.text}
          </div>
        )}
      </main>
    </>
  );
}

const PARITY: Record<string, string> = { odd: '홀수', even: '짝수', none: '없음' };
const LOG_DIR: Record<string, string> = { tx: '보냄 →', rx: '받음 ←', info: '알림', error: '오류' };

function parseList(s: string): number[] {
  return s.split(/[\s,]+/).filter(Boolean).map(Number);
}

function StepTitle({ n, title, badge }: { n: number; title: string; badge?: string }) {
  return (
    <h2 className="dv-step">
      <span className="dv-step-n">{n}</span>
      {title}
      {badge && <span className="dv-badge">{badge}</span>}
    </h2>
  );
}

function StatusItem({ label, state, value, sub, error }: { label: string; state: 'ok' | 'bad' | 'off'; value: string; sub: string; error: string | null }) {
  return (
    <div className="dv-status-item">
      <div className="dv-status-label">{label}</div>
      <div className="dv-status-value">
        <span className={`dv-dot ${state}`} />
        {value}
      </div>
      <div className="dv-status-sub">{sub}</div>
      {error && <div className="dv-error">{error}</div>}
    </div>
  );
}

function CamChip({ n }: { n: number | null }) {
  if (!n) return <span className="dv-muted">없음</span>;
  return (
    <span className="cam-chip" style={{ background: cameraColor(n) }}>
      CAM {n}
    </span>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="dv-field">
      <div className="dv-label">{label}</div>
      {children}
      {help && <div className="dv-help">{help}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, label, help }: { checked: boolean; onChange: (on: boolean) => void; label: string; help?: string }) {
  return (
    <label className="dv-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="dv-switch" aria-hidden />
      <span>
        <span className="dv-label">{label}</span>
        {help && <span className="dv-help">{help}</span>}
      </span>
    </label>
  );
}

function Segments({
  value,
  options,
  labels,
  onChange,
}: {
  value: string;
  options: readonly string[];
  labels?: Record<string, string>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="dv-seg" role="radiogroup">
      {options.map((o) => (
        <button key={o} role="radio" aria-checked={value === o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

/** "3,5,,7" ↔ CAM 1~8 칸별 숫자 입력 */
function CamGrid({ value, prefix, onChange }: { value: string; prefix: string; onChange: (v: string) => void }) {
  const cells = Array.from({ length: 8 }, (_, i) => {
    const n = value.split(',')[i]?.trim() ?? '';
    return n === '0' ? '' : n;
  });
  const update = (i: number, v: string) => {
    const next = [...cells];
    next[i] = v.replace(/[^0-9]/g, '');
    // 끝쪽 빈 칸은 잘라내고, 중간 빈 칸은 0(없음)으로 저장
    let last = next.length - 1;
    while (last >= 0 && !next[last]) last--;
    onChange(next.slice(0, last + 1).map((c) => c || '0').join(','));
  };
  return (
    <div className="dv-camgrid">
      {cells.map((c, i) => (
        <label key={i} className="dv-camcell" style={{ ['--cam' as string]: cameraColor(i + 1) }}>
          <span className="dv-camcell-name">CAM {i + 1}</span>
          <span className="dv-camcell-input">
            <small>{prefix}</small>
            <input inputMode="numeric" value={c} placeholder="—" onChange={(e) => update(i, e.target.value)} />
          </span>
        </label>
      ))}
    </div>
  );
}
