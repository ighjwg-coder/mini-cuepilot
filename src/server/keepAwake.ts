// 캠큐 서버가 켜져 있는 동안 Windows 가 절전(대기 모드)으로 들어가지 않게 한다.
// SetThreadExecutionState 는 호출한 스레드가 살아 있는 동안만 유효하므로, 숨긴 PowerShell 을 하나 띄워
// 캠큐(부모 프로세스)가 끝날 때까지 기다리게 한다. 캠큐가 비정상 종료해도 PowerShell 이 스스로 끝난다.
import { spawn } from 'node:child_process';

const SCRIPT = (parentPid: number) => `
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
$k = Add-Type -MemberDefinition $sig -Name Power -Namespace CamCue -PassThru
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED (화면은 꺼져도 되고, 시스템 절전만 막음)
[void]$k::SetThreadExecutionState([uint32]2147483649)
while (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }
`;

/** 절전 방지 시작. Windows 가 아니면 아무 것도 하지 않는다. 반환값: 해제 함수 */
export function preventSleep(log: (msg: string) => void = () => {}): () => void {
  if (process.platform !== 'win32') return () => {};
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT(process.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => log(`절전 방지를 켜지 못했습니다: ${err.message}`));
    child.unref();
    return () => {
      try {
        child.kill();
      } catch {
        // 이미 끝남
      }
    };
  } catch (err) {
    log(`절전 방지를 켜지 못했습니다: ${(err as Error).message}`);
    return () => {};
  }
}
