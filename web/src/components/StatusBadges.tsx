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

export function CamClients({ clients }: { clients: ConnectedClient[] }) {
  const cams = [...new Set(clients.filter((c) => c.role === 'cam' && c.camera).map((c) => c.camera!))].sort((a, b) => a - b);
  return (
    <span className="badge" title="접속 중인 CueScreen">
      📱
      {cams.length === 0 ? (
        <span className="muted">CueScreen 없음</span>
      ) : (
        cams.map((n) => (
          <span key={n} className="cam-chip" style={{ background: cameraColor(n) }}>
            {n}
          </span>
        ))
      )}
    </span>
  );
}
