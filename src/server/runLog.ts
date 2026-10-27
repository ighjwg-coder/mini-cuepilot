// 진행 기록: 예배가 끝난 뒤 팀 피드백용으로 큐 이동·스위처 명령 결과를 날짜별 CSV 로 남긴다.
// 엑셀에서 바로 열리도록 UTF-8 BOM + 쉼표 구분. 파일: <logDir>/run-YYYY-MM-DD.csv
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandLogEntry } from '../shared/protocol';
import type { TransitionRecord } from './runtime';

const HEADER = '시각,구분,행사,순서,큐,카메라,샷,메모,비고\r\n';
export const LOG_NAME = /^run-\d{4}-\d{2}-\d{2}\.csv$/;

const pad = (n: number) => String(n).padStart(2, '0');
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const time = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const csv = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const KIND: Record<string, string> = { go: 'GO', back: 'BACK', auto: '자동', timecode: '타임코드', jump: 'JUMP' };

export function createRunLogger(dir: string, serviceTitle: () => string) {
  const write = (at: number, cols: Array<string | number>) => {
    try {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `run-${day(at)}.csv`);
      const head = existsSync(path) ? '' : `﻿${HEADER}`;
      appendFileSync(path, head + [time(at), ...cols].map(csv).join(',') + '\r\n', 'utf8');
    } catch {
      // 기록 실패는 진행에 영향 없음
    }
  };
  return {
    transition(r: TransitionRecord) {
      const notes = [r.rehearsal && '리허설', r.silent && '컷 없이 이동'].filter(Boolean).join(' ');
      write(r.at, [KIND[r.kind] ?? r.kind, serviceTitle(), r.actTitle, r.cueNumber, `CAM ${r.camera}`, r.shotSize, r.note, notes]);
    },
    command(e: CommandLogEntry) {
      if (e.result === 'ok') return; // 성공은 큐 이동 기록으로 충분
      write(e.at, [e.result === 'failed' ? '컷 실패' : '컷 못 보냄', serviceTitle(), '', '', '', '', e.label, e.error ?? '']);
    },
  };
}

/** 기록 파일 목록 (최근 것부터) */
export function listRunLogs(dir: string): Array<{ name: string; size: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => LOG_NAME.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name, size: statSync(join(dir, name)).size }));
}
