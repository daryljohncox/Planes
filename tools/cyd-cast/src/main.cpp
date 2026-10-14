// PlaneCast CYD: keeps the plane map cast on a Google Nest Hub.
//
// The CYD holds a Cast connection open to the Hub (TLS, port 8009, the same protocol catt uses).
// Whenever the Hub goes back to its idle screen (clock / photo frame), it launches the DashCast
// receiver and loads the map. It leaves the Hub alone while another app (Spotify, YouTube…) is cast.
//
// Screen: status + "Cast now" and "Pause" buttons. Hold the BOOT button 3 s to redo Wi-Fi setup.
// First boot: join the "PlaneCast-Setup" Wi-Fi from a phone and pick your home Wi-Fi.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>

// ---------- settings (defaults; changeable on the Wi-Fi setup page) ----------
static String mapUrl = "https://planes-steel.vercel.app/";
static String hubIp = "10.0.0.75";          // tried first; otherwise the Hub is found by mDNS

static const char *DASHCAST_APP = "84912283";  // DashCast receiver (what catt uses for websites)
static const char *DASHCAST_NS = "urn:x-cast:com.madmod.dashcast";
static const char *BACKDROP_APP = "E8C28D3C";  // the Hub's idle photo frame / clock
static const uint32_t RECAST_DELAY_MS = 5000;  // Hub must stay idle this long before we recast
static const uint32_t RETRY_MS = 30000;        // wait after a failed cast before trying again

// ---------- CYD hardware ----------
#define XPT_IRQ 36
#define XPT_MOSI 32
#define XPT_MISO 39
#define XPT_CLK 25
#define XPT_CS 33
#define BOOT_BTN 0

TFT_eSPI tft;
SPIClass touchSpi(VSPI);
XPT2046_Touchscreen touch(XPT_CS, XPT_IRQ);
Preferences prefs;
WiFiClientSecure sock;

// ---------- state ----------
enum HubState { H_NONE, H_IDLE, H_OURS, H_OTHER };
static HubState hub = H_NONE;
static String otherApp;                 // name of the app using the Hub when it isn't us
static String hubName = "Nest Hub";
static IPAddress hubAddr;
static bool paused = false;
static bool connected = false;
static uint32_t idleSince = 0, lastRx = 0, lastPing = 0, lastStatusAsk = 0, nextTry = 0;
static uint32_t launchAt = 0;           // non-zero while we're waiting for DashCast to be ready
static String dashSession, launchOldSession;  // DashCast session now / before our launch
static bool forceLaunch = false;        // "Cast now" pressed
static int requestId = 1;
static String note;                     // small line under the status

// ---------- display ----------
#define C_BG 0x0841
#define C_ORANGE 0xFD20
#define C_GREEN 0x2EA6
#define C_GREY 0x8410
#define C_RED 0xF186

struct Btn { int x, y, w, h; };
static const Btn BTN_CAST = {10, 178, 145, 52};
static const Btn BTN_PAUSE = {165, 178, 145, 52};

static void drawBtn(const Btn &b, const char *label, uint16_t fill) {
  tft.fillRoundRect(b.x, b.y, b.w, b.h, 10, fill);
  tft.setTextColor(TFT_WHITE, fill);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(label, b.x + b.w / 2, b.y + b.h / 2, 4);
}

static String lastDrawn;
static void draw(bool force = false) {
  String big, small;
  uint16_t col = TFT_WHITE;
  if (WiFi.status() != WL_CONNECTED) { big = "No Wi-Fi"; col = C_RED; small = "Reconnecting..."; }
  else if (!connected) { big = "Finding Hub"; col = C_GREY; small = hubIp.length() ? "Trying " + hubIp : "Searching the network"; }
  else if (paused) { big = "Paused"; col = C_GREY; small = "Tap Resume to keep the map up"; }
  else if (hub == H_OURS) { big = "Map is on"; col = C_GREEN; small = hubName; }
  else if (hub == H_OTHER) { big = "Hub busy"; col = C_ORANGE; small = otherApp + " is playing"; }
  else if (launchAt) { big = "Casting..."; col = C_ORANGE; small = hubName; }
  else { big = "Hub idle"; col = C_ORANGE; small = "Casting the map shortly"; }
  if (note.length()) small = note;
  String key = big + "|" + small + (paused ? "|P" : "|");
  if (!force && key == lastDrawn) return;
  lastDrawn = key;

  tft.fillScreen(C_BG);
  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(C_GREY, C_BG);
  tft.drawString("Plane map -> Nest Hub", 12, 10, 2);
  tft.setTextDatum(MC_DATUM);
  tft.setTextColor(col, C_BG);
  tft.drawString(big, 160, 80, 4);
  tft.setTextColor(TFT_WHITE, C_BG);
  tft.drawString(small, 160, 120, 2);
  if (connected) {
    tft.setTextColor(C_GREY, C_BG);
    tft.drawString(hubAddr.toString(), 160, 145, 2);
  }
  drawBtn(BTN_CAST, "Cast now", 0x3186);
  drawBtn(BTN_PAUSE, paused ? "Resume" : "Pause", paused ? C_GREEN : 0x3186);
}

