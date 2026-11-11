// CamCue 탈리 램프 — M5StickC Plus
//
// 캠큐 서버(/api/tally/stream?cam=N)에서 "내 카메라" 상태만 받아 화면 전체를 탈리 색으로 보여 준다.
//   빨강 = 내 카메라 송출 중 (본체 빨간 LED 도 켜짐) · 초록 = PVW (ATEM·vMix·OBS 만) · 어두움 = 대기
//   대기 화면에는 다음 내 샷(MS 등)과 몇 큐 뒤인지, 지금 무엇이 송출 중인지 표시
//
// 버튼
//   A (앞면 큰 버튼)  : 카메라 번호 바꾸기 1 → 2 → … → 8 → 1 (저장됨)
//   B (오른쪽 옆면)   : 화면 위아래 뒤집기 (저장됨) · 2초 누르면 설정 모드
//   전원 (왼쪽 옆면)  : 2초 누르면 켜짐 · 6초 누르면 꺼짐
//
// 설정 모드 (처음 켤 때 · B 2초)
//   "CamCue-Tally-XXXX" 와이파이(비밀번호 camcue1234)가 열린다 → 폰으로 접속하면 설정 화면이 뜬다 (안 뜨면 http://4.3.2.1)
//   공유기 이름·비밀번호·카메라 번호 입력. 캠큐 주소는 비워 두면 같은 와이파이에서 자동으로 찾는다.
//
// 연결이 끊기면 빨강을 그대로 두지 않고 "연결 끊김" 화면으로 바꾼다 (옛 탈리를 계속 보여 주지 않음).

#include <M5Unified.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_netif.h>

#define FW_VERSION "1.2"

static const uint16_t DISCOVERY_PORT = 38089;   // 캠큐 자동 검색 (UDP)
static const uint16_t DEFAULT_HTTP_PORT = 38080;
static const uint32_t STREAM_TIMEOUT_MS = 10000; // 서버는 4초마다 확인 줄을 보낸다
static const uint8_t MAX_CAM = 8;
// 설정 모드 와이파이. 주소는 공인 IP 모양(4.3.2.1)이어야 갤럭시가 "로그인 필요" 로 보고 설정 화면을 띄운다
// (192.168.x.x 같은 내부 주소로 답하면 삼성 폰은 인터넷 확인을 포기하고 "인터넷 연결 안 됨" 으로만 표시. WLED 도 같은 이유로 4.3.2.1 사용)
static const char* SETUP_AP_PASSWORD = "camcue1234";
static const IPAddress SETUP_AP_IP(4, 3, 2, 1);

// 타입은 함수보다 먼저 둔다 (Arduino 가 함수 원형을 맨 앞 함수 위에 자동으로 넣기 때문)
enum class Link : uint8_t { WifiConnecting, Searching, Connecting, Live, Lost, Https, NoEndpoint };
enum class HttpPhase : uint8_t { Idle, Status, Headers, Body };

struct Tally {
  char st = 'o';  // p = 송출(PGM), v = PVW, o = 그 외
  bool real = false;
  bool rh = false;
  String shot;
  String next;
  int in = -1;
  String now;
};

// ─────────────────────────────── 설정 (전원을 꺼도 유지) ───────────────────────────────

struct Settings {
  String ssid;
  String pass;
  String host;  // 비우면 자동 찾기. "192.168.0.10" 또는 "192.168.0.10:38080"
  uint8_t cam = 1;
  bool flip = false;
};
static Settings cfg;
static Preferences prefs;

static void loadSettings() {
  prefs.begin("camcue", true);
  cfg.ssid = prefs.getString("ssid", "");
  cfg.pass = prefs.getString("pass", "");
  cfg.host = prefs.getString("host", "");
  cfg.cam = prefs.getUChar("cam", 1);
  cfg.flip = prefs.getBool("flip", false);
  prefs.end();
  if (cfg.cam < 1 || cfg.cam > MAX_CAM) cfg.cam = 1;
}

static void saveSettings() {
  prefs.begin("camcue", false);
  prefs.putString("ssid", cfg.ssid);
  prefs.putString("pass", cfg.pass);
  prefs.putString("host", cfg.host);
  prefs.putUChar("cam", cfg.cam);
  prefs.putBool("flip", cfg.flip);
  prefs.end();
}

/** 다음에 켤 때 설정 모드로 (B 2초) */
static void requestSetupOnBoot(bool on) {
  prefs.begin("camcue", false);
  prefs.putBool("setup", on);
  prefs.end();
}

