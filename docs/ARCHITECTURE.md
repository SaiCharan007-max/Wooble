# HomeWard: Technical Documentation

## 1. Goal

Make a patient's home behave like a small, always-aware hospital ward. The system has to:
**sense** vitals and equipment, **understand** the patient's state, **predict** deterioration early,
**alert** the right person, and record how they **respond**. It also has to keep working through network or power
problems, stay explainable, and be clinically cautious.

## 2. Components and data flow

```
┌──────────────── HOME ────────────────┐        ┌──────────────── PLATFORM ─────────────────────┐
│ virtual wearables (HR, SpO2, RR,     │        │  POST /api/ingest                              │
│ temp, BP, consciousness) + O2        │ HTTPS  │   ├─ auth (X-Device-Key)                      │
│ concentrator + battery/power         ├───────►│   ├─ validation (plausible ranges -> artifact)│
│            │                         │ batch  │   ├─ idempotent insert UNIQUE(device,seq)     │
│            ▼                         │        │   ├─ equipment checks (O2 flow, battery)      │
│ HOME HUB                             │        │   └─ risk engine ─► alert manager ─► WS push  │
│  1. write to SQLite outbox           │        │                                                │
│  2. try send; on failure keep        │        │  Watchdog (2s): device offline, missed         │
│     buffering, replay in order       │        │  check-ins, escalation of unacked alerts       │
│  3. while offline: local NEWS2 alarm │        │                                                │
└──────────────────────────────────────┘        │  Dashboard (WS live + polling fallback)        │
                                                │  notes / check-in / acknowledge / resolve      │
                                                └────────────────────────────────────────────────┘
```

### 2.1 IoT simulation (`homeward/simulator.py`)
- `VirtualPatient` keeps a smoothed "true physiology" state that drifts toward a **scenario** target
  (`stable`, `sepsis`, `copd_exacerbation`, `heart_failure`, `acute_event`, `recovery`). Gaussian sensor noise is added,
  and about 1% of readings carry a realistic artifact (SpO2 = 0 when the probe slips off).
- **Accelerated clock**: each tick (1s) represents 10 patient-minutes, so 48 patient-hours take about 5 real minutes.
  Reading timestamps use the simulated clock, which the prediction relies on.
- `HomeHub` is the gateway. It uses a **store-and-forward** outbox (SQLite), persists sequence numbers and the clock
  across restarts, polls `/api/sim/control` for demo scenarios, and raises a **local alarm** when it's offline and
  NEWS2 is HIGH.

### 2.2 Platform (`homeward/server.py`)
- FastAPI app built by `create_app(db_path)`, a factory that the tests also use.
- `Hub` holds the database, the alert manager, the WebSocket clients and the latest assessment per patient.
- After each ingest or note, the affected patients are **re-assessed** and a full snapshot is pushed over WebSocket.
- A watchdog coroutine runs every 2s: it marks silent devices offline, raises missed check-in alerts, and escalates
  unacknowledged alerts.

### 2.3 Data model (`homeward/db.py`)
`patients`, `devices`, `readings` (UNIQUE device_id+seq, `artifact`, `backfilled`), `notes` (with stored analysis),
`assessments` (risk history), `alerts` (full lifecycle fields), `checkins`, `events` (audit trail), `sim_control`, `kv`.

## 3. Risk engine

### 3.1 NEWS2 (`news2.py`)
This is the standard UK early-warning score. Each parameter maps to 0–3 points. The mapping to three levels follows the
NEWS2 clinical-response thresholds: **0–4 LOW, 5–6 or any single 3 MEDIUM, 7+ HIGH**. SpO2 scale 2 is used for
patients with hypercapnic respiratory failure (COPD). Missing parameters are listed, never assumed normal.

### 3.2 Prediction (`trends.py`)
1. Window: the last 6 patient-hours. At least 6 points spanning at least 1h are required, otherwise the engine reports "not enough history".
2. Per vital: a least-squares slope plus R². A trend counts only if R² ≥ 0.3 and |slope| is above a per-vital
   minimum (for example 0.5 bpm/h for HR). This filters out noise.
3. Projection: `value(h) = now + slope × 24 × ln(1 + h/24)`. This is a **damped** trend, because physiology seldom
   keeps changing linearly. Values are clamped to physiological limits.
