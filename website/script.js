/**
 * NeoLuma — Neonatal Phototherapy Optical Monitoring
 * script.js
 *
 * Web Serial connection, sensor parsing, dashboard update,
 * real-time graph, data log, demo mode.
 *
 * Serial Commands sent to ESP32:
 *   PHOTO_ON  — Turn on main phototherapy relay
 *   PHOTO_OFF — Turn off main phototherapy relay
 *   LED_ON    — Turn on 4 measurement LEDs
 *   LED_OFF   — Turn off 4 measurement LEDs
 *
 * JSON received from ESP32:
 *   {"ldr1":NNN,"ldr2":NNN,"ldr3":NNN,"ldr4":NNN,"photo":0|1,"led":0|1}
 */

'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */
const BAUD_RATE      = 115200;
const MAX_LOG_LINES  = 30;
const GRAPH_POINTS   = 50;
const DEMO_INTERVAL  = 800;  // ms between demo readings
const READ_INTERVAL  = 100;  // ms polling for serial reads
const ADC_MAX        = 4095; // ESP32 12-bit ADC max

/* Graph line colours — must match legend in index.html */
const GRAPH_COLORS = {
  ldr1: '#e05a5a',   // Red
  ldr2: '#3fba74',   // Green
  ldr3: '#e0905a',   // Orange
  ldr4: '#4a90d9',   // Blue
};

/* ============================================================
   STATE
   ============================================================ */
let serialPort      = null;
let serialReader    = null;
let serialWriter    = null;
let isConnected     = false;
let isDemoMode      = false;
let demoIntervalId  = null;
let readLoopActive  = false;
let lineBuffer      = '';

/* Sensor data store */
let sensorData = { pd1: 0, pd2: 0, ldr1: 0, ldr2: 0, ldr3: 0, ldr4: 0, photo: 0, led: 0 };
let dataReceived = false; // true once at least one valid packet arrived

/* Graph history */
const graphHistory = {
  pd1: new Array(GRAPH_POINTS).fill(0),
  pd2: new Array(GRAPH_POINTS).fill(0),
  ldr1: new Array(GRAPH_POINTS).fill(0),
  ldr2: new Array(GRAPH_POINTS).fill(0),
  ldr3: new Array(GRAPH_POINTS).fill(0),
  ldr4: new Array(GRAPH_POINTS).fill(0),
};

/* Log lines */
let logLines = [];

/* ============================================================
   WEB SERIAL — CONNECT / DISCONNECT
   ============================================================ */

/**
 * Called when user clicks "CONNECT ESP32" or "DISCONNECT" button.
 */
async function handleConnectButton() {
  if (isConnected) {
    await disconnectESP32();
  } else {
    await connectESP32();
  }
}

/**
 * Open the browser serial-port picker and connect.
 */
async function connectESP32() {
  if (!('serial' in navigator)) {
    showNotification(
      'Your browser does not support Web Serial API. ' +
      'Please use Google Chrome, Edge, or another Chromium-based browser.',
      'error'
    );
    return;
  }

  // Stop demo mode before real connection
  if (isDemoMode) stopDemoMode();

  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: BAUD_RATE });

    isConnected = true;
    serialWriter = serialPort.writable.getWriter();
    setConnectionUI(true);
    showNotification('ESP32 connected successfully.', 'success');
    startReadLoop();

  } catch (err) {
    serialPort = null;
    serialWriter = null;
    if (err.name === 'NotFoundError' || err.name === 'AbortError') {
      // User cancelled the port picker — not an error
    } else {
      showNotification(
        'Unable to connect to ESP32. Please check the USB connection.',
        'error'
      );
    }
  }
}

/**
 * Close the serial port and clean up.
 */
async function disconnectESP32() {
  isConnected = false;
  readLoopActive = false;

  try {
    if (serialReader) {
      await serialReader.cancel();
      serialReader = null;
    }
  } catch (_) { /* ignore */ }

  try {
    if (serialWriter) {
      serialWriter.releaseLock();
      serialWriter = null;
    }
  } catch (_) { /* ignore */ }

  try {
    if (serialPort) {
      await serialPort.close();
      serialPort = null;
    }
  } catch (_) { /* ignore */ }

  lineBuffer = '';
  dataReceived = false;
  setConnectionUI(false);
  resetSensorStatus();
  showNotification('ESP32 disconnected.', 'info');
}