static bool takeSetupRequest() {
  prefs.begin("camcue", false);
  bool on = prefs.getBool("setup", false);
  if (on) prefs.putBool("setup", false);
  prefs.end();
  return on;
}

// ─────────────────────────────── 화면 ───────────────────────────────

static uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) { return M5.Display.color565(r, g, b); }

// 캠큐 화면과 같은 카메라 구분색 (빨강·초록·노랑·주황은 탈리 색이라 쓰지 않음)
static uint16_t camColor(uint8_t n) {
  switch (n) {
    case 1: return rgb(0x3b, 0x82, 0xf6);
    case 2: return rgb(0x06, 0xb6, 0xd4);
    case 3: return rgb(0xa8, 0x55, 0xf7);
    case 4: return rgb(0xec, 0x48, 0x99);
    case 5: return rgb(0xe2, 0xe8, 0xf0);
    case 6: return rgb(0x81, 0x8c, 0xf8);
    case 7: return rgb(0xf0, 0xab, 0xfc);
    default: return rgb(0x94, 0xa3, 0xb8);
  }
}

static uint16_t BG_PGM, BG_PVW, BG_DARK, FG_WHITE, FG_DIM, FG_WARN;

static void initColors() {
  BG_PGM = rgb(210, 0, 0);
  BG_PVW = rgb(0, 140, 40);
  BG_DARK = rgb(14, 18, 24);
  FG_WHITE = rgb(255, 255, 255);
  FG_DIM = rgb(150, 160, 175);
  FG_WARN = rgb(250, 204, 21);
}

static void applyRotation() { M5.Display.setRotation(cfg.flip ? 3 : 1); }

/** 폭에 맞게 자르기 (한글 UTF-8 이 깨지지 않게 글자 단위로) */
static String fitText(const String& s, int maxWidth) {
  if (M5.Display.textWidth(s.c_str()) <= maxWidth) return s;
  String t = s;
  while (t.length() > 0) {
    int i = t.length() - 1;
    while (i > 0 && (static_cast<uint8_t>(t[i]) & 0xC0) == 0x80) i--;
    t.remove(i);
    String withDots = t + "..";
    if (M5.Display.textWidth(withDots.c_str()) <= maxWidth) return withDots;
  }
  return String("..");
}

static void drawText(const String& s, int x, int y, const lgfx::IFont* font, float size, uint16_t fg, uint16_t bg, textdatum_t datum, int maxWidth) {
  M5.Display.setFont(font);
  M5.Display.setTextSize(size);
  M5.Display.setTextColor(fg, bg);
  M5.Display.setTextDatum(datum);
  String t = maxWidth > 0 ? fitText(s, maxWidth) : s;
  M5.Display.drawString(t.c_str(), x, y);
}

/** 왼쪽: 큰 카메라 번호 */
static void drawCamNumber(uint16_t fg, uint16_t bg) {
  drawText("CAM", 46, 4, &fonts::Font2, 1, fg, bg, top_center, 0);
  drawText(String(cfg.cam), 46, 66, &fonts::Font8, 1, fg, bg, middle_center, 0);
}

// 배터리는 10초마다만 읽는다 (전원 칩을 매번 읽지 않게)
static int batteryLevel = -1;
static bool batteryCharging = false;
static uint32_t batteryReadAt = 0;

static void updateBattery(bool force) {
  if (!force && millis() - batteryReadAt < 10000) return;
  batteryReadAt = millis();
  batteryLevel = M5.Power.getBatteryLevel();
  batteryCharging = M5.Power.isCharging() == m5::Power_Class::is_charging_t::is_charging;
}

static void drawBattery(uint16_t fg, uint16_t bg) {
  if (batteryLevel < 0) return;
  String s = String(batteryCharging ? "+" : "") + batteryLevel + "%";
  drawText(s, M5.Display.width() - 4, 4, &fonts::Font2, 1, batteryLevel <= 15 && !batteryCharging ? FG_WARN : fg, bg, top_right, 0);
}

// ─────────────────────────────── 탈리 상태 ───────────────────────────────

static Link linkState = Link::WifiConnecting;  // (link 는 POSIX 함수 이름이라 피함)
static Tally tally;
static String lastScreenKey;

static String screenKey() {
  String k = String(static_cast<int>(linkState)) + "|" + cfg.cam + "|" + (cfg.flip ? 1 : 0) + "|" + (batteryLevel / 5) + "|" +
             (batteryCharging ? 1 : 0);
  if (linkState == Link::Live) {
    k += String("|") + tally.st + (tally.real ? "R" : "E") + (tally.rh ? "H" : "-") + "|" + tally.shot + "|" + tally.next + "|" + tally.in + "|" + tally.now;
  }
  return k;
}

