/**
 * NeoLuma — Neonatal Phototherapy Optical Monitoring Prototype
 * ESP32 Firmware
 * File: esp32/NeoLuma_ESP32.cpp
 *
 * Framework: Arduino (ESP32 Arduino Core)
 * IDE:       Arduino IDE or PlatformIO
 *
 * Receives serial commands from the NeoLuma web dashboard:
 *   PHOTO_ON   — Activate phototherapy relay
 *   PHOTO_OFF  — Deactivate phototherapy relay
 *   LED_ON     — Turn on all four measurement LEDs
 *   LED_OFF    — Turn off all four measurement LEDs
 *
 * Sends JSON sensor readings every ~800 ms:
 *   {"ldr1":NNN,"ldr2":NNN,"ldr3":NNN,"ldr4":NNN,"photo":0|1,"led":0|1}
 *
 * Hardware:
 *   - 4 x LDR sensor modules (analog input)
 *   - 2 x Red LEDs, 1 x Green LED, 1 x Blue LED
 *     (driven via transistor/MOSFET — NOT directly from GPIO)
 *   - 1 x Relay module controlling the central simulated phototherapy light
 *   - Buck converter provides LED supply voltage
 *   - Current-limiting resistors on each LED branch
 *
 * IMPORTANT: Adjust pin definitions below to match your actual wiring.
 */

#include <Arduino.h>

/* ============================================================
   PIN DEFINITIONS — Adjust to match your wiring
   ============================================================ */

// BPW34 Photodiode inputs (Primary sensors)
// Assigned to available ADC2 pins since Wi-Fi is not being used
#define PD1_PIN     27    // BPW34 Photodiode 1
#define PD2_PIN     14    // BPW34 Photodiode 2

// LDR Sensor inputs (Secondary sensors - analog input)
// ESP32 ADC1 channels are recommended
#define LDR1_PIN    34    // LDR 1 — paired with Red LED 1
#define LDR2_PIN    35    // LDR 2 — paired with Green LED
#define LDR3_PIN    32    // LDR 3 — paired with Red LED 2
#define LDR4_PIN    33    // LDR 4 — paired with Blue LED

// Measurement LED relay output (digital — connects to relay module IN pin)
// All four measurement LEDs are switched by this single relay.
#define LED_DRIVER_PIN   26   // Output to measurement LED relay module IN pin

// Phototherapy relay output
#define PHOTO_RELAY_PIN  25   // Output to relay module IN pin

/* ============================================================
   RELAY CONFIGURATION
   Most relay modules are active-LOW (LOW = relay energised).
   Change to HIGH/LOW if your specific module uses active-HIGH logic.
   ============================================================ */

// Phototherapy relay (controls main simulated light)
#define RELAY_ACTIVE_STATE        LOW    // Change to HIGH if your relay is active-HIGH
#define RELAY_INACTIVE_STATE      HIGH   // Change to LOW  if your relay is active-HIGH

// Measurement LED relay (controls all 4 measurement LEDs)
#define LED_RELAY_ACTIVE_STATE    LOW    // Change to HIGH if your relay is active-HIGH
#define LED_RELAY_INACTIVE_STATE  HIGH   // Change to LOW  if your relay is active-HIGH

/* ============================================================
   TIMING CONFIGURATION
   ============================================================ */
#define SEND_INTERVAL_MS   800   // How often to send JSON over serial (ms)
#define LDR_SAMPLES        5     // Number of ADC samples to average per reading

/* ============================================================
   SERIAL CONFIGURATION
   Must match NeoLuma website (baud rate: 115200)
   ============================================================ */
#define SERIAL_BAUD_RATE  115200

/* ============================================================
   GLOBAL STATE
   ============================================================ */
bool photoOn = false;   // Is the phototherapy relay currently active?
bool ledOn   = false;   // Are the measurement LEDs currently on?

unsigned long lastSendTime = 0;  // Timestamp of last JSON send

String serialInputBuffer = "";   // Buffer for incoming serial command characters

/* ============================================================
   FUNCTION DECLARATIONS
   ============================================================ */
void initPins();
void processSerialCommand(const String& cmd);
void setPhotoRelay(bool on);
void setMeasurementLEDs(bool on);
int readLDR(int pin);
void sendSensorJSON();

/* ============================================================
   SETUP
   ============================================================ */
void setup() {
  // Initialize serial communication at 115200 baud
  Serial.begin(SERIAL_BAUD_RATE);

  // Small startup delay for serial to stabilize
  delay(200);

  // Configure all hardware pins
  initPins();

  // Ensure relay and LEDs start in OFF state
  setPhotoRelay(false);
  setMeasurementLEDs(false);

  // Send a startup message (non-JSON — will be ignored by JS parser)
  // Comment this out if you want a pure JSON stream
  Serial.println("# NeoLuma ESP32 Ready");
}

/* ============================================================
   MAIN LOOP
   ============================================================ */
void loop() {
  // --- Read and process incoming serial commands ---
  while (Serial.available() > 0) {
    char c = (char)Serial.read();

    if (c == '\n' || c == '\r') {
      // End of command line — process it
      serialInputBuffer.trim();
      if (serialInputBuffer.length() > 0) {
        processSerialCommand(serialInputBuffer);
      }
      serialInputBuffer = "";
    } else {
      // Accumulate characters
      serialInputBuffer += c;
      // Guard against buffer overflow from garbage input
      if (serialInputBuffer.length() > 64) {
        serialInputBuffer = "";
      }
    }
  }

  // --- Send sensor readings at regular intervals ---
  unsigned long now = millis();
  if (now - lastSendTime >= SEND_INTERVAL_MS) {
    lastSendTime = now;
    sendSensorJSON();
  }
}

/* ============================================================
   HARDWARE INITIALIZATION
   ============================================================ */