/* ============================================================
   SERIAL READ LOOP
   ============================================================ */

/**
 * Continuously reads from the serial port until disconnected.
 * Buffers incoming bytes and extracts complete JSON lines.
 */
async function startReadLoop() {
  if (!serialPort || !serialPort.readable) return;
  readLoopActive = true;

  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable);
  serialReader = textDecoder.readable.getReader();

  try {
    while (readLoopActive && isConnected) {
      const { value, done } = await serialReader.read();
      if (done) break;
      if (value) readSerialData(value);
    }
  } catch (err) {
    if (isConnected) {
      showNotification('Serial connection lost. Please reconnect.', 'error');
      await disconnectESP32();
    }
  }

  try { await readableStreamClosed; } catch (_) { /* ignore */ }
}

/**
 * Process incoming raw string chunks from the serial port.
 * Accumulates into lineBuffer, extracts complete newline-terminated lines.
 * @param {string} chunk - Raw text chunk from serial
 */
function readSerialData(chunk) {
  lineBuffer += chunk;
  const lines = lineBuffer.split('\n');
  // Keep the incomplete last fragment in the buffer
  lineBuffer = lines.pop();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('{')) {
      parseSensorData(trimmed);
    }
    // Silently ignore non-JSON debug lines
  }
}

/* ============================================================
   PARSE & UPDATE
   ============================================================ */

/**
 * Parse a JSON string from ESP32 and update the dashboard.
 * Safely ignores unknown fields. Does not crash on invalid JSON.
 * @param {string} jsonStr - Raw JSON string
 */
function parseSensorData(jsonStr) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (_) {
    // Invalid JSON — skip silently
    return;
  }

  // Validate that at minimum ldr1–ldr4 exist and are numbers
  const required = ['pd1', 'pd2', 'ldr1', 'ldr2', 'ldr3', 'ldr4'];
  for (const key of required) {
    if (typeof parsed[key] !== 'number') return;
  }

  // Clamp values to valid ADC range
  sensorData.pd1   = Math.max(0, Math.min(ADC_MAX, Math.round(parsed.pd1)));
  sensorData.pd2   = Math.max(0, Math.min(ADC_MAX, Math.round(parsed.pd2)));
  sensorData.ldr1  = Math.max(0, Math.min(ADC_MAX, Math.round(parsed.ldr1)));
  sensorData.ldr2  = Math.max(0, Math.min(ADC_MAX, Math.round(parsed.ldr2)));
  sensorData.ldr3  = Math.max(0, Math.min(ADC_MAX, Math.round(parsed.ldr3)));
  sensorData.ldr4  = Math.max(0, Math.min(ADC_MAX, Math.round(parsed.ldr4)));

  // Optional state fields
  if (typeof parsed.photo === 'number') sensorData.photo = parsed.photo;
  if (typeof parsed.led   === 'number') sensorData.led   = parsed.led;

  dataReceived = true;
  updateDashboard(sensorData);
  addLogEntry(sensorData);
}

/**
 * Update all dashboard sections from a data object.
 * @param {Object} data - { ldr1, ldr2, ldr3, ldr4, photo, led }
 */
function updateDashboard(data) {
  updatePDValues(data);
  updateLDRValues(data);
  updateRGBValues(data);
  updateAverage(data);
  updateSensorStatus(data);
  updateGraphHistory(data);
  drawGraph();
  updateControlStatesFromData(data);
  updateProgress(data);
  updateFirebase(data); // placeholder for future Firebase integration
}

/**
 * Update individual LDR value displays.
 * Main display = inverted value (4095 - raw) — represents absorption index.
 * Sub display  = raw ADC reading shown small below.
 * @param {Object} data
 */
function updatePDValues(data) {
  const updates = [
    { mainId: 'pd1-value', rawId: 'pd1-raw', val: data.pd1 },
    { mainId: 'pd2-value', rawId: 'pd2-raw', val: data.pd2 },
  ];
  for (const { mainId, rawId, val } of updates) {
    const inverted = ADC_MAX - val;
    const mainEl = document.getElementById(mainId);
    if (mainEl) {
      mainEl.textContent = String(inverted).padStart(4, '0');
      mainEl.classList.add('updated');
      setTimeout(() => mainEl.classList.remove('updated'), 400);
    }
    const rawEl = document.getElementById(rawId);
    if (rawEl) rawEl.textContent = String(val).padStart(4, '0');
  }
}