static void drawLinkScreen() {
  M5.Display.fillScreen(BG_DARK);
  drawCamNumber(camColor(cfg.cam), BG_DARK);
  drawBattery(FG_DIM, BG_DARK);
  const int cx = 166;
  String line1, line2;
  switch (linkState) {
    case Link::WifiConnecting:
      line1 = "와이파이 연결 중";
      line2 = cfg.ssid;
      break;
    case Link::Searching:
      line1 = "캠큐 찾는 중";
      line2 = "같은 와이파이인지 확인";
      break;
    case Link::Connecting:
      line1 = "캠큐 연결 중";
      line2 = "";
      break;
    case Link::Lost:
      line1 = "연결 끊김";
      line2 = "다시 연결 중";
      break;
    case Link::Https:
      line1 = "연결 불가";
      line2 = "캠큐 HTTPS 모드";
      break;
    case Link::NoEndpoint:
      line1 = "캠큐 업데이트";
      line2 = "0.1.1 이상 필요";
      break;
    case Link::Live:
      break;
  }
  drawText(line1, cx, 58, &fonts::efontKR_16_b, 1, FG_WARN, BG_DARK, middle_center, 140);
  drawText(line2, cx, 84, &fonts::efontKR_16_b, 1, FG_DIM, BG_DARK, middle_center, 140);
  drawText(String("v") + FW_VERSION, M5.Display.width() - 4, M5.Display.height() - 4, &fonts::Font0, 1, FG_DIM, BG_DARK, bottom_right, 0);
}

static void drawLiveScreen() {
  const int cx = 166;
  const int w = M5.Display.width();
  const int h = M5.Display.height();
  uint16_t bg = tally.st == 'p' ? BG_PGM : tally.st == 'v' ? BG_PVW : BG_DARK;
  M5.Display.fillScreen(bg);
  drawCamNumber(tally.st == 'o' ? camColor(cfg.cam) : FG_WHITE, bg);
  drawBattery(tally.st == 'o' ? FG_DIM : FG_WHITE, bg);

  // 추정 탈리 · 리허설 표시 (실제 송출과 다를 수 있음)
  String badge;
  if (tally.rh) badge = "리허설";
  else if (!tally.real) badge = "추정";
  if (badge.length()) drawText(badge, 98, 4, &fonts::efontKR_16_b, 1, tally.st == 'o' ? FG_WARN : FG_WHITE, bg, top_left, 0);

  if (tally.st == 'p') {
    M5.Power.setLed(255);
    drawText("ON AIR", cx, 58, &fonts::FreeSansBold18pt7b, 1, FG_WHITE, bg, middle_center, 140);
    if (tally.shot.length()) drawText(tally.shot, cx, 98, &fonts::FreeSansBold12pt7b, 1, FG_WHITE, bg, middle_center, 140);
    return;
  }
  M5.Power.setLed(0);
  if (tally.st == 'v') {
    drawText("PVW", cx, 62, &fonts::FreeSansBold24pt7b, 1, FG_WHITE, bg, middle_center, 140);
    return;
  }

  // 대기: 다음 내 샷(크게) · 몇 큐 뒤 · 지금 송출
  if (tally.next.length()) {
    drawText("다음 내 샷", cx, 30, &fonts::efontKR_16_b, 1, FG_DIM, bg, middle_center, 140);
    drawText(tally.next, cx, 62, &fonts::FreeSansBold24pt7b, 1, FG_WHITE, bg, middle_center, 140);
    String when;
    if (tally.in == 1) when = "바로 다음";
    else if (tally.in > 1) when = String(tally.in) + "큐 뒤";
    drawText(when, cx, 94, &fonts::efontKR_16_b, 1, tally.in == 1 ? FG_WARN : FG_DIM, bg, middle_center, 140);
  } else {
    drawText("대기", cx, 58, &fonts::efontKR_16_b, 2, FG_DIM, bg, middle_center, 140);
  }
  if (tally.now.length()) {
    drawText(String("송출: ") + tally.now, 6, h - 6, &fonts::efontKR_16_b, 1, FG_DIM, bg, bottom_left, w - 12);
  }
}

static void render(bool force) {
  String key = screenKey();
  if (!force && key == lastScreenKey) return;
  lastScreenKey = key;
  M5.Display.startWrite();
  if (linkState == Link::Live) drawLiveScreen();
  else {
    M5.Power.setLed(0);
    drawLinkScreen();
  }
  M5.Display.endWrite();
}

