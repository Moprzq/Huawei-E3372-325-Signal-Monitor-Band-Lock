const $ = id => document.getElementById(id);
const row = (k,v,c="") => `<div class="row"><span class="k">${k}</span><span class="v ${c}">${v ?? "—"}</span></div>`;

let latestState = null;
let pendingMonitoringEnabled = null;
let monitoringToggleRequestId = 0;
const MONITORING_OVERRIDE_KEY = "lteMonitoringEnabled";
const popupOpenedAt = Date.now();

function localMonitoringEnabled(state) {
  const value = localStorage.getItem(MONITORING_OVERRIDE_KEY);
  if (value === "true") return true;
  if (value === "false") return false;
  return state?.monitoringEnabled !== false;
}
function ensureMonitoringOverrideInitialized(state) {
  if (localStorage.getItem(MONITORING_OVERRIDE_KEY) === null && state?.monitoringEnabled !== undefined) {
    localStorage.setItem(MONITORING_OVERRIDE_KEY, String(state.monitoringEnabled !== false));
  }
}
function withLocalMonitoringState(state) {
  const enabled = localMonitoringEnabled(state);
  return { ...(state || {}), monitoringEnabled: enabled, monitoringStatus: enabled ? "Active" : "Disabled" };
}

function msg(text, cls="muted") {
  $("message").className = "hint " + cls;
  $("message").textContent = text;
}
function send(type, payload={}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, resp => {
      if (!resp) return reject(new Error("No response from background worker"));
      if (!resp.ok) return reject(new Error(resp.error));
      resolve(resp.data);
    });
  });
}
function num(x) {
  const m = String(x||"").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
function cqi(x) {
  const v = num(x);
  return Number.isNaN(v) || v >= 127 ? "N/A" : String(v);
}
function rate(name, raw) {
  const v = num(raw);
  if (Number.isNaN(v)) return ["unknown","muted"];
  if (name === "sinr") return v >= 15 ? ["very good","good"] : v >= 10 ? ["good","good"] : v >= 5 ? ["medium","warn"] : ["bad","bad"];
  if (name === "rsrp") return v >= -90 ? ["very good","good"] : v >= -100 ? ["good","good"] : v >= -110 ? ["medium","warn"] : ["bad","bad"];
  if (name === "rsrq") return v >= -8 ? ["very good","good"] : v >= -10 ? ["good","good"] : v >= -12 ? ["medium","warn"] : ["bad","bad"];
  return ["secondary","muted"];
}
function maskForBands(bands, masks) {
  let mask = 0n;
  for (const b of bands) mask |= BigInt("0x" + masks[b]);
  return mask.toString(16);
}

function bandsFromMaskLocal(hex, masks) {
  if (!hex || !masks) return [];
  let mask;
  try { mask = BigInt("0x" + hex); } catch { return []; }
  return Object.entries(masks)
    .filter(([_, h]) => (mask & BigInt("0x" + h)) !== 0n)
    .map(([b]) => b);
}
function selectedBands() {
  return [...document.querySelectorAll(".bandCheck:checked")].map(x => x.value);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
}
function formatAvg(value, unit, digits=1) {
  return Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : "—";
}
function formatRelativeTime(ts) {
  if (!ts) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleString();
}
function formatCellLabel(cell) {
  const parts = String(cell || "").split("/");
  if (parts.length < 3) return cell || "—";
  return parts[0] + " / PCI" + parts[1] + " / eNB" + parts[2];
}
function renderMonitoring(state) {
  const effectiveMonitoringEnabled = pendingMonitoringEnabled !== null ? pendingMonitoringEnabled : localMonitoringEnabled(state);
  const status = effectiveMonitoringEnabled ? "Active" : "Disabled";
  const badge = $("monitoringBadge");
  const toggle = $("monitoringToggle");
  if (!badge || !toggle) return;
  const cls = status === "Active" ? "good" : "muted";
  badge.className = "badge " + cls;
  badge.textContent = "Monitoring: " + status;
  toggle.textContent = effectiveMonitoringEnabled ? "ON" : "OFF";
  toggle.dataset.enabled = effectiveMonitoringEnabled ? "1" : "0";
  const lastSample = state.lastSuccessfulSampleTs ? formatRelativeTime(state.lastSuccessfulSampleTs) : "—";
  $("monitoringDetails").innerHTML =
    row("Last successful modem sample", lastSample)+
    row("Watchdog restarts", state.stats?.watchdogRestarts || 0);
}

async function refresh(now=false, manual=false) {
  if (!manual && !localMonitoringEnabled(latestState)) return;
  const requestId = monitoringToggleRequestId;
  const refreshBtn = document.getElementById("refreshBtn");
  if (manual) refreshBtn.disabled = true;
  try {
    const state = await send(now ? "refreshNow" : "getState");
    if (requestId !== monitoringToggleRequestId) return;
    ensureMonitoringOverrideInitialized(state);
    latestState = withLocalMonitoringState(state);
    render(latestState);
  } catch(e) {
    msg("Error: " + e.message, "bad");
  } finally {
    if (manual) refreshBtn.disabled = false;
  }
}
function render(state) {
  $("modemUrl").value = state.modem || "http://192.168.8.1";
  $("routerUrl").value = state.router || "http://192.168.1.1";
  $("internetCheckUrl").value = state.internetCheck || "https://cloudflare-dns.com/dns-query";
  renderBandCheckboxes(state);
  renderMonitoring(state);
  const monitoringEnabled = pendingMonitoringEnabled !== null ? pendingMonitoringEnabled : state.monitoringEnabled !== false;
  const statusData = document.getElementById("statusData");
  if (statusData) statusData.style.display = monitoringEnabled ? "grid" : "none";
  if (!monitoringEnabled) {
    document.getElementById("subtitle").textContent = state.modem + " · monitoring disabled";
    renderStats(state);
    renderCellStatistics(state);
    renderEvents(state);
    drawChart(state);
    updateMaskPreview();
    return;
  }
  const snap = state.lastSnapshot;
  if (!snap) {
    msg("No data yet. Click refresh or wait for background collector.", "warn");
    renderStats(state);
    renderCellStatistics(state);
    renderEvents(state);
    drawChart(state);
    return;
  }

  const modemApiOK = snap.modemApiOK === true;
  const s = modemApiOK ? (snap.signal || {}) : {};
  const n = modemApiOK ? (snap.netMode || {}) : {};
  const i = modemApiOK ? (snap.info || {}) : {};
  document.getElementById("subtitle").textContent = state.modem + " · " + (modemApiOK ? (i.DeviceName || "Huawei HiLink") : "modem unavailable") + " · last " + new Date(snap.ts).toLocaleTimeString();
  $("cellBadge").className = "badge " + (modemApiOK ? "muted" : "bad");
  $("cellBadge").textContent = modemApiOK ? "CURRENT CELL" : "MODEM UNAVAILABLE";
  $("servingCell").innerHTML =
    row("Band", s.band ? "B" + s.band : "—")+
    row("PCI", s.pci || "—")+
    row("eNodeB", s.enodeb_id || "—")+
    row("EARFCN", s.earfcn || "—");

  $("radio").innerHTML =
    row("Band",s.band ? "B" + s.band : "—")+row("PCI",s.pci || "—")+row("eNodeB",s.enodeb_id || "—")+row("EARFCN",s.earfcn || "—")+
    row("Cell ID",s.cell_id || "—")+row("TAC",s.tac || "—")+row("DL/UL BW",(s.dlbandwidth||"—")+" / "+(s.ulbandwidth||"—"))+row("Mode",s.transmode || "—");

  const [sinrR,sinrC]=rate("sinr",s.sinr), [rsrpR,rsrpC]=rate("rsrp",s.rsrp), [rsrqR,rsrqC]=rate("rsrq",s.rsrq);
  document.getElementById("signal").innerHTML =
    row("SINR", modemApiOK ? (String(s.sinr || "—") + " · " + sinrR) : "—", modemApiOK ? sinrC : "muted")+row("RSRP", modemApiOK ? (String(s.rsrp || "—") + " · " + rsrpR) : "—", modemApiOK ? rsrpC : "muted")+
    row("RSRQ", modemApiOK ? (String(s.rsrq || "—") + " · " + rsrqR) : "—", modemApiOK ? rsrqC : "muted")+row("RSSI", modemApiOK ? (s.rssi || "—") : "—")+row("CQI0", modemApiOK ? cqi(s.cqi0) : "—")+row("CQI1", modemApiOK ? cqi(s.cqi1) : "—");

  const routerLabel = snap.routerOK === null ? "not checked" : snap.routerOK ? "OK" : "DOWN";
  const routerClass = snap.routerOK === null ? "muted" : snap.routerOK ? "good" : "bad";
  $("checks").innerHTML =
    row("Router", routerLabel, routerClass)+
    row("Internet", snap.internetOK ? "OK" : "DOWN", snap.internetOK ? "good" : "bad")+
    row("Modem API", modemApiOK ? "OK" : "DOWN", modemApiOK ? "good" : "bad")+
    row("WAN IPv4", i.WanIPAddress || "—")+
    row("Modem uptime", i.uptime ? formatDuration(i.uptime) : "—");

  const enabledBands = snap.enabledBands || [];
  const currentText = enabledBands.length === 1
    ? enabledBands[0] + " only"
    : enabledBands.length > 1
      ? enabledBands.join("+")
      : "unknown";

  const backupBands = bandsFromMaskLocal(state.backup?.LTEBand, state.bandMasks || {});
  const backupText = backupBands.length === 1
    ? backupBands[0] + " only"
    : backupBands.length > 1
      ? backupBands.join("+")
      : (state.backup?.LTEBand || "—");

  const lockStatus = enabledBands.length === 1 ? "LOCKED" : "MULTI-BAND / UNLOCKED";

  $("netMode").innerHTML =
    row("Current bands", currentText, enabledBands.length === 1 ? "warn" : "good")+
    row("Lock status", lockStatus, enabledBands.length === 1 ? "warn" : "good")+
    row("Current LTEBand mask", n.LTEBand)+
    row("Startup bands", backupText)+
    row("Startup LTEBand mask", state.backup?.LTEBand || "—")+
    row("Raw NetworkMode", n.NetworkMode)+
    row("Raw NetworkBand", n.NetworkBand);

  const backupSame = state.backup?.LTEBand && n.LTEBand && state.backup.LTEBand.toLowerCase() === n.LTEBand.toLowerCase();
  $("backupWarning").textContent = backupSame
    ? "⚠ Startup band equals current LTEBand. Restore startup band will not change the current band configuration. Use Restore default band if you need the default multi-band mask."
    : "";

  $("recommendation").innerHTML = buildRecommendation(state, snap, enabledBands);

  renderStats(state);
  renderCellStatistics(state);
  renderEvents(state);
  drawChart(state);
  updateMaskPreview();
  if (!modemApiOK) msg("Modem API unavailable. Internet check is still running.", "warn");
  else if (state.lastError) msg("Last background error: " + state.lastError, "warn");
  else msg("OK " + new Date().toLocaleTimeString(), "good");
}
function renderBandCheckboxes(state) {
  const masks = state.bandMasks || {};
  const root = $("bandCheckboxes");
  if (root.dataset.ready === "1") return;
  root.innerHTML = Object.entries(masks).map(([band, mask]) => `
    <label class="bandItem">
      <input class="bandCheck" type="checkbox" value="${band}" ${band==="B7" ? "checked" : ""}>
      <span>${band}</span>
      <span class="muted">0x${mask}</span>
    </label>
  `).join("");
  root.dataset.ready = "1";
  root.addEventListener("change", updateMaskPreview);
  updateMaskPreview();
}
function updateMaskPreview() {
  if (!latestState?.bandMasks) return;
  const bands = selectedBands();
  if (bands.length === 0) {
    $("maskPreview").textContent = "Select at least one band.";
    return;
  }
  $("maskPreview").textContent = `Selected: ${bands.join("+")} → LTEBand=${maskForBands(bands, latestState.bandMasks)}`;
}
function renderStats(state) {
  const history = state.history || [];
  const events = state.events || [];

  const viewHistory = history.filter(x => x.ts >= popupOpenedAt);
  const viewEvents = events.filter(x => x.ts >= popupOpenedAt);

  const allSec = Math.round((Date.now() - (state.startedAt || Date.now())) / 1000);
  const viewSec = Math.round((Date.now() - popupOpenedAt) / 1000);

  const viewStats = calcStatsFromData(viewHistory, viewEvents);
  const allStats = {
    bandChanges: state.stats?.bandChanges || 0,
    cellChanges: state.stats?.cellChanges || 0,
    pciChanges: state.stats?.pciChanges || 0,
    enodebChanges: state.stats?.enodebChanges || 0,
    earfcnChanges: state.stats?.earfcnChanges || 0,
    invalidSamples: state.stats?.invalidSamples || 0,
    internetDrops: state.stats?.internetDrops || 0,
    watchdogRestarts: state.stats?.watchdogRestarts || 0,
    samples: state.stats?.samples || 0,
    currentSamplesShown: history.length
  };

  $("viewStats").innerHTML =
    row("Popup uptime", formatDuration(viewSec))+
    row("Band changes", viewStats.bandChanges)+
    row("PCI changes", viewStats.pciChanges)+
    row("eNodeB changes", viewStats.enodebChanges)+
    row("EARFCN changes", viewStats.earfcnChanges)+
    row("Internet drops", viewStats.internetDrops)+
    row("Invalid samples", viewStats.invalidSamples)+
    row("Watchdog restarts", viewStats.watchdogRestarts)+
    row("Samples", viewStats.samples)+
    row("Current band", latestBand(viewHistory));

  $("allStats").innerHTML =
    row("Extension uptime", formatDuration(allSec))+
    row("Band changes", allStats.bandChanges)+
    row("PCI changes", allStats.pciChanges)+
    row("eNodeB changes", allStats.enodebChanges)+
    row("EARFCN changes", allStats.earfcnChanges)+
    row("Internet drops", allStats.internetDrops)+
    row("Invalid samples", allStats.invalidSamples)+
    row("Watchdog restarts", allStats.watchdogRestarts)+
    row("Samples total", allStats.samples)+
    row("Samples shown", allStats.currentSamplesShown)+
    row("Current band", latestBand(history));
}

function calcStatsFromData(history, events) {
  const msg = event => String(event.msg || "");
  const isCellChangeEvent = event => /\b(CELL|PCI|ENODEB|eNodeB) CHANGE\b/.test(msg(event));
  return {
    bandChanges: events.filter(e => msg(e).includes("BAND CHANGE")).length,
    cellChanges: events.filter(isCellChangeEvent).length,
    pciChanges: events.filter(e => msg(e).includes("PCI CHANGE")).length,
    enodebChanges: events.filter(e => /\b(ENODEB|eNodeB) CHANGE\b/.test(msg(e))).length,
    earfcnChanges: events.filter(e => msg(e).includes("EARFCN CHANGE")).length,
    invalidSamples: events.filter(e => msg(e).includes("INVALID MODEM SAMPLE")).length,
    watchdogRestarts: events.filter(e => msg(e).includes("Monitoring restarted by watchdog")).length,
    internetDrops: events.filter(e => msg(e).includes("INTERNET DROP")).length,
    samples: history.length
  };
}

function normalizeCellKey(value) {
  const parts = String(value || "").split("/");
  if (parts.length < 3) return "";
  const band = parts[0].replace(/^B/i, "");
  const pci = parts[1] || "";
  const enodeb = parts[2] || "";
  if (!band || !pci || !enodeb) return "";
  return `B${band}/${pci}/${enodeb}`;
}
function emptyCellStat(cell, ts) {
  const parts = cell.split("/");
  return { cell, band: parts[0]?.replace(/^B/i, "") || "", pci: parts[1] || "", enodeb: parts[2] || "", timeSeconds: 0, sinrSum: 0, sinrCount: 0, rsrpSum: 0, rsrpCount: 0, rsrqSum: 0, rsrqCount: 0, drops: 0, selections: 0, lastSeen: ts || null };
}
function addStatMetric(stat, name, value) {
  if (!Number.isFinite(value)) return;
  stat[name + "Sum"] += value;
  stat[name + "Count"] += 1;
}
function finalizeCellStat(stat) {
  const avg = name => stat[name + "Count"] ? stat[name + "Sum"] / stat[name + "Count"] : null;
  return { cell: stat.cell, band: stat.band, pci: stat.pci, enodeb: stat.enodeb, timeSeconds: Math.round(stat.timeSeconds || 0), avgSinr: avg("sinr"), avgRsrp: avg("rsrp"), avgRsrq: avg("rsrq"), drops: stat.drops || 0, selections: stat.selections || 0, lastSeen: stat.lastSeen || null };
}
function buildCellStatisticsFromHistory(history, events) {
  const byCell = new Map();
  const statFor = (cell, ts) => {
    if (!byCell.has(cell)) byCell.set(cell, emptyCellStat(cell, ts));
    return byCell.get(cell);
  };
  let previous = null;
  for (const sample of history || []) {
    const cell = normalizeCellKey(sample.cellIdentity || sample.cell);
    if (!cell) {
      previous = null;
      continue;
    }
    if (previous?.cell === cell) {
      const delta = Math.max(0, (sample.ts - previous.ts) / 1000);
      if (delta <= 300) statFor(previous.cell, previous.ts).timeSeconds += delta;
    }
    const stat = statFor(cell, sample.ts);
    addStatMetric(stat, "sinr", sample.sinr);
    addStatMetric(stat, "rsrp", sample.rsrp);
    addStatMetric(stat, "rsrq", sample.rsrq);
    if (!previous || previous.cell !== cell) stat.selections += 1;
    stat.lastSeen = sample.ts;
    previous = { cell, ts: sample.ts };
  }
  for (const event of events || []) {
    if (!String(event.msg || "").includes("INTERNET DROP")) continue;
    const cell = normalizeCellKey((String(event.msg || "").match(/cell=([^\n]+)/) || [])[1]);
    if (cell) statFor(cell, event.ts).drops += 1;
  }
  return [...byCell.values()].map(finalizeCellStat).sort((a, b) => (b.timeSeconds || 0) - (a.timeSeconds || 0));
}
function renderCellStatistics(state) {
  const root = $("cellStatsBody");
  if (!root) return;
  const persistedRows = state.cellStatistics || [];
  const rows = (persistedRows.length ? persistedRows : buildCellStatisticsFromHistory(state.history || [], state.events || []))
    .sort((a, b) => (b.timeSeconds || 0) - (a.timeSeconds || 0));
  if (!rows.length) {
    root.innerHTML = '<tr><td colspan="8" class="emptyCellStats">no cell statistics yet</td></tr>';
    return;
  }
  root.innerHTML = rows.map(item => `
    <tr>
      <td>${escapeHtml(formatCellLabel(item.cell))}</td>
      <td>${formatDuration(Math.round(item.timeSeconds || 0))}</td>
      <td>${formatAvg(item.avgSinr, "dB")}</td>
      <td>${formatAvg(item.avgRsrp, "dBm")}</td>
      <td>${formatAvg(item.avgRsrq, "dB")}</td>
      <td>${item.drops || 0}</td>
      <td>${item.selections || 0}</td>
      <td>${formatRelativeTime(item.lastSeen)}</td>
    </tr>
  `).join("");
}

function latestBand(history) {
  if (!history || history.length === 0) return "—";
  const last = history[history.length - 1];
  return last.band ? "B" + last.band : "—";
}
function renderEvents(state) {
  const events = state.events || [];
  const viewEvents = events.filter(e => e.ts >= popupOpenedAt);
  const viewText = viewEvents.map(e => `${e.time} [${e.kind}] ${e.msg}`).join("\n") || "no events since popup opened";
  const allText = events.map(e => `${e.time} [${e.kind}] ${e.msg}`).join("\n") || "no events in all history";
  $("events").textContent =
    "=== Since popup opened ===\n" + viewText +
    "\n\n=== All history shown ===\n" + allText;
}
function formatDuration(seconds) {
  seconds = Number(seconds || 0);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
const fmt = formatDuration;
function drawChart(state) {
  const c = $("sinrChart"), ctx = c.getContext("2d");
  ctx.clearRect(0,0,c.width,c.height);
  ctx.strokeStyle="#30363d"; ctx.lineWidth=1;
  for(let i=0;i<5;i++){ const y=22+i*42; ctx.beginPath(); ctx.moveTo(40,y); ctx.lineTo(c.width-20,y); ctx.stroke(); }
  ctx.fillStyle="#8b949e"; ctx.font="13px monospace"; ctx.fillText("SINR",8,18);
  const data = (state.history || []).slice(-180);
  if(data.length < 2) return;
  const min=-5,max=25;
  const xFor=i=>40+i*(c.width-65)/(data.length-1);
  const yFor=v=>c.height-24-((Math.max(min,Math.min(max,v))-min)/(max-min))*(c.height-50);
  ctx.strokeStyle="#3fb950"; ctx.lineWidth=2.5; ctx.beginPath();
  data.forEach((p,i)=>{ const x=xFor(i), y=yFor(p.sinr); if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y); });
  ctx.stroke();
  ctx.fillStyle="#f85149";
  data.forEach((p,i)=>{ if(!p.internetOK){ const x=xFor(i); ctx.fillRect(x-1, 8, 2, c.height-18); } });
}
function buildRecommendation(state, snap, enabledBands) {
  const drops = state.stats?.internetDrops || 0;
  const bandChanges = state.stats?.bandChanges || 0;
  const internetOK = !!snap.internetOK;
  const sinr = snap.signal?.sinr || "—";

  let cls = "muted";
  let title = "Observe";
  let text = "Keep collecting data. Use history to compare drops before and after band changes.";

  if (!internetOK) {
    cls = "bad";
    title = "Internet check is down";
    text = snap.modemApiOK === false
      ? "Internet check is down and Huawei modem API is unavailable from this network."
      : "If Modem API is OK but internet is down, the issue is after the modem: LTE session, base station, or operator network.";
  } else if (enabledBands.length === 1 && enabledBands[0] === "B7" && drops === 0) {
    cls = "good";
    title = "B7 lock looks stable";
    text = `Current config is B7 only, internet is OK, SINR is ${sinr}. Keep this for a longer observation period.`;
  } else if (bandChanges > 0 || drops > 0) {
    cls = "warn";
    title = "Instability detected";
    text = `Band changes: ${bandChanges}, Internet drops: ${drops}. Consider locking known stable bands and comparing history.`;
  } else if (enabledBands.length > 1) {
    cls = "warn";
    title = "Multi-band mode";
    text = "The modem may switch bands automatically. This is normal, but can be unstable in some locations.";
  }

  return `<div class="badge ${cls}">${title}</div><p class="hint">${text}</p>`;
}

async function lockBands(bands) {
  try {
    if (!bands.length) throw new Error("Select at least one band");
    if (!confirm(`Lock LTE bands: ${bands.join("+")}?\n\nThe modem may disconnect for 30–90 seconds.`)) return;
    msg(`Locking ${bands.join("+")}...`);
    const st = await send("lockBands", {bands});
    latestState = withLocalMonitoringState(st);
    render(latestState);
    msg(`Sent ${bands.join("+")}. Wait 30–90 sec.`, "good");
  } catch(e) { msg("Error: "+e.message, "bad"); }
}
async function exportLogs() {
  const state = await send("exportAll");
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `lte-panel-log-${Date.now()}.json`, saveAs: true });
}

