# 버전 관리 · 릴리스 절차

## 버전 규칙

[Semantic Versioning](https://semver.org/lang/ko/) `MAJOR.MINOR.PATCH`

| 단계 | 버전 | 올리는 경우 |
|---|---|---|
| 테스트 (현재) | `0.0.x` | 버그 수정, 작은 기능 추가 → `npm run release:patch` |
| 베타 | `0.x.0` | 큰 기능 추가, 데이터 형식 변경 → `npm run release:minor` |
| 정식 | `1.0.0` | 실제 행사에서 안정적으로 운영 검증 후 |

- **버전의 기준은 `package.json` 의 `version` 하나뿐**입니다. 서버 로그, 화면 상단(`v0.0.1`), `/api/health`, 설치 파일 이름, GitHub Release 가 모두 이 값을 씁니다.
- `0.` 으로 시작하는 버전은 GitHub Release 에 **Pre-release** 로 표시됩니다.

## 평소 개발할 때

변경할 때마다 `CHANGELOG.md` 의 `## [Unreleased]` 아래에 기록합니다.

```markdown
## [Unreleased]

### 추가
- 에디터에서 큐 여러 개 한꺼번에 삭제

### 수정
- CueScreen 가로 모드에서 메모가 잘리던 문제
```

분류: `추가` / `변경` / `수정` / `제거` / `보안`

## 릴리스 하기

방법은 두 가지이며 결과는 같습니다.

### 방법 A — PR 머지만으로 (GitHub 웹에서 끝)

1. 작업 브랜치에서 `package.json` 버전을 올리고(`npm version patch --no-git-tag-version` 또는 직접 수정) `CHANGELOG.md` 에 해당 버전 섹션을 작성
2. PR 을 **main 에 머지**
3. 워크플로가 `v<버전>` 태그가 아직 없으면 **태그 생성 + Release 게시**까지 자동 처리

> v0.0.1 은 이 방법으로 게시됩니다 (PR #1 머지 시).

### 방법 B — 로컬에서 버전 명령으로

```bash
# 1) main 최신 상태에서 테스트
git checkout main && git pull
npm ci && npm test

# 2) 버전 올리기 (0.0.1 → 0.0.2)
npm run release:patch
#   - package.json / package-lock.json 버전 변경
#   - CHANGELOG.md 의 [Unreleased] → [0.0.2] - 오늘날짜 로 이동
#   - "chore(release): v0.0.2" 커밋 + v0.0.2 태그 생성

# 3) GitHub 에 올리기
git push --follow-tags
```

태그(또는 main 머지)가 올라가면 GitHub Actions **"Windows 배포판"** 워크플로가 자동으로:

1. Windows 서버에서 테스트 실행
2. 배포 패키지 조립 (`scripts/package.mjs`) + 설치판 첫 실행 스모크 테스트
3. `CamCue-Setup-v0.0.2-win-x64.exe` (Inno Setup) / `CamCue-portable-v0.0.2-win-x64.zip` 생성
4. GitHub **Releases** 에 CHANGELOG 내용을 노트로 하여 게시

진행 상황: 저장소 → Actions 탭. 약 5~10분.

> `[Unreleased]` 가 비어 있으면 `npm run release:patch` 가 중단됩니다 (변경 기록 없는 릴리스 방지).
> 태그와 `package.json` 버전이 다르면 워크플로가 실패합니다.

## PR 에서 미리 확인

PR 을 열면 같은 워크플로가 Windows 빌드까지 수행하고 결과물을 **Actions 아티팩트**로 보관합니다(14일). Release 에는 올라가지 않습니다. 설치 파일을 미리 받아 시험해 볼 수 있습니다.

## 잘못 올린 릴리스 되돌리기

1. GitHub → Releases → 해당 릴리스 Delete
2. 태그 삭제: `git push origin :refs/tags/v0.0.2` && `git tag -d v0.0.2`
3. 수정 후 **다음 번호로** 다시 릴리스 (같은 번호 재사용 지양)

## 배포판 구조 (참고)

```
CamCue/
├─ CamCue.cmd        실행기 (설치판 바로가기가 이것을 실행)
├─ node/node.exe           Node.js 런타임 (빌드 시점 Node 22)
├─ app/dist/server/        서버 번들
├─ app/dist/web/           웹 UI
├─ app/node_modules/       런타임 의존성 + Windows 용 Prisma 엔진
├─ app/template.db         빈 DB (첫 실행 시 데이터 폴더로 복사)
├─ icon.ico
└─ 사용법.txt

%LOCALAPPDATA%\CamCue\
├─ config.env              설정 (PORT, ATEM_HOST …)
└─ camcue.db             큐시트 데이터
```

- DB 스키마가 바뀌는 버전을 낼 때는 기존 `camcue.db` 마이그레이션 처리가 필요합니다 (현재 0.0.1 은 최초 스키마).
