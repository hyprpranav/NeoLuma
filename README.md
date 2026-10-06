# NeoLuma

**Neonatal Phototherapy Optical Monitoring Prototype**

> **Prototype Notice:** NeoLuma is an academic hardware prototype for optical monitoring demonstration.
> Sensor values are **relative optical readings** and are **not calibrated clinical measurements**.
> This system is not intended for clinical diagnosis, bilirubin measurement, or neonatal treatment decisions.

---

## Project Overview

NeoLuma is a student engineering prototype that combines:

- An **ESP32 microcontroller** reading four LDR (light-dependent resistor) sensors
- A **web dashboard** (HTML + CSS + Vanilla JavaScript) for real-time monitoring
- **Web Serial API** for USB communication between the browser and ESP32
- A **simulated phototherapy light** controlled via a relay
- **Four measurement LEDs** (Red, Green, Red, Blue) to probe the optical properties

---

## Hardware Components

| Component | Quantity | Notes |
|---|---|---|
| ESP32 development board | 1 | Any standard ESP32 devkit |
| LDR sensor modules | 4 | Analog output, one per LED channel |
| Red LED | 2 | Measurement LEDs |
| Green LED | 1 | Measurement LED |
| Blue LED | 1 | Measurement LED |
| Main simulated light | 1 | Phototherapy lamp or high-brightness LED strip |
| Relay module | 1 | Controls the main simulated light |
| Buck converter | 1 | Steps down supply for LED power |
| Current-limiting resistors | ≥4 | One per LED branch |
| Transistor / MOSFET drivers | As needed | For each LED if current exceeds ESP32 GPIO limit |
| USB cable | 1 | ESP32 to computer |

---

## LED to LDR Mapping

Each measurement LED is placed directly facing its paired LDR:

```
Red LED 1  →  LDR 1
Green LED  →  LDR 2
Red LED 2  →  LDR 3
Blue LED   →  LDR 4
```

### Physical Layout (conceptual)

```
              LDR 1
                ↑
           [ RED LED ]

LDR 4         CENTRAL        LDR 2
  ↤ [BLUE]  [ LIGHT  ]  [GREEN] ↦

           [ RED LED ]
                ↓
              LDR 3
```

The central **Simulated Phototherapy Light** is mounted separately in the centre of the prototype box.

---

## Software

| Layer | Technology |
|---|---|
| Website structure | HTML5 |
| Website styling | CSS3 (Vanilla) |
| Website logic | Vanilla JavaScript |
| ESP32 firmware | Arduino C++ (ESP32 Arduino Core) |
| Browser-to-ESP32 | Web Serial API |

---

## File Structure

```
NeoLuma/
│
├── website/
│   ├── index.html       ← Dashboard HTML
│   ├── style.css        ← Stylesheet
│   └── script.js        ← JavaScript (Web Serial, parsing, graph, demo)
│
├── esp32/
│   └── NeoLuma_ESP32.cpp  ← ESP32 Arduino firmware
│
└── README.md
```

---

## How to Run the Website

The NeoLuma dashboard uses the **Web Serial API**, which requires a **localhost or HTTPS** origin.
Simply opening `index.html` as a `file://` URL will **not** work.

### Option 1 — VS Code Live Server (Recommended)

1. Install the **Live Server** extension in VS Code.
2. Open the `NeoLuma/website/` folder in VS Code.
3. Right-click `index.html` → **Open with Live Server**.
4. The dashboard opens at `http://127.0.0.1:5500` (or similar).

### Option 2 — Python HTTP Server

Open a terminal in the `website/` folder and run:

```bash
# Python 3
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

### Option 3 — Node.js serve

```bash
npx serve .
```

---

## Browser Requirements

The **Web Serial API** is supported only in **Chromium-based browsers**:

| Browser | Supported |
|---|---|
| Google Chrome ≥ 89 | ✅ Yes |
| Microsoft Edge ≥ 89 | ✅ Yes |
| Opera | ✅ Yes |
| Firefox | ❌ No |
| Safari | ❌ No |

> The page must be served from `localhost` or `https://` — not from a `file://` URL.

---

## How to Upload ESP32 Firmware

### Arduino IDE Method

1. Install **Arduino IDE** (version 2.x recommended).
2. Add the ESP32 board support:
   - Go to **File → Preferences**.
   - Add this URL to *Additional Boards Manager URLs*:
     ```
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
     ```
   - Go to **Tools → Board → Boards Manager**, search **esp32**, install **esp32 by Espressif Systems**.
3. Open `NeoLuma_ESP32.cpp`.
   - Rename it to `NeoLuma_ESP32.ino` if using Arduino IDE (or copy its contents into a new `.ino` sketch).
4. Select your board:
   - **Tools → Board → ESP32 Arduino → ESP32 Dev Module** (or your specific board)
5. Select the correct COM port:
   - **Tools → Port → COMx** (Windows) or `/dev/ttyUSB0` (Linux/Mac)
6. Click **Upload** (▶).

### PlatformIO Method

Create a `platformio.ini` in the `esp32/` folder:

