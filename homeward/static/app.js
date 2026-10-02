// HomeWard dashboard - vanilla JS, no build step, no external CDN (works on a local network
// even when the internet is down). Live updates via WebSocket, with polling as a fallback.
"use strict";

const state = { patients: [], alerts: [], selected: null, detail: null, ws: null, wsOk: false,
                pendingDetail: false, lastDetailFetch: 0, scenarios: [] };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (t) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
const clock = (t) => new Date(t * 1000).toLocaleTimeString();
const simTime = (ts) => ts ? ts.replace("T", " ").slice(5, 16) : "";
const me = () => $("#me").value.trim() || "Caregiver";

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------- live connection
function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => { state.wsOk = true; setConn(); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "snapshot") applySnapshot(msg);
  };
  ws.onclose = () => { state.wsOk = false; setConn(); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}
setInterval(() => { if (state.ws && state.ws.readyState === 1) state.ws.send("ping"); }, 20000);

// Fallback polling when the WebSocket is down.
setInterval(async () => {
  if (state.wsOk) return;
  try {
    const [patients, alerts] = await Promise.all([api("/api/patients"), api("/api/alerts")]);
    applySnapshot({ patients, alerts });
    setConn("poll");
  } catch { setConn("down"); }
}, 3000);

function setConn(mode) {
  const el = $("#conn");
  if (state.wsOk) { el.textContent = "● live"; el.className = "pill pill-ok"; }
  else if (mode === "poll") { el.textContent = "● polling (live link down)"; el.className = "pill pill-wait"; }
  else { el.textContent = "● server unreachable - retrying"; el.className = "pill pill-bad"; }
}

function applySnapshot(msg) {
  state.patients = msg.patients;
  state.alerts = msg.alerts;
  if (!state.selected && state.patients.length) state.selected = state.patients[0].id;
  renderPatients();
  renderAlerts();
  scheduleDetail();
  refreshEvents();
}

// ------------------------------------------------------------------- patient list
function renderPatients() {
  const list = $("#patientList");
  list.innerHTML = "";
  for (const p of state.patients) {
    const lvl = p.risk.level || "unknown";
    const l = p.latest || {};
    const dev = p.device;
    const el = document.createElement("div");
    el.className = `pcard ${lvl} ${p.id === state.selected ? "sel" : ""}`;
    el.innerHTML = `
      <div class="row"><span class="name">${esc(p.name)}</span><span class="badge ${lvl}">${lvl}</span></div>
      <div class="sub">${esc(p.id)} · ${p.age}y · NEWS2 ${p.risk.news2 ?? "-"}
        ${p.active_alerts ? ` · <b style="color:#ff8a8d">${p.active_alerts} alert(s)</b>` : ""}</div>
      <div class="mini">
        <span>♥ ${l.hr != null ? Math.round(l.hr) : "-"}</span><span>SpO₂ ${l.spo2 != null ? Math.round(l.spo2) : "-"}%</span>
        <span>RR ${l.rr != null ? Math.round(l.rr) : "-"}</span><span>${l.temp != null ? l.temp.toFixed(1) : "-"}°C</span>
        <span>${dev ? (dev.status === "offline" ? "⚠ offline" : "📶 online") : "no device"}</span>
      </div>
      <canvas></canvas>
      <div class="why">${p.risk.early_warning ? "⚠ Early warning - " : ""}${p.risk.hours_to_high ? `HIGH predicted in ~${p.risk.hours_to_high}h` : ""}</div>`;
    el.dataset.pid = p.id;
    list.appendChild(el);
    sparkline($("canvas", el), (p.spark || []).map((r) => r.hr), lvl);
  }
}

$("#patientList").addEventListener("click", (e) => {
  const card = e.target.closest(".pcard");
  if (!card) return;
  state.selected = card.dataset.pid; state.detail = null;
  renderPatients(); loadDetail(true);
});

function sparkline(canvas, values, lvl) {
  const v = values.filter((x) => x != null);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  if (v.length < 2) return;
  const min = Math.min(...v) - 2, max = Math.max(...v) + 2;
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue(`--${lvl}`) || "#3fb6a8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  v.forEach((y, i) => {
    const px = (i / (v.length - 1)) * w, py = h - ((y - min) / (max - min)) * h;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.stroke();
}

// ----------------------------------------------------------------- patient detail
function scheduleDetail() {
  if (state.pendingDetail) return;
  const wait = Math.max(0, 1200 - (Date.now() - state.lastDetailFetch));
  state.pendingDetail = true;
  setTimeout(() => { state.pendingDetail = false; loadDetail(); }, wait);
}

