/**
 * CamMIDI — Node for Max
 * Cualquier cámara del sistema → motion (3 bandas) → MIDI + WinMIDI + preview.
 * Captura vía ffmpeg (DirectShow en Windows).
 */

const Max = require("max-api");
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");

const DEBUG_LOG = path.join(__dirname, "node_debug.log");
function fileLog(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + " " + msg + "\n", "utf8");
  } catch (_) {}
}

fileLog("cam_midi.js boot __dirname=" + __dirname);
Max.post("[CamMIDI] boot…");

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const BANDS = [
  { name: "treble", root: 72 },
  { name: "mid", root: 60 },
  { name: "bass", root: 36 },
];

let sharp = null;
let ffmpegPath = null;

let sensitivity = 0.7;
let gate = 0.04;
let maxVelocity = 110;
let holdMs = 450;
let scaleName = "pentatonic";
let lastNoteAt = [0, 0, 0];
let noteCooldownMs = 140;
let autoStarted = false;
let notesFired = 0;
let noiseFloor = 12;
let framesSinceStart = 0;

let camProc = null;
let running = false;
let prevGray = null;
let prevW = 0;
let prevH = 0;
let activeNotes = new Map();
let frameCount = 0;
let lastFpsT = Date.now();
let fps = 0;
let scriptReady = false;
let installing = false;
let previewEnabled = true;
let visualFx = true;
let lastPreviewT = 0;
let previewFlip = 0;
const PREVIEW_MIN_MS = 66;
const PREVIEW_PATHS = [
  path.join(__dirname, "preview_a.jpg"),
  path.join(__dirname, "preview_b.jpg"),
];
const PREVIEW_TMP = path.join(__dirname, "preview.tmp.jpg");
const PREVIEW_PATH = path.join(__dirname, "preview.jpg");
let bandFlash = [0, 0, 0];
let lastLevels = [0, 0, 0];

let winMidiProc = null;
let winMidiReady = false;
let winMidiQueue = [];
const WIN_MIDI_SCRIPT = path.join(__dirname, "win_midi_daemon.ps1");

let devices = [];
let deviceIndex = 0;
let targetFps = 15;
let captureSize = "1280x720";

function scriptDir() {
  try {
    if (typeof __dirname === "string" && __dirname.length) return __dirname;
  } catch (_) {}
  return process.cwd();
}

function packageRoot() {
  const dir = scriptDir();
  for (const c of [dir, path.join(dir, "..")]) {
    try {
      if (fs.existsSync(path.join(c, "package.json"))) return c;
    } catch (_) {}
  }
  return dir;
}

function status(msg) {
  fileLog(msg);
  Max.post("[CamMIDI] " + msg);
  Max.outlet("status", "set", String(msg).replace(/\s+/g, " "));
}

function tryLoadSharp() {
  const root = packageRoot();
  const dir = scriptDir();
  for (const c of [
    path.join(root, "node_modules", "sharp"),
    path.join(dir, "node_modules", "sharp"),
    "sharp",
  ]) {
    try {
      sharp = require(c);
      status("sharp OK");
      return true;
    } catch (_) {}
  }
  return false;
}

function tryLoadFfmpeg() {
  const root = packageRoot();
  const candidates = [
    path.join(root, "node_modules", "ffmpeg-static"),
    path.join(scriptDir(), "node_modules", "ffmpeg-static"),
    "ffmpeg-static",
  ];
  for (const c of candidates) {
    try {
      const p = require(c);
      if (p && fs.existsSync(p)) {
        ffmpegPath = p;
        status("ffmpeg OK");
        return true;
      }
    } catch (_) {}
  }
  // PATH fallback
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const r = require("child_process").execSync(which + " ffmpeg", {
      encoding: "utf8",
      windowsHide: true,
    });
    const line = String(r).split(/\r?\n/).find((x) => x.trim());
    if (line && fs.existsSync(line.trim())) {
      ffmpegPath = line.trim();
      status("ffmpeg PATH OK");
      return true;
    }
  } catch (_) {}
  return false;
}

