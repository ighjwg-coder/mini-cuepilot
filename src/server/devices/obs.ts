// OBS Studio — obs-websocket v5 (OBS 28 이상 기본 내장, 기본 포트 4455) 제어·탈리.
//
// obs-websocket 5.x 프로토콜 기준:
//   서버 Hello(op 0) → 클라이언트 Identify(op 1, 비밀번호가 있으면 인증 문자열) → Identified(op 2)
//   요청 Request(op 6) → RequestResponse(op 7), 이벤트 Event(op 5)
//   인증 = base64(sha256( base64(sha256(비밀번호 + salt)) + challenge ))
//
// OBS 에는 "입력 번호" 가 없으므로 CAM 마다 장면(Scene) 이름을 지정한다 (OBS_CAM_SCENES).
// 탈리 = 현재 프로그램 장면 하나. 장면 안에 다른 카메라 소스가 겹쳐 있거나 트랜지션 중인 것까지는 알 수 없다.
//   스튜디오 모드 켜짐: setPreview = 미리보기 장면 지정, 컷 = 그 장면을 바로 프로그램으로, AUTO = 스튜디오 모드 트랜지션
//   스튜디오 모드 꺼짐: setPreview = 다음 장면 기억만, 컷·AUTO = 프로그램 장면 변경 (OBS 에서 고른 트랜지션 적용)
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import type { AtemStatus, SwitcherCaps } from '../../shared/protocol';
import { camerasFrom, type AtemAdapter } from '../atem/types';

export const OBS_DEFAULT_PORT = 4455;

/** EventSubscription: General(1) | Scenes(4) | Ui(1024, 스튜디오 모드 전환) */
const EVENT_SUBS = 1 | 4 | 1024;

export interface ObsOptions {
  host: string;
  port?: number;
  password?: string;
  /** camScenes[i] = CAM(i+1) 장면 이름 ('' = 없음) */
  camScenes: string[];
  retryMs?: number;
  timeoutMs?: number;
}

export function obsAuth(password: string, salt: string, challenge: string): string {
  const sha = (s: string) => createHash('sha256').update(s).digest('base64');
  return sha(sha(password + salt) + challenge);
}

interface ObsMessage {
  op: number;
  d: Record<string, any>;
}

