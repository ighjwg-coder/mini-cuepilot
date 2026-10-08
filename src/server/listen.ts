// 포트 자동 선택.
// Windows 는 Hyper-V / WSL / Docker 가 켜져 있으면 일부 포트 대역을 예약해 두어(excludedportrange)
// 3000 같은 포트에서 listen 이 EACCES 로 실패할 수 있다. 다른 프로그램이 쓰는 중이면 EADDRINUSE.
// 이런 경우 후보 포트를 차례로 시도하고, 모두 실패하면 OS 가 빈 포트를 고르게(0) 한다.

/** 기본 포트. 5자리 + Windows 동적 포트 대역(49152~) 밖이라 예약·충돌이 드묾 */
export const DEFAULT_PORT = 38080;

/** 설정 포트를 못 쓸 때 차례로 시도 (모두 5자리). 기본 포트가 맨 앞 */
export const FALLBACK_PORTS = [DEFAULT_PORT, 38090, 28080, 18080, 48080];

const RETRYABLE = new Set(['EACCES', 'EADDRINUSE']);

export interface ListenAttempt {
  port: number;
  code: string;
}

export interface ListenResult {
  port: number;
  /** 실패한 시도 (비어 있으면 원래 포트로 성공) */
  failed: ListenAttempt[];
}

/**
 * @param listen 지정 포트로 listen 하고 실제 바인딩된 포트를 돌려주는 함수
 * @param shouldStop 실패 직후 호출. true 면 더 시도하지 않고 그 에러를 던짐 (예: 이미 CamCue 가 실행 중)
 */
export async function listenWithFallback(
  listen: (port: number) => Promise<number>,
  preferred: number,
  options: { candidates?: number[]; shouldStop?: (attempt: ListenAttempt) => Promise<boolean> } = {},
): Promise<ListenResult> {
  const ports = [...new Set([preferred, ...(options.candidates ?? FALLBACK_PORTS), 0])];
  const failed: ListenAttempt[] = [];
  for (const port of ports) {
    try {
      return { port: await listen(port), failed };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE.has(code)) throw err;
      const attempt = { port, code };
      failed.push(attempt);
      if (options.shouldStop && (await options.shouldStop(attempt))) throw err;
    }
  }
  // 포트 0 까지 실패하는 경우는 사실상 없음
  throw new Error(`사용 가능한 포트를 찾지 못했습니다 (${failed.map((f) => `${f.port}:${f.code}`).join(', ')})`);
}

/** 해당 포트에서 이미 CamCue 가 응답하는가 (중복 실행 감지) */
export async function isCamCueRunning(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as { ok?: boolean; version?: string };
    return body.ok === true && typeof body.version === 'string';
  } catch {
    return false;
  }
}