async function loadDetail(force) {
  if (!state.selected) return;
  state.lastDetailFetch = Date.now();
  try {
    const d = await api(`/api/patients/${state.selected}`);
    if (d.patient.id !== state.selected) return;
    const first = force || !state.detail || state.detail.patient.id !== d.patient.id;
    state.detail = d;
    renderDetail(first);
  } catch (e) { console.warn(e); }
}

const VITALS = [
  { k: "hr", n: "Heart rate", u: "bpm", lo: 51, hi: 90, min: 40, max: 160 },
  { k: "spo2", n: "SpO₂", u: "%", lo: 96, hi: 100, min: 75, max: 100 },
  { k: "rr", n: "Resp. rate", u: "/min", lo: 12, hi: 20, min: 6, max: 40 },
  { k: "temp", n: "Temperature", u: "°C", lo: 36.1, hi: 38.0, min: 34.5, max: 41, dec: 1 },
  { k: "sbp", n: "Systolic BP", u: "mmHg", lo: 111, hi: 219, min: 70, max: 180 },
];

const SAMPLE_NOTES = [
  ["Reassuring", "Ate well at lunch, comfortable and in good spirits. No chest pain, no fever."],
  ["Worrying", "Seems confused this evening and refused dinner. Feels hot and is breathing fast."],
  ["Red flag", "He is complaining of chest pain and sweating."],
  ["हिन्दी", "पिताजी को बुखार है और सांस लेने में तकलीफ हो रही है।"],
  ["తెలుగు", "నాన్నకు జ్వరం ఉంది, ఆయాసం గా ఉంది."],
];