function updateLDRValues(data) {
  const updates = [
    { mainId: 'ldr1-value', rawId: 'ldr1-raw', val: data.ldr1 },
    { mainId: 'ldr2-value', rawId: 'ldr2-raw', val: data.ldr2 },
    { mainId: 'ldr3-value', rawId: 'ldr3-raw', val: data.ldr3 },
    { mainId: 'ldr4-value', rawId: 'ldr4-raw', val: data.ldr4 },
  ];

  for (const { mainId, rawId, val } of updates) {
    const inverted = ADC_MAX - val;

    // Main big display: inverted (absorption) value
    const mainEl = document.getElementById(mainId);
    if (mainEl) {
      mainEl.textContent = String(inverted).padStart(4, '0');
      mainEl.classList.add('updated');
      setTimeout(() => mainEl.classList.remove('updated'), 400);
    }

    // Small sub-display: raw ADC reading
    const rawEl = document.getElementById(rawId);
    if (rawEl) rawEl.textContent = String(val).padStart(4, '0');
  }
}

/**
 * Calculate and update RGB relative optical readings.
 * Uses inverted (absorption) values: 4095 - raw.
 * Red Average = ((4095-LDR1) + (4095-LDR3)) / 2
 * Green       = 4095 - LDR2
 * Blue        = 4095 - LDR4
 * @param {Object} data
 */
function updateRGBValues(data) {
  const inv1 = ADC_MAX - data.ldr1;
  const inv2 = ADC_MAX - data.ldr2;
  const inv3 = ADC_MAX - data.ldr3;
  const inv4 = ADC_MAX - data.ldr4;

  const redAvg   = Math.round((inv1 + inv3) / 2);
  const greenVal = inv2;
  const blueVal  = inv4;

  safeSetText('rgb-red-value',   String(redAvg).padStart(4, '0'));
  safeSetText('rgb-green-value', String(greenVal).padStart(4, '0'));
  safeSetText('rgb-blue-value',  String(blueVal).padStart(4, '0'));
}

/**
 * Calculate and update overall average reading and progress bar.
 * Uses inverted absorption values: avg = (inv1+inv2+inv3+inv4)/4
 * @param {Object} data
 */
function updateAverage(data) {
  const inv1 = ADC_MAX - data.ldr1;
  const inv2 = ADC_MAX - data.ldr2;
  const inv3 = ADC_MAX - data.ldr3;
  const inv4 = ADC_MAX - data.ldr4;
  const avg = Math.round((inv1 + inv2 + inv3 + inv4) / 4);

  safeSetText('avg-value', String(avg).padStart(4, '0'));

  const pct = (avg / ADC_MAX) * 100;
  const bar = document.getElementById('avg-progress-bar');
  if (bar) bar.style.width = pct.toFixed(1) + '%';
}

/**
 * Update per-sensor status indicators.
 * A sensor is "Active" once data has been received.
 * @param {Object} data
 */
function updateSensorStatus(data) {
  // Individual LDR card statuses
  const ldrIds = ['pd1', 'pd2', 'ldr1', 'ldr2', 'ldr3', 'ldr4'];
  for (const id of ldrIds) {
    const statusEl    = document.getElementById(`${id}-status`);
    const statusTxtEl = document.getElementById(`${id}-status-text`);
    if (statusEl && statusTxtEl) {
      statusEl.classList.add('active');
      statusTxtEl.textContent = 'Active';
    }
  }

  // Sidebar sensor status badges
  const ssIds = ['ss-pd1', 'ss-pd2', 'ss-ldr1', 'ss-ldr2', 'ss-ldr3', 'ss-ldr4'];
  const ssTexts = ['ss-pd1-text', 'ss-pd2-text', 'ss-ldr1-text', 'ss-ldr2-text', 'ss-ldr3-text', 'ss-ldr4-text'];
  for (let i = 0; i < ssIds.length; i++) {
    const badge = document.getElementById(ssIds[i]);
    const txt   = document.getElementById(ssTexts[i]);
    if (badge && txt) {
      badge.classList.add('active');
      txt.textContent = 'Active';
    }
  }
}