// ─────────────────────────────── 캠큐 찾기 (UDP) ───────────────────────────────

static WiFiUDP udp;
static bool udpReady = false;
static IPAddress serverIp;
static uint16_t serverPort = 0;
static bool serverManual = false;
static uint32_t lastDiscoverAt = 0;

/** 수동 주소 (IP 만, 포트 생략 시 38080) */
static bool useManualHost() {
  if (cfg.host.length() == 0) return false;
  String h = cfg.host;
  h.trim();
  uint16_t port = DEFAULT_HTTP_PORT;
  int colon = h.lastIndexOf(':');
  if (colon > 0) {
    port = static_cast<uint16_t>(h.substring(colon + 1).toInt());
    h = h.substring(0, colon);
  }
  IPAddress ip;
  if (!ip.fromString(h) || port == 0) return false;
  serverIp = ip;
  serverPort = port;
  serverManual = true;
  return true;
}

static void sendDiscover() {
  if (!udpReady) {
    udpReady = udp.begin(DISCOVERY_PORT + 1) == 1;
    if (!udpReady) return;
  }
  static const char query[] = "CAMCUE_DISCOVER";
  IPAddress targets[2] = {IPAddress(255, 255, 255, 255), WiFi.broadcastIP()};
  for (const IPAddress& dst : targets) {
    udp.beginPacket(dst, DISCOVERY_PORT);
    udp.write(reinterpret_cast<const uint8_t*>(query), sizeof(query) - 1);
    udp.endPacket();
  }
}

/** 응답 예: {"app":"CamCue","version":"0.1.1","name":"PC","port":38080,"proto":"http"} */
static bool readDiscoverReply() {
  if (!udpReady) return false;
  int size = udp.parsePacket();
  if (size <= 0) return false;
  char buf[256];
  int len = udp.read(buf, sizeof(buf) - 1);
  if (len <= 0) return false;
  buf[len] = 0;
  String s(buf);
  if (s.indexOf("\"app\":\"CamCue\"") < 0) return false;
  int p = s.indexOf("\"port\":");
  if (p < 0) return false;
  uint16_t port = static_cast<uint16_t>(s.substring(p + 7).toInt());
  if (port == 0) return false;
  if (s.indexOf("\"proto\":\"https\"") >= 0) {
    linkState = Link::Https;  // 이 기기는 HTTPS 를 지원하지 않음
    return false;
  }
  serverIp = udp.remoteIP();
  serverPort = port;
  Serial.printf("[find] 캠큐 %s:%u\n", serverIp.toString().c_str(), serverPort);
  return true;
}

// ─────────────────────────────── 탈리 받기 (HTTP 스트림) ───────────────────────────────

static WiFiClient client;
static HttpPhase phase = HttpPhase::Idle;
static String lineBuf;
static uint32_t lastRxAt = 0;
static uint32_t nextConnectAt = 0;
static uint8_t failCount = 0;

static String urlDecode(const String& s) {
  String out;
  out.reserve(s.length());
  for (unsigned int i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '+') {
      out += ' ';
    } else if (c == '%' && i + 2 < s.length()) {
      char hex[3] = {s[i + 1], s[i + 2], 0};
      out += static_cast<char>(strtol(hex, nullptr, 16));
      i += 2;
    } else {
      out += c;
    }
  }
  return out;
}

/** v=1&cam=1&st=pgm&real=1&rh=0&shot=MS&next=WS&in=3&now=CAM+2 */
static void applyPayload(const String& p) {
  Tally t;
  bool mine = false;
  int start = 0;
  const int n = p.length();
  while (start <= n) {
    int amp = p.indexOf('&', start);
    if (amp < 0) amp = n;
    String kv = p.substring(start, amp);
    int eq = kv.indexOf('=');
    String k = eq < 0 ? kv : kv.substring(0, eq);
    String v = eq < 0 ? String("") : urlDecode(kv.substring(eq + 1));
    if (k == "cam") mine = v.toInt() == cfg.cam;
    else if (k == "st") t.st = v == "pgm" ? 'p' : (v == "pvw" ? 'v' : 'o');
    else if (k == "real") t.real = v == "1";
    else if (k == "rh") t.rh = v == "1";
    else if (k == "shot") t.shot = v;
    else if (k == "next") t.next = v;
    else if (k == "in") t.in = v.toInt();
    else if (k == "now") t.now = v;
    start = amp + 1;
  }
  if (mine) tally = t;
}

