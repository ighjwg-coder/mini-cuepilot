// CHANGELOG.md 도구 (Keep a Changelog 형식)
//   tsx scripts/changelog.ts check            ← npm preversion 훅: [Unreleased] 가 비어 있으면 버전을 올리기 전에 중단
//   tsx scripts/changelog.ts release          ← npm version 훅: [Unreleased] 내용을 새 버전 섹션으로 이동
//   tsx scripts/changelog.ts notes 0.0.2      ← 해당 버전 섹션 본문 출력 (GitHub Release 노트용)
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const UNRELEASED = '## [Unreleased]';
const EMPTY_UNRELEASED = `${UNRELEASED}\n\n`;

/** [Unreleased] 아래 내용을 `## [version] - date` 섹션으로 옮기고 빈 [Unreleased] 를 남긴다 */
export function stampRelease(changelog: string, version: string, date: string): string {
  if (changelog.includes(`## [${version}]`)) throw new Error(`CHANGELOG 에 이미 ${version} 섹션이 있습니다`);
  const start = changelog.indexOf(UNRELEASED);
  if (start < 0) throw new Error('CHANGELOG 에 "## [Unreleased]" 섹션이 없습니다');
  const bodyStart = start + UNRELEASED.length;
  const next = changelog.indexOf('\n## [', bodyStart);
  const end = next < 0 ? changelog.length : next + 1;
  const body = changelog.slice(bodyStart, end).trim();
  if (!body) throw new Error('[Unreleased] 에 변경 내용이 없습니다. 릴리스 전에 CHANGELOG.md 를 작성하세요');
  return `${changelog.slice(0, start)}${EMPTY_UNRELEASED}## [${version}] - ${date}\n\n${body}\n\n${changelog.slice(end)}`;
}

/** [Unreleased] 섹션 본문 (비어 있으면 '') */
export function unreleasedBody(changelog: string): string {
  const start = changelog.indexOf(UNRELEASED);
  if (start < 0) throw new Error('CHANGELOG 에 "## [Unreleased]" 섹션이 없습니다');
  const bodyStart = start + UNRELEASED.length;
  const next = changelog.indexOf('\n## [', bodyStart);
  return changelog.slice(bodyStart, next < 0 ? undefined : next).trim();
}

/** 특정 버전 섹션 본문 (제목 줄 제외) */
export function releaseNotes(changelog: string, version: string): string {
  const head = changelog.indexOf(`## [${version}]`);
  if (head < 0) throw new Error(`CHANGELOG 에 ${version} 섹션이 없습니다`);
  const bodyStart = changelog.indexOf('\n', head) + 1;
  const next = changelog.indexOf('\n## [', bodyStart);
  return changelog.slice(bodyStart, next < 0 ? undefined : next).trim();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, arg] = process.argv.slice(2);
  const file = 'CHANGELOG.md';
  const text = readFileSync(file, 'utf8');
  if (cmd === 'check') {
    if (!unreleasedBody(text)) {
      console.error('[changelog] [Unreleased] 에 변경 내용이 없습니다. CHANGELOG.md 를 먼저 작성하세요 (버전은 올리지 않았습니다)');
      process.exit(1);
    }
  } else if (cmd === 'release') {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (로컬 날짜)
    writeFileSync(file, stampRelease(text, version, today));
    console.log(`[changelog] ${version} (${today}) 섹션 생성`);
  } else if (cmd === 'notes' && arg) {
    process.stdout.write(releaseNotes(text, arg) + '\n');
  } else {
    console.error('사용법: tsx scripts/changelog.ts check | release | notes <version>');
    process.exit(1);
  }
}
