// PlaneCast CYD: keeps the plane map cast on a Google Nest Hub.
//
// The CYD holds a Cast connection open to the Hub (TLS, port 8009, the same protocol catt uses).
// Whenever the Hub goes back to its idle screen (clock / photo frame), it launches the DashCast
// receiver and loads the map. It leaves the Hub alone while another app (Spotify, YouTube…) is cast.
//
// Screen: status + "Cast now" and "Pause" buttons. Hold the BOOT button 3 s to redo Wi-Fi setup.
// The same screen is served as a web page at http://<CYD IP>/ (shown top right on the CYD), so a phone
// home-screen shortcut can show the status and press the same buttons.
// First boot: join the "PlaneCast-Setup" Wi-Fi from a phone and pick your home Wi-Fi.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <ESPmDNS.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>

// ---------- settings (defaults; changeable on the Wi-Fi setup page) ----------
static String mapUrl = "https://planes-steel.vercel.app/";
static String hubIp = "10.0.0.75";          // preferred Hub; checked to really be a Nest Hub before casting

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
WebServer web(80);

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

// What the screen (and the web page) says right now
struct Status { String big, small; uint16_t col; };
static Status status() {
  Status st; st.col = TFT_WHITE;
  if (WiFi.status() != WL_CONNECTED) { st.big = "No Wi-Fi"; st.col = C_RED; st.small = "Reconnecting..."; }
  else if (!connected) { st.big = "Finding Hub"; st.col = C_GREY; st.small = "Looking for a Nest Hub"; }
  else if (paused) { st.big = "Paused"; st.col = C_GREY; st.small = "Tap Resume to put the map back"; }
  else if (hub == H_OURS) { st.big = "Map is on"; st.col = C_GREEN; st.small = hubName; }
  else if (hub == H_OTHER) { st.big = "Hub busy"; st.col = C_ORANGE; st.small = otherApp + " is playing"; }
  else if (launchAt) { st.big = "Casting..."; st.col = C_ORANGE; st.small = hubName; }
  else { st.big = "Hub idle"; st.col = C_ORANGE; st.small = "Casting the map shortly"; }
  if (note.length()) st.small = note;
  return st;
}

