# 설계 결정 기록 (DECISIONS)

요청서에 명시되지 않았거나 해석이 필요한 부분을 어떻게 결정했는지 기록합니다.

## 1. 프로젝트 구조

| 항목 | 결정 | 이유 |
|---|---|---|
| 저장소 형태 | 단일 `package.json` (워크스페이스 미사용) | 서버/웹/공용 코드가 같은 TS 설정을 공유. 설치·실행 명령 단순화 |
| 디렉터리 | `src/shared`(도메인·엔진), `src/server`, `web`(Vite root), `prisma`, `tests` | 엔진은 서버와 브라우저 양쪽에서 import (카운트다운 계산 재사용) |
| 서버 실행 | `tsx` 로 TS 직접 실행 (별도 빌드 없음) | MVP 단계에서 빌드 파이프라인 최소화 |
| 웹 배포 | `vite build` → `dist/web` 를 Fastify가 정적 서빙 | 운영 시 포트 1개(3000)로 폰 접속 단순화 |
| Prisma 버전 | 6.x (`prisma-client-js`) | 7.x는 driver adapter/`prisma.config.ts` 필수로 구성이 복잡. 6.x가 SQLite 단일 파일 운용에 가장 단순 |
| TypeScript | 5.x | 7.x(네이티브 포트)는 생태계 호환성 검증 부족 |
| 환경 변수 | Node 내장 `process.loadEnvFile()` 사용, dotenv 미사용 | 의존성 최소화 |

### 알려진 이슈
- `npm audit` 에서 `prisma`(CLI, devDependency) → `@prisma/config` → `deepmerge-ts` high 경고가 보고됨. 런타임(@prisma/client)이 아닌 CLI 전용 경로이며, 권장 수정(`--force`)은 prisma 다운그레이드라 적용하지 않음.
