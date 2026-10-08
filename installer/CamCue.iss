; CamCue Windows 설치 프로그램 (Inno Setup 6)
; 빌드: node scripts/package.mjs 후
;   ISCC.exe /DAppVersion=0.0.1 installer\CamCue.iss
; 결과: release\CamCue-Setup-v<버전>-win-x64.exe

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "CamCue"
#define AppExeCmd "CamCue.cmd"

[Setup]
; AppId 는 절대 바꾸지 말 것 — 같은 값이어야 새 버전이 기존 설치를 덮어쓰며 업그레이드됨
AppId={{6B1E2F4A-3C7D-4E8B-9A15-2D6C8F0E7B31}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} v{#AppVersion}
AppPublisher=CamCue
AppPublisherURL=https://github.com/ighjwg-coder/mini-cuepilot
AppSupportURL=https://github.com/ighjwg-coder/mini-cuepilot/issues
AppUpdatesURL=https://github.com/ighjwg-coder/mini-cuepilot/releases
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\CamCue
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\release
OutputBaseFilename=CamCue-Setup-v{#AppVersion}-win-x64
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\icon.ico
UninstallDisplayName={#AppName} v{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
InfoAfterFile=..\release\CamCue\사용법.txt
; 업그레이드 시 실행 중인 서버(node.exe)를 닫고 교체
CloseApplications=yes
; v0.0.1(Mini CuePilot) 설치 폴더·시작 메뉴 그룹을 재사용하지 않고 새 이름으로 설치
UsePreviousAppDir=no
UsePreviousGroup=no

[Languages]
#if FileExists(AddBackslash(CompilerPath) + "Languages\Korean.isl")
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
#else
Name: "english"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 바로가기 만들기"; GroupDescription: "추가 작업:"
Name: "firewall"; Description: "Windows 방화벽에서 CamCue 허용 (카메라맨 폰 접속에 필요)"; GroupDescription: "추가 작업:"

[InstallDelete]
; v0.0.1(Mini CuePilot) 흔적 정리 — 프로그램 파일·바로가기만 삭제. 큐시트 데이터(%LOCALAPPDATA%)는 건드리지 않음
Type: filesandordirs; Name: "{autopf}\Mini CuePilot"
Type: filesandordirs; Name: "{autoprograms}\Mini CuePilot"
Type: files; Name: "{autodesktop}\Mini CuePilot.lnk"

[Files]
Source: "..\release\CamCue\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeCmd}"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"
Name: "{group}\설정·데이터 폴더 열기"; Filename: "{win}\explorer.exe"; Parameters: """{localappdata}\CamCue"""
Name: "{group}\사용법"; Filename: "{app}\사용법.txt"
Name: "{group}\{#AppName} 제거"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeCmd}"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
; v0.0.1 방화벽 규칙 제거
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Mini CuePilot"""; Flags: runhidden
; 기존 규칙 제거 후 추가 (재설치 시 중복 방지). 교회 Wi-Fi 가 '공용 네트워크'로 잡히는 경우가 많아 모든 프로필 허용
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""CamCue"""; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""CamCue"" dir=in action=allow program=""{app}\node\node.exe"" enable=yes profile=any"; Flags: runhidden; Tasks: firewall
Filename: "{app}\{#AppExeCmd}"; Description: "지금 CamCue 실행"; Flags: postinstall nowait skipifsilent shellexec

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""CamCue"""; Flags: runhidden; RunOnceId: "RemoveFirewallRule"

; 사용자 데이터(%LOCALAPPDATA%\CamCue)는 제거 시에도 남겨 둠 (큐시트 보존)
