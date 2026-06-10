const DEFAULT_MODE = { NetworkMode: "03", NetworkBand: "2000000400000", LTEBand: "a0080800c5" }; // from net-mode-backup.xml
const DEFAULT_MODEM = "http://192.168.8.1";
const DEFAULT_ROUTER = "http://192.168.1.1";
const DEFAULT_INTERNET_CHECK = "https://cloudflare-dns.com/dns-query";

const BAND_MASKS = {
  B1:"1", B3:"4", B7:"40", B8:"80",
  B20:"80000", B28:"8000000", B38:"2000000000", B40:"8000000000"
};

const DB_NAME = "huawei_lte_panel";
const DB_VERSION = 2;
const MAX_HISTORY_POINTS_FOR_UI = 2000;
const MAX_EVENTS_FOR_UI = 500;
const MAX_CELL_SAMPLE_GAP_SECONDS = 300;
const WATCHDOG_STALE_MS = 60 * 1000;
const MODEM_UNAVAILABLE_RETRY_MS = 10 * 1000;
const COLLECT_ALARM = "collect";

let monitorTickInFlight = null;

let state = {
  modem: DEFAULT_MODEM,
  router: DEFAULT_ROUTER,
  internetCheck: DEFAULT_INTERNET_CHECK,
  monitoringEnabled: true,
  lastSuccessfulSampleTs: null,
  lastWatchdogRestartTs: null,
  backup: null,
  lastCell: null,
  lastCellIdentity: null,
  lastSampleTs: null,
  lastInternetOK: null,
  startedAt: Date.now(),
  stats: { bandChanges: 0, cellChanges: 0, pciChanges: 0, enodebChanges: 0, earfcnChanges: 0, invalidSamples: 0, internetDrops: 0, watchdogRestarts: 0, samples: 0 },
  lastSnapshot: null,
  lastError: null
};