function renderDetail(first) {
  const d = state.detail, p = d.patient, a = d.assessment || {};
  const root = $("#detail");
  if (first || !$(".phead", root)) {
    root.innerHTML = "";
    root.appendChild($("#detailTpl").content.cloneNode(true));
    $(".checkin", root).onclick = async () => {
      await api(`/api/patients/${p.id}/checkin`, { method: "POST", body: JSON.stringify({ caregiver: me(), method: "app" }) });
      loadDetail();
    };
    const form = $(".noteform", root);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const ta = $("textarea", form);
      if (!ta.value.trim()) return;
      await api(`/api/patients/${p.id}/notes`, { method: "POST", body: JSON.stringify({ author: me(), text: ta.value.trim() }) });
      ta.value = "";
      loadDetail();
    };
    const samples = $(".samples", form);
    for (const [label, text] of SAMPLE_NOTES) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn small"; b.textContent = `Sample: ${label}`;
      b.onclick = () => { $("textarea", form).value = text; };
      samples.appendChild(b);
    }
  }

  $(".pname", root).textContent = `${p.name} (${p.id})`;
  $(".pmeta", root).textContent = `${p.age} years · ${p.conditions}${p.spo2_scale === 2 ? " · NEWS2 SpO₂ scale 2" : ""}`;
  $(".pcontacts", root).textContent = `Caregiver: ${p.caregiver} · Escalation contact: ${p.emergency_contact}`;
  const dev = d.device;
  $(".device", root).innerHTML = dev
    ? `${dev.status === "offline" ? '<span class="pill pill-bad">wearable offline</span>' : '<span class="pill pill-ok">wearable online</span>'}
       · battery ${Math.round(dev.battery ?? 0)}% · power: ${esc(dev.power)} · last data ${ago(dev.last_seen)}`
    : "no device data yet";
  const lc = d.checkins[0];
  $(".lastcheckin", root).textContent = lc ? `Last check-in: ${lc.caregiver} (${lc.method}) ${ago(lc.created_at)}` : "No check-ins";

  // risk
  const lvl = a.level || "unknown";
  const rl = $(".risk-level", root);
  rl.textContent = lvl.toUpperCase(); rl.className = `risk-level ${lvl}`;
  $(".news2", root).textContent = a.news2 ?? "-";
  $(".ew", root).textContent = a.early_warning
    ? `⚠ EARLY WARNING: vitals still look acceptable, but trends predict HIGH risk in ~${a.prediction.hours_to_high}h. Act now.`
    : "";
  $(".reasons", root).innerHTML = (a.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("");
  $(".action", root).innerHTML = `<b>Recommended action:</b> ${esc(a.action || "")}`;
  $(".disclaimer", root).textContent = a.disclaimer || "";

  // prediction
  const pr = a.prediction || {};
  if (pr.available) {
    $(".pred-main", root).innerHTML = a.vitals_level === "high"
      ? `<span style="color:var(--high)">Already at HIGH risk - act now</span>`
      : pr.hours_to_high
      ? `<span style="color:var(--high)">HIGH risk predicted in ~${pr.hours_to_high}h</span> <span class="hint">(confidence ${pr.confidence})</span>`
      : pr.hours_to_medium
        ? `<span style="color:var(--medium)">MEDIUM risk predicted in ~${pr.hours_to_medium}h</span> <span class="hint">(confidence ${pr.confidence})</span>`
        : `<span style="color:var(--low)">No deterioration predicted in the next 48h</span>`;
    $(".pred-timeline", root).innerHTML = pr.timeline.map((t) =>
      `<span class="${t.level}">+${t.hours}h: NEWS2 ${t.news2}</span>`).join("");
    $(".trends", root).innerHTML = pr.trends.length
      ? pr.trends.map((t) => `<li class="${t.worsening ? "bad" : ""}">${esc(t.text)} <span class="hint">R²=${t.r2}</span></li>`).join("")
      : "<li>No significant trends - vitals stable</li>";
  } else {
    $(".pred-main", root).textContent = pr.reason || "Collecting history…";
    $(".pred-timeline", root).innerHTML = ""; $(".trends", root).innerHTML = "";
  }
  const comps = (a.news2_detail && a.news2_detail.components) || [];
  $(".breakdown tbody", root).innerHTML = comps.map((c) =>
    `<tr><td>${esc(c.label)}</td><td>${esc(typeof c.value === "number" ? (c.param === "temp" ? c.value.toFixed(1) : Math.round(c.value)) : c.value)}</td>
     <td class="pts${c.points}">+${c.points}</td></tr>`).join("")
    + (a.news2_detail && a.news2_detail.missing.length ? `<tr><td colspan="3" class="hint">Missing: ${esc(a.news2_detail.missing.join(", "))}</td></tr>` : "");

  // vitals tiles
  const pts = Object.fromEntries(comps.map((c) => [c.param, c.points]));
  const cur = a.current || {};
  $(".vitals", root).innerHTML = VITALS.map((v) => {
    const val = cur[v.k];
    return `<div class="vital p${pts[v.k] || 0}"><div class="n">${v.n}</div>
      <div class="v">${val == null ? "-" : v.dec ? val.toFixed(v.dec) : Math.round(val)} <span class="u">${v.u}</span></div>
      <div class="u">NEWS2 +${pts[v.k] || 0}</div></div>`;
  }).join("") + `<div class="vital p${pts.consciousness || 0}"><div class="n">Consciousness</div>
      <div class="v">${esc(cur.consciousness || "-")}</div><div class="u">ACVPU · +${pts.consciousness || 0}</div></div>`;

  renderCharts(root, d.readings, p);

  // notes
  $(".notelist", root).innerHTML = d.notes.map((n) => {
    const an = n.analysis;
    const chips = an.concerns.map((c) => `<span class="chip ${c.red_flag ? "red" : ""}" title="matched: ${esc(c.phrase)}">${esc(c.category)}</span>`).join("")
      + an.negated.map((c) => `<span class="chip neg" title="negated: ${esc(c.phrase)}">${esc(c.category)}</span>`).join("")
      + an.reassuring.map((r) => `<span class="chip ok">${esc(r)}</span>`).join("");
    return `<div class="note"><div class="meta">${esc(n.author)} · ${clock(n.created_at)} · lang: ${an.language}</div>
      <div>${esc(n.text)}</div><div>${chips || '<span class="hint">no clinical concerns detected</span>'}</div></div>`;
  }).join("") || '<div class="hint">No notes yet</div>';

  $(".alerthistory", root).innerHTML = d.alerts.map((al) =>
    `<div class="small-list"><div><span class="badge ${al.severity}">${al.severity}</span> #${al.id} ${esc(al.title)}
      <span class="hint">- ${al.status}${al.acked_by ? ` by ${esc(al.acked_by)} in ${Math.round(al.acked_at - al.created_at)}s` : ""}</span></div></div>`
  ).join("") || '<div class="hint">No alerts</div>';
  $(".checkins", root).innerHTML = `<div class="small-list">${d.checkins.map((c) =>
    `<div>${esc(c.caregiver)} · ${esc(c.method)} · ${clock(c.created_at)}</div>`).join("")}</div>`;
}

