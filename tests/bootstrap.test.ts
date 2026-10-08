import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE,
  DB_FILE,
  DEFAULT_CONFIG,
  LEGACY_DB_FILE,
  LEGACY_DIR_NAME,
  TEMPLATE_DB,
  prepareDataDir,
  saveConfigPort,
} from '../src/server/bootstrap';

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
    const root = mkdtempSync(join(tmpdir(), 'camcue-'));
    dirs.push(root);
    const appDir = join(root, 'app');
    const dataDir = join(root, 'data', 'CamCue');
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

describe('v0.0.1(Mini CuePilot) → CamCue 데이터 이전', () => {
  const roots: string[] = [];
  const saved = { DATABASE_URL: process.env.DATABASE_URL, ATEM_HOST: process.env.ATEM_HOST, PORT: process.env.PORT };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'camcue-mig-'));
    roots.push(root);
    const appDir = join(root, 'app');
    mkdirSync(appDir);
    writeFileSync(join(appDir, TEMPLATE_DB), 'TEMPLATE');
    const legacy = join(root, 'local', LEGACY_DIR_NAME);
    mkdirSync(legacy, { recursive: true });
    return { appDir, legacy, dataDir: join(root, 'local', 'CamCue') };
  }

  it('예전 폴더의 DB·설정을 복사해 오고, 예전 기본 포트 3000 은 38080 으로 교체', () => {
    const { appDir, legacy, dataDir } = setup();
    writeFileSync(join(legacy, LEGACY_DB_FILE), 'OLD DATA');
    writeFileSync(join(legacy, CONFIG_FILE), 'PORT=3000\nATEM_HOST=192.168.10.240\n');
    delete process.env.PORT;
    delete process.env.ATEM_HOST;
    const r = prepareDataDir(dataDir, appDir);
    expect(r.migratedFrom).toBe(legacy);
    expect(r.freshDb).toBe(false);
    expect(readFileSync(join(dataDir, DB_FILE), 'utf8')).toBe('OLD DATA');
    expect(readFileSync(join(dataDir, CONFIG_FILE), 'utf8')).toContain('PORT=38080');
    expect(process.env.ATEM_HOST).toBe('192.168.10.240');
    // 예전 폴더는 그대로 둠
    expect(readFileSync(join(legacy, LEGACY_DB_FILE), 'utf8')).toBe('OLD DATA');
  });

  it('사용자가 직접 바꾼 포트는 유지', () => {
    const { appDir, legacy, dataDir } = setup();
    writeFileSync(join(legacy, LEGACY_DB_FILE), 'OLD');
    writeFileSync(join(legacy, CONFIG_FILE), 'PORT=8090\n');
    delete process.env.PORT;
    prepareDataDir(dataDir, appDir);
    expect(readFileSync(join(dataDir, CONFIG_FILE), 'utf8')).toContain('PORT=8090');
  });

  it('새 폴더에 이미 데이터가 있으면 이전하지 않음', () => {
    const { appDir, legacy, dataDir } = setup();
    writeFileSync(join(legacy, LEGACY_DB_FILE), 'OLD');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, DB_FILE), 'NEW');
    const r = prepareDataDir(dataDir, appDir);
    expect(r.migratedFrom).toBeNull();
    expect(readFileSync(join(dataDir, DB_FILE), 'utf8')).toBe('NEW');
  });

  it('saveConfigPort: PORT 줄만 교체, 다른 설정 보존', () => {
    const { dataDir } = setup();
    mkdirSync(dataDir, { recursive: true });
    const cfg = join(dataDir, CONFIG_FILE);
    writeFileSync(cfg, '# 주석\nPORT=38080\nATEM_HOST=mock\n');
    saveConfigPort(cfg, 28080);
    expect(readFileSync(cfg, 'utf8')).toBe('# 주석\nPORT=28080\nATEM_HOST=mock\n');
  });
});
