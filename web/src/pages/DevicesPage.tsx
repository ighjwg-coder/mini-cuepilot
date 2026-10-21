// 장비 연결 화면: 스위처 종류 선택, 이케가미 RS-422 / GPI 모듈 설정, 시험 컷, 송수신 모니터
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEVICE_KEYS, type DeviceKey, type DeviceSettings, type DevicesSnapshot, type SerialLogEntry } from '@shared/devices';
import { TopBar } from '../components/TopBar';
import { api } from '../lib/api';
import { cameraColor } from '../lib/format';
import './devices.css';

const MODE_LABEL: Record<string, string> = {
  disabled: '사용 안 함',
  mock: '가상 ATEM',
  real: 'ATEM',
  ikegami: '이케가미 라우터 (RS-422)',
  gpi: 'GPI 접점 컷',
};

export function DevicesPage() {
  const [snap, setSnap] = useState<DevicesSnapshot | null>(null);
  const [form, setForm] = useState<DeviceSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [ports, setPorts] = useState<string[] | null>(null);
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

  if (!snap || !form) {
    return (
      <>
        <TopBar />
        <main className="home">불러오는 중…</main>
      </>
    );
  }

  const set = (key: DeviceKey, value: string) => {
    setForm({ ...form, [key]: value });
    setDirty(true);
  };

  const run = async (label: string, fn: () => Promise<DevicesSnapshot | unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'settings' in r) setSnap(r as DevicesSnapshot);
      setMessage({ ok: true, text: label });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
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
  const kind = form.SWITCHER;
  const tallyInputs = form.GPI_TALLY_INPUTS.split(/[\s,]+/).map(Number);
  const inputCount = gpi.inputs?.length ?? Math.max(8, ...tallyInputs.filter((n) => Number.isFinite(n)));

  return (
    <>
      <TopBar />
      <main className="home devices">
        {/* ── 상태 ── */}
        <section>
          <h2>현재 상태</h2>
          <div className="dev-status">
            <div>
              <div className="muted">스위처</div>
              <div className="row">
                <span className={`dot ${sw.mode === 'disabled' ? '' : sw.connected ? 'ok' : 'bad'}`} />
                <b>{MODE_LABEL[sw.mode]}</b>
                {sw.host && sw.mode !== 'mock' && <span className="mono muted">{sw.host}</span>}
              </div>
              <div className="muted small">
                {sw.mode === 'disabled' ? '큐 진행만 합니다' : sw.connected ? (sw.model ?? '연결됨') : '연결 안 됨'}
              </div>
              {sw.lastError && <div className="dev-err">{sw.lastError}</div>}
            </div>
            <div>
              <div className="muted">GPI 모듈</div>
              <div className="row">
                <span className={`dot ${gpi.mode === 'disabled' ? '' : gpi.connected ? 'ok' : 'bad'}`} />
                <b>{gpi.mode === 'disabled' ? '사용 안 함' : gpi.mode === 'mock' ? '가상 모듈' : gpi.host}</b>
              </div>
              <div className="muted small">{gpi.mode === 'disabled' ? '' : gpi.connected ? '입력 읽는 중' : '연결 안 됨'}</div>
              {gpi.lastError && <div className="dev-err">{gpi.lastError}</div>}
            </div>
            <div>
              <div className="muted">탈리 기준</div>
              <div className="row">
                <b>{snap.tally.source === 'gpi' ? 'GPI 실제 신호' : snap.tally.source === 'atem' ? '스위처 보고값' : '큐 진행 추정'}</b>
              </div>
              <div className="row small">
                PGM{' '}
                {snap.tally.program ? (
                  <span className="cam-chip" style={{ background: cameraColor(snap.tally.program) }}>
                    {snap.tally.program}
                  </span>
                ) : (
                  <span className="muted">없음</span>
                )}
                PVW{' '}
                {snap.tally.preview ? (
                  <span className="cam-chip" style={{ background: cameraColor(snap.tally.preview) }}>
                    {snap.tally.preview}
                  </span>
                ) : (
                  <span className="muted">없음</span>
                )}
              </div>
            </div>
          </div>
          {snap.errors.length > 0 && (
            <ul className="dev-errors">
              {snap.errors.map((e) => (
                <li key={e}>⚠️ {e}</li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 스위처 설정 ── */}
        <section>
          <h2>스위처</h2>
          <Field k="SWITCHER">
            <select value={kind} onChange={(e) => set('SWITCHER', e.target.value)}>
              <option value="atem">ATEM (Blackmagic)</option>
              <option value="ikegami">이케가미 라우터 (RS-422)</option>
              <option value="gpi">GPI 접점 컷 (GPI 모듈 출력)</option>
              <option value="none">사용 안 함 (큐 진행만)</option>
            </select>
          </Field>

          {kind === 'atem' && (
            <>
              <Field k="ATEM_HOST">
                <input value={form.ATEM_HOST} onChange={(e) => set('ATEM_HOST', e.target.value)} placeholder="mock 또는 192.168.10.240" />
              </Field>
              <Field k="ATEM_ME">
                <input value={form.ATEM_ME} onChange={(e) => set('ATEM_ME', e.target.value)} style={{ width: 80 }} />
              </Field>
            </>
          )}

          {kind === 'ikegami' && (
            <>
              <Field k="IKEGAMI_PORT">
                <div className="row">
                  <input value={form.IKEGAMI_PORT} onChange={(e) => set('IKEGAMI_PORT', e.target.value)} placeholder="COM3 또는 mock" />
                  <button
                    onClick={() =>
                      run('COM 포트 목록을 읽었습니다.', async () => {
                        const r = await api.serialPorts();
                        setPorts(r.ports.map((p) => `${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}`));
                      })
                    }
                  >
                    포트 찾기
                  </button>
                </div>
                {ports && (
                  <div className="row wrap small" style={{ marginTop: 6 }}>
                    {ports.length === 0 && <span className="muted">COM 포트가 없습니다. USB-RS422 변환기 연결·드라이버를 확인하세요.</span>}
                    {ports.map((p) => (
                      <button key={p} onClick={() => set('IKEGAMI_PORT', p.split(' ')[0])}>
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
              <div className="row wrap">
                <Field k="IKEGAMI_BAUD">
                  <input value={form.IKEGAMI_BAUD} onChange={(e) => set('IKEGAMI_BAUD', e.target.value)} style={{ width: 100 }} />
                </Field>
                <Field k="IKEGAMI_PARITY">
                  <select value={form.IKEGAMI_PARITY} onChange={(e) => set('IKEGAMI_PARITY', e.target.value)}>
                    <option value="odd">odd (홀수)</option>
                    <option value="even">even (짝수)</option>
                    <option value="none">none (없음)</option>
                  </select>
                </Field>
                <Field k="IKEGAMI_PGM_OUT">
                  <input value={form.IKEGAMI_PGM_OUT} onChange={(e) => set('IKEGAMI_PGM_OUT', e.target.value)} style={{ width: 80 }} />
                </Field>
              </div>
              <Field k="IKEGAMI_CAM_INPUTS">
                <input value={form.IKEGAMI_CAM_INPUTS} onChange={(e) => set('IKEGAMI_CAM_INPUTS', e.target.value)} placeholder="1,2,3,4" />
                <CamMap list={form.IKEGAMI_CAM_INPUTS} prefix="IN" />
              </Field>
              <Field k="IKEGAMI_TAKE">
                <input
                  className="mono"
                  value={form.IKEGAMI_TAKE}
                  onChange={(e) => set('IKEGAMI_TAKE', e.target.value)}
                  placeholder="예) 02 {OUT0} {IN0} {SUM}"
                  style={{ width: '100%' }}
                />
                <div className="muted small" style={{ marginTop: 4 }}>
                  16진수 바이트를 띄어쓰기로 구분. 자리표시: <code>{'{IN}'}</code>/<code>{'{OUT}'}</code> 번호(1부터),{' '}
                  <code>{'{IN0}'}</code>/<code>{'{OUT0}'}</code> 번호(0부터), <code>{'{SUM}'}</code> 앞 바이트 합, <code>{'{XOR}'}</code> 앞 바이트 XOR.
                  <br />
                  명령 형식은 이케가미 매뉴얼에 없어 제조사·시공사에서 받은 값을 넣어야 합니다. 비워 두면 컷 명령을 보내지 않습니다.
                </div>
              </Field>
            </>
          )}

          {kind === 'gpi' && (
            <>
              <Field k="GPI_CUT_OUTPUTS">
                <input value={form.GPI_CUT_OUTPUTS} onChange={(e) => set('GPI_CUT_OUTPUTS', e.target.value)} />
                <CamMap list={form.GPI_CUT_OUTPUTS} prefix="DO" />
              </Field>
              <Field k="GPI_PULSE_MS">
                <input value={form.GPI_PULSE_MS} onChange={(e) => set('GPI_PULSE_MS', e.target.value)} style={{ width: 100 }} />
              </Field>
              <p className="muted small">GPI 모듈 접속 정보는 아래 [GPI 모듈] 에서 설정합니다.</p>
            </>
          )}
        </section>

        {/* ── GPI 모듈 ── */}
        <section>
          <h2>GPI 모듈 · 탈리 입력</h2>
          <Field k="TALLY_SOURCE">
            <select value={form.TALLY_SOURCE} onChange={(e) => set('TALLY_SOURCE', e.target.value)}>
              <option value="switcher">스위처 보고값 (ATEM 등)</option>
              <option value="gpi">GPI 모듈 실제 신호</option>
            </select>
          </Field>
          <Field k="GPI_HOST">
            <input value={form.GPI_HOST} onChange={(e) => set('GPI_HOST', e.target.value)} placeholder="mock 또는 192.168.0.50" />
          </Field>
          <details>
            <summary className="muted small">모듈 세부 설정 (주소·함수 코드)</summary>
            <div className="row wrap" style={{ marginTop: 8 }}>
              {(['GPI_UNIT', 'GPI_DI_FC', 'GPI_DI_ADDR', 'GPI_DO_ADDR', 'GPI_POLL_MS'] as const).map((k) => (
                <Field key={k} k={k}>
                  <input value={form[k]} onChange={(e) => set(k, e.target.value)} style={{ width: 90 }} />
                </Field>
              ))}
            </div>
          </details>
          <Field k="GPI_TALLY_INPUTS">
            <input value={form.GPI_TALLY_INPUTS} onChange={(e) => set('GPI_TALLY_INPUTS', e.target.value)} />
            <CamMap list={form.GPI_TALLY_INPUTS} prefix="DI" />
          </Field>
          <label className="row small">
            <input
              type="checkbox"
              checked={form.GPI_TALLY_INVERT === '1'}
              onChange={(e) => set('GPI_TALLY_INVERT', e.target.checked ? '1' : '0')}
            />
            {DEVICE_KEYS.GPI_TALLY_INVERT}
          </label>

          {gpi.mode !== 'disabled' && (
            <div style={{ marginTop: 12 }}>
              <div className="muted small" style={{ marginBottom: 6 }}>
                입력 채널 {gpi.mode === 'mock' && '— 눌러서 켜고 끄기 (가상 모듈)'}
              </div>
              <div className="dev-lamps">
                {Array.from({ length: inputCount }, (_, i) => i + 1).map((ch) => {
                  const on = gpi.inputs?.[ch - 1] ?? false;
                  const cam = tallyInputs.indexOf(ch) + 1;
                  return (
                    <button
                      key={ch}
                      className={`lamp ${on ? 'on' : ''}`}
                      disabled={gpi.mode !== 'mock' || busy}
                      onClick={() => run(`DI ${ch} ${on ? '끔' : '켬'}`, () => api.mockGpiInput(ch, !on))}
                      title={cam ? `CAM ${cam}` : '매핑 없음'}
                    >
                      <span className="mono">DI {ch}</span>
                      <small>{cam ? `CAM ${cam}` : '—'}</small>
                    </button>
                  );
                })}
              </div>
              <div className="row wrap small" style={{ marginTop: 10 }}>
                <span className="muted">출력 펄스 시험:</span>
                {Array.from({ length: 8 }, (_, i) => i + 1).map((ch) => (
                  <button key={ch} disabled={!gpi.connected || busy} onClick={() => run(`DO ${ch} 펄스 보냄`, () => api.pulseGpi(ch))}>
                    DO {ch}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <div className="dev-save">
          <span className="muted small">
            {dirty ? '변경 사항이 있습니다.' : '저장된 설정과 같습니다.'} {snap.configPath && <>저장 위치: <span className="mono">{snap.configPath}</span></>}
          </span>
          <span className="spacer" />
          {dirty && (
            <button disabled={busy} onClick={() => (setForm(snap.settings), setDirty(false))}>
              되돌리기
            </button>
          )}
          <button className="primary" disabled={!dirty || busy} onClick={save}>
            저장 · 다시 연결
          </button>
        </div>

        {/* ── 시험 ── */}
        <section>
          <h2>시험</h2>
          <p className="muted small">실제 송출 화면이 바뀝니다. 행사 중에는 누르지 마세요.</p>
          <div className="row wrap">
            {Array.from({ length: 8 }, (_, i) => i + 1).map((cam) => (
              <button
                key={cam}
                disabled={!sw.connected || busy}
                onClick={() => confirm(`CAM ${cam} 을(를) 송출(PGM)로 전환할까요?`) && run(`CAM ${cam} 전환 명령 보냄`, () => api.testTake(cam))}
              >
                <span style={{ color: cameraColor(cam), fontWeight: 800 }}>CAM {cam}</span> 컷
              </button>
            ))}
          </div>

          {kind === 'ikegami' && snap.settings.SWITCHER === 'ikegami' && (
            <div style={{ marginTop: 16 }}>
              <div className="row">
                <b className="small">RS-422 송수신 모니터</b>
                <span className="spacer" />
                <button className="small" onClick={() => setLog([])}>
                  지우기
                </button>
              </div>
              <div className="dev-log mono">
                {log.length === 0 && <div className="muted">기록 없음</div>}
                {log.map((e) => (
                  <div key={e.id} className={`dev-log-${e.dir}`}>
                    <span className="muted">{new Date(e.at).toLocaleTimeString()}</span> {e.dir.toUpperCase().padEnd(5, ' ')} {e.text}
                  </div>
                ))}
              </div>
              <form
                className="row"
                style={{ marginTop: 8 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  run('보냈습니다.', () => api.sendSerial(hex));
                }}
              >
                <input className="mono" value={hex} onChange={(e) => setHex(e.target.value)} placeholder="보낼 16진수 (예: 02 00 03 05)" style={{ flex: 1 }} />
                <button type="submit" disabled={!sw.connected || busy || !hex.trim()}>
                  보내기
                </button>
              </form>
            </div>
          )}
        </section>

        {message && (
          <div className={`dev-toast ${message.ok ? 'ok' : 'bad'}`} onClick={() => setMessage(null)}>
            {message.ok ? '✓' : '⚠️'} {message.text}
          </div>
        )}
      </main>
    </>
  );
}

function Field({ k, children }: { k: DeviceKey; children: ReactNode }) {
  return (
    <div className="dev-field">
      <label>
        <span className="mono small">{k}</span> <span className="muted small">{DEVICE_KEYS[k]}</span>
      </label>
      {children}
    </div>
  );
}

/** "3,5,0,7" → CAM1→IN3 CAM2→IN5 … 미리보기 */
function CamMap({ list, prefix }: { list: string; prefix: string }) {
  const nums = list.split(/[\s,]+/).filter(Boolean);
  if (nums.length === 0) return null;
  return (
    <div className="row wrap small" style={{ marginTop: 4 }}>
      {nums.slice(0, 8).map((n, i) => (
        <span key={i} className="badge">
          <span style={{ color: cameraColor(i + 1), fontWeight: 700 }}>CAM {i + 1}</span>→ {Number(n) > 0 ? `${prefix} ${n}` : '없음'}
        </span>
      ))}
    </div>
  );
}