static void streamClose(Link reason, uint32_t retryMs) {
  Serial.printf("[tally] 연결 끊음 (이유 %d)\n", static_cast<int>(reason));
  client.stop();
  phase = HttpPhase::Idle;
  lineBuf = "";
  tally = Tally();  // 옛 탈리를 남기지 않는다
  linkState = reason;
  nextConnectAt = millis() + retryMs;
  if (reason == Link::Lost && ++failCount >= 3 && !serverManual) {
    serverPort = 0;  // 캠큐 PC 주소가 바뀌었을 수 있으니 다시 찾는다
    failCount = 0;
  }
}

static void streamOpen() {
  linkState = Link::Connecting;
  render(false);
  Serial.printf("[tally] %s:%u 연결 · CAM %u\n", serverIp.toString().c_str(), serverPort, cfg.cam);
  if (!client.connect(serverIp, serverPort, 3000)) {
    streamClose(Link::Lost, 2000);
    return;
  }
  client.setNoDelay(true);
  // HTTP/1.0 → 서버가 chunked 로 나누지 않고 줄 단위로 그대로 보낸다
  String req = String("GET /api/tally/stream?cam=") + cfg.cam + " HTTP/1.0\r\n" + "Host: " + serverIp.toString() + "\r\n" +
               "Accept: text/event-stream\r\n" + "User-Agent: CamCue-Tally/" FW_VERSION "\r\n\r\n";
  client.print(req);
  phase = HttpPhase::Status;
  lineBuf = "";
  lastRxAt = millis();
}

static void handleLine(const String& line) {
  switch (phase) {
    case HttpPhase::Status:
      if (line.startsWith("HTTP/1.") && line.indexOf(" 200") > 0) {
        phase = HttpPhase::Headers;
      } else {
        Serial.printf("[tally] 응답 오류: %s\n", line.c_str());
        streamClose(line.indexOf(" 404") > 0 ? Link::NoEndpoint : Link::Lost, 5000);
      }
      break;
    case HttpPhase::Headers:
      if (line.length() == 0) phase = HttpPhase::Body;
      break;
    case HttpPhase::Body:
      if (line.startsWith("data:")) {
        String payload = line.substring(5);
        payload.trim();
        applyPayload(payload);
        // 첫 상태를 받은 뒤에야 탈리 화면으로 (그 전에는 "연결 중")
        linkState = Link::Live;
        failCount = 0;
      }
      break;
    case HttpPhase::Idle:
      break;
  }
}

static void streamPoll() {
  while (client.available() > 0) {
    int c = client.read();
    if (c < 0) break;
    lastRxAt = millis();
    if (c == '\r') continue;
    if (c == '\n') {
      handleLine(lineBuf);
      lineBuf = "";
      if (phase == HttpPhase::Idle) return;
      continue;
    }
    if (lineBuf.length() < 600) lineBuf += static_cast<char>(c);
  }
  if (!client.connected()) {
    streamClose(Link::Lost, 1000);
  } else if (millis() - lastRxAt > STREAM_TIMEOUT_MS) {
    streamClose(Link::Lost, 1000);  // 서버 확인 줄이 안 옴 = 와이파이·캠큐 PC 문제
  }
}

/** 카메라 번호를 바꾸면 바로 다시 연결 */
static void reconnectNow() {
  if (phase != HttpPhase::Idle) {
    client.stop();
    phase = HttpPhase::Idle;
    lineBuf = "";
  }
  tally = Tally();
  nextConnectAt = 0;
  if (linkState == Link::Live || linkState == Link::Lost) linkState = Link::Connecting;
}

static bool wifiWasUp = false;

static void runLoop() {
  const bool wifiUp = WiFi.status() == WL_CONNECTED;
  if (wifiUp != wifiWasUp) {
    wifiWasUp = wifiUp;
    if (wifiUp) Serial.printf("[wifi] %s 연결 · IP %s\n", cfg.ssid.c_str(), WiFi.localIP().toString().c_str());
    else Serial.println("[wifi] 연결 끊김");
  }
  if (!wifiUp) {
    if (phase != HttpPhase::Idle) {
      client.stop();
      phase = HttpPhase::Idle;
      lineBuf = "";
    }
    tally = Tally();
    linkState = Link::WifiConnecting;
    return;
  }
  if (phase != HttpPhase::Idle) {
    streamPoll();
    return;
  }
  if (serverPort == 0 && !useManualHost()) {
    if (linkState != Link::Https) linkState = Link::Searching;
    if (millis() - lastDiscoverAt > 2000 || lastDiscoverAt == 0) {
      lastDiscoverAt = millis();
      sendDiscover();
    }
    readDiscoverReply();
    return;
  }
  if (static_cast<int32_t>(millis() - nextConnectAt) >= 0) streamOpen();
}

