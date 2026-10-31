// ─── Haunt Ctrl — PIR early-warning sensor (ESP32) ────────────────────────────
//
// One PIR on an ESP32. When it sees someone coming, it tells the server
// (POST /api/sensor/trigger {zone:"street"}), and Lily starts writing and
// voicing her greeting before the guests reach her. Every 10 s it sends a
// heartbeat (POST /api/sensor/heartbeat) so the server knows the board is
// alive — it marks the board offline after 30 s without one.
//
// Wiring (HC-SR501 style PIR):
//   PIR VCC -> ESP32 5V (VIN)     PIR GND -> ESP32 GND     PIR OUT -> GPIO 27
// The PIR's two knobs: Sx = sensitivity/range, Tx = how long OUT stays high.
// Set Tx near minimum (fully counter-clockwise) and the jumper to "H"
// (repeat trigger) — this sketch does its own cooldown.
//
// Wi-Fi name/password go in secrets.h (copy secrets.example.h; never commit it).
// Board: "ESP32 Dev Module". Serial monitor at 115200 shows what it's doing.

#include <WiFi.h>
#include <HTTPClient.h>
#include "secrets.h"            // WIFI_SSID, WIFI_PASS

// ── Settings ──────────────────────────────────────────────────────────────────
const char* SERVER = "http://192.168.1.118:3000";   // haunt-ctrl server
const char* ZONE = "street";          // early warning: Lily prepares her greeting
const int PIR_PIN = 27;
const int LED_PIN = 2;                // on-board blue LED: blinks on each trigger
const unsigned long WARMUP_MS = 60000;      // PIRs false-trigger for ~1 min after power-up
const unsigned long COOLDOWN_MS = 20000;    // one alert per group, not one per step
const unsigned long HEARTBEAT_MS = 10000;
const unsigned long WIFI_RETRY_MS = 5000;

unsigned long bootAt = 0, lastTrigger = 0, lastBeat = 0, lastWifiTry = 0;
bool lastPir = false;

bool post(const char* path, const String& body) {
  if (WiFi.status() != WL_CONNECTED) return false;
  HTTPClient http;
  http.setTimeout(3000);
  http.begin(String(SERVER) + path);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  http.end();
  return code >= 200 && code < 300;
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < WIFI_RETRY_MS) return;
  lastWifiTry = millis();
  Serial.println("Wi-Fi: connecting...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void blink(int times) {
  for (int i = 0; i < times; i++) { digitalWrite(LED_PIN, HIGH); delay(80); digitalWrite(LED_PIN, LOW); delay(80); }
}

void setup() {
  Serial.begin(115200);
  pinMode(PIR_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);               // stay responsive; sleep adds latency to the first POST
  WiFi.setAutoReconnect(true);
  bootAt = millis();
  lastWifiTry = millis() - WIFI_RETRY_MS;
  ensureWifi();
  Serial.println("PIR warming up (60 s)...");
}

void loop() {
  ensureWifi();
  static bool announced = false;
  if (WiFi.status() == WL_CONNECTED && !announced) {
    announced = true;
    Serial.print("Wi-Fi connected, IP "); Serial.println(WiFi.localIP());
    blink(3);
  }
  if (WiFi.status() != WL_CONNECTED) announced = false;

  unsigned long now = millis();
  if (now - lastBeat >= HEARTBEAT_MS) {
    lastBeat = now;
    post("/api/sensor/heartbeat", "{\"board\":\"pir-early-warning\"}");
  }

  bool pir = digitalRead(PIR_PIN) == HIGH;
  if (pir && !lastPir) {                                  // rising edge = someone new
    if (now - bootAt < WARMUP_MS) {
      Serial.println("motion ignored (warming up)");
    } else if (now - lastTrigger < COOLDOWN_MS) {
      Serial.println("motion ignored (cooldown)");
    } else {
      lastTrigger = now;
      bool ok = post("/api/sensor/trigger", String("{\"zone\":\"") + ZONE + "\"}");
      Serial.println(ok ? "MOTION -> server told" : "MOTION -> server unreachable");
      blink(ok ? 1 : 5);
    }
  }
  lastPir = pir;
  delay(20);
}
