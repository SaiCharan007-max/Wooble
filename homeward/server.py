"""HomeWard platform: REST API + WebSocket live feed + dashboard.

Run:  python -m homeward.server
"""
import asyncio
import json
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config
from .alerts import AlertManager
from .db import Database
from .engine import assess
from .notes import analyse_note

STATIC_DIR = Path(__file__).parent / "static"

SEED_PATIENTS = [
    dict(id="P001", name="Ramesh Kumar", age=68, conditions="Day 5 after hip replacement surgery; Type 2 diabetes",
         spo2_scale=1, home_oxygen=0, caregiver="Priya (daughter)", emergency_contact="Dr. Rao, +91 90000 00001"),
    dict(id="P002", name="Anita Sharma", age=75, conditions="Chronic heart failure; Hypertension",
         spo2_scale=1, home_oxygen=0, caregiver="Suresh (home nurse)", emergency_contact="Dr. Mehta, +91 90000 00002"),
    dict(id="P003", name="Joseph D'Souza", age=71, conditions="COPD on home oxygen (target SpO2 88-92%)",
         spo2_scale=2, home_oxygen=1, caregiver="Maria (wife)", emergency_contact="Dr. Iyer, +91 90000 00003"),
]
DEFAULT_SCENARIOS = {"P001": "sepsis", "P002": "stable", "P003": "stable"}
SCENARIOS = ["stable", "sepsis", "copd_exacerbation", "heart_failure", "acute_event", "recovery"]

# Values outside these ranges are physically impossible -> sensor artifact, not a vital sign.
PLAUSIBLE = {"hr": (20, 250), "spo2": (50, 100), "temp": (30, 43), "rr": (3, 60), "sbp": (50, 260), "dbp": (20, 160)}


# --- API models -------------------------------------------------------------------
class VitalsIn(BaseModel):
    hr: Optional[float] = None
    spo2: Optional[float] = None
    temp: Optional[float] = None
    rr: Optional[float] = None
    sbp: Optional[float] = None
    dbp: Optional[float] = None
    consciousness: Optional[str] = "A"


class ReadingIn(BaseModel):
    device_id: str = Field(max_length=64)
    patient_id: str = Field(max_length=32)
    seq: int
    ts: str
    generated_at: Optional[float] = None
    vitals: VitalsIn
    on_oxygen: bool = False
    o2_flow: Optional[float] = None
    battery: Optional[float] = None
    power: Optional[str] = "mains"


class IngestIn(BaseModel):
    readings: list[ReadingIn] = Field(max_length=2000)


class NoteIn(BaseModel):
    author: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=2000)


class ActionIn(BaseModel):
    by: str = Field(min_length=1, max_length=80)
    note: str = Field(default="", max_length=500)


class CheckinIn(BaseModel):
    caregiver: str = Field(min_length=1, max_length=80)
    method: str = Field(default="app", max_length=20)


class SimControlIn(BaseModel):
    patient_id: Optional[str] = None
    scenario: Optional[str] = None
    unplugged: Optional[bool] = None
    outage_seconds: Optional[int] = Field(default=None, ge=0, le=300)


# --- helpers -------------------------------------------------------------------------
def normalise_ts(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None).isoformat(timespec="seconds")


def validate_vitals(v):
    """Returns (clean_vitals, artifact_description)."""
    clean, artifacts = {}, []
    for k in ("hr", "spo2", "temp", "rr", "sbp", "dbp"):
        val = getattr(v, k)
        if val is None:
            clean[k] = None
            continue
        lo, hi = PLAUSIBLE[k]
        if lo <= val <= hi:
            clean[k] = val
        else:
            clean[k] = None
            artifacts.append(f"{k}={val:g} rejected (implausible - sensor off/loose?)")
    c = (v.consciousness or "A").upper()[:1]
    clean["consciousness"] = c if c in "ACVPU" else "A"
    return clean, "; ".join(artifacts) or None