function npmInstallOnce() {
  return new Promise((resolve, reject) => {
    const root = packageRoot();
    const marker = path.join(root, "node_modules", ".cammidi_installed");
    if (fs.existsSync(marker) && tryLoadSharp() && tryLoadFfmpeg()) {
      resolve(false);
      return;
    }
    if (tryLoadSharp() && tryLoadFfmpeg()) {
      try {
        fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
        fs.writeFileSync(marker, new Date().toISOString());
      } catch (_) {}
      resolve(false);
      return;
    }

    installing = true;
    status("Primera vez: npm install (espera)…");
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    execFile(
      npmCmd,
      ["install", "--no-fund", "--no-audit", "--loglevel=error"],
      {
        cwd: root,
        windowsHide: true,
        env: process.env,
        timeout: 240000,
      },
      (err, stdout, stderr) => {
        installing = false;
        if (stdout) Max.post(String(stdout).slice(0, 500));
        if (stderr) Max.post(String(stderr).slice(0, 500));
        if (err) {
          reject(new Error("npm install falló (" + err.message + ")"));
          return;
        }
        if (!tryLoadSharp() || !tryLoadFfmpeg()) {
          reject(new Error("npm install OK pero faltan sharp/ffmpeg-static"));
          return;
        }
        try {
          fs.writeFileSync(marker, new Date().toISOString());
        } catch (_) {}
        status("npm install listo");
        resolve(true);
      }
    );
  });
}

function ensureDeps() {
  if (!sharp && !tryLoadSharp()) {
    throw new Error("sharp no disponible");
  }
  if (!ffmpegPath && !tryLoadFfmpeg()) {
    throw new Error("ffmpeg no disponible (npm install ffmpeg-static)");
  }
}

function winMidiSend(line) {
  if (!winMidiProc || !winMidiProc.stdin || !winMidiProc.stdin.writable) {
    winMidiQueue.push(line);
    ensureWinMidi();
    return;
  }
  if (!winMidiReady) {
    winMidiQueue.push(line);
    return;
  }
  try {
    winMidiProc.stdin.write(line + "\n");
  } catch (e) {
    fileLog("winMidi write fail: " + e.message);
  }
}

function ensureWinMidi() {
  if (winMidiProc) return;
  if (!fs.existsSync(WIN_MIDI_SCRIPT)) {
    fileLog("win_midi_daemon.ps1 missing");
    return;
  }
  try {
    winMidiProc = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WIN_MIDI_SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    winMidiReady = false;
    winMidiProc.stdout.on("data", (buf) => {
      const s = String(buf);
      if (s.indexOf("READY") >= 0) {
        winMidiReady = true;
        try {
          winMidiProc.stdin.write("pc 4\n");
        } catch (_) {}
        const q = winMidiQueue.splice(0, winMidiQueue.length);
        for (const line of q) {
          try {
            winMidiProc.stdin.write(line + "\n");
          } catch (_) {}
        }
        status("WinMIDI listo (GS Wavetable → altavoces)");
      }
    });
    winMidiProc.stderr.on("data", (buf) => fileLog("winMidi: " + String(buf).trim()));
    winMidiProc.on("exit", () => {
      winMidiProc = null;
      winMidiReady = false;
    });
    winMidiProc.on("error", () => {
      winMidiProc = null;
      winMidiReady = false;
    });
  } catch (e) {
    fileLog("ensureWinMidi: " + e.message);
  }
}

function stopWinMidi() {
  winMidiQueue = [];
  if (!winMidiProc) return;
  try {
    winMidiProc.stdin.write("panic\nquit\n");
  } catch (_) {}
  try {
    winMidiProc.kill();
  } catch (_) {}
  winMidiProc = null;
  winMidiReady = false;
}

