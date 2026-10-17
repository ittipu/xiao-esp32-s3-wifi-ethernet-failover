/*
 * ============================================================================
 *  IoT Bhai — WiFi -> Ethernet Failover MQTT Node
 *  XIAO ESP32-S3 (PoE board) + W5500 (native ETH.h)
 * ----------------------------------------------------------------------------
 *  Story: node runs on WiFi -> you kill WiFi -> it auto-fails-over to the
 *  wired W5500 link and KEEPS publishing to MQTT without missing data.
 *
 *  Why this is clean: ETH.h registers the W5500 into the same lwIP stack as
 *  WiFi, so ONE NetworkClient routes over whichever interface is up.
 *
 *  How a switch works (applyLinkChange):
 *    1. a WiFi/ETH event flips wifi_up / eth_up and marks the link "dirty"
 *    2. loop() picks the active link (the PREFERRED one if it is up, else the
 *       other; PREFER_ETHERNET chooses which is main) and makes it lwIP's
 *       DEFAULT route, so "link" always matches reality
 *    3. only if the active link changed, it closes the old MQTT socket (it is bound to the dead
 *       route and would otherwise hang until keepalive, 15-30 s)
 *    4. MQTT reconnects over the new route within ~1-2 s, using a cached
 *       broker IP so it never waits on DNS from the dead network
 *  The publish counter only counts messages that really went out, so it
 *  never skips a number = proof on camera.
 *
 *  ON-CAMERA SEQUENCE with PREFER_ETHERNET 1 (Ethernet main, WiFi backup):
 *    1. Boot with the Ethernet cable UNPLUGGED -> node runs on WiFi
 *    2. Plug the cable in -> it moves to Ethernet (the main link) within ~2 s
 *    3. Kill the WiFi -> nothing happens: still on Ethernet, zero interruption
 *       ("I killed the WiFi and my sensor didn't care")
 *    4. Bring WiFi back, then PULL the cable -> fails over to WiFi, counter
 *       keeps climbing, MQTT Bhai keeps receiving
 *    5. Plug the cable back -> returns to Ethernet
 *
 *  SENSORS:
 *    DHT22   (temperature + humidity)  DATA -> D0   (10k pull-up to 3V3 if
 *                                       your module has none)
 *    TSL2561 (light, lux, I2C 0x39)    SDA  -> D4,  SCL -> D5
 *    Both run on 3V3 + GND.
 *
 *  Libraries: PubSubClient, "DHT sensor library" + "Adafruit Unified Sensor",
 *             "Adafruit TSL2561", U8g2 (only if USE_OLED).
 *  Board: XIAO_ESP32S3.  W5500 pins (Seeed wiki): CS=D1 SCK=D8 MISO=D9 MOSI=D10
 * ============================================================================
 */

#include <SPI.h>
#include <ETH.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <NetworkClient.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <DHT.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_TSL2561_U.h>

// ---- OLED: 128x64 I2C on D4/D5 (shares the bus with the TSL2561) ----
// OLED 0x3C, TSL2561 0x39. Set USE_OLED 0 if no display is wired.
#define USE_OLED 1
// Pick the controller. 1.3" modules are almost always SH1106; 0.96" ones are
// SSD1306. The wrong one shifts the image by 2 px: the left edge is cut off and
// a garbage line appears down the right side.
#define OLED_SH1106 1
#if USE_OLED
  #include <U8g2lib.h>
  #if OLED_SH1106
    U8G2_SH1106_128X64_NONAME_F_HW_I2C  oled(U8G2_R0, U8X8_PIN_NONE, /*SCL=*/D5, /*SDA=*/D4);
  #else
    U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, /*SCL=*/D5, /*SDA=*/D4);
  #endif
#endif

// ============================== USER CONFIG =================================