document.addEventListener("DOMContentLoaded", async () => {
  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tabPage").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.tab).classList.add("active");
  }));

  document.getElementById("refreshBtn").addEventListener("click", () => refresh(true, true));
  $("lockSelectedBtn").addEventListener("click", () => lockBands(selectedBands()));
  $("quickB7Btn").addEventListener("click", () => lockBands(["B7"]));
  $("quickB3B7Btn").addEventListener("click", () => lockBands(["B3","B7"]));
  $("restoreStartupBtn").addEventListener("click", async () => {
    if (!confirm("Restore startup band?")) return;
    try { render(withLocalMonitoringState(await send("restoreStartupBand"))); msg("Startup band sent.", "good"); } catch(e){ msg("Error: "+e.message,"bad"); }
  });
  $("restoreDefaultBtn").addEventListener("click", async () => {
    if (!confirm("Restore default band mask a0080800c5?\n\nThe modem may reconnect.")) return;
    try { render(withLocalMonitoringState(await send("restoreDefault"))); msg("Default band sent.", "good"); } catch(e){ msg("Error: "+e.message,"bad"); }
  });
  $("exportBtn").addEventListener("click", exportLogs);
  $("clearBtn").addEventListener("click", async () => {
    if (!confirm("Clear all IndexedDB history and events?")) return;
    render(withLocalMonitoringState(await send("clearHistory"))); msg("History cleared.", "good");
  });
  $("saveUrlBtn").addEventListener("click", async () => {
    render(withLocalMonitoringState(await send("setUrls", {
      modem: $("modemUrl").value,
      router: $("routerUrl").value,
      internetCheck: $("internetCheckUrl").value
    })));
    msg("Connection settings saved.", "good");
  });
  const monitoringToggle = document.getElementById("monitoringToggle");
  async function applyMonitoringToggle(enabled) {
    const requestId = ++monitoringToggleRequestId;
    pendingMonitoringEnabled = enabled;
    localStorage.setItem(MONITORING_OVERRIDE_KEY, String(enabled));
    const optimisticState = { ...(latestState || {}), monitoringEnabled: enabled, monitoringStatus: enabled ? "Active" : "Disabled", stats: latestState?.stats || {} };
    latestState = optimisticState;
    render(optimisticState);
    try {
      const st = await send("setMonitoring", { enabled });
      if (requestId !== monitoringToggleRequestId) return;
      latestState = withLocalMonitoringState(st);
      pendingMonitoringEnabled = null;
      render(latestState);
    } catch (err) {
      if (requestId !== monitoringToggleRequestId) return;
      pendingMonitoringEnabled = null;
      await refresh(false);
      msg("Error: " + err.message, "bad");
    }
  }
  monitoringToggle.addEventListener("click", () => {
    const current = pendingMonitoringEnabled !== null ? pendingMonitoringEnabled : monitoringToggle.dataset.enabled === "1";
    applyMonitoringToggle(!current);
  });
  $("markRouterRebootBtn").addEventListener("click", async () => {
    const st = await send("markUserAction", { action: "routerReboot" });
    latestState = withLocalMonitoringState(st);
    render(latestState);
    msg("Router reboot marked.", "good");
  });
  $("markModemReconnectBtn").addEventListener("click", async () => {
    const st = await send("markUserAction", { action: "modemReconnect" });
    latestState = withLocalMonitoringState(st);
    render(latestState);
    msg("Modem reconnect marked.", "good");
  });

  refresh(false, true);
  setInterval(() => refresh(false, false), 4000);
});
