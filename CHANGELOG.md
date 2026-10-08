# Changelog

이 프로젝트의 모든 주요 변경 사항을 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/), 버전은 [Semantic Versioning](https://semver.org/lang/ko/)을 따릅니다.
정식 버전(1.0.0) 전까지는 `0.0.x`(수정·소규모 기능) / `0.x.0`(큰 기능·호환성 변경)으로 올립니다.

## [Unreleased]

## [0.0.1] - 2026-10-08

첫 테스트 릴리스입니다.

### 추가
- **큐 진행 엔진**: 순서(Act)별 MANUAL / SECTION(BPM·마디 자동 진행) / TIMECODE(시뮬레이션 클락) 모드, GO·BACK·HOLD·JUMP
- **디렉터 콘솔** (`/director`): 현재/다음 큐, 남은 시간, 탈리 그리드, 런시트, 단축키 Space·Backspace·H
- **CueScreen** (`/cam/1`~`/cam/8`): 카메라맨 폰용 다크 화면, 내 차례 카운트다운, ON AIR 빨강·PREVIEW 초록 테두리, 화면 꺼짐 방지
- **에디터** (`/editor`): 타임라인 드래그 정렬, 큐 인스펙터, JSON 내보내기·가져오기, 라이브 중 저장 즉시 반영
- **ATEM 제어**: CUT / AUTO / 매크로 / DSK, 실제 장비(atem-connection)·가상 스위처(mock)·미사용 모드
- **Windows 배포판**: 설치 파일(Setup.exe)·포터블 ZIP, Node.js 내장, 데이터는 `%LOCALAPPDATA%\MiniCuePilot` 에 보관
- 샘플 예배(찬양 3곡 + 대표기도 + 설교) 자동 생성

### 알려진 제한
- 코드 서명 인증서가 없어 처음 실행 시 Windows SmartScreen 경고가 표시됨 (추가 정보 → 실행)
- 폰 화면 꺼짐 방지는 HTTP 접속에서 기기에 따라 보장되지 않음 (폰 자동 잠금 해제 권장)
- 외부 타임코드(LTC/MTC) 입력 미지원