function renderCharts(root, readings, patient) {
  const box = $(".charts", root);
  if (box.children.length !== VITALS.length) {
    box.innerHTML = VITALS.map((v) => `<div class="chart"><div class="ct"><span>${v.n}</span><span class="last"></span></div><canvas data-k="${v.k}"></canvas></div>`).join("");
  }
  const css = getComputedStyle(document.documentElement);
  for (const v of VITALS) {
    let lo = v.lo, hi = v.hi;
    if (v.k === "spo2" && patient.spo2_scale === 2) { lo = 88; hi = 92; }
    const canvas = $(`canvas[data-k="${v.k}"]`, box);
    const series = readings.map((r) => ({ y: r[v.k], back: r.backfilled, ts: r.ts }));
    const last = [...series].reverse().find((s) => s.y != null);
    canvas.parentElement.querySelector(".last").textContent = last ? `${v.dec ? last.y.toFixed(1) : Math.round(last.y)} ${v.u}` : "";
    drawChart(canvas, series, { ...v, lo, hi }, css);
  }
}

function drawChart(canvas, series, v, css) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const pad = { l: 28, r: 4, t: 4, b: 14 };
  const vals = series.map((s) => s.y).filter((y) => y != null);
  const min = Math.min(v.min, ...vals), max = Math.max(v.max, ...vals);
  const X = (i) => pad.l + (i / Math.max(1, series.length - 1)) * (w - pad.l - pad.r);
  const Y = (y) => pad.t + (1 - (y - min) / (max - min)) * (h - pad.t - pad.b);

  ctx.fillStyle = "rgba(46,168,107,0.12)";
  ctx.fillRect(pad.l, Y(Math.min(v.hi, max)), w - pad.l - pad.r, Y(Math.max(v.lo, min)) - Y(Math.min(v.hi, max)));
  ctx.fillStyle = css.getPropertyValue("--muted"); ctx.font = "10px sans-serif";
  ctx.fillText(String(Math.round(max)), 2, pad.t + 8);
  ctx.fillText(String(Math.round(min)), 2, h - pad.b);
  if (series.length) {
    ctx.fillText(simTime(series[0].ts), pad.l, h - 2);
    const lastLabel = simTime(series[series.length - 1].ts);
    ctx.fillText(lastLabel, w - pad.r - ctx.measureText(lastLabel).width, h - 2);
  }

  ctx.strokeStyle = css.getPropertyValue("--accent"); ctx.lineWidth = 1.6;
  ctx.beginPath();
  let started = false;
  series.forEach((s, i) => {
    if (s.y == null) { started = false; return; }   // gap for artifacts / missing data
    started ? ctx.lineTo(X(i), Y(s.y)) : ctx.moveTo(X(i), Y(s.y));
    started = true;
  });
  ctx.stroke();
  ctx.fillStyle = "#f1c35c";
  series.forEach((s, i) => {
    if (s.back && s.y != null) { ctx.beginPath(); ctx.arc(X(i), Y(s.y), 2.2, 0, 7); ctx.fill(); }
  });
}

// ---------------------------------------------------------------------- alerts
const CHAIN = ["Primary caregiver", "Family + on-call nurse", "Doctor / emergency (108)"];
const KIND = { clinical: "Clinical", device_offline: "Device", oxygen_supply: "Equipment", battery: "Equipment", missed_checkin: "Attendance" };