// ─────────────────────────────── 설정 모드 (폰으로 와이파이 입력) ───────────────────────────────

static bool setupMode = false;
static WebServer web(80);
static DNSServer dns;
static String scanOptions;
static uint32_t restartAt = 0;
static bool portalServed = false;      // 설정 화면을 한 번이라도 보냈는지 (화면에 "화면 열림")
static uint8_t shownStations = 255;    // 화면에 표시한 접속 기기 수 (255 = 아직 안 그림)
static bool shownPortalServed = false;
static uint32_t setupStatusAt = 0;

static String htmlEscape(const String& s) {
  String o;
  o.reserve(s.length());
  for (unsigned int i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '&') o += "&amp;";
    else if (c == '<') o += "&lt;";
    else if (c == '>') o += "&gt;";
    else if (c == '"') o += "&quot;";
    else if (c == '\'') o += "&#39;";
    else o += c;
  }
  return o;
}

static String apName() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char name[32];
  snprintf(name, sizeof(name), "CamCue-Tally-%02X%02X", mac[4], mac[5]);
  return String(name);
}

static void handleRoot() {
  portalServed = true;
  Serial.println("[http] GET / (설정 화면)");
  String camOptions;
  for (uint8_t i = 1; i <= MAX_CAM; i++) {
    camOptions += String("<option value=\"") + i + "\"" + (i == cfg.cam ? " selected" : "") + ">CAM " + i + "</option>";
  }
  String page;
  page.reserve(4096);
  page += F("<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>CamCue 탈리 램프</title>"
            "<style>body{font-family:sans-serif;background:#0e1218;color:#eef1f4;margin:0;padding:20px}"
            "h1{font-size:22px;margin:0 0 4px}p{color:#94a3b8;font-size:14px;margin:0 0 18px}"
            "label{display:block;font-size:14px;margin:14px 0 6px;color:#cbd5e1}"
            "input,select{width:100%;box-sizing:border-box;font-size:17px;padding:10px;border-radius:8px;border:1px solid #334155;background:#111827;color:#fff}"
            "button{margin-top:22px;width:100%;font-size:18px;padding:14px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-weight:700}"
            "small{color:#94a3b8}</style></head><body>"
            "<h1>CamCue 탈리 램프</h1><p>공유기와 카메라 번호를 넣고 저장하세요. 캠큐 PC 와 같은 와이파이여야 합니다.</p>"
            "<form method=\"post\" action=\"/save\">"
            "<label>와이파이 (목록에서 고르기)</label><select name=\"pick\">");
  page += scanOptions;
  page += F("</select><label>목록에 없으면 직접 입력</label><input name=\"ssid\" autocomplete=\"off\" placeholder=\"공유기 이름\">"
            "<label>와이파이 비밀번호</label><input name=\"pass\" type=\"password\" autocomplete=\"off\" placeholder=\"같은 공유기면 비워 둬도 기존 값 유지\">"
            "<label>카메라 번호</label><select name=\"cam\">");
  page += camOptions;
  page += F("</select><label>캠큐 PC 주소 (선택)</label><input name=\"host\" autocomplete=\"off\" placeholder=\"비워 두면 자동으로 찾기 · 예: 192.168.0.10:38080\" value=\"");
  page += htmlEscape(cfg.host);
  page += F("\"><small>자동으로 못 찾을 때만 캠큐 PC 의 IP 를 넣으세요 (캠큐 창에 표시된 주소).</small>"
            "<button type=\"submit\">저장하고 다시 시작</button></form>");
  page += String("<p style=\"margin-top:18px\">펌웨어 v") + FW_VERSION + "</p></body></html>";
  web.send(200, "text/html; charset=utf-8", page);
}