export class ObsAdapter implements AtemAdapter {
  private ws: WebSocket | null = null;
  private identified = false;
  private version: string | null = null;
  private lastError: string | null = null;
  private programScene: string | null = null;
  private previewScene: string | null = null;
  private studioMode = false;
  /** 스튜디오 모드가 꺼져 있을 때 다음에 컷할 카메라 */
  private nextCamera: number | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (data: Record<string, any>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(s: AtemStatus) => void>();
  private retry: NodeJS.Timeout | null = null;
  private wanted = false;

  constructor(private readonly opts: ObsOptions) {}

  private get port() {
    return this.opts.port ?? OBS_DEFAULT_PORT;
  }

  private camOf(scene: string | null): number | null {
    if (!scene) return null;
    const i = this.opts.camScenes.indexOf(scene);
    return i >= 0 ? i + 1 : null;
  }

  status(): AtemStatus {
    const on = this.identified;
    const pgm = this.camOf(this.programScene);
    return {
      mode: 'obs',
      host: `${this.opts.host}:${this.port}`,
      connected: on,
      model: on ? `OBS${this.version ? ` ${this.version}` : ''}${this.studioMode ? ' · 스튜디오 모드' : ''}${this.programScene ? ` · ${this.programScene}` : ''}` : null,
      programInput: on ? pgm : null,
      previewInput: on ? (this.studioMode ? this.camOf(this.previewScene) : this.nextCamera) : null,
      lastError: this.lastError,
      onAirInputs: on ? (pgm === null ? [] : [pgm]) : undefined,
    };
  }

  onStatus(listener: (s: AtemStatus) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capabilities(): SwitcherCaps {
    return { cameras: camerasFrom(this.opts.camScenes.map((s) => (s ? 1 : 0))), transition: true, macro: false, dsk: false };
  }

  connect(): Promise<void> {
    this.wanted = true;
    return this.open();
  }

  async disconnect() {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    this.identified = false;
    ws?.terminate();
    this.drop(new Error('연결 종료'));
    this.emit();
  }

  async setPreview(camera: number) {
    const scene = this.scene(camera);
    if (this.studioMode) await this.request('SetCurrentPreviewScene', { sceneName: scene });
    else {
      this.nextCamera = camera;
      this.emit();
    }
  }

  async cut() {
    const camera = this.studioMode ? this.camOf(this.previewScene) : this.nextCamera;
    if (camera === null) throw new Error('전환할 카메라 장면이 지정되지 않음');
    await this.request('SetCurrentProgramScene', { sceneName: this.scene(camera) });
  }

  async autoTransition() {
    if (this.studioMode) await this.request('TriggerStudioModeTransition');
    else await this.cut();
  }

  async runMacro() {
    throw new Error('OBS 모드에서는 매크로를 지원하지 않습니다');
  }

  async setDownstreamKeyOnAir() {
    throw new Error('OBS 모드에서는 DSK 를 지원하지 않습니다');
  }

  private scene(camera: number) {
    const s = this.opts.camScenes[camera - 1];
    if (!s) throw new Error(`CAM ${camera} 의 OBS 장면 이름이 설정되지 않았습니다 (OBS_CAM_SCENES)`);
    return s;
  }

  private request(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, any>> {
    const ws = this.ws;
    if (!ws || !this.identified) return Promise.reject(new Error('OBS 에 연결되어 있지 않습니다'));
    const requestId = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS 응답 없음: ${requestType}`));
      }, this.opts.timeoutMs ?? 3000);
      this.pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } }));
    });
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      const ws = new WebSocket(`ws://${this.opts.host}:${this.port}`, { handshakeTimeout: 5000 });
      this.ws = ws;
      ws.on('message', (raw) => {
        let msg: ObsMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.onMessage(ws, msg, done);
      });
      ws.on('error', (err) => {
        this.lastError = `OBS 연결 실패 (${this.opts.host}:${this.port}): ${err.message}`;
        done(err);
      });
      ws.on('close', (code, reason) => {
        if (this.ws !== ws) return;
        this.ws = null;
        const was = this.identified;
        this.identified = false;
        this.drop(new Error('OBS 연결 끊김'));
        // 4009 = 인증 실패 (비밀번호 틀림)
        if (code === 4009) this.lastError = 'OBS 비밀번호가 맞지 않습니다 (OBS → 도구 → WebSocket 서버 설정)';
        else if (was) this.lastError = 'OBS 연결 끊김 — 재시도 중';
        else if (!this.lastError) this.lastError = `OBS 연결 실패 (${code}${reason.length ? ` ${reason.toString()}` : ''})`;
        done(new Error(this.lastError));
        this.emit();
        this.scheduleRetry();
      });
    });
  }

  private onMessage(ws: WebSocket, msg: ObsMessage, done: (err?: Error) => void) {
    const d = msg.d ?? {};
    switch (msg.op) {
      case 0: {
        // Hello
        this.version = typeof d.obsWebSocketVersion === 'string' ? d.obsWebSocketVersion : null;
        const identify: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: EVENT_SUBS };
        if (d.authentication) {
          if (!this.opts.password) {
            this.lastError = 'OBS 에 비밀번호가 걸려 있습니다 — OBS_PASSWORD 를 입력해 주세요';
            done(new Error(this.lastError));
            ws.close();
            return;
          }
          identify.authentication = obsAuth(this.opts.password, d.authentication.salt, d.authentication.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
        return;
      }
      case 2:
        // Identified
        this.identified = true;
        this.lastError = null;
        this.refresh()
          .then(() => done())
          .catch((err) => {
            this.lastError = `OBS 상태 읽기 실패: ${(err as Error).message}`;
            done();
          })
          .finally(() => this.emit());
        return;
      case 5: {
        const e = d.eventData ?? {};
        switch (d.eventType) {
          case 'CurrentProgramSceneChanged':
            this.programScene = e.sceneName ?? null;
            if (this.nextCamera !== null && this.camOf(this.programScene) === this.nextCamera) this.nextCamera = null;
            break;
          case 'CurrentPreviewSceneChanged':
            this.previewScene = e.sceneName ?? null;
            break;
          case 'StudioModeStateChanged':
            this.studioMode = !!e.studioModeEnabled;
            if (this.studioMode) this.refreshPreview().finally(() => this.emit());
            else this.previewScene = null;
            break;
          default:
            return;
        }
        this.emit();
        return;
      }
      case 7: {
        const p = this.pending.get(d.requestId);
        if (!p) return;
        this.pending.delete(d.requestId);
        clearTimeout(p.timer);
        if (d.requestStatus?.result) p.resolve(d.responseData ?? {});
        else p.reject(new Error(`OBS 오류 (${d.requestType}): ${d.requestStatus?.comment ?? d.requestStatus?.code ?? '알 수 없음'}`));
        return;
      }
    }
  }

  private async refresh() {
    const pgm = await this.request('GetCurrentProgramScene');
    this.programScene = pgm.currentProgramSceneName ?? pgm.sceneName ?? null;
    const sm = await this.request('GetStudioModeEnabled');
    this.studioMode = !!sm.studioModeEnabled;
    await this.refreshPreview();
  }

  private async refreshPreview() {
    if (!this.studioMode) {
      this.previewScene = null;
      return;
    }
    const pvw = await this.request('GetCurrentPreviewScene').catch(() => ({}) as Record<string, any>);
    this.previewScene = pvw.currentPreviewSceneName ?? pvw.sceneName ?? null;
  }

  private drop(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private scheduleRetry() {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted && !this.identified) this.open().catch(() => this.emit());
    }, this.opts.retryMs ?? 3000);
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }
}