function noteOn(pitch, vel) {
  pitch = Math.max(0, Math.min(127, pitch | 0));
  vel = Math.max(1, Math.min(127, vel | 0));
  if (activeNotes.has(pitch)) clearTimeout(activeNotes.get(pitch));
  Max.outlet("midi", pitch, vel);
  winMidiSend("on " + pitch + " " + vel);
  Max.outlet("noteui", "set", "MIDI " + pitch + "  vel " + vel);
  const t = setTimeout(() => {
    Max.outlet("midi", pitch, 0);
    winMidiSend("off " + pitch);
    activeNotes.delete(pitch);
  }, holdMs);
  activeNotes.set(pitch, t);
}

function allNotesOff() {
  for (const [pitch, t] of activeNotes) {
    clearTimeout(t);
    Max.outlet("midi", pitch, 0);
    winMidiSend("off " + pitch);
  }
  activeNotes.clear();
  winMidiSend("panic");
}

function scaleDegree(t, root) {
  const sc = SCALES[scaleName] || SCALES.pentatonic;
  const idx = Math.min(sc.length - 1, Math.floor(t * sc.length));
  const oct = Math.floor(t * 2);
  return root + sc[idx] + 12 * Math.min(1, oct);
}

function bandMeans(gray, width, height) {
  const h1 = (height / 3) | 0;
  const h2 = ((2 * height) / 3) | 0;
  const ranges = [
    [0, h1],
    [h1, h2],
    [h2, height],
  ];
  const means = [];
  for (const [y0, y1] of ranges) {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 4) {
      const row = y * width;
      for (let x = 0; x < width; x += 4) {
        sum += gray[row + x];
        n++;
      }
    }
    means.push(n ? sum / n / 255 : 0);
  }
  return means;
}

function bandDiffMaps(gray, width, height, prev) {
  const h1 = (height / 3) | 0;
  const h2 = ((2 * height) / 3) | 0;
  const ranges = [
    [0, h1],
    [h1, h2],
    [h2, height],
  ];
  const diffs = [];
  const floor = noiseFloor;
  for (const [y0, y1] of ranges) {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 4) {
      const row = y * width;
      for (let x = 0; x < width; x += 4) {
        const i = row + x;
        const d = Math.abs(gray[i] - prev[i]);
        n++;
        if (d > floor) sum += d - floor;
      }
    }
    diffs.push(n ? sum / n / 255 : 0);
  }
  return diffs;
}

let decodeBusy = false;

async function renderElegantFx(jpg) {
  const meta = await sharp(jpg).metadata();
  const w = meta.width || 640;
  const h = meta.height || 360;
  const h1 = Math.floor(h / 3);
  const h2 = Math.floor((2 * h) / 3);
  const stripW = Math.max(6, Math.floor(w * 0.028));
  const overlays = [];
  for (const y of [h1, h2]) {
    const line = await sharp({
      create: {
        width: w,
        height: 1,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 55 },
      },
    })
      .png()
      .toBuffer();
    overlays.push({ input: line, top: y, left: 0 });
  }
  const colors = [
    { rgb: [140, 210, 255], a: bandFlash[0] },
    { rgb: [170, 230, 180], a: bandFlash[1] },
    { rgb: [255, 190, 140], a: bandFlash[2] },
  ];
  const tops = [0, h1, h2];
  const heights = [h1, h2 - h1, h - h2];
  for (let i = 0; i < 3; i++) {
    const strength = Math.min(1, colors[i].a * 0.85 + (lastLevels[i] || 0) * 0.25);
    if (strength < 0.04 || heights[i] < 2) continue;
    const alpha = Math.min(90, Math.floor(28 + strength * 55));
    const edge = await sharp({
      create: {
        width: stripW,
        height: heights[i],
        channels: 4,
        background: {
          r: colors[i].rgb[0],
          g: colors[i].rgb[1],
          b: colors[i].rgb[2],
          alpha,
        },
      },
    })
      .png()
      .toBuffer();
    overlays.push({ input: edge, top: tops[i], left: 0 });
  }
  return sharp(jpg)
    .composite(overlays)
    .jpeg({ quality: 78, chromaSubsampling: "4:2:0" })
    .toBuffer();
}