class Hub:
    """Shared state of the running platform."""

    def __init__(self, db_path):
        self.db = Database(db_path)
        self.alerts = AlertManager(self.db)
        self.sockets: set[WebSocket] = set()
        self.latest: dict[str, dict] = {}
        self.started_at = time.time()
        self.seed()

    def seed(self):
        if self.db.one("SELECT COUNT(*) AS n FROM patients")["n"]:
            return
        for p in SEED_PATIENTS:
            self.db.execute("INSERT INTO patients (id,name,age,conditions,spo2_scale,home_oxygen,caregiver,"
                            "emergency_contact) VALUES (:id,:name,:age,:conditions,:spo2_scale,:home_oxygen,"
                            ":caregiver,:emergency_contact)", p)
            self.db.execute("INSERT INTO sim_control (patient_id, scenario, unplugged, updated_at) VALUES (?,?,0,?)",
                            (p["id"], DEFAULT_SCENARIOS[p["id"]], time.time()))
            self.db.execute("INSERT INTO checkins (patient_id, caregiver, method, created_at) VALUES (?,?,?,?)",
                            (p["id"], p["caregiver"], "shift start", time.time()))

    # --- reads ------------------------------------------------------------------
    def patients(self):
        return self.db.query("SELECT * FROM patients ORDER BY id")

    def patient(self, pid):
        return self.db.one("SELECT * FROM patients WHERE id=?", (pid,))

    def device_online(self, pid):
        d = self.db.one("SELECT status FROM devices WHERE patient_id=? ORDER BY last_seen DESC LIMIT 1", (pid,))
        return d is None or d["status"] != "offline"

    def recent_readings(self, pid, limit=80):
        rows = self.db.query("SELECT * FROM readings WHERE patient_id=? ORDER BY ts DESC LIMIT ?", (pid, limit))
        return rows[::-1]

    def recent_notes(self, pid):
        rows = self.db.query("SELECT * FROM notes WHERE patient_id=? AND created_at>? ORDER BY id DESC LIMIT 10",
                             (pid, time.time() - config.NOTE_RELEVANCE_SECONDS))
        for r in rows:
            r["analysis"] = json.loads(r["analysis"])
        return rows

    def summary(self, p):
        pid = p["id"]
        last = self.db.one("SELECT * FROM readings WHERE patient_id=? ORDER BY ts DESC LIMIT 1", (pid,))
        device = self.db.one("SELECT * FROM devices WHERE patient_id=? ORDER BY last_seen DESC LIMIT 1", (pid,))
        a = self.latest.get(pid)
        if a is None:
            a = self.reassess(pid, raise_alerts=False)
        checkin = self.db.one("SELECT * FROM checkins WHERE patient_id=? ORDER BY id DESC LIMIT 1", (pid,))
        active = self.db.one("SELECT COUNT(*) AS n FROM alerts WHERE patient_id=? AND status IN "
                             "('open','acknowledged')", (pid,))["n"]
        spark = self.db.query("SELECT hr, spo2, rr FROM readings WHERE patient_id=? ORDER BY ts DESC LIMIT 36", (pid,))
        return {**p, "latest": last, "device": device, "last_checkin": checkin, "active_alerts": active,
                "risk": {k: a.get(k) for k in ("level", "news2", "summary", "early_warning", "action")}
                | {"hours_to_high": (a.get("prediction") or {}).get("hours_to_high")},
                "spark": spark[::-1]}

    def snapshot(self):
        return {"type": "snapshot", "server_time": time.time(),
                "patients": [self.summary(p) for p in self.patients()],
                "alerts": self.alerts.list_active()}

    # --- risk -------------------------------------------------------------------
    def reassess(self, pid, raise_alerts=True):
        patient = self.patient(pid)
        previous = self.latest.get(pid)
        a = assess(patient, self.recent_readings(pid), self.recent_notes(pid), self.device_online(pid), previous)
        self.latest[pid] = a
        if a["level"] == "unknown":
            return a
        pred = a.get("prediction") or {}
        self.db.insert("INSERT INTO assessments (patient_id, ts, created_at, level, news2, predicted_level, "
                       "hours_to_high, summary) VALUES (?,?,?,?,?,?,?,?)",
                       (pid, a["ts"], time.time(), a["level"], a["news2"], pred.get("predicted_level_24h"),
                        pred.get("hours_to_high"), a["summary"]))
        if previous and previous.get("level") != a["level"]:
            self.alerts.event(pid, "risk", f"Risk changed {previous['level'].upper()} -> {a['level'].upper()}: "
                                           f"{a['summary']}")
        if raise_alerts:
            self.apply_clinical_alert(pid, a, previous)
        return a

    def apply_clinical_alert(self, pid, a, previous):
        if a["level"] in ("medium", "high"):
            if a["early_warning"]:
                title = f"Early warning: deterioration predicted (HIGH in ~{a['prediction']['hours_to_high']}h)"
            else:
                driver = a["summary"].split(": ", 1)[-1]
                title = f"{a['level'].upper()} risk - {driver[:90]}"
            self.alerts.raise_alert(pid, "clinical", a["level"], title, a["summary"] + " | Action: " + a["action"])
        elif previous and previous.get("level") in ("medium", "high"):
            if self.alerts.active(pid, "clinical"):
                self.alerts.event(pid, "risk", "Risk back to LOW - clinical alert stays open until a caregiver "
                                               "reviews and resolves it (no silent auto-close)")

    # --- periodic checks (device offline, missed check-ins, escalation) ----------------
    def periodic(self):
        now = time.time()
        changed = self.alerts.escalate_overdue()
        for d in self.db.query("SELECT * FROM devices WHERE status='online' AND last_seen < ?",
                               (now - config.DEVICE_OFFLINE_SECONDS,)):
            self.db.execute("UPDATE devices SET status='offline' WHERE id=?", (d["id"],))
            gap = int(now - d["last_seen"])
            self.alerts.raise_alert(d["patient_id"], "device_offline", "medium", "Wearable / home hub offline",
                                    f"No data from {d['id']} for {gap}s. Possible network or power cut. "
                                    f"The home hub keeps recording and will back-fill readings when it reconnects. "
                                    f"Last known battery {d['battery'] or 0:.0f}%.")
            self.latest.pop(d["patient_id"], None)
            changed = True
        for p in self.patients():
            last = self.db.one("SELECT created_at FROM checkins WHERE patient_id=? ORDER BY id DESC LIMIT 1",
                               (p["id"],))
            since = now - (last["created_at"] if last else self.started_at)
            if since > config.CHECKIN_INTERVAL_SECONDS:
                changed |= self.alerts.raise_alert(
                    p["id"], "missed_checkin", "medium", "Caregiver check-in overdue",
                    f"No caregiver check-in for {int(since // 60)} min (expected every "
                    f"{config.CHECKIN_INTERVAL_SECONDS // 60} min). Attendance not verified.")
        return changed

    async def broadcast(self, message=None):
        message = message or self.snapshot()
        data = json.dumps(message, default=str)
        dead = []
        for ws in list(self.sockets):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.sockets.discard(ws)