// ---------- Cast protocol: protobuf CastMessage, length-prefixed ----------
static void pbVarint(String &o, uint32_t v) {
  while (v >= 0x80) { o += char((v & 0x7F) | 0x80); v >>= 7; }
  o += char(v);
}
static void pbString(String &o, int field, const String &s) {
  o += char((field << 3) | 2);
  pbVarint(o, s.length());
  o += s;
}

static bool castSend(const String &dest, const char *ns, const String &json) {
  String m;
  m += char(0x08); m += char(0);            // protocol_version = CASTV2_1_0
  pbString(m, 2, "sender-0");
  pbString(m, 3, dest);
  pbString(m, 4, ns);
  m += char(0x28); m += char(0);            // payload_type = STRING
  pbString(m, 6, json);
  uint32_t n = m.length();
  uint8_t hdr[4] = {uint8_t(n >> 24), uint8_t(n >> 16), uint8_t(n >> 8), uint8_t(n)};
  if (sock.write(hdr, 4) != 4) return false;
  return sock.write((const uint8_t *)m.c_str(), n) == n;
}

static void sendReceiver(JsonDocument &d) {
  d["requestId"] = requestId++;
  String s; serializeJson(d, s);
  castSend("receiver-0", "urn:x-cast:com.google.cast.receiver", s);
}

static void askStatus() {
  JsonDocument d; d["type"] = "GET_STATUS";
  sendReceiver(d);
  lastStatusAsk = millis();
}

static void launchDashcast() {
  Serial.println("Launching DashCast");
  JsonDocument d; d["type"] = "LAUNCH"; d["appId"] = DASHCAST_APP;
  sendReceiver(d);
  launchAt = millis();
  launchOldSession = dashSession;  // when relaunching, wait for the new session, not the old one
}

static void loadMap(const String &transportId, const String &sessionId) {
  Serial.println("Loading " + mapUrl);
  castSend(transportId, "urn:x-cast:com.google.cast.tp.connection", "{\"type\":\"CONNECT\"}");
  JsonDocument d;
  d["url"] = mapUrl;
  d["force"] = true;  // navigate the receiver to the page (as catt does), not an iframe
  d["reload"] = false;
  d["reload_time"] = 0;
  d["requestId"] = requestId++;
  d["sessionId"] = sessionId;
  String s; serializeJson(d, s);
  castSend(transportId, DASHCAST_NS, s);
}

// RECEIVER_STATUS: decide whether the Hub is idle, showing our map, or busy with something else.
static void onReceiverStatus(JsonDocument &d) {
  JsonArray apps = d["status"]["applications"].as<JsonArray>();
  HubState s = H_IDLE;
  dashSession = "";
  for (JsonObject a : apps) {
    String id = a["appId"] | "";
    if (a["isIdleScreen"] | false || id == BACKDROP_APP) continue;
    if (id == DASHCAST_APP) {
      s = H_OURS;
      String st = a["statusText"] | "";
      dashSession = a["sessionId"] | "";
      if (launchAt && st == "Application ready" && dashSession != launchOldSession) {
        loadMap(a["transportId"] | "", a["sessionId"] | "");
        launchAt = 0;
        note = "";
      }
    } else {
      s = H_OTHER;
      otherApp = a["displayName"] | "Another app";
    }
  }
  if (s == H_IDLE && hub != H_IDLE) idleSince = millis();
  if (s != H_OURS && s != H_IDLE) launchAt = 0;
  hub = s;
}

static uint8_t rxBuf[8192];
static bool readExact(uint8_t *p, size_t n) {
  uint32_t t0 = millis();
  while (n) {
    int r = sock.read(p, n);
    if (r > 0) { p += r; n -= r; t0 = millis(); }
    else if (!sock.connected() || millis() - t0 > 3000) return false;
    else delay(1);
  }
  return true;
}