// --- WiFi ---
// Put your WiFi name/password in secrets.h (copy secrets.example.h -> secrets.h).
// secrets.h is git-ignored so your password never ends up on GitHub.
#include "secrets.h"
const char* WIFI_SSID = WIFI_SSID_SECRET;
const char* WIFI_PASS = WIFI_PASS_SECRET;

// --- MQTT (mqtt.iotbhai.io, viewed in MQTT Bhai app) ---
const char* MQTT_HOST   = "mqtt.iotbhai.io";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER   = "";                 // "" if broker is open
const char* MQTT_PASS   = "";
const char* MQTT_TOPIC  = "iotbhai/node";
const char* MQTT_CLIENT = "xiao-s3-failover";

const uint32_t PUBLISH_INTERVAL_MS = 2000;    // fast-ish so the switch is visible

// Which link is the MAIN one. 1 = Ethernet main, WiFi backup: as soon as the
// cable is plugged in the node moves to it, and it falls back to WiFi when the
// cable is pulled. 0 = WiFi main, Ethernet backup.
#define PREFER_ETHERNET 1

const char* FW_VERSION = "1.3.2";          // shown on the dashboard's node card

// WiFi-loss detection: seconds without beacons from the router before the
// node declares WiFi dead (ESP-IDF default is 6). Lower = faster failover.
const uint16_t WIFI_BEACON_TIMEOUT_S = 3;

// --- W5500 pins (confirmed from Seeed wiki demo) ---
#define ETH_PHY_TYPE  ETH_PHY_W5500
#define ETH_PHY_ADDR  1
#define ETH_PHY_CS    D1
#define ETH_PHY_IRQ   -1
#define ETH_PHY_RST   -1
#define ETH_SPI_SCK   D8
#define ETH_SPI_MISO  D9
#define ETH_SPI_MOSI  D10

// --- Sensors ---
#define DHT_PIN   D0
#define DHT_TYPE  DHT22
#define I2C_SDA   D4
#define I2C_SCL   D5

// ===========================================================================

NetworkClient netClient;              // ONE client, routed by the stack
PubSubClient  mqtt(netClient);

DHT dht(DHT_PIN, DHT_TYPE);
Adafruit_TSL2561_Unified tsl(TSL2561_ADDR_FLOAT, 2561);   // ADDR pin floating = 0x39
bool tsl_ok = false;

struct Readings {
  float temp;   // °C   (NAN if the read failed)
  float hum;    // %RH  (NAN if the read failed)
  float lux;    // lux  (NAN if the sensor is missing or saturated)
};
Readings lastR = { NAN, NAN, NAN };   // latest readings, for redrawing the OLED on a switch

volatile bool eth_up    = false;
volatile bool wifi_up   = false;
volatile bool linkDirty = false;      // set by events, handled in loop()
uint32_t pubCount = 0;

IPAddress brokerIP;                   // cached so a reconnect never needs DNS
bool      brokerIPok = false;
uint8_t   connFails  = 0;

const char* PREFERRED_LINK = PREFER_ETHERNET ? "ETH" : "WiFi";

// The active link: the preferred one if it is up, else the other one.
// applyLinkChange() makes this same interface lwIP's default route, so the
// label always matches the interface carrying the traffic.
const char* activeLink() {
#if PREFER_ETHERNET
  if (eth_up)  return "ETH";
  if (wifi_up) return "WiFi";
#else
  if (wifi_up) return "WiFi";
  if (eth_up)  return "ETH";
#endif
  return "none";
}
const char* currentLink = "none";     // the link the MQTT socket is on right now

String activeIP() {
  return strcmp(activeLink(), "ETH") == 0 ? ETH.localIP().toString() : WiFi.localIP().toString();
}

void setFlag(volatile bool& flag, bool value) {
  if (flag != value) { flag = value; linkDirty = true; }
}

