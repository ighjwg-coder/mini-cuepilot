CamCue(캠큐) v{{VERSION}} — Windows 사용 안내
================================================

공연·컨퍼런스·행사 라이브 중계용 카메라 큐시트 진행 + ATEM 스위처 제어 + 카메라맨 폰 CueScreen.

[실행]
  - 설치판: 시작 메뉴 또는 바탕화면의 "CamCue" 아이콘
  - 포터블: 이 폴더의 CamCue.cmd 더블클릭
  → 검은 서버 창이 열리고 브라우저에 http://localhost:38080 이 자동으로 열립니다.
     (38080 을 쓸 수 없는 PC 면 다른 5자리 포트로 자동 변경 — 서버 창에 실제 주소가 표시됩니다)
  → 서버 창을 닫으면 프로그램이 종료됩니다. 행사 중에는 닫지 마세요.

  * 처음 실행 시 "Windows의 PC 보호" 파란 창이 뜨면
    [추가 정보] → [실행] 을 누르세요. (코드 서명 인증서가 없는 무료 배포본이라 표시됩니다)
  * "Windows 보안 경고(방화벽)" 창이 뜨면 [개인 네트워크]에 체크 후 [액세스 허용]
    → 이것을 허용해야 카메라맨 폰이 접속할 수 있습니다.

[화면]
  http://localhost:38080            홈 (행사 목록)
  http://localhost:38080/director   디렉터 콘솔   Space=GO  Backspace=BACK  H=HOLD
  http://localhost:38080/editor     큐시트 에디터  Ctrl+S=저장
  http://<PC IP>:38080/cam/1~8      카메라맨 폰 화면 (서버 창에 주소가 표시됩니다)

[설정 / 데이터 위치]
  %LOCALAPPDATA%\CamCue\config.env    ← 설정 (메모장으로 편집 후 프로그램 재시작)
  %LOCALAPPDATA%\CamCue\camcue.db   ← 큐시트 데이터 (백업하려면 이 파일 복사)
  (탐색기 주소창에 %LOCALAPPDATA%\CamCue 입력)
  프로그램을 지우거나 새 버전으로 설치해도 이 폴더는 유지됩니다.

[실제 ATEM 연결]
  1. ATEM Setup 에서 스위처 IP 확인 (예: 192.168.10.240)
  2. 이 PC 를 같은 대역 고정 IP 로 (예: 192.168.10.10)
  3. config.env 에서  ATEM_HOST=192.168.10.240  으로 변경 후 프로그램 재시작
  4. 디렉터 콘솔 상단 ATEM 배지가 초록이면 연결 완료
  - ATEM_HOST=mock  : 가상 스위처 (장비 없이 연습)
  - ATEM_HOST=      : ATEM 제어 안 함

[카메라맨 폰]
  - PC 와 같은 Wi-Fi (게스트 Wi-Fi 불가)
  - 주소: http://<PC IP>:38080/cam/<카메라 번호>
  - "화면을 탭해서 시작" 터치, 폰 자동 잠금은 "안 함" 권장

[문제 해결]
  - 서버 창에 "이미 실행 중입니다" → 브라우저에서 서버 창에 적힌 주소를 여세요
  - 포트를 쓸 수 없으면 자동으로 다른 5자리 포트로 바꿔 실행하고 config.env 에 저장합니다
  - 폰 접속 불가 → 방화벽 허용 여부, 같은 Wi-Fi 여부 확인
  - 자세한 설명: https://github.com/ighjwg-coder/mini-cuepilot