static void handleSave() {
  String ssid = web.arg("ssid");
  ssid.trim();
  if (ssid.length() == 0) ssid = web.arg("pick");
  String pass = web.arg("pass");
  int cam = web.arg("cam").toInt();
  if (ssid.length() == 0) {
    web.send(400, "text/html; charset=utf-8", "<meta charset=\"utf-8\"><p>와이파이 이름을 고르거나 입력하세요. <a href=\"/\">돌아가기</a></p>");
    return;
  }
  // 같은 공유기에서 비밀번호를 비우면 기존 비밀번호 유지
  if (!(pass.length() == 0 && ssid == cfg.ssid)) cfg.pass = pass;
  cfg.ssid = ssid;
  if (cam >= 1 && cam <= MAX_CAM) cfg.cam = static_cast<uint8_t>(cam);
  cfg.host = web.arg("host");
  cfg.host.trim();
  saveSettings();
  web.send(200, "text/html; charset=utf-8",
           "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
           "<body style=\"font-family:sans-serif;background:#0e1218;color:#eef1f4;padding:20px\">"
           "<h2>저장했습니다</h2><p>탈리 램프가 다시 시작해 공유기에 연결합니다. 이 와이파이 연결은 끊어도 됩니다.</p></body>");
  restartAt = millis() + 1500;
}

/** 폰의 "로그인 필요" 확인 요청을 모두 설정 화면으로 보낸다 */
static void handleRedirect() {
  Serial.printf("[http] %s -> 설정 화면으로\n", web.uri().c_str());
  web.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
  web.send(302, "text/plain", "");
}

/**
 * 설정 와이파이에 붙은 폰에게 "DNS 서버 = 이 기기" 를 알려 준다.
 * 코어 기본값은 DNS 를 알려 주지 않아서, 폰의 인터넷 확인이 실패해 "인터넷 연결 안 됨" 으로만 뜨고
 * 설정 화면이 자동으로 열리지 않았다. 이 기기가 DNS 에 답하면 폰이 "로그인 필요" 로 보고 설정 화면을 띄운다.
 */
static void offerDnsOnAp(const IPAddress& ip) {
  esp_netif_t* ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
  if (ap == nullptr) {
    Serial.println("[setup] AP netif 없음 — DNS 안내 생략");
    return;
  }
  esp_netif_dns_info_t dnsInfo = {};
  dnsInfo.ip.type = ESP_IPADDR_TYPE_V4;
  dnsInfo.ip.u_addr.ip4.addr = static_cast<uint32_t>(ip);
  uint8_t offerDns = 0x02;  // OFFER_DNS (ESP-IDF 4.4) = DHCPS_OFFER_DNS (ESP-IDF 5)
  esp_netif_dhcps_stop(ap);
  esp_err_t e1 = esp_netif_dhcps_option(ap, ESP_NETIF_OP_SET, ESP_NETIF_DOMAIN_NAME_SERVER, &offerDns, sizeof(offerDns));
  esp_err_t e2 = esp_netif_set_dns_info(ap, ESP_NETIF_DNS_MAIN, &dnsInfo);
  esp_err_t e3 = esp_netif_dhcps_start(ap);
  Serial.printf("[setup] DHCP DNS 안내: option=%d dns=%d start=%d\n", e1, e2, e3);
}

/** 설정 모드 화면 오른쪽 위: 폰이 붙었는지 · 설정 화면이 열렸는지 (안 뜰 때 원인 찾기용) */
static void drawSetupStatus(bool force) {
  uint8_t n = WiFi.softAPgetStationNum();
  if (!force && n == shownStations && portalServed == shownPortalServed) return;
  if (n != shownStations) Serial.printf("[setup] 접속한 기기 %d대\n", n);
  shownStations = n;
  shownPortalServed = portalServed;
  String s = portalServed ? "화면 열림" : (n > 0 ? "폰 연결됨" : "폰 대기");
  uint16_t color = portalServed ? rgb(80, 220, 120) : (n > 0 ? FG_WHITE : FG_DIM);
  M5.Display.startWrite();
  M5.Display.fillRect(156, 0, M5.Display.width() - 156, 36, BG_DARK);
  drawText(s, M5.Display.width() - 4, 12, &fonts::efontKR_16_b, 1, color, BG_DARK, top_right, 80);
  M5.Display.endWrite();
}