/**
 * Reflect photo/led state from ESP32 data in the control cards.
 * @param {Object} data
 */
function updateControlStatesFromData(data) {
  if (typeof data.photo === 'number') {
    setPhotoState(data.photo === 1);
  }
  if (typeof data.led === 'number') {
    setLEDState(data.led === 1);
  }
}

/* ============================================================
   CONTROL COMMANDS — Website → ESP32
   ============================================================ */

/**
 * Send a text command string to ESP32 over serial.
 * Commands are newline-terminated so ESP32 can detect end-of-line.
 * @param {string} command - One of: PHOTO_ON, PHOTO_OFF, LED_ON, LED_OFF
 */
async function sendCommand(command) {
  if (!isConnected || !serialWriter) {
    showNotification('ESP32 not connected. Connect the device first.', 'error');
    return;
  }
  try {
    const encoder = new TextEncoder();
    await serialWriter.write(encoder.encode(command + '\n'));
  } catch (err) {
    showNotification('Failed to send command. Check USB connection.', 'error');
  }
}

/** Turn ON main phototherapy relay. */
async function turnPhototherapyOn() {
  await sendCommand('PHOTO_ON');
  setPhotoState(true);
}

/** Turn OFF main phototherapy relay. */
async function turnPhototherapyOff() {
  await sendCommand('PHOTO_OFF');
  setPhotoState(false);
}

/** Turn ON all four measurement LEDs. */
async function turnLEDsOn() {
  await sendCommand('LED_ON');
  setLEDState(true);
}

/** Turn OFF all four measurement LEDs. */
async function turnLEDsOff() {
  await sendCommand('LED_OFF');
  setLEDState(false);
}

/* ============================================================
   UI STATE HELPERS
   ============================================================ */

/**
 * Update header connection indicator and button label.
 * @param {boolean} connected
 */
function setConnectionUI(connected) {
  const dot     = document.getElementById('status-dot');
  const txt     = document.getElementById('status-text');
  const btn     = document.getElementById('btn-connect');
  const demoBtnWrap = document.getElementById('demo-toggle-wrap');

  if (!dot || !txt || !btn) return;

  if (connected) {
    dot.className = 'status-dot connected';
    txt.textContent = 'ESP32 Connected';
    btn.textContent = 'DISCONNECT';
    btn.classList.add('disconnecting');
    if (demoBtnWrap) demoBtnWrap.style.display = 'none';
  } else {
    dot.className = 'status-dot';
    txt.textContent = 'Disconnected';
    btn.textContent = 'CONNECT ESP32';
    btn.classList.remove('disconnecting');
    if (demoBtnWrap) demoBtnWrap.style.display = 'block';
  }
}

/**
 * Update phototherapy light state UI.
 * @param {boolean} on
 */
function setPhotoState(on) {
  sensorData.photo = on ? 1 : 0;
  const stateEl = document.getElementById('photo-state');
  const textEl  = document.getElementById('photo-state-text');
  if (!stateEl || !textEl) return;
  if (on) {
    stateEl.classList.add('on');
    textEl.textContent = 'ON';
  } else {
    stateEl.classList.remove('on');
    textEl.textContent = 'OFF';
  }
}

/**
 * Update LED system state UI.
 * @param {boolean} on
 */
function setLEDState(on) {
  sensorData.led = on ? 1 : 0;
  const stateEl = document.getElementById('led-state');
  const textEl  = document.getElementById('led-state-text');
  if (!stateEl || !textEl) return;
  if (on) {
    stateEl.classList.add('on');
    textEl.textContent = 'ON';
  } else {
    stateEl.classList.remove('on');
    textEl.textContent = 'OFF';
  }
}

/**
 * Reset all sensor statuses to "Waiting" state.
 */