/**
 * Configure all GPIO pins.
 * LDR pins are analog inputs — no pinMode needed for ESP32 analogRead,
 * but we set them as INPUT for clarity.
 */
void initPins() {
  analogReadResolution(12); // 0-4095

  // Primary Photodiode pins
  analogSetPinAttenuation(PD1_PIN, ADC_11db);
  analogSetPinAttenuation(PD2_PIN, ADC_11db);
  pinMode(PD1_PIN, INPUT);
  pinMode(PD2_PIN, INPUT);

  // LDR sensor pins (analog input)
  pinMode(LDR1_PIN, INPUT);
  pinMode(LDR2_PIN, INPUT);
  pinMode(LDR3_PIN, INPUT);
  pinMode(LDR4_PIN, INPUT);

  // Measurement LED relay output
  pinMode(LED_DRIVER_PIN, OUTPUT);
  digitalWrite(LED_DRIVER_PIN, LED_RELAY_INACTIVE_STATE);  // LEDs off at startup

  // Phototherapy relay output
  pinMode(PHOTO_RELAY_PIN, OUTPUT);
  digitalWrite(PHOTO_RELAY_PIN, RELAY_INACTIVE_STATE);  // Relay off at startup
}

/* ============================================================
   SERIAL COMMAND PROCESSING
   ============================================================ */

/**
 * Process a single text command received from the website.
 * Recognized commands (must match JavaScript exactly):
 *   PHOTO_ON   — Activate phototherapy relay
 *   PHOTO_OFF  — Deactivate phototherapy relay
 *   LED_ON     — Turn on measurement LEDs
 *   LED_OFF    — Turn off measurement LEDs
 *
 * @param cmd  The trimmed command string
 */
void processSerialCommand(const String& cmd) {
  if (cmd == "PHOTO_ON") {
    setPhotoRelay(true);

  } else if (cmd == "PHOTO_OFF") {
    setPhotoRelay(false);

  } else if (cmd == "LED_ON") {
    setMeasurementLEDs(true);

  } else if (cmd == "LED_OFF") {
    setMeasurementLEDs(false);

  }
  // Unknown commands are silently ignored
}

/* ============================================================
   RELAY CONTROL
   ============================================================ */

/**
 * Set the phototherapy relay state.
 * Uses RELAY_ACTIVE_STATE / RELAY_INACTIVE_STATE so this works
 * with both active-HIGH and active-LOW relay modules.
 *
 * @param on  true = relay energised (light ON), false = relay off (light OFF)
 */
void setPhotoRelay(bool on) {
  photoOn = on;
  digitalWrite(PHOTO_RELAY_PIN, on ? RELAY_ACTIVE_STATE : RELAY_INACTIVE_STATE);
}

/* ============================================================
   LED CONTROL
   ============================================================ */

/**
 * Enable or disable all four measurement LEDs via the relay module.
 * Uses LED_RELAY_ACTIVE_STATE / LED_RELAY_INACTIVE_STATE so this works
 * with both active-HIGH and active-LOW relay modules.
 *
 * @param on  true = relay energised (LEDs ON), false = relay off (LEDs OFF)
 */
void setMeasurementLEDs(bool on) {
  ledOn = on;
  digitalWrite(LED_DRIVER_PIN, on ? LED_RELAY_ACTIVE_STATE : LED_RELAY_INACTIVE_STATE);
}

/* ============================================================
   LDR READING
   ============================================================ */

/**
 * Read an LDR value from an analog pin.
 * Takes multiple samples and returns the average to reduce noise.
 * Returns raw 12-bit ADC value (0–4095). No lux conversion.
 *
 * @param pin  GPIO pin number
 * @return     Averaged ADC reading (0–4095)
 */
int readLDR(int pin) {
  long sum = 0;
  for (int i = 0; i < LDR_SAMPLES; i++) {
    sum += analogRead(pin);
    delay(2);   // Small delay between samples to reduce ADC noise
  }
  return (int)(sum / LDR_SAMPLES);
}

/* ============================================================
   JSON SERIAL OUTPUT
   ============================================================ */

/**
 * Read all sensors and send a JSON packet over Serial.
 * Format (must match JavaScript parser exactly):
 *   {"pd1":NNN,"pd2":NNN,"ldr1":NNN,"ldr2":NNN,"ldr3":NNN,"ldr4":NNN,"photo":0|1,"led":0|1}
 *
 * The JSON is sent as a single line followed by '\n'.
 * The JavaScript readSerialData() function splits on '\n' to extract lines.
 */
void sendSensorJSON() {
  // Read primary photodiode sensors
  int p1 = readLDR(PD1_PIN);
  int p2 = readLDR(PD2_PIN);

  // Read secondary LDR sensors
  int v1 = readLDR(LDR1_PIN);
  int v2 = readLDR(LDR2_PIN);
  int v3 = readLDR(LDR3_PIN);
  int v4 = readLDR(LDR4_PIN);

  // Build JSON string manually (no library dependency)
  Serial.print("{");
  Serial.print("\"pd1\":"); Serial.print(p1); Serial.print(",");
  Serial.print("\"pd2\":"); Serial.print(p2); Serial.print(",");
  Serial.print("\"ldr1\":"); Serial.print(v1); Serial.print(",");
  Serial.print("\"ldr2\":"); Serial.print(v2); Serial.print(",");
  Serial.print("\"ldr3\":"); Serial.print(v3); Serial.print(",");
  Serial.print("\"ldr4\":"); Serial.print(v4); Serial.print(",");
  Serial.print("\"photo\":"); Serial.print(photoOn ? 1 : 0); Serial.print(",");
  Serial.print("\"led\":");   Serial.print(ledOn   ? 1 : 0);
  Serial.println("}");
}