```ini
[env:esp32dev]
platform  = espressif32
board     = esp32dev
framework = arduino
monitor_speed = 115200
```

Then run:

```bash
pio run --target upload
pio device monitor
```

---

## Pin Configuration

All pin numbers are defined at the top of `NeoLuma_ESP32.cpp`.
**Edit these values to match your actual wiring before uploading.**

```cpp
// LDR sensor analog inputs
#define LDR1_PIN    34    // LDR 1 (Red LED 1)
#define LDR2_PIN    35    // LDR 2 (Green LED)
#define LDR3_PIN    32    // LDR 3 (Red LED 2)
#define LDR4_PIN    33    // LDR 4 (Blue LED)

// Measurement LED driver
#define LED_DRIVER_PIN   26   // Drives transistor/MOSFET for all 4 LEDs

// Phototherapy relay
#define PHOTO_RELAY_PIN  25

// Relay logic (change if your relay module is active-HIGH)
#define RELAY_ACTIVE_STATE    LOW
#define RELAY_INACTIVE_STATE  HIGH
```

> **Important:** GPIO 34, 35, 36, 39 on most ESP32 boards are **input-only** (no internal pull-up).
> They are fine for LDR analog reads. Do not use them as outputs.

---

## Serial Communication

### Baud Rate

```
115200
```

Both the ESP32 firmware and the JavaScript use **115200 baud**.
If you change this, update **both** files.

---

### Commands (Website → ESP32)

| Command | Action |
|---|---|
| `PHOTO_ON` | Energise relay → Main light ON |
| `PHOTO_OFF` | De-energise relay → Main light OFF |
| `LED_ON` | Enable measurement LED driver → LEDs ON |
| `LED_OFF` | Disable measurement LED driver → LEDs OFF |

Commands are sent as ASCII strings terminated with `\n`.

---

### JSON Data Format (ESP32 → Website)

The ESP32 sends one JSON object per line approximately every 800 ms:

```json
{"ldr1":1245,"ldr2":1189,"ldr3":1260,"ldr4":1210,"photo":1,"led":1}
```

| Field | Type | Description |
|---|---|---|
| `ldr1` | integer 0–4095 | Raw ADC reading, LDR 1 (Red LED 1) |
| `ldr2` | integer 0–4095 | Raw ADC reading, LDR 2 (Green LED) |
| `ldr3` | integer 0–4095 | Raw ADC reading, LDR 3 (Red LED 2) |
| `ldr4` | integer 0–4095 | Raw ADC reading, LDR 4 (Blue LED) |
| `photo` | 0 or 1 | Phototherapy relay state |
| `led` | 0 or 1 | Measurement LED state |

---

## Optical Calculations

The dashboard computes these values automatically:

```
Red Average   = (LDR1 + LDR3) / 2
Green Reading = LDR2
Blue Reading  = LDR4
Overall Average = (LDR1 + LDR2 + LDR3 + LDR4) / 4
```

All values are **relative optical readings** (raw ADC units, 0–4095).
They are **not** lux values, bilirubin measurements, or calibrated phototherapy doses.

---

## Hardware Safety Notes

- Do **not** power measurement LEDs directly from ESP32 GPIO pins if their forward current exceeds ~12 mA per pin.
- Use a **transistor or MOSFET driver** between the ESP32 GPIO and the LEDs.
- Power the LEDs from the **buck converter output**, not from the ESP32 3.3 V or 5 V pin.
- Each LED branch should have an appropriate **current-limiting resistor**.
- The relay should only control the **main simulated phototherapy light**.
- Use the correct relay module polarity (`RELAY_ACTIVE_STATE` configuration).

---

## Demo Mode

If no ESP32 is connected, click **START DEMO MODE** on the dashboard.

- The dashboard generates simulated LDR readings with realistic variation.
- A yellow **DEMO MODE** banner is displayed at the top.
- When you connect a real ESP32, demo mode stops automatically.
- Real and simulated data are never mixed.

---

## Future Extensions (Not Yet Implemented)

The codebase is structured to support:

- Firebase Realtime Database integration (`updateFirebase()` placeholder in `script.js`)
- Historical session logging
- Patient/session ID tracking
- Cloud data export
- Authentication and role-based access
- Calibrated sensor readings (when hardware calibration is available)

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Web Serial not supported" | Use Google Chrome or Microsoft Edge |
| Cannot open `file://` with Web Serial | Serve from localhost (VS Code Live Server, Python HTTP server) |
| No COM port visible | Install CP2102 or CH340 USB driver for your ESP32 board |
| ESP32 not responding | Check baud rate is 115200 in both firmware and browser |
| JSON not parsing | Open browser DevTools console and inspect incoming serial data |
| LDR values stuck at 0 | Check LDR wiring to correct GPIO; confirm analog pins |
| Relay clicks but light doesn't turn on | Check relay active state (HIGH vs LOW); check relay wiring |
| LEDs not turning on | Check transistor/MOSFET wiring; check buck converter output voltage |

---

## Project Team

Academic prototype developed as part of an engineering coursework project.

---

*NeoLuma — Neonatal Phototherapy Optical Monitoring Prototype*