function resetSensorStatus() {
  dataReceived = false;

  const ids = ['ldr1', 'ldr2', 'ldr3', 'ldr4'];
  for (const id of ids) {
    const statusEl    = document.getElementById(`${id}-status`);
    const statusTxtEl = document.getElementById(`${id}-status-text`);
    if (statusEl) statusEl.classList.remove('active');
    if (statusTxtEl) statusTxtEl.textContent = 'Waiting';
  }

  const ssIds = ['ss-pd1', 'ss-pd2', 'ss-ldr1', 'ss-ldr2', 'ss-ldr3', 'ss-ldr4'];
  const ssTxts = ['ss-ldr1-text', 'ss-ldr2-text', 'ss-ldr3-text', 'ss-ldr4-text'];
  for (let i = 0; i < ssIds.length; i++) {
    const badge = document.getElementById(ssIds[i]);
    const txt   = document.getElementById(ssTxts[i]);
    if (badge) badge.classList.remove('active');
    if (txt) txt.textContent = 'Waiting';
  }

  setPhotoState(false);
  setLEDState(false);
}

/* ============================================================
   NOTIFICATION
   ============================================================ */

let notifTimeout = null;

/**
 * Show a notification bar message.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function showNotification(message, type) {
  const el = document.getElementById('notification');
  if (!el) return;

  el.textContent = message;
  el.className   = `notification visible ${type}`;

  if (notifTimeout) clearTimeout(notifTimeout);
  notifTimeout = setTimeout(() => {
    el.classList.remove('visible');
  }, 5000);
}

/* ============================================================
   DEMO MODE
   ============================================================ */

/**
 * Toggle demo mode on/off.
 * Called by the "START DEMO MODE" / "STOP DEMO MODE" button.
 */
function toggleDemoMode() {
  if (isDemoMode) {
    stopDemoMode();
  } else {
    startDemoMode();
  }
}

/**
 * Start generating simulated LDR readings.
 * Only available when ESP32 is not connected.
 */
function startDemoMode() {
  if (isConnected) return; // Never mix demo and real data
  isDemoMode = true;

  const banner = document.getElementById('demo-banner');
  const btn    = document.getElementById('btn-demo');
  if (banner) banner.classList.add('visible');
  if (btn)    btn.textContent = 'STOP DEMO MODE';

  showNotification('Demo mode started. Simulated sensor data.', 'info');

  demoIntervalId = setInterval(() => {
    const demoData = generateDemoData();
    parseSensorData(JSON.stringify(demoData));
  }, DEMO_INTERVAL);
}

/**
 * Stop demo mode.
 */
function stopDemoMode() {
  isDemoMode = false;
  if (demoIntervalId) {
    clearInterval(demoIntervalId);
    demoIntervalId = null;
  }

  const banner = document.getElementById('demo-banner');
  const btn    = document.getElementById('btn-demo');
  if (banner) banner.classList.remove('visible');
  if (btn)    btn.textContent = 'START DEMO MODE';

  if (!isConnected) {
    showNotification('Demo mode stopped.', 'info');
  }
}

/**
 * Generate a simulated sensor data object with realistic variation.
 * @returns {Object} Simulated sensor reading
 */
function generateDemoData() {
  function simLDR(base, range) {
    return Math.max(0, Math.min(ADC_MAX,
      Math.round(base + (Math.random() - 0.5) * range * 2)
    ));
  }

  return {
    pd1:   simLDR(850, 50),
    pd2:   simLDR(870, 45),
    ldr1:  simLDR(1200, 80),
    ldr2:  simLDR(1150, 75),
    ldr3:  simLDR(1230, 85),
    ldr4:  simLDR(1180, 70),
    photo: sensorData.photo,
    led:   sensorData.led,
  };
}

/* ============================================================
   DATA LOG
   ============================================================ */

/**
 * Add a parsed data entry to the visual log.
 * Keeps only the last MAX_LOG_LINES entries.
 * @param {Object} data
 */
function addLogEntry(data) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour12: false });

  const entry = {
    time: timeStr,
    ldr1: data.ldr1,
    ldr2: data.ldr2,
    ldr3: data.ldr3,
    ldr4: data.ldr4,
  };

  logLines.push(entry);
  if (logLines.length > MAX_LOG_LINES) {
    logLines.shift();
  }

  renderLog();
}

/**
 * Render the log entries into the log body element.
 */
