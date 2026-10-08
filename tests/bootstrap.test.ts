import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, DB_FILE, DEFAULT_CONFIG, TEMPLATE_DB, prepareDataDir } from '../src/server/bootstrap';

describe('prepareDataDir (설치판 데이터 폴더)', () => {
  const dirs: string[] = [];
  // process.env 를 새 객체로 바꾸면 실제 환경과 연결이 끊기므로 키 단위로 복원
  const KEYS = ['DATABASE_URL', 'ATEM_HOST', 'PORT'] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'cuepilot-'));
    dirs.push(root);
    const appDir = join(root, 'app');
    const dataDir = join(root, 'data', 'MiniCuePilot');
    mkdirSync(appDir);
    writeFileSync(join(appDir, TEMPLATE_DB), 'TEMPLATE');
    return { appDir, dataDir };
  }

  it('첫 실행: 폴더·기본 설정 생성, 템플릿 DB 복사, DATABASE_URL 지정', () => {
    const { appDir, dataDir } = setup();
    delete process.env.ATEM_HOST;
    const r = prepareDataDir(dataDir, appDir);
    expect(r.freshDb).toBe(true);
    expect(readFileSync(join(dataDir, CONFIG_FILE), 'utf8')).toBe(DEFAULT_CONFIG);
    expect(readFileSync(join(dataDir, DB_FILE), 'utf8')).toBe('TEMPLATE');
    expect(process.env.DATABASE_URL).toBe(`file:${join(dataDir, DB_FILE).replace(/\\/g, '/')}`);
    expect(process.env.ATEM_HOST).toBe('mock');
  });

  it('두 번째 실행: 기존 DB·사용자가 고친 설정을 유지', () => {
    const { appDir, dataDir } = setup();
    prepareDataDir(dataDir, appDir);
    writeFileSync(join(dataDir, DB_FILE), 'USER DATA');
    writeFileSync(join(dataDir, CONFIG_FILE), 'ATEM_HOST=192.168.10.240\n');
    delete process.env.ATEM_HOST;
    const r = prepareDataDir(dataDir, appDir);
    expect(r.freshDb).toBe(false);
    expect(readFileSync(join(dataDir, DB_FILE), 'utf8')).toBe('USER DATA');
    expect(process.env.ATEM_HOST).toBe('192.168.10.240');
  });

  it('이미 설정된 환경변수가 설정 파일보다 우선', () => {
    const { appDir, dataDir } = setup();
    process.env.PORT = '4567';
    prepareDataDir(dataDir, appDir);
    expect(process.env.PORT).toBe('4567');
  });
});