def create_app(db_path=None):
    hub = Hub(db_path or config.DB_PATH)

    @asynccontextmanager
    async def lifespan(app):
        async def loop():
            while True:
                await asyncio.sleep(2)
                try:
                    if hub.periodic():
                        await hub.broadcast()
                except Exception as exc:  # keep the watchdog alive no matter what
                    print("periodic check failed:", exc)
        task = asyncio.create_task(loop())
        yield
        task.cancel()
        hub.db.close()

    app = FastAPI(title="HomeWard", version="1.0.0", lifespan=lifespan,
                  description="Smart home-care monitoring: Sense -> Understand -> Predict -> Alert -> Respond")
    app.state.hub = hub

    # --- Sense: device ingestion ---------------------------------------------------------
    @app.post("/api/ingest")
    async def ingest(body: IngestIn, x_device_key: Optional[str] = Header(default=None)):
        if x_device_key != config.DEVICE_API_KEY:
            raise HTTPException(401, "Invalid device key")
        now = time.time()
        accepted = duplicates = rejected = backfilled = 0
        touched, last_by_patient = set(), {}
        known = {p["id"]: p for p in hub.patients()}
        for r in sorted(body.readings, key=lambda r: (r.device_id, r.seq)):
            if r.patient_id not in known:
                rejected += 1
                continue
            try:
                ts = normalise_ts(r.ts)
            except ValueError:
                rejected += 1
                continue
            vitals, artifact = validate_vitals(r.vitals)
            is_backfill = bool(r.generated_at and now - r.generated_at > config.BACKFILL_THRESHOLD_SECONDS)
            try:
                hub.db.execute(
                    "INSERT INTO readings (patient_id, device_id, seq, ts, received_at, hr, spo2, temp, rr, sbp, "
                    "dbp, consciousness, on_oxygen, o2_flow, artifact, backfilled) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (r.patient_id, r.device_id, r.seq, ts, now, vitals["hr"], vitals["spo2"], vitals["temp"],
                     vitals["rr"], vitals["sbp"], vitals["dbp"], vitals["consciousness"], int(r.on_oxygen),
                     r.o2_flow, artifact, int(is_backfill)))
            except sqlite3.IntegrityError:
                duplicates += 1  # already stored - safe replay
                continue
            accepted += 1
            backfilled += is_backfill
            touched.add(r.patient_id)
            last_by_patient[r.patient_id] = r

        for pid, r in last_by_patient.items():
            device = hub.db.one("SELECT * FROM devices WHERE id=?", (r.device_id,))
            hub.db.execute("INSERT INTO devices (id, patient_id, kind, last_seen, battery, power, status) "
                           "VALUES (?,?,?,?,?,?, 'online') ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, "
                           "battery=excluded.battery, power=excluded.power, status='online'",
                           (r.device_id, pid, "wearable", now, r.battery, r.power))
            if device and device["status"] == "offline":
                n = hub.db.one("SELECT COUNT(*) AS n FROM readings WHERE patient_id=? AND backfilled=1 "
                               "AND received_at=?", (pid, now))["n"]
                hub.alerts.auto_resolve(pid, "device_offline", f"Device reconnected; {n} buffered readings back-filled")
            patient = known[pid]
            # Equipment monitoring
            if patient["home_oxygen"] and r.o2_flow is not None and r.o2_flow < 0.5:
                hub.alerts.raise_alert(pid, "oxygen_supply", "high", "Oxygen concentrator not delivering",
                                       f"O2 flow {r.o2_flow:.1f} L/min (prescribed ~2 L/min). Check power, tubing "
                                       f"and switch to backup cylinder.")
            elif patient["home_oxygen"] and r.o2_flow is not None:
                hub.alerts.auto_resolve(pid, "oxygen_supply", f"O2 flow restored ({r.o2_flow:.1f} L/min)")
            if r.battery is not None and r.battery < config.LOW_BATTERY_PERCENT:
                hub.alerts.raise_alert(pid, "battery", "medium", "Wearable battery low",
                                       f"Battery {r.battery:.0f}% - charge the wearable to avoid a monitoring gap.")
            elif r.battery is not None:
                hub.alerts.auto_resolve(pid, "battery", "Battery charged")
            if r.power == "battery" and not hub.db.one("SELECT 1 FROM kv WHERE key=?", (f"power:{pid}",)):
                hub.db.execute("INSERT OR REPLACE INTO kv VALUES (?, 'battery')", (f"power:{pid}",))
                hub.alerts.event(pid, "device", "Home hub reports mains power lost - running on battery backup")
            elif r.power != "battery" and hub.db.one("SELECT 1 FROM kv WHERE key=?", (f"power:{pid}",)):
                hub.db.execute("DELETE FROM kv WHERE key=?", (f"power:{pid}",))
                hub.alerts.event(pid, "device", "Home hub back on mains power")

        if backfilled:
            hub.alerts.event(None, "device", f"Back-filled {backfilled} readings buffered during an outage")
        for pid in touched:
            hub.reassess(pid)
        if touched:
            await hub.broadcast()
        return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected, "backfilled": backfilled}

    # --- Understand / Predict: patient views ------------------------------------------------------
    @app.get("/api/patients")
    def list_patients():
        return [hub.summary(p) for p in hub.patients()]

    @app.get("/api/patients/{pid}")
    def patient_detail(pid: str):
        p = hub.patient(pid)
        if not p:
            raise HTTPException(404, "Unknown patient")
        a = hub.latest.get(pid) or hub.reassess(pid, raise_alerts=False)
        notes = hub.db.query("SELECT * FROM notes WHERE patient_id=? ORDER BY id DESC LIMIT 20", (pid,))
        for n in notes:
            n["analysis"] = json.loads(n["analysis"])
        return {
            "patient": p,
            "assessment": a,
            "readings": hub.recent_readings(pid, 120),
            "risk_history": hub.db.query("SELECT ts, level, news2, hours_to_high FROM assessments WHERE patient_id=? "
                                         "ORDER BY id DESC LIMIT 120", (pid,))[::-1],
            "notes": notes,
            "alerts": hub.db.query("SELECT * FROM alerts WHERE patient_id=? ORDER BY id DESC LIMIT 20", (pid,)),
            "checkins": hub.db.query("SELECT * FROM checkins WHERE patient_id=? ORDER BY id DESC LIMIT 10", (pid,)),
            "events": hub.db.query("SELECT * FROM events WHERE patient_id=? OR patient_id IS NULL "
                                   "ORDER BY id DESC LIMIT 40", (pid,)),
            "device": hub.db.one("SELECT * FROM devices WHERE patient_id=? ORDER BY last_seen DESC LIMIT 1", (pid,)),
        }

    @app.post("/api/patients/{pid}/notes")
    async def add_note(pid: str, body: NoteIn):
        if not hub.patient(pid):
            raise HTTPException(404, "Unknown patient")
        analysis = analyse_note(body.text)
        nid = hub.db.insert("INSERT INTO notes (patient_id, author, created_at, text, analysis) VALUES (?,?,?,?,?)",
                            (pid, body.author, time.time(), body.text, json.dumps(analysis)))
        found = ", ".join(c["category"] for c in analysis["concerns"]) or "no concerns"
        hub.alerts.event(pid, "note", f"Note by {body.author}: {found}")
        assessment = hub.reassess(pid)
        await hub.broadcast()
        return {"id": nid, "analysis": analysis, "assessment": {k: assessment.get(k) for k in
                                                                 ("level", "news2", "summary", "reasons")}}

    # --- Respond: caregiver actions ---------------------------------------------------------------
    @app.post("/api/patients/{pid}/checkin")
    async def checkin(pid: str, body: CheckinIn):
        if not hub.patient(pid):
            raise HTTPException(404, "Unknown patient")
        hub.db.insert("INSERT INTO checkins (patient_id, caregiver, method, created_at) VALUES (?,?,?,?)",
                      (pid, body.caregiver, body.method, time.time()))
        hub.alerts.event(pid, "checkin", f"{body.caregiver} checked in ({body.method})")
        hub.alerts.auto_resolve(pid, "missed_checkin", f"{body.caregiver} checked in")
        await hub.broadcast()
        return {"ok": True}

    @app.get("/api/alerts")
    def list_alerts(status: str = "active"):
        if status == "active":
            return hub.alerts.list_active()
        return hub.db.query("SELECT a.*, p.name AS patient_name FROM alerts a JOIN patients p ON p.id=a.patient_id "
                            "ORDER BY a.id DESC LIMIT 100")

    @app.post("/api/alerts/{alert_id}/ack")
    async def ack(alert_id: int, body: ActionIn):
        alert = hub.alerts.acknowledge(alert_id, body.by, body.note)
        if not alert:
            raise HTTPException(409, "Alert not found or already closed")
        await hub.broadcast()
        return alert

    @app.post("/api/alerts/{alert_id}/resolve")
    async def resolve(alert_id: int, body: ActionIn):
        alert = hub.alerts.resolve(alert_id, body.by, body.note)
        if not alert:
            raise HTTPException(409, "Alert not found or already closed")
        await hub.broadcast()
        return alert

    @app.get("/api/events")
    def events(limit: int = 50):
        return hub.db.query("SELECT e.*, p.name AS patient_name FROM events e LEFT JOIN patients p "
                            "ON p.id=e.patient_id ORDER BY e.id DESC LIMIT ?", (min(limit, 500),))

    # --- Simulator control (demo only) -------------------------------------------------------------
    @app.get("/api/sim/control")
    def sim_control():
        row = hub.db.one("SELECT value FROM kv WHERE key='outage_until'")
        remaining = max(0.0, float(row["value"]) - time.time()) if row else 0.0
        return {"scenarios": SCENARIOS, "outage_remaining": remaining,
                "patients": {r["patient_id"]: {"scenario": r["scenario"], "unplugged": bool(r["unplugged"])}
                             for r in hub.db.query("SELECT * FROM sim_control")}}

    @app.post("/api/sim/control")
    async def set_sim_control(body: SimControlIn):
        if body.patient_id:
            if not hub.patient(body.patient_id):
                raise HTTPException(404, "Unknown patient")
            if body.scenario:
                if body.scenario not in SCENARIOS:
                    raise HTTPException(400, f"Scenario must be one of {SCENARIOS}")
                hub.db.execute("UPDATE sim_control SET scenario=?, updated_at=? WHERE patient_id=?",
                               (body.scenario, time.time(), body.patient_id))
                hub.alerts.event(body.patient_id, "sim", f"[demo] scenario set to '{body.scenario}'")
            if body.unplugged is not None:
                hub.db.execute("UPDATE sim_control SET unplugged=?, updated_at=? WHERE patient_id=?",
                               (int(body.unplugged), time.time(), body.patient_id))
                hub.alerts.event(body.patient_id, "sim", f"[demo] oxygen concentrator "
                                                         f"{'unplugged' if body.unplugged else 'plugged back in'}")
        if body.outage_seconds:
            hub.db.execute("INSERT OR REPLACE INTO kv VALUES ('outage_until', ?)",
                           (str(time.time() + body.outage_seconds),))
            hub.alerts.event(None, "sim", f"[demo] simulating a {body.outage_seconds}s network outage at the home hub")
        await hub.broadcast()
        return sim_control()

    @app.get("/api/health")
    def health():
        return {"status": "ok", "uptime_s": round(time.time() - hub.started_at),
                "readings": hub.db.one("SELECT COUNT(*) AS n FROM readings")["n"]}

    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        await websocket.accept()
        hub.sockets.add(websocket)
        try:
            await websocket.send_text(json.dumps(hub.snapshot(), default=str))
            while True:
                await websocket.receive_text()  # keep-alive pings from the browser
        except WebSocketDisconnect:
            pass
        finally:
            hub.sockets.discard(websocket)

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="HomeWard platform server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run("homeward.server:create_app", factory=True, host=args.host, port=args.port)