async function writePreview(jpg) {
  if (!previewEnabled || !jpg || !jpg.length) return;
  const now = Date.now();
  if (now - lastPreviewT < PREVIEW_MIN_MS) return;
  lastPreviewT = now;
  try {
    let out = jpg;
    if (visualFx && sharp) out = await renderElegantFx(jpg);
    previewFlip ^= 1;
    const dest = PREVIEW_PATHS[previewFlip];
    fs.writeFileSync(PREVIEW_TMP, out);
    try {
      fs.renameSync(PREVIEW_TMP, dest);
    } catch (_) {
      fs.copyFileSync(PREVIEW_TMP, dest);
    }
    try {
      fs.copyFileSync(dest, PREVIEW_PATH);
    } catch (_) {}
    Max.outlet("frame", dest.replace(/\\/g, "/"));
  } catch (e) {
    try {
      previewFlip ^= 1;
      const dest = PREVIEW_PATHS[previewFlip];
      fs.writeFileSync(dest, jpg);
      Max.outlet("frame", dest.replace(/\\/g, "/"));
    } catch (_) {}
    fileLog("preview write fail: " + e.message);
  }
}

function decayFlash() {
  for (let i = 0; i < 3; i++) {
    bandFlash[i] *= 0.85;
    if (bandFlash[i] < 0.02) bandFlash[i] = 0;
  }
}

async function processJpeg(jpg) {
  if (!sharp || decodeBusy) return;
  decodeBusy = true;
  try {
    const { data, info } = await sharp(jpg)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = info.width;
    const height = info.height;
    const gray = data;
    const means = bandMeans(gray, width, height);
    framesSinceStart++;

    if (!prevGray || prevW !== width || prevH !== height) {
      prevGray = Buffer.from(gray);
      prevW = width;
      prevH = height;
      lastLevels = [0, 0, 0];
      Max.outlet("levels", 0, 0, 0);
      await writePreview(jpg);
      return;
    }

    const diffs = bandDiffMaps(gray, width, height, prevGray);
    prevGray = Buffer.from(gray);
    const gain = 4 + sensitivity * 12;
    const levels = diffs.map((d) => Math.min(1, d * gain));
    lastLevels = levels;
    Max.outlet("levels", levels[2], levels[1], levels[0]);

    const now = Date.now();
    decayFlash();
    if (framesSinceStart > 2) {
      for (let i = 0; i < 3; i++) {
        const change = levels[i];
        if (change < gate) continue;
        if (now - lastNoteAt[i] < noteCooldownMs) continue;
        lastNoteAt[i] = now;
        const pitch = scaleDegree(Math.min(1, Math.max(0, means[i])), BANDS[i].root);
        const vel = Math.max(
          1,
          Math.min(maxVelocity, Math.floor(change * maxVelocity * (0.5 + sensitivity)))
        );
        noteOn(pitch, vel);
        notesFired++;
        bandFlash[i] = Math.min(1, bandFlash[i] + Math.max(change, 0.35));
      }
    }

    Max.outlet(
      "fx",
      bandFlash[0],
      bandFlash[1],
      bandFlash[2],
      levels[0],
      levels[1],
      levels[2]
    );
    await writePreview(jpg);

    frameCount++;
    if (now - lastFpsT >= 1000) {
      fps = frameCount;
      frameCount = 0;
      lastFpsT = now;
      const name = devices[deviceIndex] || "?";
      status(
        "OK fps " +
          fps +
          " notes " +
          notesFired +
          " | " +
          name.slice(0, 28) +
          " | B:" +
          levels[2].toFixed(2) +
          " M:" +
          levels[1].toFixed(2) +
          " T:" +
          levels[0].toFixed(2)
      );
    }
  } catch (_) {
  } finally {
    decodeBusy = false;
  }
}

function feedMjpeg(chunk, state) {
  state.buf = Buffer.concat([state.buf, chunk]);
  if (state.buf.length > 2 * 1024 * 1024) state.buf = Buffer.alloc(0);
  while (true) {
    const soi = state.buf.indexOf(Buffer.from([0xff, 0xd8]));
    if (soi < 0) {
      if (state.buf.length > 500000) state.buf = Buffer.alloc(0);
      break;
    }
    if (soi > 0) state.buf = state.buf.slice(soi);
    const eoi = state.buf.indexOf(Buffer.from([0xff, 0xd9]), 2);
    if (eoi < 0) break;
    const frame = state.buf.slice(0, eoi + 2);
    state.buf = state.buf.slice(eoi + 2);
    processJpeg(frame);
  }
}

