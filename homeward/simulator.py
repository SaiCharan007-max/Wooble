"""IoT simulation: virtual wearables + a "home hub" gateway.

    [wearable sensors] --> [home hub: buffer + local safety check] --HTTPS--> [HomeWard platform]

Resilience features:
  * Store-and-forward: every reading is written to a local SQLite outbox FIRST, then sent.
    If the network or server is down, readings stay in the outbox and are replayed in
    order when the connection returns (nothing is lost).
  * Idempotent replay: each reading has a per-device sequence number, so re-sending is safe.
  * Edge safety net: while offline the hub scores NEWS2 locally and sounds a local alarm
    (printed here) for HIGH risk - the home still protects the patient without the cloud.
  * Power-cut simulation: the hub reports when it is running on battery backup.

Run:  python -m homeward.simulator            (needs the server running)
"""
import argparse
import json
import random
import sqlite3
import time
from datetime import datetime, timedelta

import requests

from . import config, news2

PATIENTS = {
    "P001": {"base": dict(hr=78, spo2=97, temp=36.8, rr=16, sbp=128, dbp=78), "scale": 1, "oxygen": False},
    "P002": {"base": dict(hr=72, spo2=96, temp=36.6, rr=15, sbp=138, dbp=84), "scale": 1, "oxygen": False},
    "P003": {"base": dict(hr=86, spo2=90, temp=36.7, rr=18, sbp=132, dbp=80), "scale": 2, "oxygen": True},
}

# Each scenario: change from baseline at full progression, onset (h) and duration (h) of the change.
SCENARIOS = {
    "stable": dict(delta={}, onset=0, duration=1),
    "recovery": dict(delta={}, onset=0, duration=1),
    # Infection after surgery: slow (~36h) rise in HR/temp/RR, falling BP -> classic sepsis picture.
    "sepsis": dict(delta=dict(hr=46, temp=2.5, rr=11, sbp=-38, dbp=-24, spo2=-4), onset=1, duration=36,
                   confusion_at=0.85),
    # COPD flare: falling saturation, faster breathing over ~24h.
    "copd_exacerbation": dict(delta=dict(spo2=-8, rr=13, hr=30, temp=0.7, sbp=6), onset=1, duration=24,
                              confusion_at=0.95),
    # Fluid overload: breathlessness and falling SpO2 over ~30h.
    "heart_failure": dict(delta=dict(rr=10, spo2=-6, hr=28, sbp=-22, dbp=-10), onset=1, duration=30),
    # Sudden event (e.g. pulmonary embolism / fall): severe change within ~1h.
    "acute_event": dict(delta=dict(spo2=-13, hr=48, rr=14, sbp=-30), onset=0, duration=1, confusion_at=0.6),
}
NOISE = dict(hr=2.0, spo2=0.6, temp=0.08, rr=0.8, sbp=4.0, dbp=3.0)


class VirtualPatient:
    def __init__(self, pid, cfg, seq_start=0):
        self.pid = pid
        self.base = cfg["base"]
        self.scale = cfg["scale"]
        self.oxygen = cfg["oxygen"]
        self.device_id = f"{pid}-WEARABLE"
        self.state = dict(self.base)  # the "true" physiology, smoothed
        self.scenario = "stable"
        self.scenario_hours = 0.0
        self.seq = seq_start
        self.battery = random.uniform(70, 100)
        self.unplugged = False
        self.hypoxia_offset = 0.0  # extra desaturation when the O2 concentrator is off

    def set_scenario(self, name):
        if name != self.scenario and name in SCENARIOS:
            print(f"  [{self.pid}] scenario -> {name}")
            self.scenario = name
            self.scenario_hours = 0.0

    def step(self, hours):
        self.scenario_hours += hours
        sc = SCENARIOS[self.scenario]
        progress = min(1.0, max(0.0, (self.scenario_hours - sc["onset"]) / sc["duration"]))
        target = {k: v + sc["delta"].get(k, 0) * progress for k, v in self.base.items()}

        if self.oxygen and self.unplugged:
            self.hypoxia_offset = min(10.0, self.hypoxia_offset + 1.5)
        else:
            self.hypoxia_offset = max(0.0, self.hypoxia_offset - 2.0)
        target["spo2"] -= self.hypoxia_offset
        target["rr"] += self.hypoxia_offset * 0.6
        target["hr"] += self.hypoxia_offset * 1.2

        # Physiology moves smoothly towards the target (also gives realistic transitions).
        for k in self.state:
            self.state[k] += (target[k] - self.state[k]) * 0.35
        confused = progress >= sc.get("confusion_at", 2)

        reading = {k: v + random.gauss(0, NOISE[k]) for k, v in self.state.items()}
        reading["spo2"] = min(100, round(reading["spo2"]))
        for k in ("hr", "rr", "sbp", "dbp"):
            reading[k] = round(reading[k])
        reading["temp"] = round(reading["temp"], 1)
        reading["consciousness"] = "C" if confused else "A"

        # Realistic sensor glitch: pulse-oximeter slipped off the finger.
        if random.random() < 0.01:
            reading["spo2"] = 0

        self.battery = max(5.0, self.battery - random.uniform(0.0, 0.08))
        return reading