let alertsSig = "";
function renderAlerts() {
  $("#alertCount").textContent = state.alerts.length;
  const box = $("#alerts");
  // Only re-render when something changed, so a caregiver's click is never lost mid-update.
  const sig = JSON.stringify(state.alerts.map((a) => [a.id, a.status, a.severity, a.escalation_level]))
    + Math.floor(Date.now() / 30000);
  if (sig === alertsSig) {
    for (const a of state.alerts) {  // refresh changing text in place
      const el = box.querySelector(`.alert[data-aid="${a.id}"]`);
      if (el) { $(".t", el).textContent = a.title; $(".r", el).textContent = a.reason; }
    }
    return;
  }
  alertsSig = sig;
  const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const drafts = Object.fromEntries([...box.querySelectorAll("input[data-id]")].map((i) => [i.dataset.id, i.value]));
  if (!state.alerts.length) { box.innerHTML = '<div class="noalerts">✓ No active alerts</div>'; return; }
  box.innerHTML = state.alerts.map((a) => `
    <div class="alert ${a.severity} ${a.status}" data-aid="${a.id}">
      <div><span class="badge ${a.severity}">${a.severity}</span> <span class="hint">${KIND[a.kind] || a.kind} · ${esc(a.patient_name)} · #${a.id} · ${ago(a.created_at)}</span></div>
      <div class="t">${esc(a.title)}</div>
      <div class="r">${esc(a.reason)}</div>
      ${a.status === "open"
        ? `<div class="esc">🔔 Notified: ${CHAIN.slice(0, a.escalation_level + 1).join(" → ")}${a.escalation_level < 2 ? " (escalates if not acknowledged)" : ""}</div>`
        : `<div class="acked">✓ Acknowledged by ${esc(a.acked_by)} after ${Math.round(a.acked_at - a.created_at)}s${a.ack_note ? `: "${esc(a.ack_note)}"` : ""}</div>`}
      <div class="acts">
        <input data-id="${a.id}" placeholder="Action taken (e.g. checked patient, called nurse)" maxlength="500">
        ${a.status === "open" ? `<button class="btn primary small" data-ack="${a.id}">Acknowledge</button>` : ""}
        <button class="btn small" data-resolve="${a.id}">Resolve</button>
      </div>
    </div>`).join("");
  for (const [id, val] of Object.entries(drafts)) {
    const i = box.querySelector(`input[data-id="${id}"]`);
    if (i) i.value = val;
  }
  if (focused) { const i = box.querySelector(`input[data-id="${focused}"]`); if (i) i.focus(); }
}
$("#alerts").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && b.dataset.ack) alertAction(b.dataset.ack, "ack");
  if (b && b.dataset.resolve) alertAction(b.dataset.resolve, "resolve");
});

async function alertAction(id, action) {
  const input = $(`#alerts input[data-id="${id}"]`);
  const note = input.value.trim();
  try {
    await api(`/api/alerts/${id}/${action}`, { method: "POST", body: JSON.stringify({ by: me(), note }) });
    input.value = "";
  } catch (e) { alert(e.message); }
  alertsSig = "";
  state.alerts = await api("/api/alerts");
  renderAlerts(); loadDetail(); refreshEvents();
}

// ---------------------------------------------------------------------- events
let eventsBusy = false;
async function refreshEvents() {
  if (eventsBusy) return;
  eventsBusy = true;
  try {
    const evs = await api("/api/events?limit=60");
    $("#events").innerHTML = evs.map((e) =>
      `<div class="ev ${e.kind}"><span class="k">${esc(e.kind)}</span> <span class="tm">${clock(e.created_at)}</span>
       ${e.patient_name ? `<b>${esc(e.patient_name)}</b>: ` : ""}${esc(e.message)}</div>`).join("");
  } catch { /* offline */ }
  setTimeout(() => { eventsBusy = false; }, 1000);
}

// ---------------------------------------------------------------------- demo controls
async function renderDemo() {
  const ctl = await api("/api/sim/control");
  state.scenarios = ctl.scenarios;
  $("#demoPatients").innerHTML = Object.entries(ctl.patients).map(([pid, c]) =>
    `<label>${pid}: <select data-pid="${pid}">${ctl.scenarios.map((s) =>
      `<option ${s === c.scenario ? "selected" : ""}>${s}</option>`).join("")}</select></label>`).join("");
  document.querySelectorAll("#demoPatients select").forEach((s) => s.onchange = () =>
    api("/api/sim/control", { method: "POST", body: JSON.stringify({ patient_id: s.dataset.pid, scenario: s.value }) }));
  state.o2Unplugged = ctl.patients.P003 && ctl.patients.P003.unplugged;
}
$("#toggleDemo").onclick = () => { $("#demo").classList.toggle("hidden"); renderDemo(); };
$("#outageBtn").onclick = () => api("/api/sim/control", { method: "POST", body: JSON.stringify({ outage_seconds: 20 }) });
$("#o2Btn").onclick = async () => {
  state.o2Unplugged = !state.o2Unplugged;
  await api("/api/sim/control", { method: "POST", body: JSON.stringify({ patient_id: "P003", unplugged: state.o2Unplugged }) });
};

try { const saved = localStorage.getItem("homeward-me"); if (saved) $("#me").value = saved; } catch {}
$("#me").onchange = () => { try { localStorage.setItem("homeward-me", $("#me").value); } catch {} };
window.addEventListener("resize", () => { renderPatients(); if (state.detail) renderDetail(false); });

setConn("down");
connect();