function renderLog() {
  const el = document.getElementById('log-body');
  if (!el) return;

  if (logLines.length === 0) {
    el.innerHTML = '<div class="log-empty">No data received yet.</div>';
    return;
  }

  // Build HTML in reverse (latest first)
  const html = [...logLines].reverse().map(entry => {
    return `<div class="log-entry">` +
      `<span class="log-time">${entry.time}</span> ` +
      `<span class="log-key">LDR1:</span><span class="log-val">${entry.ldr1}</span> ` +
      `<span class="log-key">LDR2:</span><span class="log-val">${entry.ldr2}</span> ` +
      `<span class="log-key">LDR3:</span><span class="log-val">${entry.ldr3}</span> ` +
      `<span class="log-key">LDR4:</span><span class="log-val">${entry.ldr4}</span>` +
      `</div>`;
  }).join('');

  el.innerHTML = html;
}

/**
 * Clear the data log.
 */
function clearLog() {
  logLines = [];
  renderLog();
}

/* ============================================================
   REAL-TIME GRAPH
   ============================================================ */

/**
 * Push new values into the rolling graph history arrays.
 * @param {Object} data
 */
function updateGraphHistory(data) {
  for (const key of ['ldr1', 'ldr2', 'ldr3', 'ldr4']) {
    graphHistory[key].push(data[key]);
    if (graphHistory[key].length > GRAPH_POINTS) {
      graphHistory[key].shift();
    }
  }
}

/**
 * Draw the real-time graph on the canvas.
 * Uses plain HTML Canvas — no external library required.
 */
function drawGraph() {
  const canvas = document.getElementById('ldr-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Resize canvas to match CSS display size
  const dpr    = window.devicePixelRatio || 1;
  const rect   = canvas.getBoundingClientRect();
  canvas.width  = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;

  const PADDING_TOP    = 10;
  const PADDING_BOTTOM = 24;
  const PADDING_LEFT   = 42;
  const PADDING_RIGHT  = 10;

  const plotW = W - PADDING_LEFT - PADDING_RIGHT;
  const plotH = H - PADDING_TOP  - PADDING_BOTTOM;

  // Background
  ctx.fillStyle = '#f0f4f8';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#dde3ef';
  ctx.lineWidth   = 1;
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const y = PADDING_TOP + (plotH / gridSteps) * i;
    ctx.beginPath();
    ctx.moveTo(PADDING_LEFT, y);
    ctx.lineTo(PADDING_LEFT + plotW, y);
    ctx.stroke();

    // Y-axis labels
    const val = Math.round(ADC_MAX - (ADC_MAX / gridSteps) * i);
    ctx.fillStyle = '#8a93a8';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(val, PADDING_LEFT - 4, y + 4);
  }

  // X-axis labels
  ctx.fillStyle = '#8a93a8';
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Latest', PADDING_LEFT + plotW, H - 6);
  ctx.fillText('Oldest', PADDING_LEFT, H - 6);

  // Plot each LDR series
  const series = [
    { key: 'ldr1', color: GRAPH_COLORS.ldr1 },
    { key: 'ldr2', color: GRAPH_COLORS.ldr2 },
    { key: 'ldr3', color: GRAPH_COLORS.ldr3 },
    { key: 'ldr4', color: GRAPH_COLORS.ldr4 },
  ];

  for (const { key, color } of series) {
    const values = graphHistory[key];
    if (values.length < 2) continue;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';

    for (let i = 0; i < values.length; i++) {
      const x = PADDING_LEFT + (i / (GRAPH_POINTS - 1)) * plotW;
      const y = PADDING_TOP  + plotH - (values[i] / ADC_MAX) * plotH;

      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }

    ctx.stroke();
  }
}

/* ============================================================
   FIREBASE PLACEHOLDER
   ============================================================ */

/**
 * Placeholder for future Firebase real-time database integration.
 * Called after every dashboard update.
 * @param {Object} data - Current sensor data
 */
function updateFirebase(data) {
  // Future Firebase integration
  // Example:
  //   const db = firebase.database();
  //   db.ref('neoluma/readings').push({
  //     timestamp: Date.now(),
  //     ldr1: data.ldr1,
  //     ldr2: data.ldr2,
  //     ldr3: data.ldr3,
  //     ldr4: data.ldr4,
  //   });
}

/* ============================================================
   UTILITY
   ============================================================ */

/**
 * Safely set the textContent of an element by ID.
 * Does nothing if element is not found.
 * @param {string} id
 * @param {string} text
 */
