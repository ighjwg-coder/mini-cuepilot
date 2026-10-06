// atemAction 문자열 <-> 구조체 변환
//   cut            : 해당 카메라를 PVW에 올리고 CUT
//   auto           : 해당 카메라를 PVW에 올리고 AUTO(믹스 등 설정된 트랜지션)
//   macro:n        : 매크로 n번 실행 (ATEM Software Control 표기 기준 1부터)
//   dsk:n:on|off   : 다운스트림 키어 n번 ON AIR 켜기/끄기 (1부터)

export type AtemAction =
  | { kind: 'cut' }
  | { kind: 'auto' }
  | { kind: 'macro'; index: number }
  | { kind: 'dsk'; keyer: number; onAir: boolean };

const MACRO_RE = /^macro:(\d{1,3})$/;
const DSK_RE = /^dsk:(\d):(on|off)$/;

export function parseAtemAction(raw: string): AtemAction | null {
  const s = raw.trim().toLowerCase();
  if (s === 'cut') return { kind: 'cut' };
  if (s === 'auto') return { kind: 'auto' };
  const m = MACRO_RE.exec(s);
  if (m) {
    const index = Number(m[1]);
    return index >= 1 ? { kind: 'macro', index } : null;
  }
  const d = DSK_RE.exec(s);
  if (d) {
    const keyer = Number(d[1]);
    return keyer >= 1 ? { kind: 'dsk', keyer, onAir: d[2] === 'on' } : null;
  }
  return null;
}

export function formatAtemAction(a: AtemAction): string {
  switch (a.kind) {
    case 'cut':
    case 'auto':
      return a.kind;
    case 'macro':
      return `macro:${a.index}`;
    case 'dsk':
      return `dsk:${a.keyer}:${a.onAir ? 'on' : 'off'}`;
  }
}

export function isValidAtemAction(raw: string): boolean {
  return parseAtemAction(raw) !== null;
}

/** 이 액션이 프로그램 출력 카메라를 바꾸는가 (탈리 판단용) */
export function switchesProgram(a: AtemAction | null): boolean {
  return a !== null && (a.kind === 'cut' || a.kind === 'auto');
}