async function makeBlackJpeg() {
  ensureDeps();
  return sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .jpeg({ quality: 70 })
    .toBuffer();
}

async function writeBlackPreview() {
  try {
    const jpg = await makeBlackJpeg();
    // limpiar A/B para que no quede un frame viejo (p.ej. microscopio) en el flip
    for (const p of PREVIEW_PATHS) {
      try {
        fs.writeFileSync(p, jpg);
      } catch (_) {}
    }
    try {
      fs.writeFileSync(PREVIEW_PATH, jpg);
    } catch (_) {}
    lastPreviewT = 0;
    previewEnabled = true;
    Max.outlet("frame", PREVIEW_PATHS[0].replace(/\\/g, "/"));
  } catch (e) {
    fileLog("black preview: " + e.message);
  }
}

function pushCamMenu() {
  Max.outlet("cammenu", "clear");
  if (!devices.length) {
    Max.outlet("cammenu", "append", "(sin cámaras)");
    Max.outlet("cammenu", "set", 0);
    Max.outlet("devices");
    return;
  }
  for (let i = 0; i < devices.length; i++) {
    Max.outlet("cammenu", "append", devices[i]);
  }
  if (deviceIndex < 0 || deviceIndex >= devices.length) deviceIndex = 0;
  Max.outlet("cammenu", "set", deviceIndex);
  Max.outlet("devices", ...devices);
}

function listDevicesWin() {
  return new Promise((resolve, reject) => {
    try {
      ensureDeps();
    } catch (e) {
      reject(e);
      return;
    }
    const args = ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];
    execFile(
      ffmpegPath,
      args,
      { windowsHide: true, timeout: 15000, encoding: "utf8" },
      (err, stdout, stderr) => {
        const text = String(stderr || "") + String(stdout || "");
        fileLog("list_devices:\n" + text.slice(0, 4000));
        const found = [];
        const re = /"([^"]+)"\s*\(video\)/gi;
        let m;
        while ((m = re.exec(text))) {
          if (found.indexOf(m[1]) < 0) found.push(m[1]);
        }
        if (!found.length) {
          const re2 = /\[dshow[^\]]*\]\s*"([^"]+)"/gi;
          while ((m = re2.exec(text))) {
            if (/alternative name/i.test(text.slice(Math.max(0, m.index - 40), m.index)))
              continue;
            if (found.indexOf(m[1]) < 0) found.push(m[1]);
          }
        }
        devices = found;
        if (deviceIndex >= devices.length) deviceIndex = 0;
        pushCamMenu();
        if (!devices.length) {
          status("sin cámaras — pantalla negra");
          writeBlackPreview();
        } else {
          status(
            "cámaras " +
              devices.length +
              " · default [" +
              deviceIndex +
              "] " +
              devices[deviceIndex]
          );
        }
        resolve(devices);
      }
    );
  });
}

function listDevices() {
  if (process.platform === "win32") return listDevicesWin();
  devices = [];
  pushCamMenu();
  writeBlackPreview();
  status("sin cámaras (plataforma no Windows)");
  return Promise.resolve(devices);
}

function currentDeviceName() {
  if (!devices.length) return null;
  return devices[Math.max(0, Math.min(devices.length - 1, deviceIndex))];
}