function safeSetText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/* ============================================================
   INITIALIZATION
   ============================================================ */

/**
 * Run on page load.
 * Checks Web Serial support and sets initial UI state.
 */
function init() {
  setConnectionUI(false);
  resetSensorStatus();
  renderLog();
  drawGraph();

  // Warn if Web Serial is not supported
  if (!('serial' in navigator)) {
    showNotification(
      'Web Serial API is not supported in this browser. ' +
      'Please use Google Chrome or Microsoft Edge.',
      'error'
    );
    const btn = document.getElementById('btn-connect');
    if (btn) btn.disabled = true;
  }

  // Redraw graph on window resize
  window.addEventListener('resize', () => {
    drawGraph();
  });
}

// Wait for DOM to be ready before initializing
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

/* ============================================================
   PHOTOTHERAPY PROGRESS ESTIMATION
   ============================================================ */

let sessionActive = false;
let sessionStartTime = 0;
let sessionTimerInterval = null;
let sessionDurationMs = 12 * 60 * 60 * 1000;

function startSession() {
  if (sessionActive) return;
  const durationInput = document.getElementById('prog-duration-input');
  const hours = parseFloat(durationInput.value);
  if (isNaN(hours) || hours <= 0) {
    showNotification('Invalid session duration', 'error');
    return;
  }
  
  sessionDurationMs = hours * 60 * 60 * 1000;
  sessionStartTime = Date.now();
  sessionActive = true;
  
  document.getElementById('btn-session-start').disabled = true;
  document.getElementById('btn-session-stop').disabled = false;
  durationInput.disabled = true;
  
  safeSetText('prog-total-hours-display', hours.toFixed(1) + 'h');
  
  sessionTimerInterval = setInterval(updateSessionTimer, 1000);
  updateSessionTimer(); // Initial call
  showNotification('Phototherapy session started', 'success');
}

function stopSession() {
  if (!sessionActive) return;
  sessionActive = false;
  clearInterval(sessionTimerInterval);
  
  document.getElementById('btn-session-start').disabled = false;
  document.getElementById('btn-session-stop').disabled = true;
  document.getElementById('prog-duration-input').disabled = false;
  
  showNotification('Phototherapy session stopped', 'info');
}

function updateSessionTimer() {
  if (!sessionActive) return;
  const elapsedMs = Date.now() - sessionStartTime;
  
  let totalSeconds = Math.floor(elapsedMs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  totalSeconds %= 3600;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  
  const formatted = [
    h.toString().padStart(2, '0'),
    m.toString().padStart(2, '0'),
    s.toString().padStart(2, '0')
  ].join(':');
  
  safeSetText('prog-session-time', formatted);
}

function updateProgress(data) {
  const inv1 = ADC_MAX - data.pd1;
  const inv2 = ADC_MAX - data.pd2;
  const absAvg = Math.round((inv1 + inv2) / 2);
  
  safeSetText('prog-abs-value', String(absAvg).padStart(4, '0'));
  
  let completionPct = 0;
  if (sessionActive) {
     const elapsedMs = Date.now() - sessionStartTime;
     completionPct = Math.min(100, Math.max(0, (elapsedMs / sessionDurationMs) * 100));
  }
  
  const circleCircumference = 314;
  const dashOffset = circleCircumference - (completionPct / 100) * circleCircumference;
  
  const ring = document.getElementById('prog-ring-fill');
  if (ring) {
    ring.style.strokeDashoffset = dashOffset;
  }
  
  safeSetText('prog-pct-text', Math.floor(completionPct) + '%');
  safeSetText('prog-completed-pct', completionPct.toFixed(1) + '%');
  safeSetText('prog-remaining-pct', (100 - completionPct).toFixed(1) + '%');
  
  if (sessionActive) {
     const elapsedMs = Date.now() - sessionStartTime;
     const remainingMs = Math.max(0, sessionDurationMs - elapsedMs);
     const remainingHours = remainingMs / (1000 * 60 * 60);
     safeSetText('prog-est-hours', remainingHours.toFixed(1) + 'h');
     
     if (elapsedMs >= sessionDurationMs) {
         stopSession();
         showNotification('Phototherapy session completed!', 'success');
     }
  } else {
     safeSetText('prog-est-hours', '�');
  }
}