4. NEWS2 is re-computed for h = 1…48. Outputs: hours to MEDIUM, hours to HIGH, the predicted level at 24h, a timeline
   at +6/12/24/36/48h, and the list of worsening trends.
5. Confidence comes from the mean R² of the worsening trends.

Why not a black-box ML model? There was no labelled outcome data, and clinical users need to see *why*. The interface
(`analyse(readings) -> prediction`) makes it easy to swap in a trained model later, for example gradient boosting on
MIMIC-IV, while the same safety rules stay around it.

### 3.3 Caregiver notes (`notes.py`)
- 19 symptom categories with weights, 6 of them red flags (chest pain, severe breathing difficulty, unresponsive,
  seizure, stroke signs).
- Negation: a negator ("no", "not", "denies", "without", "n't"…) within the preceding 4 words *of the same clause*
  cancels the match. So "no fever or chills" negates both, while "denies chest pain but has fever" still flags fever.
- Reassuring phrases soften minor concerns but never cancel a red flag.
- Bonus: native-script and romanised Hindi and Telugu keywords. Language is detected from the Unicode block.

### 3.4 Fusion and safety rules (`engine.py`)
| Rule | Why |
|---|---|
| Vitals level is a floor; notes and predictions only raise | A reassuring note must never hide abnormal vitals |
| Red-flag note → HIGH | Some symptoms need action whatever the numbers say |
| Worrying notes → +1 level max | Avoids over-reacting to subjective text |
| Credible predicted HIGH (≥2 worsening vitals, confidence ≥ moderate) → LOW becomes MEDIUM early warning | Catches deterioration 24–48h ahead, with protection against false alarms |
| Early-warning hysteresis | Doesn't flicker with noise once raised |
| De-escalate only after 3 consecutive better assessments | Threshold noise doesn't cause flip-flopping |
| Artifacts rejected, missing data reported | Bad data is never silently treated as normal |

## 4. Alerting (`alerts.py`)
- States: `open → acknowledged → resolved`. There is one active alert per (patient, kind).
- Upgrade: a higher severity on an active alert re-opens it and resets its escalation timer.
- Escalation chain: caregiver → family and nurse → doctor or emergency (108). The timer is per severity (HIGH 45s, MEDIUM 120s in the demo).
- Clinical alerts need a human to close them. Technical alerts (device offline, O2 supply, battery, missed check-in) auto-resolve when
  the condition clears, with a note.
- Every transition is written to `events`, giving an auditable timeline that includes response times.

## 5. Caregiver attendance
Caregivers check in from the dashboard (in production this would be NFC, QR at the bedside, or BLE proximity). If there
is no check-in within `CHECKIN_INTERVAL_SECONDS` (10 min in the demo, 4–6h in practice), a "check-in overdue" alert is
raised. It auto-resolves on the next check-in.

## 6. Resilience summary
See the table in the README. The key ideas are **store-and-forward**, **idempotent replay**, an **edge safety net**,
a **watchdog for silence**, and **client-side reconnect with a polling fallback**.

## 7. Testing
`python -m pytest -q` runs 24 tests:
- NEWS2 thresholds, scale 2, missing data
- Notes: detection, negation, red flags, "fell asleep", Hindi/Telugu
- Safety rules: notes can't lower risk, red flag → HIGH, one-level bump, de-escalation hysteresis
- Prediction: early warning fires while the vitals are still LOW in a sepsis-like drift
- API: device auth, idempotent ingest, artifact rejection, backfill flag, the full sensor → alert → ack → resolve flow,
  no duplicate alerts, escalation, oxygen equipment alert

## 8. Production roadmap
- Real devices over MQTT/BLE (the hub's `flush()` is the only part that changes). FHIR export for EHR integration.
- PostgreSQL/TimescaleDB, message queue, horizontal scaling. Caregiver authentication (OAuth/OIDC), role-based access,
  TLS everywhere, encryption at rest, consent and data-retention policies (DPDP Act / HIPAA).
- Real notifications (SMS/WhatsApp/voice through a provider) with delivery receipts.
- A trained prediction model validated on outcome data, with calibration and clinician review. An LLM note summariser
  sitting behind the same "can only raise risk" safety rules.
- Clinical validation and regulatory pathway (software as a medical device).