// -------- unified network events (WiFi + ETH share Network.onEvent) --------
// Runs in the network event task: only set flags here, the work is in loop().
void onNetEvent(arduino_event_id_t event, arduino_event_info_t info) {
  switch (event) {
    // ---- Ethernet ----
    case ARDUINO_EVENT_ETH_START:        ETH.setHostname("iotbhai-failover"); break;
    case ARDUINO_EVENT_ETH_CONNECTED:    Serial.println("[eth] cable connected"); break;
    case ARDUINO_EVENT_ETH_GOT_IP:
      Serial.print("[eth] IP: "); Serial.println(ETH.localIP());
      setFlag(eth_up, true); break;
    case ARDUINO_EVENT_ETH_LOST_IP:
    case ARDUINO_EVENT_ETH_DISCONNECTED:
    case ARDUINO_EVENT_ETH_STOP:
      if (eth_up) Serial.println("[eth] down");
      setFlag(eth_up, false); break;

    // ---- WiFi ----
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.print("[wifi] IP: "); Serial.println(WiFi.localIP());
      setFlag(wifi_up, true); break;
    case ARDUINO_EVENT_WIFI_STA_LOST_IP:
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      if (wifi_up) Serial.println("[wifi] down");
      setFlag(wifi_up, false); break;

    default: break;
  }
}

// Called from loop() after any link change.
void applyLinkChange() {
  linkDirty = false;
  const char* link = activeLink();

  // The OTHER interface changed but the active one didn't (e.g. WiFi dropped
  // while we're on Ethernet): leave the MQTT socket alone, so zero interruption.
  if (strcmp(link, currentLink) == 0) {
    Serial.printf("[net] still on %s (wifi=%d eth=%d)\n", link, wifi_up ? 1 : 0, eth_up ? 1 : 0);
    return;
  }

  // 1. route: the chosen interface becomes lwIP's default route
  if (strcmp(link, "ETH") == 0)       Network.setDefaultInterface(ETH);
  else if (strcmp(link, "WiFi") == 0) Network.setDefaultInterface(WiFi.STA);

  // 2. the old MQTT socket is bound to the old route: close it now so we
  //    reconnect over the new one instead of hanging until keepalive expires
  netClient.stop();                    // mqtt.connected() is now false

  Serial.printf("[net] link change %s -> %s (wifi=%d eth=%d)\n",
                currentLink, link, wifi_up ? 1 : 0, eth_up ? 1 : 0);
  currentLink = link;
}

// ------------------------------- SENSORS -----------------------------------
// DHT22 can be read at most every 2 s, which matches PUBLISH_INTERVAL_MS.
Readings readSensors() {
  Readings r;
  r.temp = dht.readTemperature();
  r.hum  = dht.readHumidity();
  r.lux  = NAN;
  if (tsl_ok) {
    sensors_event_t ev;
    tsl.getEvent(&ev);
    // The Adafruit driver reports 0 for "no valid reading" and 65536 when the
    // sensor is saturated (too much light). Neither is a real value: send null.
    if (ev.light > 0 && ev.light < 65535) r.lux = ev.light;
  }
  return r;
}

// JSON has no NaN: write a failed reading as null so the dashboard shows a gap.
void jsonNum(char* out, size_t n, float v) {
  if (isnan(v)) snprintf(out, n, "null");
  else          snprintf(out, n, "%.1f", v);
}
// ---------------------------------------------------------------------------

#if USE_OLED
// 128x64 layout:
//   IoT Bhai                 #123     header: title + messages sent
//   ------------------------------
//   [       WiFi / Ethernet      ]    active link, inverted box
//   27.4°C        61%       312lx     temperature | humidity | light
//   -58 dBm            192.168.0.57   WiFi signal | IP of the active link
void drawRight(int x, int y, const char* s)  { oled.drawUTF8(x - oled.getUTF8Width(s), y, s); }
void drawCenter(int x, int y, const char* s) { oled.drawUTF8(x - oled.getUTF8Width(s) / 2, y, s); }