function startCapture(deviceName) {
  ensureDeps();
  const name = deviceName || currentDeviceName();
  if (!name) throw new Error("sin cámara — envía devices");

  const input = "video=" + name;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "dshow",
    "-rtbufsize",
    "100M",
    "-framerate",
    String(targetFps),
    "-video_size",
    captureSize,
    "-i",
    input,
    "-f",
    "mjpeg",
    "-q:v",
    "6",
    "pipe:1",
  ];

  fileLog("ffmpeg " + args.join(" "));
  const state = { buf: Buffer.alloc(0) };
  camProc = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  camProc.stdout.on("data", (chunk) => feedMjpeg(chunk, state));
  camProc.stderr.on("data", (buf) => {
    const s = String(buf).trim();
    if (s) fileLog("ffmpeg: " + s);
  });
  camProc.on("exit", (code) => {
    fileLog("ffmpeg exit " + code);
    camProc = null;
    if (running) {
      // retry without forced size if open failed quickly
      if (code && code !== 0 && captureSize) {
        status("reintento sin resolución fija…");
        const args2 = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "dshow",
          "-rtbufsize",
          "100M",
          "-i",
          input,
          "-f",
          "mjpeg",
          "-q:v",
          "6",
          "pipe:1",
        ];
        const state2 = { buf: Buffer.alloc(0) };
        camProc = spawn(ffmpegPath, args2, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        camProc.stdout.on("data", (chunk) => feedMjpeg(chunk, state2));
        camProc.stderr.on("data", (buf) => fileLog("ffmpeg2: " + String(buf).trim()));
        camProc.on("exit", (c2) => {
          camProc = null;
          if (running) {
            running = false;
            status("cámara cerrada (code " + c2 + ")");
          }
        });
        return;
      }
      running = false;
      status("cámara cerrada");
    }
  });
  camProc.on("error", (e) => {
    status("ffmpeg error: " + e.message);
    running = false;
  });
}

async function start() {
  try {
    ensureDeps();
  } catch (e) {
    status("ERROR: " + e.message);
    await writeBlackPreview();
    return;
  }
  if (running) {
    status("already running");
    return;
  }

  try {
    await listDevices();
  } catch (e) {
    status("ERROR devices: " + e.message);
    devices = [];
    pushCamMenu();
    await writeBlackPreview();
    return;
  }

  const name = currentDeviceName();
  if (!name) {
    running = false;
    await writeBlackPreview();
    status("sin cámaras — elige otra cuando haya dispositivo");
    return;
  }

  running = true;
  prevGray = null;
  notesFired = 0;
  framesSinceStart = 0;
  await writeBlackPreview();
  ensureWinMidi();
  try {
    startCapture(name);
  } catch (e) {
    running = false;
    await writeBlackPreview();
    status("start failed: " + e.message);
    return;
  }
  status("started cam[" + deviceIndex + "]=" + name);
  setTimeout(() => {
    noteOn(60, 100);
    noteOn(64, 90);
    noteOn(67, 90);
  }, 700);
}

