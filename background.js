const DEFAULT_MODE = { NetworkMode: "03", NetworkBand: "2000000400000", LTEBand: "a0080800c5" }; // from net-mode-backup.xml
const DEFAULT_MODEM = "http://192.168.8.1";
const DEFAULT_ROUTER = "http://192.168.1.1";
const DEFAULT_INTERNET_CHECK = "https://cloudflare-dns.com/dns-query";

const BAND_MASKS = {
  B1:"1", B3:"4", B7:"40", B8:"80",
  B20:"80000", B28:"8000000", B38:"2000000000", B40:"8000000000"
};

const DB_NAME = "huawei_lte_panel";
const DB_VERSION = 1;
const MAX_HISTORY_POINTS_FOR_UI = 2000;
const MAX_EVENTS_FOR_UI = 500;

let state = {
  modem: DEFAULT_MODEM,
  router: DEFAULT_ROUTER,
  internetCheck: DEFAULT_INTERNET_CHECK,
  backup: null,
  lastCell: null,
  lastInternetOK: null,
  startedAt: Date.now(),
  stats: { bandChanges: 0, cellChanges: 0, internetDrops: 0, samples: 0 },
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

async function dbClearAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["samples", "events"], "readwrite");
    tx.objectStore("samples").clear();
    tx.objectStore("events").clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbExportAll() {
  const samples = await dbGetRecent("samples", 1000000);
  const events = await dbGetRecent("events", 1000000);
  return { samples, events };
}

async function addEvent(kind, msg) {
  const ev = { ts: Date.now(), time: now(), kind, msg };
  await dbAdd("events", ev);
}

async function load() {
  const data = await chrome.storage.local.get(["lteState", "modemUrl", "routerUrl", "internetCheckUrl"]);
  if (data.lteState) state = { ...state, ...data.lteState };
  if (data.modemUrl) state.modem = data.modemUrl;
  if (data.routerUrl) state.router = data.routerUrl;
  if (data.internetCheckUrl) state.internetCheck = data.internetCheckUrl;
}

async function save() {
  await chrome.storage.local.set({
    lteState: state,
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
function cellKey(s) {
  return `B${s.band}/${s.pci}/${s.enodeb_id}/${s.earfcn}`;
}
function cellStatus(s) {
  return [`B${s.band || "—"} / PCI ${s.pci || "—"} / eNodeB ${s.enodeb_id || "—"}`, "muted"];
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

async function collect() {
  try {
    const [signal, netMode, info, internetOK, routerOK] = await Promise.all([
      getSignal(), getNetMode(), getInfo(), pingInternet(), checkRouter()
    ]);

    if (!state.backup && netMode.LTEBand) {
      state.backup = { ...netMode };
      await addEvent("info", `Startup band captured: LTEBand=${netMode.LTEBand}`);
    }

    const ck = cellKey(signal);
    if (state.lastCell && state.lastCell !== ck) {
      const oldBand = (state.lastCell.match(/^B([^/]+)/) || [])[1];
      if (oldBand && oldBand !== signal.band) {
        state.stats.bandChanges++;
        await addEvent("warn", `BAND CHANGE: B${oldBand} -> B${signal.band}`);
      }
      state.stats.cellChanges++;
      await addEvent("warn", `CELL CHANGE: ${state.lastCell} -> ${ck}`);
    }
    state.lastCell = ck;

    if (state.lastInternetOK !== null && state.lastInternetOK && !internetOK) {
      state.stats.internetDrops++;
      await addEvent("bad", `INTERNET DROP while cell=${ck}`);
    }
    if (state.lastInternetOK !== null && !state.lastInternetOK && internetOK) {
      await addEvent("good", `INTERNET RECOVERED while cell=${ck}`);
    }
    state.lastInternetOK = internetOK;

    const [cellLabel, cellClass] = cellStatus(signal);
    state.lastSnapshot = { signal, netMode, info, internetOK, routerOK, cellLabel, cellClass, ts: Date.now(), enabledBands: bandsFromMask(netMode.LTEBand) };

    await dbAdd("samples", {
      ts: Date.now(),
      sinr: num(signal.sinr),
      rsrp: num(signal.rsrp),
      rsrq: num(signal.rsrq),
      rssi: num(signal.rssi),
      band: signal.band,
      pci: signal.pci,
      enodeb: signal.enodeb_id,
      earfcn: signal.earfcn,
      cell: ck,
      internetOK,
      routerOK
    });

    state.stats.samples++;
    state.lastError = null;
  } catch (e) {
    state.lastError = e.message;
    await addEvent("error", e.message);
  }

  await save();
}

async function setUrls({ modem, router, internetCheck }) {
  if (modem !== undefined) state.modem = String(modem || DEFAULT_MODEM).replace(/\/+$/, "");
  if (router !== undefined) state.router = normalizeURL(router || DEFAULT_ROUTER);
  if (internetCheck !== undefined) state.internetCheck = normalizeURL(internetCheck || DEFAULT_INTERNET_CHECK);
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
  await addEvent("action", `LOCK ${bands.join("+")}: LTEBand=${mask}`);
  await save();
}
async function restoreDefault() {
  await postNetMode(DEFAULT_MODE);
  await addEvent("action", `RESTORE DEFAULT: LTEBand=${DEFAULT_MODE.LTEBand}`);
  await save();
}
async function restoreStartupBand() {
  if (!state.backup) throw new Error("Startup band was not captured yet");
  await postNetMode(state.backup);
  await addEvent("action", `RESTORE STARTUP BAND: LTEBand=${state.backup.LTEBand}`);
  await save();
}
async function clearHistory() {
  await dbClearAll();
  state.stats = { bandChanges: 0, cellChanges: 0, internetDrops: 0, samples: 0 };
  state.startedAt = Date.now();
  state.lastCell = null;
  state.lastInternetOK = null;
  await save();
}
async function getFullState() {
  const history = await dbGetRecent("samples", MAX_HISTORY_POINTS_FOR_UI);
  const events = await dbGetRecent("events", MAX_EVENTS_FOR_UI);
  return { ...state, history, events, bandMasks: BAND_MASKS, defaultMode: DEFAULT_MODE };
}

chrome.runtime.onInstalled.addListener(async () => {
  await load();
  chrome.alarms.create("collect", { periodInMinutes: 0.5 }); // Chrome MV3 reliable minimum is about 30 sec
  await addEvent("info", "Extension installed/updated. Background collector started.");
  await collect();
});
chrome.runtime.onStartup.addListener(async () => {
  await load();
  chrome.alarms.create("collect", { periodInMinutes: 0.5 }); // Chrome MV3 reliable minimum is about 30 sec
  await addEvent("info", "Browser startup. Background collector started.");
  await collect();
});
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === "collect") {
    await load();
    await collect();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await load();
    if (msg.type === "getState") return await getFullState();
    if (msg.type === "refreshNow") { await collect(); return await getFullState(); }
    if (msg.type === "setUrls") { await setUrls(msg); return await getFullState(); }
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
