import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { releaseNotes, stampRelease } from '../scripts/changelog';

const BASE = `# Changelog

## [Unreleased]

### 추가
- 새 기능 A

## [0.0.1] - 2026-10-08

### 추가
- 첫 릴리스
`;

describe('CHANGELOG 도구', () => {
  it('stampRelease: Unreleased → 새 버전 섹션, 빈 Unreleased 유지', () => {
    const out = stampRelease(BASE, '0.0.2', '2026-10-15');
    expect(out).toContain('## [Unreleased]\n\n## [0.0.2] - 2026-10-15\n\n### 추가\n- 새 기능 A\n\n## [0.0.1]');
    expect(releaseNotes(out, '0.0.2')).toBe('### 추가\n- 새 기능 A');
    expect(releaseNotes(out, '0.0.1')).toBe('### 추가\n- 첫 릴리스');
  });

  it('Unreleased 가 비어 있으면 릴리스 거부 (변경 기록 누락 방지)', () => {
    const out = stampRelease(BASE, '0.0.2', '2026-10-15');
    expect(() => stampRelease(out, '0.0.3', '2026-10-16')).toThrow('변경 내용이 없습니다');
  });

  it('이미 있는 버전 / 없는 버전', () => {
    expect(() => stampRelease(BASE, '0.0.1', 'x')).toThrow('이미');
    expect(() => releaseNotes(BASE, '9.9.9')).toThrow('없습니다');
  });

  it('저장소 CHANGELOG 에 현재 package.json 버전 섹션이 있음', () => {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
    expect(releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version).length).toBeGreaterThan(0);
  });
});