// Reads one message if any is waiting. Only the fields we need are decoded.
static void castPoll() {
  while (sock.available() >= 4) {
    uint8_t hdr[4];
    if (!readExact(hdr, 4)) { sock.stop(); return; }
    uint32_t n = (uint32_t(hdr[0]) << 24) | (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
    if (n > sizeof(rxBuf)) {                // too big for us: skip it
      while (n) { uint8_t junk[256]; size_t k = min<size_t>(n, sizeof junk); if (!readExact(junk, k)) { sock.stop(); return; } n -= k; }
      continue;
    }
    if (!readExact(rxBuf, n)) { sock.stop(); return; }
    lastRx = millis();
    String ns, payload, src;
    size_t i = 0;
    while (i < n) {
      uint8_t tag = rxBuf[i++];
      int field = tag >> 3, wt = tag & 7;
      uint32_t v = 0; int sh = 0;
      if (wt == 0) { while (i < n) { uint8_t b = rxBuf[i++]; v |= uint32_t(b & 0x7F) << sh; sh += 7; if (!(b & 0x80)) break; } continue; }
      if (wt != 2) break;
      while (i < n) { uint8_t b = rxBuf[i++]; v |= uint32_t(b & 0x7F) << sh; sh += 7; if (!(b & 0x80)) break; }
      if (i + v > n) break;
      String s; s.reserve(v);
      for (uint32_t k = 0; k < v; k++) s += char(rxBuf[i + k]);
      if (field == 2) src = s; else if (field == 4) ns = s; else if (field == 6) payload = s;
      i += v;
    }
    if (ns.endsWith("tp.heartbeat")) {
      if (payload.indexOf("PING") >= 0) castSend(src, "urn:x-cast:com.google.cast.tp.heartbeat", "{\"type\":\"PONG\"}");
      continue;
    }
    if (ns.endsWith("tp.connection") && payload.indexOf("CLOSE") >= 0 && src == "receiver-0") { sock.stop(); return; }
    if (ns.endsWith("com.google.cast.receiver")) {
      JsonDocument d;
      if (deserializeJson(d, payload)) continue;
      String type = d["type"] | "";
      if (type == "RECEIVER_STATUS") onReceiverStatus(d);
      else if (type == "LAUNCH_ERROR") { Serial.println("Launch error: " + payload); launchAt = 0; nextTry = millis() + RETRY_MS; note = "Hub refused, retrying soon"; }
    }
  }
}

// ---------- finding and connecting to the Hub ----------
static bool findHub() {
  IPAddress ip;
  if (hubIp.length() && ip.fromString(hubIp)) {
    WiFiClient probe;
    if (probe.connect(ip, 8009, 2000)) { probe.stop(); hubAddr = ip; return true; }
  }
  int n = MDNS.queryService("googlecast", "tcp");
  int pick = -1;
  for (int i = 0; i < n; i++) {
    String md = MDNS.txt(i, "md");
    if (pick < 0 || md.indexOf("Hub") >= 0) pick = i;   // prefer a Nest Hub over speakers / TVs
    if (md.indexOf("Hub") >= 0) break;
  }
  if (pick < 0) return false;
  hubAddr = MDNS.IP(pick);
  String fn = MDNS.txt(pick, "fn");
  if (fn.length()) hubName = fn;
  return true;
}

static uint32_t nextConnect = 0;
static void castConnect() {
  if (millis() < nextConnect) return;
  nextConnect = millis() + 10000;
  if (!findHub()) { Serial.println("Hub not found"); return; }
  sock.setInsecure();                          // Cast devices use self-signed certificates
  if (!sock.connect(hubAddr, 8009, 5000)) { Serial.println("TLS connect failed"); return; }
  castSend("receiver-0", "urn:x-cast:com.google.cast.tp.connection", "{\"type\":\"CONNECT\"}");
  connected = true;
  hub = H_NONE;
  lastRx = lastPing = millis();
  askStatus();
  Serial.println("Connected to " + hubAddr.toString());
}

// ---------- Wi-Fi setup ----------
static void wifiSetup(bool forcePortal) {
  WiFiManager wm;
  WiFiManagerParameter pUrl("url", "Map address", mapUrl.c_str(), 200);
  WiFiManagerParameter pIp("hub", "Nest Hub IP (blank = find it)", hubIp.c_str(), 40);
  wm.addParameter(&pUrl);
  wm.addParameter(&pIp);
  bool saved = false;
  wm.setSaveParamsCallback([&]() { saved = true; });
  wm.setSaveConfigCallback([&]() { saved = true; });
  wm.setConfigPortalTimeout(600);
  wm.setAPCallback([](WiFiManager *) {
    tft.fillScreen(C_BG);
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(C_ORANGE, C_BG);
    tft.drawString("Wi-Fi setup", 160, 50, 4);
    tft.setTextColor(TFT_WHITE, C_BG);
    tft.drawString("On your phone, join the Wi-Fi", 160, 100, 2);
    tft.drawString("PlaneCast-Setup", 160, 128, 4);
    tft.drawString("then pick your home Wi-Fi.", 160, 156, 2);
    tft.setTextColor(C_GREY, C_BG);
    tft.drawString("If no page opens, go to 192.168.4.1", 160, 200, 2);
  });
  bool ok = forcePortal ? wm.startConfigPortal("PlaneCast-Setup") : wm.autoConnect("PlaneCast-Setup");
  if (saved) {
    mapUrl = pUrl.getValue();
    hubIp = pIp.getValue();
    mapUrl.trim(); hubIp.trim();
    prefs.putString("url", mapUrl);
    prefs.putString("hub", hubIp);
  }
  if (!ok) ESP.restart();
}

// ---------- touch ----------
static bool hit(const Btn &b, int x, int y) { return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h; }

static void handleTouch() {
  static uint32_t lastTap = 0;
  if (!touch.tirqTouched() || !touch.touched()) return;
  if (millis() - lastTap < 400) return;
  lastTap = millis();
  TS_Point p = touch.getPoint();
  int x = map(p.x, 200, 3700, 0, 320), y = map(p.y, 240, 3800, 0, 240);
  if (hit(BTN_PAUSE, x, y)) {
    paused = !paused;
    note = "";
    if (!paused) idleSince = millis() - RECAST_DELAY_MS;  // recast straight away if idle
  } else if (hit(BTN_CAST, x, y)) {
    paused = false;
    forceLaunch = true;
  }
  draw(true);
}

void setup() {
  Serial.begin(115200);
  pinMode(BOOT_BTN, INPUT_PULLUP);
  tft.init();
  tft.setRotation(1);
  touchSpi.begin(XPT_CLK, XPT_MISO, XPT_MOSI, XPT_CS);
  touch.begin(touchSpi);
  touch.setRotation(1);

  prefs.begin("planecast", false);
  mapUrl = prefs.getString("url", mapUrl);
  hubIp = prefs.getString("hub", hubIp);

  WiFi.setHostname("planecast-cyd");
  wifiSetup(false);
  MDNS.begin("planecast-cyd");
  draw(true);
}

void loop() {
  // Hold BOOT for 3 s: redo Wi-Fi / settings setup
  static uint32_t bootDown = 0;
  if (digitalRead(BOOT_BTN) == LOW) {
    if (!bootDown) bootDown = millis();
    if (millis() - bootDown > 3000) { sock.stop(); wifiSetup(true); ESP.restart(); }
  } else bootDown = 0;

  handleTouch();

  if (WiFi.status() != WL_CONNECTED) { connected = false; draw(); delay(200); return; }

  if (!connected || !sock.connected()) {
    if (connected) Serial.println("Lost Hub connection");
    connected = false;
    sock.stop();
    castConnect();
    draw();
    return;
  }

  castPoll();
  uint32_t now = millis();
  if (now - lastPing > 5000) { castSend("receiver-0", "urn:x-cast:com.google.cast.tp.heartbeat", "{\"type\":\"PING\"}"); lastPing = now; }
  if (now - lastStatusAsk > 30000) askStatus();
  if (now - lastRx > 20000) { Serial.println("Hub went quiet"); sock.stop(); connected = false; return; }
  if (launchAt && now - launchAt > 20000) { launchAt = 0; nextTry = now + RETRY_MS; note = "Cast didn't start, retrying soon"; }

  bool idleLongEnough = hub == H_IDLE && now - idleSince > RECAST_DELAY_MS;
  if (forceLaunch && !launchAt) { forceLaunch = false; note = ""; launchDashcast(); }
  else if (!paused && !launchAt && idleLongEnough && (int32_t)(now - nextTry) >= 0) launchDashcast();

  draw();
  delay(10);
}