void drawOLED(const Readings& r) {
  char buf[24];
  oled.clearBuffer();

  // header
  oled.setFont(u8g2_font_6x10_tf);
  oled.drawUTF8(0, 9, "IoT Bhai");
  snprintf(buf, sizeof(buf), "#%lu", (unsigned long)pubCount);
  drawRight(128, 9, buf);
  oled.drawHLine(0, 12, 128);

  // active link: big and inverted so the switch is obvious on camera
  // same activeLink() as the MQTT payload and the default route, so it can't disagree
  const char* a = activeLink();
  const char* link = strcmp(a, "ETH") == 0 ? "Ethernet" : strcmp(a, "WiFi") == 0 ? "WiFi" : "Offline";
  oled.drawRBox(0, 15, 128, 21, 3);
  oled.setDrawColor(0);
  oled.setFont(u8g2_font_helvB12_tf);
  drawCenter(64, 31, link);
  oled.setDrawColor(1);

  // sensors in three aligned columns; a failed read shows "--"
  oled.setFont(u8g2_font_6x12_tf);
  if (isnan(r.temp)) snprintf(buf, sizeof(buf), "--°C");
  else               snprintf(buf, sizeof(buf), "%.1f°C", r.temp);
  oled.drawUTF8(0, 50, buf);
  if (isnan(r.hum))  snprintf(buf, sizeof(buf), "--%%");
  else               snprintf(buf, sizeof(buf), "%.0f%%", r.hum);
  drawCenter(64, 50, buf);
  if (isnan(r.lux))  snprintf(buf, sizeof(buf), "--lx");
  else               snprintf(buf, sizeof(buf), "%.0flx", r.lux);
  drawRight(128, 50, buf);

  // footer: WiFi signal + IP of the active link
  oled.setFont(u8g2_font_5x8_tf);
  if (wifi_up) snprintf(buf, sizeof(buf), "%d dBm", (int)WiFi.RSSI());
  else         snprintf(buf, sizeof(buf), "WiFi down");
  oled.drawUTF8(0, 63, buf);
  if (wifi_up || eth_up) {
    String ip = activeIP();
    drawRight(128, 63, ip.c_str());
  }

  oled.sendBuffer();
}
#endif

// Resolve the broker once and cache it. If WiFi and Ethernet sit on different
// networks, the DNS server learned from the dead link would be unreachable.
bool resolveBroker() {
  IPAddress ip;
  if (WiFi.hostByName(MQTT_HOST, ip) && ip != IPAddress(0, 0, 0, 0)) {
    brokerIP = ip;
    brokerIPok = true;
    Serial.printf("[dns] %s -> %s\n", MQTT_HOST, ip.toString().c_str());
    return true;
  }
  return false;
}

void mqttReconnect() {
  if (mqtt.connected()) return;
  if (!brokerIPok || connFails >= 3) {   // first time, or the cached IP keeps failing
    if (resolveBroker()) connFails = 0;
  }
  if (brokerIPok) mqtt.setServer(brokerIP, MQTT_PORT);
  else            mqtt.setServer(MQTT_HOST, MQTT_PORT);

  uint32_t t0 = millis();
  bool ok = (strlen(MQTT_USER) > 0)
              ? mqtt.connect(MQTT_CLIENT, MQTT_USER, MQTT_PASS)
              : mqtt.connect(MQTT_CLIENT);
  connFails = ok ? 0 : connFails + 1;
  Serial.printf("[mqtt] connect over %s : %s (%lu ms)\n",
                activeLink(), ok ? "OK" : "fail", (unsigned long)(millis() - t0));
}