function stop() {
  running = false;
  if (camProc) {
    try {
      camProc.stdin && camProc.stdin.end();
    } catch (_) {}
    try {
      camProc.kill("SIGTERM");
    } catch (_) {}
    // Windows: taskkill if needed
    try {
      if (process.platform === "win32" && camProc.pid) {
        spawn("taskkill", ["/pid", String(camProc.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      }
    } catch (_) {}
    camProc = null;
  }
  allNotesOff();
  stopWinMidi();
  status("stopped");
}

function freeze() {
  prevGray = null;
  status("reference frame reset");
}

function setDevice(v) {
  const s = String(v);
  if (!devices.length) {
    pushCamMenu();
    writeBlackPreview();
    status("sin cámaras");
    return;
  }
  let idx = parseInt(s, 10);
  if (!Number.isNaN(idx) && /^\s*\d+\s*$/.test(s)) {
    if (idx < 0 || idx >= devices.length) {
      status("device fuera de rango 0.." + (devices.length - 1));
      return;
    }
    if (idx === deviceIndex && running) {
      status("ya en cam[" + idx + "] " + devices[idx]);
      return;
    }
    deviceIndex = idx;
  } else {
    const found = devices.findIndex((d) => d.toLowerCase() === s.toLowerCase());
    if (found < 0) {
      const f2 = devices.findIndex((d) => d.toLowerCase().indexOf(s.toLowerCase()) >= 0);
      if (f2 < 0) {
        status("cámara no encontrada: " + s);
        return;
      }
      deviceIndex = f2;
    } else deviceIndex = found;
  }
  Max.outlet("cammenu", "set", deviceIndex);
  status("device=" + deviceIndex + " " + (devices[deviceIndex] || ""));
  const was = running;
  if (was) {
    stop();
    setTimeout(() => start(), 350);
  }
}

function nextDevice() {
  if (!devices.length) {
    listDevices()
      .then(() => {
        deviceIndex = (deviceIndex + 1) % devices.length;
        status("device=" + deviceIndex + " " + devices[deviceIndex]);
        if (running) {
          stop();
          setTimeout(() => start(), 400);
        }
      })
      .catch((e) => status(e.message));
    return;
  }
  deviceIndex = (deviceIndex + 1) % devices.length;
  status("device=" + deviceIndex + " " + devices[deviceIndex]);
  if (running) {
    stop();
    setTimeout(() => start(), 400);
  }
}

function markReady() {
  scriptReady = true;
  status("READY — listando cámaras…");
  Max.outlet("ready");
  listDevices()
    .then((list) => {
      if (!autoStarted) {
        autoStarted = true;
        setTimeout(() => {
          try {
            if (list && list.length) start();
            else {
              writeBlackPreview();
              status("sin cámaras — pantalla negra");
            }
          } catch (e) {
            status("auto-start fail: " + e.message);
          }
        }, 500);
      }
    })
    .catch((e) => {
      status("WARN: " + e.message);
      pushCamMenu();
      writeBlackPreview();
    });
}

async function bootInstallThenReady() {
  try {
    await npmInstallOnce();
  } catch (e) {
    status("WARN install: " + e.message);
    tryLoadSharp();
    tryLoadFfmpeg();
  }
  markReady();
}

Max.addHandler("start", () => {
  if (installing) {
    status("espera: npm install…");
    return;
  }
  if (!scriptReady) {
    status("aún arrancando…");
    return;
  }
  start();
});
Max.addHandler("stop", () => stop());
Max.addHandler("freeze", () => freeze());
Max.addHandler("devices", () => {
  listDevices().catch((e) => status(e.message));
});
Max.addHandler("device", (v) => setDevice(v));
Max.addHandler("next", () => nextDevice());
Max.addHandler("cam", () => nextDevice());
Max.addHandler("preview", (v) => {
  previewEnabled = Number(v) !== 0 && String(v) !== "off";
});
Max.addHandler("fxvis", (v) => {
  visualFx = Number(v) !== 0 && String(v) !== "off";
});
Max.addHandler("fps", (v) => {
  targetFps = Math.max(5, Math.min(30, Number(v) | 0));
  status("targetFps=" + targetFps);
});
Max.addHandler("size", (v) => {
  captureSize = String(v);
  status("size=" + captureSize);
});
Max.addHandler("sensitivity", (v) => {
  sensitivity = Math.max(0, Math.min(1, Number(v)));
});
Max.addHandler("gate", (v) => {
  gate = Math.max(0, Math.min(1, Number(v)));
});
Max.addHandler("noise", (v) => {
  noiseFloor = Math.max(1, Math.min(64, Number(v) | 0));
});
Max.addHandler("velocity", (v) => {
  maxVelocity = Math.max(1, Math.min(127, Number(v) | 0));
});
Max.addHandler("hold_ms", (v) => {
  holdMs = Math.max(30, Math.min(2000, Number(v) | 0));
});
Max.addHandler("scale", (name) => {
  const n = String(name).toLowerCase();
  if (SCALES[n]) {
    scaleName = n;
    status("scale=" + scaleName);
  } else status("scales: major minor pentatonic chromatic");
});
Max.addHandler("bang", () => {
  status(running ? "running fps~" + fps + " cam=" + (currentDeviceName() || "?") : "idle");
});
Max.addHandler(Max.MESSAGE_TYPES.DESTROY, () => stop());
process.on("exit", () => stop());

setImmediate(() => {
  bootInstallThenReady();
});