class Outbox:
    """Durable store-and-forward queue (survives restarts of the hub itself)."""

    def __init__(self, path):
        self.conn = sqlite3.connect(path, isolation_level=None)
        self.conn.execute("CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT)")
        self.conn.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)")

    def push(self, reading):
        self.conn.execute("INSERT INTO outbox (payload) VALUES (?)", (json.dumps(reading),))

    def peek(self, n=500):
        return self.conn.execute("SELECT id, payload FROM outbox ORDER BY id LIMIT ?", (n,)).fetchall()

    def remove_upto(self, last_id):
        self.conn.execute("DELETE FROM outbox WHERE id<=?", (last_id,))

    def size(self):
        return self.conn.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]

    def get(self, key, default=None):
        row = self.conn.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def put(self, key, value):
        self.conn.execute("INSERT OR REPLACE INTO state VALUES (?,?)", (key, str(value)))


class HomeHub:
    def __init__(self, server, key, outbox_path, speed_minutes, tick_seconds, power_cut_after=None):
        self.server = server.rstrip("/")
        self.session = requests.Session()
        self.session.headers["X-Device-Key"] = key
        self.outbox = Outbox(outbox_path)
        self.speed = speed_minutes
        self.tick_seconds = tick_seconds
        self.forced_offline_until = 0.0
        self.online = True
        self.power = "mains"
        self.power_cut_after = power_cut_after
        self.ticks = 0
        # Resume the simulated clock after a restart so timestamps keep moving forward.
        saved = self.outbox.get("sim_clock")
        self.clock = max(datetime.now(), datetime.fromisoformat(saved)) if saved else datetime.now()
        self.patients = {pid: VirtualPatient(pid, cfg, int(self.outbox.get(f"seq:{pid}", 0)))
                         for pid, cfg in PATIENTS.items()}

    # --- control channel (demo scenarios) -----------------------------------------------------
    def poll_control(self):
        try:
            ctl = self.session.get(f"{self.server}/api/sim/control", timeout=2).json()
        except (requests.RequestException, ValueError):
            return
        for pid, c in ctl.get("patients", {}).items():
            if pid in self.patients:
                self.patients[pid].set_scenario(c["scenario"])
                self.patients[pid].unplugged = c["unplugged"]
        if ctl.get("outage_remaining", 0) > 0 and time.time() >= self.forced_offline_until:
            self.forced_offline_until = time.time() + ctl["outage_remaining"]
            print(f"  !! simulated network outage for {ctl['outage_remaining']:.0f}s - buffering locally")

    # --- sending ------------------------------------------------------------------------
    def flush(self):
        if time.time() < self.forced_offline_until:
            self.set_online(False, "simulated outage")
            return
        while True:
            rows = self.outbox.peek()
            if not rows:
                return
            batch = [json.loads(p) for _, p in rows]
            try:
                resp = self.session.post(f"{self.server}/api/ingest", json={"readings": batch}, timeout=5)
                resp.raise_for_status()
            except requests.RequestException as exc:
                self.set_online(False, type(exc).__name__)
                return
            self.outbox.remove_upto(rows[-1][0])
            result = resp.json()
            if not self.online or result.get("backfilled"):
                print(f"  << reconnected: delivered {result['accepted']} readings "
                      f"({result['backfilled']} back-filled, {result['duplicates']} duplicates ignored)")
            self.set_online(True)
            if len(rows) < 500:
                return

    def set_online(self, online, why=""):
        if online != self.online:
            print("  >> ONLINE" if online else f"  >> OFFLINE ({why}) - store-and-forward active")
        self.online = online

    def edge_check(self, pid, reading, vp):
        """Local safety net when the cloud is unreachable."""
        vitals = {k: reading[k] for k in ("hr", "rr", "sbp", "temp", "consciousness")}
        if reading["spo2"]:
            vitals["spo2"] = reading["spo2"]
        s = news2.compute(vitals, spo2_scale=vp.scale, on_oxygen=vp.oxygen)
        if s["level"] == "high":
            print(f"  ** LOCAL ALARM (hub buzzer) {pid}: NEWS2 {s['total']} while offline - "
                  f"caregiver alerted in the home")

    # --- main loop --------------------------------------------------------------------
    def tick(self):
        self.ticks += 1
        if self.ticks % 3 == 1 and time.time() >= self.forced_offline_until:
            self.poll_control()
        if self.power_cut_after and self.ticks == self.power_cut_after:
            self.power = "battery"
            print("  !! simulated mains power cut - hub on battery backup")
        self.clock += timedelta(minutes=self.speed)
        hours = self.speed / 60
        for pid, vp in self.patients.items():
            reading = vp.step(hours)
            vp.seq += 1
            msg = {
                "device_id": vp.device_id, "patient_id": pid, "seq": vp.seq,
                "ts": self.clock.isoformat(timespec="seconds"), "generated_at": time.time(),
                "vitals": reading, "on_oxygen": vp.oxygen,
                "o2_flow": (0.0 if vp.unplugged else round(random.uniform(1.9, 2.1), 2)) if vp.oxygen else None,
                "battery": round(vp.battery, 1), "power": self.power,
            }
            self.outbox.push(msg)
            self.outbox.put(f"seq:{pid}", vp.seq)
            if not self.online:
                self.edge_check(pid, reading, vp)
        self.outbox.put("sim_clock", self.clock.isoformat(timespec="seconds"))
        self.flush()
        status = "online" if self.online else f"OFFLINE, {self.outbox.size()} buffered"
        line = " | ".join(f"{pid} HR{vp.state['hr']:.0f} SpO2 {vp.state['spo2']:.0f} RR{vp.state['rr']:.0f} "
                          f"T{vp.state['temp']:.1f} [{vp.scenario}]" for pid, vp in self.patients.items())
        print(f"{self.clock:%d %b %H:%M} ({status}) {line}")

    def run(self):
        print(f"HomeWard home hub -> {self.server}  (1 tick = {self.speed:g} patient-minutes "
              f"every {self.tick_seconds:g}s)")
        while True:
            started = time.time()
            try:
                self.tick()
            except Exception as exc:  # the hub must never die
                print("tick error:", exc)
            time.sleep(max(0.0, self.tick_seconds - (time.time() - started)))


def main():
    ap = argparse.ArgumentParser(description="HomeWard IoT simulator (virtual wearables + home hub)")
    ap.add_argument("--server", default=config.SERVER_URL)
    ap.add_argument("--key", default=config.DEVICE_API_KEY)
    ap.add_argument("--outbox", default="hub_outbox.db", help="local store-and-forward buffer file")
    ap.add_argument("--speed", type=float, default=config.SIM_MINUTES_PER_TICK,
                    help="patient-minutes simulated per tick")
    ap.add_argument("--tick", type=float, default=config.SIM_TICK_SECONDS, help="real seconds per tick")
    ap.add_argument("--power-cut-after", type=int, default=None, help="simulate mains failure after N ticks")
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()
    if args.seed is not None:
        random.seed(args.seed)
    HomeHub(args.server, args.key, args.outbox, args.speed, args.tick, args.power_cut_after).run()


if __name__ == "__main__":
    main()