void publish(const Readings& r) {
  char t[12], h[12], lx[12];
  jsonNum(t, sizeof(t), r.temp);
  jsonNum(h, sizeof(h), r.hum);
  jsonNum(lx, sizeof(lx), r.lux);

  // Node info for the dashboard: WiFi signal (null when WiFi is down), uptime,
  // the IP of the active link, and the firmware version.
  char rssi[12];
  if (wifi_up) snprintf(rssi, sizeof(rssi), "%d", (int)WiFi.RSSI());
  else         snprintf(rssi, sizeof(rssi), "null");
  String ip = activeIP();

  char payload[320];
  snprintf(payload, sizeof(payload),
    "{\"link\":\"%s\",\"temp\":%s,\"hum\":%s,\"lux\":%s,\"count\":%lu,\"wifi\":%d,\"eth\":%d,"
    "\"rssi\":%s,\"up\":%lu,\"ip\":\"%s\",\"fw\":\"%s\",\"pref\":\"%s\"}",
    activeLink(), t, h, lx, (unsigned long)(pubCount + 1),
    wifi_up ? 1 : 0, eth_up ? 1 : 0,
    rssi, (unsigned long)(millis() / 1000), ip.c_str(), FW_VERSION, PREFERRED_LINK);
  if (mqtt.publish(MQTT_TOPIC, payload)) {
    pubCount++;
    Serial.printf("[mqtt] %s\n", payload);
  } else {
    Serial.println("[mqtt] publish failed");
  }
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println("\n=== IoT Bhai - WiFi/Ethernet Failover Node ===");

  // Sensors (XIAO I2C is not the chip default: set the pins explicitly)
  Wire.begin(I2C_SDA, I2C_SCL);
  dht.begin();
  tsl_ok = tsl.begin(&Wire);
  if (tsl_ok) {
    tsl.enableAutoRange(true);                              // auto gain 1x/16x
    tsl.setIntegrationTime(TSL2561_INTEGRATIONTIME_101MS);  // speed vs resolution
    Serial.println("[tsl2561] found");
  } else {
    Serial.println("[tsl2561] NOT found - check SDA=D4, SCL=D5 and 3V3");
  }

#if USE_OLED
  oled.begin();
#endif

  mqtt.setBufferSize(512);                 // payload is ~180 bytes; default is 256 incl. header
  mqtt.setSocketTimeout(3);                // don't block the loop on a dead link
  mqtt.setKeepAlive(10);                   // (TCP connect itself times out after 3 s by default)

  Network.onEvent(onNetEvent);

  // Start Ethernet (W5500 over SPI) — will get an IP whenever a cable is present
  SPI.begin(ETH_SPI_SCK, ETH_SPI_MISO, ETH_SPI_MOSI);
  ETH.begin(ETH_PHY_TYPE, ETH_PHY_ADDR, ETH_PHY_CS, ETH_PHY_IRQ, ETH_PHY_RST, SPI);

  // Start WiFi (preferred link for the demo)
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                    // lower latency, steadier link
  WiFi.setAutoReconnect(true);             // WiFi comes back on its own
  esp_wifi_set_inactive_time(WIFI_IF_STA, WIFI_BEACON_TIMEOUT_S);   // faster loss detection
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  // wait until at least ONE link is up
  Serial.print("waiting for a link");
  while (!wifi_up && !eth_up) { delay(300); Serial.print("."); }
  Serial.printf("\nonline via %s\n", activeLink());
  applyLinkChange();                       // set the default route for the first link
}

void loop() {
  static uint32_t last = 0;

  if (linkDirty) {                         // react to a switch right away, not at the next publish
    applyLinkChange();
#if USE_OLED
    drawOLED(lastR);                       // the screen flips the moment the link changes
#endif
  }
  mqtt.loop();

  if (millis() - last >= PUBLISH_INTERVAL_MS) {
    last = millis();

    Readings r = readSensors();
    lastR = r;

    if (!wifi_up && !eth_up) {               // fully offline — nothing to do
      Serial.println("[net] no link, waiting...");
#if USE_OLED
      drawOLED(r);
#endif
      return;
    }

    mqttReconnect();                         // reconnects over the survivor after a switch
    if (mqtt.connected()) publish(r);
#if USE_OLED
    drawOLED(r);
#endif
  }
}
