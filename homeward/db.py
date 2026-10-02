"""SQLite storage. A single file, zero setup; WAL mode keeps reads fast while the
hub is writing. The UNIQUE(device_id, seq) constraint makes ingestion idempotent,
so a hub can safely re-send buffered readings after an outage."""
import sqlite3
import threading

SCHEMA = """
CREATE TABLE IF NOT EXISTS patients (
    id TEXT PRIMARY KEY, name TEXT, age INTEGER, conditions TEXT,
    spo2_scale INTEGER DEFAULT 1, home_oxygen INTEGER DEFAULT 0,
    caregiver TEXT, emergency_contact TEXT, language TEXT DEFAULT 'en'
);
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, patient_id TEXT, kind TEXT, last_seen REAL,
    battery REAL, power TEXT, status TEXT DEFAULT 'unknown'
);
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id TEXT, device_id TEXT, seq INTEGER, ts TEXT, received_at REAL,
    hr REAL, spo2 REAL, temp REAL, rr REAL, sbp REAL, dbp REAL, consciousness TEXT,
    on_oxygen INTEGER DEFAULT 0, o2_flow REAL, artifact TEXT, backfilled INTEGER DEFAULT 0,
    UNIQUE(device_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_readings_patient_ts ON readings(patient_id, ts);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, author TEXT,
    created_at REAL, text TEXT, analysis TEXT
);
CREATE TABLE IF NOT EXISTS assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, ts TEXT, created_at REAL,
    level TEXT, news2 INTEGER, predicted_level TEXT, hours_to_high INTEGER, summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_assess_patient ON assessments(patient_id, id);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, kind TEXT, severity TEXT,
    title TEXT, reason TEXT, status TEXT, created_at REAL, updated_at REAL,
    escalation_level INTEGER DEFAULT 0, last_escalated_at REAL,
    acked_by TEXT, acked_at REAL, ack_note TEXT,
    resolved_by TEXT, resolved_at REAL, resolve_note TEXT
);
CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, caregiver TEXT,
    method TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, created_at REAL,
    kind TEXT, message TEXT
);
CREATE TABLE IF NOT EXISTS sim_control (
    patient_id TEXT PRIMARY KEY, scenario TEXT, unplugged INTEGER DEFAULT 0, updated_at REAL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
"""


class Database:
    def __init__(self, path):
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.executescript(SCHEMA)

    def execute(self, sql, params=()):
        with self.lock:
            return self.conn.execute(sql, params)

    def insert(self, sql, params=()):
        with self.lock:
            return self.conn.execute(sql, params).lastrowid

    def query(self, sql, params=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def one(self, sql, params=()):
        with self.lock:
            row = self.conn.execute(sql, params).fetchone()
            return dict(row) if row else None

    def close(self):
        with self.lock:
            self.conn.close()
