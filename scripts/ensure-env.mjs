// .env 가 없으면 .env.example 을 복사한다 (최초 1회 셋업용)
import { copyFileSync, existsSync } from 'node:fs';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('[setup] .env.example -> .env 복사 완료');
}
