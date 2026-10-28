import type { ConnectedClient, ShowSnapshot } from '@shared/protocol';
import { cameraColor, formatTimecode } from '../lib/format';

export function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <span className="badge" title="서버 WebSocket 연결">
      <span className={`dot ${connected ? 'ok' : 'bad'}`} /> {connected ? '서버 연결' : '재연결 중…'}
    </span>
  );
}

export function AtemBadge({ snapshot }: { snapshot: ShowSnapshot | null }) {
  const atem = snapshot?.atem;
  if (!atem) return null;
  const label =
    atem.mode === 'disabled'
      ? '스위처 미사용'
      : atem.mode === 'mock'
        ? 'ATEM MOCK'
        : atem.mode === 'vmix'
          ? `vMix ${atem.host}`
          : atem.mode === 'obs'
            ? `OBS ${atem.host}`
            : atem.mode === 'ikegami'
              ? `이케가미 ${atem.host}`
              : atem.mode === 'gpi'
                ? `GPI 컷 ${atem.host}`
                : `ATEM ${atem.host}`;
  const cls = atem.mode === 'disabled' ? '' : atem.connected ? 'ok' : 'bad';
  return (
    <a className="badge" href="/devices" style={{ color: 'inherit', textDecoration: 'none' }} title={atem.lastError ?? atem.model ?? '장비 연결 설정'}>
      <span className={`dot ${cls}`} /> {label}
      {atem.mode !== 'disabled' && !atem.connected && <span className="muted">연결 안 됨</span>}
      {atem.connected && atem.model && <span className="muted">{atem.model}</span>}
    </a>
  );
}

export function TimecodeBadge({ snapshot }: { snapshot: ShowSnapshot | null }) {
  if (!snapshot?.timecode.running && snapshot?.state.timecodeSec == null) return null;
  return (
    <span className="badge mono" title={`타임코드 소스: ${snapshot.timecode.source}`}>
      <span className={`dot ${snapshot.timecode.running ? 'ok' : ''}`} /> TC {formatTimecode(snapshot.state.timecodeSec)}
    </span>
  );
}

/** 카메라 번호 → 접속한 CueScreen 수 */
export function camCounts(clients: ConnectedClient[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of clients) if (c.role === 'cam' && c.camera) m.set(c.camera, (m.get(c.camera) ?? 0) + 1);
  return m;
}

/** 접속 중인 CueScreen. 같은 번호가 2대 이상이면 ×2 경고, expected 중 접속 안 한 번호는 흐리게 */
export function CamClients({ clients, expected = [] }: { clients: ConnectedClient[]; expected?: number[] }) {
  const counts = camCounts(clients);
  const cams = [...new Set([...counts.keys(), ...expected])].sort((a, b) => a - b);
  return (
    <span className="badge" title="접속 중인 CueScreen (흐린 번호 = 접속 안 함, ×2 = 같은 번호 화면이 여러 대)">
      📱
      {cams.length === 0 ? (
        <span className="muted">CueScreen 없음</span>
      ) : (
        cams.map((n) => {
          const k = counts.get(n) ?? 0;
          return (
            <span
              key={n}
              className={`cam-chip ${k === 0 ? 'missing' : ''} ${k > 1 ? 'dup' : ''}`}
              style={{ background: cameraColor(n) }}
            >
              {n}
              {k > 1 && `×${k}`}
            </span>
          );
        })
      )}
    </span>
  );
}