static void startSetupMode() {
  setupMode = true;
  M5.Power.setLed(0);
  M5.Display.startWrite();
  M5.Display.fillScreen(BG_DARK);
  drawText("와이파이 찾는 중", M5.Display.width() / 2, M5.Display.height() / 2, &fonts::efontKR_16_b, 1, FG_WARN, BG_DARK, middle_center, 0);
  M5.Display.endWrite();

  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  int found = WiFi.scanNetworks();
  scanOptions = "";
  for (int i = 0; i < found; i++) {
    String s = WiFi.SSID(i);
    if (s.length() == 0 || scanOptions.indexOf(String("value=\"") + htmlEscape(s) + "\"") >= 0) continue;
    scanOptions += String("<option value=\"") + htmlEscape(s) + "\"" + (s == cfg.ssid ? " selected" : "") + ">" + htmlEscape(s) + " (" +
                   WiFi.RSSI(i) + "dBm)</option>";
  }
  if (scanOptions.length() == 0) scanOptions = "<option value=\"\">(찾은 와이파이 없음)</option>";
  WiFi.scanDelete();

  const String ap = apName();
  const IPAddress apIp = SETUP_AP_IP;
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIp, apIp, IPAddress(255, 255, 255, 0));
  WiFi.softAP(ap.c_str(), SETUP_AP_PASSWORD);
  WiFi.softAPConfig(apIp, apIp, IPAddress(255, 255, 255, 0));
  offerDnsOnAp(apIp);
  delay(200);
  dns.start(53, "*", apIp);
  Serial.printf("[setup] 설정 와이파이 %s 시작 · http://%s\n", ap.c_str(), WiFi.softAPIP().toString().c_str());
  web.on("/", HTTP_GET, handleRoot);
  web.on("/save", HTTP_POST, handleSave);
  web.onNotFound(handleRedirect);
  web.begin();

  M5.Display.startWrite();
  M5.Display.fillScreen(BG_DARK);
  drawText("설정 모드", 8, 4, &fonts::efontKR_16_b, 2, FG_WARN, BG_DARK, top_left, 0);
  drawText("1. 폰 와이파이 연결", 8, 40, &fonts::efontKR_16_b, 1, FG_WHITE, BG_DARK, top_left, M5.Display.width() - 16);
  drawText(ap, 8, 58, &fonts::FreeSansBold9pt7b, 1, FG_WHITE, BG_DARK, top_left, M5.Display.width() - 16);
  drawText(String("비밀번호 ") + SETUP_AP_PASSWORD, 8, 75, &fonts::efontKR_16_b, 1, FG_WARN, BG_DARK, top_left, M5.Display.width() - 16);
  drawText("2. 안 뜨면 주소창에", 8, 96, &fonts::efontKR_16_b, 1, FG_WHITE, BG_DARK, top_left, M5.Display.width() - 16);
  drawText(String("http://") + WiFi.softAPIP().toString(), 8, 114, &fonts::FreeSansBold9pt7b, 1, FG_WHITE, BG_DARK, top_left, 0);
  M5.Display.endWrite();
  drawSetupStatus(true);
}

// ─────────────────────────────── 시작 · 반복 ───────────────────────────────

void setup() {
  auto m5cfg = M5.config();
  m5cfg.serial_baudrate = 115200;  // USB 로 진행 기록 보기 (esptool-js 의 Console)
  M5.begin(m5cfg);
  Serial.printf("\n[CamCue Tally] v%s\n", FW_VERSION);
  M5.BtnB.setHoldThresh(2000);
  initColors();
  loadSettings();
  applyRotation();
  M5.Display.setBrightness(220);
  updateBattery(true);

  bool holdB = false;
  for (int i = 0; i < 5; i++) {
    M5.update();
    holdB = holdB || M5.BtnB.isPressed();
    delay(10);
  }
  bool wantSetup = takeSetupRequest() || holdB || cfg.ssid.length() == 0;
  if (wantSetup) {
    startSetupMode();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // 탈리 지연을 줄인다 (배터리는 더 쓴다)
  WiFi.setAutoReconnect(true);
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  render(true);
}

void loop() {
  M5.update();

  if (setupMode) {
    dns.processNextRequest();
    web.handleClient();
    if (millis() - setupStatusAt > 500) {
      setupStatusAt = millis();
      drawSetupStatus(false);
    }
    if (restartAt && static_cast<int32_t>(millis() - restartAt) >= 0) ESP.restart();
    if (M5.BtnA.wasClicked() && cfg.ssid.length() > 0) ESP.restart();  // 저장하지 않고 나가기
    M5.delay(2);
    return;
  }

  if (M5.BtnA.wasClicked()) {
    cfg.cam = cfg.cam % MAX_CAM + 1;
    saveSettings();
    reconnectNow();
    render(true);
  }
  if (M5.BtnB.wasHold()) {
    requestSetupOnBoot(true);
    ESP.restart();
  }
  if (M5.BtnB.wasClicked()) {
    cfg.flip = !cfg.flip;
    saveSettings();
    applyRotation();
    render(true);
  }

  runLoop();
  updateBattery(false);
  render(false);
  M5.delay(5);
}