static String lastDrawn;
static void draw(bool force = false) {
  Status st = status();
  String big = st.big, small = st.small;
  uint16_t col = st.col;
  String key = big + "|" + small + (paused ? "|P" : "|") + WiFi.localIP().toString();
  if (!force && key == lastDrawn) return;
  lastDrawn = key;

  tft.fillScreen(C_BG);
  tft.setTextDatum(TL_DATUM);
  tft.setTextColor(C_GREY, C_BG);
  tft.drawString("Plane map -> Nest Hub", 12, 10, 2);
  if (WiFi.status() == WL_CONNECTED) {         // address of the phone page
    tft.setTextDatum(TR_DATUM);
    tft.drawString(WiFi.localIP().toString(), 308, 10, 2);
  }
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

// Takes our map off the Hub (used by Pause), so it goes back to its clock / photos.
static void stopMap() {
  if (!connected || dashSession.isEmpty()) return;
  Serial.println("Stopping DashCast");
  JsonDocument d; d["type"] = "STOP"; d["sessionId"] = dashSession;
  sendReceiver(d);
  launchAt = 0;
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
// Only ever casts to a Nest Hub (or Nest Hub Max): never to a TV, Chromecast or speaker.
// 1) mDNS: Cast devices announce their model ("md"); take a Hub, preferring the saved IP.
// 2) If mDNS finds nothing, use the saved IP only if the device there says it's a Hub
//    (its /setup/eureka_info page on port 8008). An IP that DHCP has handed to a TV is refused.
static bool isHubModel(const String &md) { return md.indexOf("Hub") >= 0; }
static String modelAt(IPAddress ip) {
  HTTPClient http;
  http.setConnectTimeout(2000);
  http.setTimeout(2000);
  if (!http.begin("http://" + ip.toString() + ":8008/setup/eureka_info?params=name,device_info")) return "";
  String model;
  if (http.GET() == 200) {
    JsonDocument d;
    if (!deserializeJson(d, http.getString())) {
      model = d["device_info"]["model_name"] | "";
      String nm = d["name"] | "";
      if (isHubModel(model) && nm.length()) hubName = nm;
    }
  }
  http.end();
  return model;
}
static bool findHub() {
  IPAddress saved;
  bool haveSaved = hubIp.length() && saved.fromString(hubIp);
  int n = MDNS.queryService("googlecast", "tcp");
  int pick = -1;
  for (int i = 0; i < n; i++) {
    if (!isHubModel(MDNS.txt(i, "md"))) continue;          // skip TVs, Chromecasts, speakers
    if (pick < 0) pick = i;
    if (haveSaved && MDNS.IP(i) == saved) { pick = i; break; }
  }
  if (pick >= 0) {
    hubAddr = MDNS.IP(pick);
    String fn = MDNS.txt(pick, "fn");
    if (fn.length()) hubName = fn;
    return true;
  }
  if (haveSaved) {
    String model = modelAt(saved);
    if (isHubModel(model)) { hubAddr = saved; return true; }
    Serial.println("Saved IP " + hubIp + " is not a Nest Hub (" + (model.length() ? model : String("no answer")) + ")");
  }
  return false;
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

// ---------- buttons (screen and web page) ----------
static void pressPause() {
  paused = !paused;
  note = "";
  if (paused && hub == H_OURS) stopMap();
  if (!paused) idleSince = millis() - RECAST_DELAY_MS;  // recast straight away if idle
}
static void pressCast() {
  paused = false;
  forceLaunch = true;
}

// ---------- phone page: same status and buttons as the screen ----------
static const char PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#081020"><meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.json"><link rel="icon" href="/icon.svg">
<title>PlaneCast</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;background:#081020;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
 display:flex;flex-direction:column;padding:16px;gap:16px}
.top{display:flex;justify-content:space-between;color:#8a8a8a;font-size:15px}
.mid{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px}
#big{font-size:44px;font-weight:700}
#small{font-size:19px}
#ip{font-size:15px;color:#8a8a8a}
.btns{display:flex;gap:14px}
button{flex:1;height:88px;border:0;border-radius:16px;background:#303030;color:#fff;font:600 26px system-ui,sans-serif}
button:active{filter:brightness(1.4)}
button.go{background:#2bd432;color:#000}
#err{color:#ff3030;text-align:center;font-size:15px;min-height:18px}
</style></head><body>
<div class="top"><span>Plane map &rarr; Nest Hub</span><span id="me"></span></div>
<div class="mid"><div id="big">&hellip;</div><div id="small"></div><div id="ip"></div></div>
<div id="err"></div>
<div class="btns"><button id="cast">Cast now</button><button id="pause">Pause</button></div>
<script>
var $=function(i){return document.getElementById(i)};
function show(s){$("big").textContent=s.big;$("big").style.color=s.color;$("small").textContent=s.small;
 $("ip").textContent=s.hubIp||"";$("me").textContent=location.host;
 $("pause").textContent=s.paused?"Resume":"Pause";$("pause").className=s.paused?"go":"";$("err").textContent=""}
function get(){fetch("/status",{cache:"no-store"}).then(function(r){return r.json()}).then(show)
 .catch(function(){$("err").textContent="Can't reach the CYD - is your phone on the home Wi-Fi?"})}
function press(w){fetch("/"+w,{method:"POST"}).then(function(r){return r.json()}).then(show).catch(get)}
$("cast").onclick=function(){press("cast")};$("pause").onclick=function(){press("pause")};
get();setInterval(get,2000);
document.addEventListener("visibilitychange",function(){if(!document.hidden)get()});
</script></body></html>)HTML";

static const char ICON[] PROGMEM = R"SVG(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#13284a"/><path transform="translate(18 18) scale(2.5)" fill="#ffd84a" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>)SVG";

static String hex565(uint16_t c) {   // screen colour -> CSS colour
  char b[8];
  snprintf(b, sizeof b, "#%02x%02x%02x", ((c >> 11) & 0x1F) * 255 / 31, ((c >> 5) & 0x3F) * 255 / 63, (c & 0x1F) * 255 / 31);
  return b;
}
static void sendStatus() {
  Status st = status();
  JsonDocument d;
  d["big"] = st.big; d["small"] = st.small; d["color"] = hex565(st.col);
  d["paused"] = paused;
  d["hubIp"] = connected ? hubAddr.toString() : "";
  String s; serializeJson(d, s);
  web.sendHeader("Cache-Control", "no-store");
  web.send(200, "application/json", s);
}
static void webSetup() {
  web.on("/", HTTP_GET, []() { web.send_P(200, "text/html", PAGE); });
  web.on("/status", HTTP_GET, sendStatus);
  web.on("/cast", HTTP_POST, []() { pressCast(); draw(true); sendStatus(); });
  web.on("/pause", HTTP_POST, []() { pressPause(); draw(true); sendStatus(); });
  web.on("/icon.svg", HTTP_GET, []() { web.sendHeader("Cache-Control", "max-age=86400"); web.send_P(200, "image/svg+xml", ICON); });
  web.on("/manifest.json", HTTP_GET, []() {
    web.send(200, "application/manifest+json",
      "{\"name\":\"PlaneCast\",\"short_name\":\"PlaneCast\",\"start_url\":\"/\",\"display\":\"standalone\","
      "\"background_color\":\"#081020\",\"theme_color\":\"#081020\","
      "\"icons\":[{\"src\":\"/icon.svg\",\"sizes\":\"any\",\"type\":\"image/svg+xml\"}]}");
  });
  web.onNotFound([]() { web.sendHeader("Location", "/"); web.send(302, "text/plain", ""); });
  web.begin();
  MDNS.addService("http", "tcp", 80);
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
  if (hit(BTN_PAUSE, x, y)) pressPause();
  else if (hit(BTN_CAST, x, y)) pressCast();
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
  webSetup();
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
  web.handleClient();

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