function now() { return new Date().toLocaleTimeString(); }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("samples")) {
        const s = db.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
        s.createIndex("ts", "ts");
        s.createIndex("band", "band");
        s.createIndex("cell", "cell");
        s.createIndex("internetOK", "internetOK");
      }
      if (!db.objectStoreNames.contains("events")) {
        const e = db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
        e.createIndex("ts", "ts");
        e.createIndex("kind", "kind");
      }
      if (!db.objectStoreNames.contains("cellStats")) {
        const c = db.createObjectStore("cellStats", { keyPath: "cell" });
        c.createIndex("lastSeen", "lastSeen");
        c.createIndex("timeSeconds", "timeSeconds");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAdd(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).add(value);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbGetRecent(storeName, limit) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.openCursor(null, "prev");
    req.onsuccess = () => {
      const cur = req.result;
      if (cur && out.length < limit) {
        out.push(cur.value);
        cur.continue();
      } else {
        db.close();
        resolve(out.reverse());
      }
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result || []); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function dbPut(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbClearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["samples", "events", "cellStats"], "readwrite");
    tx.objectStore("samples").clear();
    tx.objectStore("events").clear();
    tx.objectStore("cellStats").clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbExportAll() {
  const samples = await dbGetRecent("samples", 1000000);
  const events = await dbGetRecent("events", 1000000);
  const cellStatistics = await getCellStatistics();
  return {
    samples,
    events,
    cellStatistics,
    eventCounters: { ...state.stats },
    monitoringState: {
      enabled: state.monitoringEnabled !== false,
      status: monitoringStatus(),
      lastSuccessfulSampleTs: state.lastSuccessfulSampleTs || null
    },
    watchdog: {
      staleAfterMs: WATCHDOG_STALE_MS,
      restarts: state.stats?.watchdogRestarts || 0,
      lastRestartTs: state.lastWatchdogRestartTs || null
    }
  };
}

async function addEvent(kind, msg) {
  const ev = { ts: Date.now(), time: now(), kind, msg };
  await dbAdd("events", ev);
}

function ensureCollectAlarm() {
  chrome.alarms.create(COLLECT_ALARM, { periodInMinutes: 0.5 });
}

function monitoringStatus() {
  if (!state.monitoringEnabled) return "Disabled";
  return "Active";
}

function defaultStats() {
  return { bandChanges: 0, cellChanges: 0, pciChanges: 0, enodebChanges: 0, earfcnChanges: 0, invalidSamples: 0, internetDrops: 0, watchdogRestarts: 0, samples: 0 };
}

async function load() {
  const data = await chrome.storage.local.get(["lteState", "monitoringEnabled", "modemUrl", "routerUrl", "internetCheckUrl"]);
  if (data.lteState) state = { ...state, ...data.lteState };
  state.stats = { ...defaultStats(), ...(state.stats || {}) };
  state.monitoringEnabled = data.monitoringEnabled !== undefined ? data.monitoringEnabled !== false : state.monitoringEnabled !== false;
  if (!state.monitoringEnabled) {
    state.lastSnapshot = null;
    state.lastError = null;
    state.lastInternetOK = null;
  }
  if (data.modemUrl) state.modem = data.modemUrl;
  if (data.routerUrl) state.router = data.routerUrl;
  if (data.internetCheckUrl) state.internetCheck = data.internetCheckUrl;
}

async function save() {
  const persistedState = { ...state };
  delete persistedState.monitoringEnabled;
  await chrome.storage.local.set({
    lteState: persistedState,
    modemUrl: state.modem,
    routerUrl: state.router,
    internetCheckUrl: state.internetCheck
  });
}

async function fetchText(path, opts = {}) {
  const res = await fetch(state.modem.replace(/\/+$/, "") + path, {
    ...opts,
    signal: AbortSignal.timeout(opts.timeoutMs || 8000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text;
}

function decodeXml(s) {
  return String(s || "")
    .replaceAll("&#40;", "(")
    .replaceAll("&#41;", ")")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&amp;", "&");
}
function val(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeXml(m[1].trim()) : "";
}
function obj(xml, tags) {
  const o = {};
  for (const t of tags) o[t] = val(xml, t);
  return o;
}
function normENB(x) {
  return String(x || "").trim().replace(/^0+/, "") || "0";
}
function num(x) {
  const m = String(x || "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
function normalizeBand(x) {
  return String(x || "").trim().replace(/^B/i, "");
}
function isValidBand(x) {
  const band = normalizeBand(x);
  return !!band && !!BAND_MASKS["B" + band];
}
function cellKey(s) {
  return `B${normalizeBand(s.band)}/${s.pci}/${s.enodeb_id}/${s.earfcn}`;
}
function parseCellKey(key) {
  const parts = String(key || "").split("/");
  if (parts.length < 3) return null;
  return {
    band: normalizeBand(parts[0]),
    pci: parts[1] || "",
    enodeb_id: parts[2] || "",
    earfcn: parts.slice(3).join("/") || ""
  };
}
function signalCell(signal) {
  return {
    band: normalizeBand(signal.band),
    pci: String(signal.pci || "").trim(),
    enodeb_id: normENB(signal.enodeb_id),
    earfcn: String(signal.earfcn || "").trim()
  };
}
function parseEarfcn(earfcn) {
  const text = String(earfcn || "");
  return {
    dl: (text.match(/\bDL\s*:\s*([^\s]+)/i) || [])[1] || "",
    ul: (text.match(/\bUL\s*:\s*([^\s]+)/i) || [])[1] || ""
  };
}
function formatEarfcnChange(oldCell, newCell) {
  const oldEarfcn = parseEarfcn(oldCell.earfcn);
  const newEarfcn = parseEarfcn(newCell.earfcn);
  const lines = [
    "EARFCN CHANGE:",
    `B${newCell.band} / PCI ${newCell.pci || "—"} / eNodeB ${newCell.enodeb_id || "—"}`
  ];

  if (oldEarfcn.dl || newEarfcn.dl) lines.push(`DL:${oldEarfcn.dl || "—"} -> DL:${newEarfcn.dl || "—"}`);
  if (oldEarfcn.ul || newEarfcn.ul) lines.push(`UL:${oldEarfcn.ul || "—"} -> UL:${newEarfcn.ul || "—"}`);
  if (lines.length === 2) lines.push(`${oldCell.earfcn || "—"} -> ${newCell.earfcn || "—"}`);

  return lines.join("\n");
}
function formatPciChange(oldCell, newCell) {
  return `PCI CHANGE: B${newCell.band} eNB${newCell.enodeb_id || "—"} PCI${oldCell.pci || "—"} -> PCI${newCell.pci || "—"}`;
}
function formatEnodebChange(oldCell, newCell) {
  return `ENODEB CHANGE: B${newCell.band} PCI${newCell.pci || "—"} eNB${oldCell.enodeb_id || "—"} -> B${newCell.band} PCI${newCell.pci || "—"} eNB${newCell.enodeb_id || "—"}`;
}
function formatCellChange(oldCell, newCell) {
  return [
    "CELL CHANGE:",
    `B${oldCell.band}/${oldCell.pci}/${oldCell.enodeb_id}/${oldCell.earfcn || "—"} -> B${newCell.band}/${newCell.pci}/${newCell.enodeb_id}/${newCell.earfcn || "—"}`
  ].join("\n");
}
function invalidCellReasons(cell) {
  const reasons = [];
  if (!cell || !isValidBand(cell.band)) reasons.push("empty band");
  if (!cell?.pci) reasons.push("missing PCI");
  if (!cell?.enodeb_id || cell.enodeb_id === "0") reasons.push("missing eNodeB");
  if (!cell?.earfcn) reasons.push("missing EARFCN");
  return reasons;
}
function cellIdentity(cell) {
  if (invalidCellReasons(cell).length) return "";
  return "B" + normalizeBand(cell.band) + "/" + cell.pci + "/" + cell.enodeb_id;
}
function cellIdentityFromKey(key) {
  return cellIdentity(parseCellKey(key));
}
function emptyCellStat(cell, ts) {
  const parsed = parseCellKey(cell);
  return {
    cell,
    band: parsed?.band || "",
    pci: parsed?.pci || "",
    enodeb: parsed?.enodeb_id || "",
    timeSeconds: 0,
    sinrSum: 0,
    sinrCount: 0,
    rsrpSum: 0,
    rsrpCount: 0,
    rsrqSum: 0,
    rsrqCount: 0,
    drops: 0,
    selections: 0,
    lastSeen: ts || Date.now()
  };
}
function addMetric(stat, name, value) {
  if (!Number.isFinite(value)) return;
  stat[name + "Sum"] = (stat[name + "Sum"] || 0) + value;
  stat[name + "Count"] = (stat[name + "Count"] || 0) + 1;
}
function statForExport(stat) {
  const avg = name => stat[name + "Count"] ? stat[name + "Sum"] / stat[name + "Count"] : null;
  return {
    cell: stat.cell,
    band: stat.band,
    pci: stat.pci,
    enodeb: stat.enodeb,
    timeSeconds: Math.round(stat.timeSeconds || 0),
    avgSinr: avg("sinr"),
    avgRsrp: avg("rsrp"),
    avgRsrq: avg("rsrq"),
    drops: stat.drops || 0,
    selections: stat.selections || 0,
    lastSeen: stat.lastSeen || null
  };
}
async function getRawCellStat(cell, ts) {
  return (await dbGet("cellStats", cell)) || emptyCellStat(cell, ts);
}
async function addCellDuration(cell, seconds) {
  if (!cell || !Number.isFinite(seconds) || seconds <= 0) return;
  const stat = await getRawCellStat(cell);
  stat.timeSeconds = (stat.timeSeconds || 0) + seconds;
  await dbPut("cellStats", stat);
}
async function recordCellSample(cell, signal, ts, selected) {
  const stat = await getRawCellStat(cell, ts);
  addMetric(stat, "sinr", num(signal.sinr));
  addMetric(stat, "rsrp", num(signal.rsrp));
  addMetric(stat, "rsrq", num(signal.rsrq));
  if (selected) stat.selections = (stat.selections || 0) + 1;
  stat.lastSeen = ts;
  await dbPut("cellStats", stat);
}
async function recordCellDrop(cell) {
  if (!cell) return;
  const stat = await getRawCellStat(cell);
  stat.drops = (stat.drops || 0) + 1;
  await dbPut("cellStats", stat);
}
function normalizeStoredCellIdentity(value) {
  const parts = String(value || "").split("/");
  if (parts.length < 3) return "";
  const band = normalizeBand(parts[0]);
  const pci = String(parts[1] || "").trim();
  const enodeb = normENB(parts[2]);
  if (!isValidBand(band) || !pci || !enodeb || enodeb === "0") return "";
  return "B" + band + "/" + pci + "/" + enodeb;
}
function sampleCellIdentity(sample) {
  return normalizeStoredCellIdentity(sample?.cellIdentity || sample?.cell);
}
function dropCellIdentity(event) {
  const match = String(event?.msg || "").match(/cell=([^\n]+)/);
  return normalizeStoredCellIdentity(match?.[1]);
}
async function rebuildCellStatisticsFromHistory() {
  const samples = await dbGetRecent("samples", 1000000);
  if (!samples.length) return [];

  const byCell = new Map();
  const statFor = (cell, ts) => {
    if (!byCell.has(cell)) byCell.set(cell, emptyCellStat(cell, ts));
    return byCell.get(cell);
  };

  let previous = null;
  for (const sample of samples) {
    const cell = sampleCellIdentity(sample);
    if (!cell) {
      previous = null;
      continue;
    }

    if (previous?.cell === cell) {
      const seconds = Math.max(0, (sample.ts - previous.ts) / 1000);
      if (seconds <= MAX_CELL_SAMPLE_GAP_SECONDS) statFor(previous.cell, previous.ts).timeSeconds += seconds;
    }

    const stat = statFor(cell, sample.ts);
    addMetric(stat, "sinr", sample.sinr);
    addMetric(stat, "rsrp", sample.rsrp);
    addMetric(stat, "rsrq", sample.rsrq);
    if (!previous || previous.cell !== cell) stat.selections = (stat.selections || 0) + 1;
    stat.lastSeen = sample.ts;
    previous = { cell, ts: sample.ts };
  }

  const events = await dbGetRecent("events", 1000000);
  for (const event of events) {
    if (!String(event.msg || "").includes("INTERNET DROP")) continue;
    const cell = dropCellIdentity(event);
    if (cell) {
      const stat = statFor(cell, event.ts);
      stat.drops = (stat.drops || 0) + 1;
    }
  }

  const rebuilt = [...byCell.values()];
  for (const stat of rebuilt) await dbPut("cellStats", stat);
  return rebuilt;
}
async function getCellStatistics() {
  let stats = await dbGetAll("cellStats");
  if (!stats.length) stats = await rebuildCellStatisticsFromHistory();
  return stats.map(statForExport).sort((a, b) => (b.timeSeconds || 0) - (a.timeSeconds || 0));
}

function maskForBands(bands) {
  let mask = 0n;
  for (const band of bands) {
    const hex = BAND_MASKS[band];
    if (!hex) throw new Error("Unknown band: " + band);
    mask |= BigInt("0x" + hex);
  }
  return mask.toString(16);
}

function bandsFromMask(hex) {
  if (!hex) return [];
  let mask;
  try { mask = BigInt("0x" + hex); } catch { return []; }
  return Object.entries(BAND_MASKS)
    .filter(([_, h]) => (mask & BigInt("0x" + h)) !== 0n)
    .map(([b]) => b);
}

async function getSignal() {
  const x = await fetchText("/api/device/signal");
  const s = obj(x, ["pci","cell_id","rsrq","rsrp","rssi","sinr","band","earfcn","tac","plmn","transmode","enodeb_id","cqi0","cqi1","ulbandwidth","dlbandwidth","ulfrequency","dlfrequency"]);
  s.enodeb_id = normENB(s.enodeb_id);
  return s;
}
async function getNetMode() {
  const x = await fetchText("/api/net/net-mode");
  return obj(x, ["NetworkMode","NetworkBand","LTEBand"]);
}
async function getInfo() {
  try {
    const x = await fetchText("/api/device/information");
    return obj(x, ["DeviceName","SoftwareVersion","WebUIVersion","WanIPAddress","WanIPv6Address","uptime","Classify","workmode","Mccmnc"]);
  } catch { return {}; }
}
async function getToken() {
  const x = await fetchText("/api/webserver/token");
  const t = val(x, "token");
  if (!t) throw new Error("Не удалось получить Huawei token");
  return t;
}
async function postNetMode(mode) {
  const token = await getToken();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<request>
<NetworkMode>${mode.NetworkMode}</NetworkMode>
<NetworkBand>${mode.NetworkBand}</NetworkBand>
<LTEBand>${mode.LTEBand}</LTEBand>
</request>`;
  const text = await fetchText("/api/net/net-mode", {
    method: "POST",
    headers: { "__RequestVerificationToken": token, "Content-Type": "text/xml" },
    body,
    timeoutMs: 20000
  });
  const code = val(text, "code");
  if (code) throw new Error(`Huawei error ${code}: ${text}`);
  return text;
}
async function checkURL(url, timeoutMs = 2500) {
  try {
    await fetch(url, { method: "HEAD", mode: "no-cors", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
async function pingInternet() { return checkURL(state.internetCheck || DEFAULT_INTERNET_CHECK, 2500); }
async function checkRouter() { return checkURL(state.router || DEFAULT_ROUTER, 2500); }
async function restartMonitoringByWatchdog(ts) {
  if (state.lastWatchdogRestartTs && ts - state.lastWatchdogRestartTs < WATCHDOG_STALE_MS) return;
  state.stats.watchdogRestarts++;
  state.lastWatchdogRestartTs = ts;
  chrome.alarms.clear(COLLECT_ALARM, ensureCollectAlarm);
  await addEvent("info", "Monitoring restarted by watchdog");
}
async function runMonitorTick() {
  if (!state.monitoringEnabled) return;
  const ts = Date.now();
  const watchdogBase = state.lastSuccessfulSampleTs || state.startedAt;
  const modemKnownUnavailable = state.lastSnapshot?.modemApiOK === false;
  if (!modemKnownUnavailable && watchdogBase && ts - watchdogBase > WATCHDOG_STALE_MS) {
    await restartMonitoringByWatchdog(ts);
  }
  await collect();
}
async function monitorTick() {
  if (monitorTickInFlight) return monitorTickInFlight;
  monitorTickInFlight = runMonitorTick().finally(() => { monitorTickInFlight = null; });
  return monitorTickInFlight;
}

async function collect() {
  if (!state.monitoringEnabled) return;

  const ts = Date.now();
  const internetOK = await pingInternet();

  let signal, netMode, info;
  try {
    [signal, netMode, info] = await Promise.all([getSignal(), getNetMode(), getInfo()]);
  } catch (e) {
    const shouldLogError = state.lastSnapshot?.modemApiOK !== false || state.lastError !== e.message;
    state.lastInternetOK = internetOK;
    state.lastSnapshot = {
      signal: {},
      netMode: {},
      info: {},
      internetOK,
      routerOK: null,
      modemApiOK: false,
      modemError: e.message,
      ts,
      enabledBands: []
    };
    state.lastError = e.message;
    if (shouldLogError) await addEvent("info", "Modem API unavailable: " + e.message);
    await save();
    return;
  }

  const routerOK = await checkRouter();

  if (!state.backup && netMode.LTEBand) {
    state.backup = { ...netMode };
    await addEvent("info", "Startup band captured: LTEBand=" + netMode.LTEBand);
  }

  const ck = cellKey(signal);
  const currentCell = signalCell(signal);
  const currentIdentity = cellIdentity(currentCell);
  if (!currentIdentity) {
    state.stats.invalidSamples++;
    state.lastSampleTs = null;
    const reasons = invalidCellReasons(currentCell).join(", ") || "incomplete LTE identity";
    await addEvent("debug", "INVALID MODEM SAMPLE: " + reasons);
  } else {
    state.lastSuccessfulSampleTs = ts;
    const previousIdentity = state.lastCellIdentity || cellIdentityFromKey(state.lastCell);
    if (state.lastSampleTs && previousIdentity) {
      const sampleGapSeconds = Math.max(0, (ts - state.lastSampleTs) / 1000);
      if (sampleGapSeconds <= MAX_CELL_SAMPLE_GAP_SECONDS) {
        await addCellDuration(previousIdentity, sampleGapSeconds);
      }
    }

    const selected = !previousIdentity || previousIdentity !== currentIdentity;
    await recordCellSample(currentIdentity, signal, ts, selected);

    const previousCell = parseCellKey(state.lastCell);
    if (previousCell && state.lastCell !== ck) {
      const previousReasons = invalidCellReasons(previousCell);
      if (previousReasons.length) {
        state.stats.invalidSamples++;
        await addEvent("debug", "INVALID MODEM SAMPLE: " + previousReasons.join(", "));
      } else {
        const bandChanged = previousCell.band !== currentCell.band;
        const pciChanged = previousCell.pci !== currentCell.pci;
        const enodebChanged = previousCell.enodeb_id !== currentCell.enodeb_id;
        const earfcnChanged = previousCell.earfcn !== currentCell.earfcn;
        const realCellChanged = bandChanged || pciChanged || enodebChanged;

        if (realCellChanged) {
          if (pciChanged || enodebChanged) state.stats.cellChanges++;
          if (bandChanged) {
            state.stats.bandChanges++;
            await addEvent("warn", "BAND CHANGE: B" + previousCell.band + " -> B" + currentCell.band);
          }
          if (enodebChanged) {
            state.stats.enodebChanges++;
            await addEvent("warn", formatEnodebChange(previousCell, currentCell));
          } else if (pciChanged) {
            state.stats.pciChanges++;
            await addEvent("warn", formatPciChange(previousCell, currentCell));
          } else if (!bandChanged) {
            await addEvent("warn", formatCellChange(previousCell, currentCell));
          }
        } else if (earfcnChanged) {
          state.stats.earfcnChanges++;
          await addEvent("info", formatEarfcnChange(previousCell, currentCell));
        }
      }
    }
    state.lastCell = ck;
    state.lastCellIdentity = currentIdentity;
    state.lastSampleTs = ts;
  }

  if (currentIdentity && state.lastInternetOK !== null && state.lastInternetOK && !internetOK) {
    state.stats.internetDrops++;
    await recordCellDrop(currentIdentity);
    await addEvent("bad", "INTERNET DROP while cell=" + ck);
  }
  if (currentIdentity && state.lastInternetOK !== null && !state.lastInternetOK && internetOK) {
    await addEvent("good", "INTERNET RECOVERED while cell=" + ck);
  }
  state.lastInternetOK = internetOK;

  state.lastSnapshot = { signal, netMode, info, internetOK, routerOK, modemApiOK: true, ts, enabledBands: bandsFromMask(netMode.LTEBand) };

  await dbAdd("samples", {
    ts,
    sinr: num(signal.sinr),
    rsrp: num(signal.rsrp),
    rsrq: num(signal.rsrq),
    rssi: num(signal.rssi),
    band: signal.band,
    pci: signal.pci,
    enodeb: signal.enodeb_id,
    earfcn: signal.earfcn,
    cell: ck,
    cellIdentity: currentIdentity,
    internetOK,
    routerOK
  });

  state.stats.samples++;
  state.lastError = null;
  await save();
}

async function setUrls({ modem, router, internetCheck }) {
  const previousModem = state.modem;
  const previousRouter = state.router;
  const previousInternetCheck = state.internetCheck;

  if (modem !== undefined) state.modem = normalizeURL(modem || DEFAULT_MODEM);
  if (router !== undefined) state.router = normalizeURL(router || DEFAULT_ROUTER);
  if (internetCheck !== undefined) state.internetCheck = normalizeURL(internetCheck || DEFAULT_INTERNET_CHECK);

  const changed = previousModem !== state.modem || previousRouter !== state.router || previousInternetCheck !== state.internetCheck;
  if (changed) {
    state.lastSnapshot = null;
    state.lastError = null;
    state.lastInternetOK = null;
    await save();
    if (state.monitoringEnabled) await monitorTick();
    return;
  }

  await save();
}
function normalizeURL(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s.replace(/\/+$/, "");
  return ("http://" + s).replace(/\/+$/, "");
}
async function lockBands(bands) {
  if (!Array.isArray(bands) || bands.length === 0) throw new Error("Select at least one band");
  const cur = await getNetMode();
  if (!state.backup) state.backup = { ...cur };
  const mask = maskForBands(bands);
  await postNetMode({
    NetworkMode: cur.NetworkMode || DEFAULT_MODE.NetworkMode,
    NetworkBand: cur.NetworkBand || DEFAULT_MODE.NetworkBand,
    LTEBand: mask
  });
  await addEvent("user", "Band lock applied: " + bands.join("+") + " LTEBand=" + mask);
  await save();
}
async function restoreDefault() {
  await postNetMode(DEFAULT_MODE);
  await addEvent("user", "Restore default band: LTEBand=" + DEFAULT_MODE.LTEBand);
  await save();
}
async function restoreStartupBand() {
  if (!state.backup) throw new Error("Startup band was not captured yet");
  await postNetMode(state.backup);
  await addEvent("user", "Restore startup band: LTEBand=" + state.backup.LTEBand);
  await save();
}
async function setMonitoring(enabled) {
  const next = enabled === true;
  const changed = state.monitoringEnabled !== next;
  state.monitoringEnabled = next;
  await chrome.storage.local.set({ monitoringEnabled: next });
  if (next) {
    ensureCollectAlarm();
    if (changed) await addEvent("user", "Monitoring enabled");
    await monitorTick();
  } else {
    chrome.alarms.clear(COLLECT_ALARM);
    state.lastSnapshot = null;
    state.lastError = null;
    state.lastInternetOK = null;
    if (changed) await addEvent("user", "Monitoring disabled");
  }
  await save();
}
async function markUserAction(action) {
  const allowed = new Map([
    ["routerReboot", "Router reboot"],
    ["modemReconnect", "Modem reconnect"]
  ]);
  const label = allowed.get(action);
  if (!label) throw new Error("Unknown user action: " + action);
  await addEvent("user", label);
}
async function clearHistory() {
  await dbClearAll();
  state.stats = defaultStats();
  state.startedAt = Date.now();
  state.lastCell = null;
  state.lastCellIdentity = null;
  state.lastSampleTs = null;
  state.lastSuccessfulSampleTs = null;
  state.lastWatchdogRestartTs = null;
  state.lastInternetOK = null;
  await save();
}
async function refreshStaleMonitoringState() {
  if (!state.monitoringEnabled) return;
  ensureCollectAlarm();

  const ts = Date.now();
  const snapshotTs = state.lastSnapshot?.ts || 0;
  const hasNoSnapshot = !state.lastSnapshot;
  const hasLegacyUnavailableSnapshot = state.lastSnapshot?.modemApiOK === false && !state.lastSnapshot?.modemError && !state.lastError;
  const unavailableIsStale = state.lastSnapshot?.modemApiOK === false && snapshotTs && ts - snapshotTs > MODEM_UNAVAILABLE_RETRY_MS;
  const sampleIsStale = snapshotTs && ts - snapshotTs > WATCHDOG_STALE_MS;

  if (hasNoSnapshot || hasLegacyUnavailableSnapshot || unavailableIsStale || sampleIsStale) {
    await monitorTick();
  }
}
async function getFullState() {
  await refreshStaleMonitoringState();
  const history = await dbGetRecent("samples", MAX_HISTORY_POINTS_FOR_UI);
  const events = await dbGetRecent("events", MAX_EVENTS_FOR_UI);
  const cellStatistics = await getCellStatistics();
  return { ...state, monitoringStatus: monitoringStatus(), history, events, cellStatistics, bandMasks: BAND_MASKS, defaultMode: DEFAULT_MODE };
}

chrome.runtime.onInstalled.addListener(async () => {
  await load();
  if (state.monitoringEnabled) ensureCollectAlarm();
  await addEvent("info", "Extension installed/updated. Background collector started.");
  await monitorTick();
});
chrome.runtime.onStartup.addListener(async () => {
  await load();
  if (state.monitoringEnabled) ensureCollectAlarm();
  await addEvent("info", "Browser startup. Background collector started.");
  await monitorTick();
});
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === COLLECT_ALARM) {
    await load();
    await monitorTick();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await load();
    if (msg.type === "getState") return await getFullState();
    if (msg.type === "refreshNow") { await monitorTick(); return await getFullState(); }
    if (msg.type === "setUrls") { await setUrls(msg); return await getFullState(); }
    if (msg.type === "setMonitoring") { await setMonitoring(msg.enabled); return await getFullState(); }
    if (msg.type === "markUserAction") { await markUserAction(msg.action); return await getFullState(); }
    if (msg.type === "lockBands") { await lockBands(msg.bands); return await getFullState(); }
    if (msg.type === "restoreDefault") { await restoreDefault(); return await getFullState(); }
    if (msg.type === "restoreStartupBand" || msg.type === "restoreBackup") { await restoreStartupBand(); return await getFullState(); }
    if (msg.type === "clearHistory") { await clearHistory(); return await getFullState(); }
    if (msg.type === "exportAll") {
      const all = await dbExportAll();
      return { ...state, ...all, bandMasks: BAND_MASKS };
    }
    throw new Error("Unknown message: " + msg.type);
  })().then(
    data => sendResponse({ ok: true, data }),
    err => sendResponse({ ok: false, error: err.message })
  );
  return true;
});
