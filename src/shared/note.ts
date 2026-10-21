// 큐 메모의 "중요" 표시. 데이터 형식을 바꾸지 않도록 메모 맨 앞의 ! 로 표현한다.
//   "!고음 직전 — 줌 준비"  → 중요 (카메라맨 화면에서 노란 강조, 차례가 다가오면 빨갛게)
export const IMPORTANT_MARK = '!';

export function parseNote(note: string): { important: boolean; text: string } {
  const t = note.trimStart();
  if (t.startsWith(IMPORTANT_MARK)) return { important: true, text: t.slice(IMPORTANT_MARK.length).trimStart() };
  return { important: false, text: note };
}

export function setImportant(note: string, on: boolean): string {
  const { text } = parseNote(note);
  return on ? `${IMPORTANT_MARK}${text}` : text;
}
