# HomeWard: Smart Home-Care Patient Monitoring

> **A small, always-aware hospital ward for the home.**
> SENSE → UNDERSTAND → PREDICT → ALERT → RESPOND

⚠ **This prototype is for demonstration purposes only and is not a medical device or substitute for professional medical judgment.** Risk levels are *prototype risk signals*, not diagnoses.

---

## 1. Problem
In hospital, monitors, nurses and alarms watch every patient. At home there is usually a family member, a thermometer, and a lot of "are you feeling okay?". Deterioration is noticed late, often only once it is an emergency.

## 2. Solution
HomeWard simulates wearable sensors in the patient's home. It streams vitals to a platform that understands **current values and trends**, explains **why** risk is rising, alerts the **right caregiver**, and records how they **respond**. It keeps collecting data through network and power failures.

| Step | What happens |
|---|---|
| **Sense** | Virtual wearables send HR, SpO2, temperature, BP and respiratory rate every 2 s |
| **Understand** | Values are validated and stored; caregiver notes become structured symptom signals |
| **Predict** | An explainable engine scores risk 0–100 (LOW/MEDIUM/HIGH) from values, trends, context and notes, and projects the trajectory over 24–48 h |
| **Alert** | De-duplicated alerts with cooldown and automatic escalation |
| **Respond** | Caregivers acknowledge, record a response, resolve or escalate. Everything is audited |

## 3. Architecture
```
Sensor Simulator ──► Backend API (Express) ──► PostgreSQL
  (buffer, retry,        │   ▲         │
   sequence numbers)     │   │         ├──► Redis/BullMQ (optional) ──► Risk Service ──► Risk Engine (FastAPI)
                         │   │         └──► Alert Service (dedupe, cooldown, escalation)
                         ▼   │
                   Socket.IO + REST ◄──► Caregiver Dashboard (React)
```
Full diagrams (Mermaid), data flow, failure handling and alert lifecycle are in **[docs/architecture.md](docs/architecture.md)**.

## 4. Features
- **Live dashboard**: patient cards with risk level, score, trend, one-line reason, vitals, device status, active alerts and caregiver status.
- **Patient page**: risk panel (level, score, confidence, trend, 24–48 h projection, "why" bullets, contributing factors, recommended action), live SpO2/HR/RR/temperature charts with reference ranges, risk trajectory, notes, alert history, caregiver activity.
- **Explainable risk**: for example *"HIGH RISK because SpO2 decreased from 97% to 89% over the last 38 s while respiratory rate increased from 16 to 28 breaths/min and heart rate increased from 80 to 115 bpm."*
- **Caregiver notes**: symptom extraction (breathing difficulty, fatigue, dizziness, chest discomfort, reduced appetite, confusion, pain) with negation handling.
- **Alerts**: triggered by risk threshold, rapid increase, critical vital, sensor offline, and unacknowledged HIGH alerts (escalation). One active alert per patient, upgraded rather than duplicated, with cooldown after resolution.
- **Attendance**: check in, check out, mark visit; PRESENT / NOT CHECKED IN status with last activity and last visit. HIGH risk with an absent caregiver escalates immediately.
- **Offline mode**: local buffer, exponential backoff, ordered batch sync, idempotent ingestion, "DEVICE OFFLINE — BUFFERING DATA" banner and recovery message.
- **Sensor failure detection**: silence is reported as a connectivity issue, never as deterioration.
- **Audit log** covering logins, ingestion, risk calculations, alerts, responses, escalations, config changes and buffer syncs.
- **Demo mode**: scenario, network and speed controls plus a self-ticking 10-step demo checklist.

## 5. Tech stack
| Layer | Technology |
|---|---|
| Backend | Node.js 20+, Express, ES modules, pg, zod, pino, Socket.IO, BullMQ + ioredis, JWT, bcrypt |
| Frontend | React 19, Vite, TailwindCSS 4, Recharts, socket.io-client |
| Risk engine | Python 3.10+, FastAPI, Pydantic |
| Database | PostgreSQL (run locally via `embedded-postgres`, no Docker or system install needed) |
| Queue | Redis + BullMQ (optional; jobs run inline without it) |
| Tests | node:test + supertest, pytest |

## 6. Database schema
`database/migrations/001_initial_schema.sql`, with 13 tables, enums, foreign keys, CHECK constraints and indexes.

| Table | Purpose |
|---|---|
| `users` | Login accounts (`ADMIN` / `CAREGIVER`), bcrypt hashes |
| `caregivers` | Caregiver profiles linked to users |
| `patients` | Demographics, medications, emergency contact, assigned caregiver, monitoring status |
| `patient_conditions` | Conditions with a risk category (RESPIRATORY, CARDIAC, …) |
| `sensor_devices` | Wearables, status ONLINE/OFFLINE, last seen, last sequence |
| `vital_readings` | Vitals with `source` (LIVE/BUFFERED/SEED), `sequence_number`; **UNIQUE (device_id, sequence_number)**; index (patient_id, timestamp) |
| `sensor_events` | ONLINE / OFFLINE / BUFFER_SYNC history |
| `caregiver_notes` | Note, language, translated text, extracted signals |
| `risk_assessments` | Level, score, confidence, explanation, reasons, factors, prediction |
| `alerts` | Status OPEN/ACKNOWLEDGED/RESOLVED/ESCALATED; partial unique index = one active alert per patient + category |
| `alert_actions` | Every acknowledgement, response, escalation, resolution |
| `caregiver_attendance` | CHECK_IN / CHECK_OUT / VISIT / ACTIVITY |
| `audit_logs` | timestamp, actor, action, entity, metadata, request id |

## 7. API documentation
All endpoints are under `/api`. User endpoints need `Authorization: Bearer <JWT>`. Ingestion needs `X-Device-Key`.

| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/auth/me` | Current user |
| POST | `/vitals` | **Device key.** One reading, or `{readings:[...]}` (≤500). Idempotent on `(device_id, sequence_number)`. Returns created / duplicate / rejected per reading |
| GET | `/patients` | Overview: latest vitals, latest risk, device, active alerts |
| GET | `/patients/:id` | Detail incl. conditions, notes, alerts, caregiver activity |
| GET | `/patients/:id/vitals?minutes=30` | Readings in a time window |
| GET | `/patients/:id/risk` | Latest assessment + score history |
| GET / POST | `/patients/:id/notes` | List / add a caregiver note `{note}` |
| GET | `/alerts?status=active\|all\|OPEN…&patientId=` | Alerts with their action history |
| GET | `/alerts/:id` | One alert |
| POST | `/alerts/:id/acknowledge` | `{note?}` |
| POST | `/alerts/:id/response` | `{note}` (also acknowledges if still open) |
| POST | `/alerts/:id/resolve` | `{note?}` |
| POST | `/alerts/:id/escalate` | `{note?}` |
| POST | `/caregivers/check-in` / `check-out` | `{note?}` (admin may pass `caregiverId`) |
| POST | `/caregivers/activity` | `{type: VISIT\|ACTIVITY, patientId?, note?}` |
| GET | `/caregivers/activity` | Caregivers with PRESENT status, last activity, last visit |
| GET | `/simulator/status` | Simulator state (demo) |
| POST | `/simulator/scenario` | `{patientId \| "ALL", scenario?, speed?: 1\|5\|10, network?: ONLINE\|OFFLINE}` |
| POST | `/simulator/reset` | ADMIN only: reset demo |
| GET | `/audit-logs?includeRoutine=false` | Audit trail |
| GET | `/health` | Database, risk engine and queue status |

Socket.IO events: `vital:new`, `risk:update`, `alert:new`, `alert:updated`, `device:status`, `device:synced`, `caregiver:activity`, `note:new`.

Risk engine: `POST /v1/assess`, `POST /v1/notes/extract`, `GET /health` (OpenAPI at http://localhost:8000/docs).

## 8. Risk engine explanation
The score combines **current values** (early-warning bands), **trends** (direction and rate over the recent window), **multiple signals worsening together**, **patient context** (age, respiratory/cardiac history), **caregiver note signals**, and **recovery** (improving trends lower the score). **Deterministic safety floors** guarantee that a critical vital is always HIGH. The output looks like this:
```json
{ "riskLevel": "HIGH", "riskScore": 82, "confidence": 0.9,
  "explanation": "HIGH RISK because SpO2 decreased from 95% to 91% over the last 2 min while respiratory rate increased ...",
  "reasons": ["SpO2 declining (95 → 91%)", "Respiratory rate rising (19 → 27 breaths/min)", "Caregiver reports breathing difficulty"],
  "contributingFactors": [{ "factor": "...", "category": "TREND", "points": 10, "detail": "..." }],
  "predictionWindow": "24-48 hours",
  "prediction": { "currentRisk": 82, "previousRisk": 54, "velocity": 28, "trend": "INCREASING", "projectedRisk": 100,
                  "statement": "Elevated deterioration risk over the next 24-48 hours if the current trend persists.",
                  "disclaimer": "Prototype trend projection based on recent data - not a clinical prediction." },
  "recommendedAction": "Requires immediate caregiver attention: ..." }
```
Details and exact point values are in [docs/architecture.md](docs/architecture.md#3-risk-calculation-prototype-hybrid-model). The model sits behind a `RiskModel` interface, so a trained ML model can replace it via `RISK_MODEL`.

## 9. Offline / retry mechanism
1. Each reading gets a per-device **sequence number**, which persists across restarts.
2. Readings are written to a **local buffer first** (atomic file writes), then sent in batches.
3. On failure the hub keeps buffering and retries with **exponential backoff + jitter** (1 s → 30 s max).
4. On reconnection the buffer is uploaded **in order**. The backend's `UNIQUE (device_id, sequence_number)` makes replays harmless (**idempotent**, duplicates counted, never stored).
5. While silent, the backend's watchdog shows **DEVICE OFFLINE — BUFFERING DATA** and raises a connectivity alert, without changing the risk score. On sync it auto-resolves that alert and logs `BUFFERED_READING_SYNCED`.

## 10. Setup instructions
Prerequisites: **Node.js 20+**, **Python 3.10+**, Git. No Docker needed.

```bash
npm install
```
```bash
pip install -r apps/risk-engine/requirements.txt
```
```bash
cp .env.example .env
```
Edit `.env` and set your own `JWT_SECRET`, `DEVICE_API_KEY` and `SIMULATOR_CONTROL_TOKEN`.

**Database.** Terminal 1 starts a project-local PostgreSQL (downloaded by npm into `.local/`, port 5433). Keep it running:
```bash
npm run db:start
```
Then, once, create the tables and demo data:
```bash
npm run db:migrate
```
(`npm run db:reset` wipes and re-seeds.) To use your own PostgreSQL instead, create a `homecare` database and point `DATABASE_URL` at it.

## 11. How to run every service
Everything at once (terminal 2):
```bash
npm run dev
```
Or individually:
| Service | Command | URL |
|---|---|---|
| Risk engine | `npm run dev:risk` | http://localhost:8000 |
| Backend | `npm run dev:backend` | http://localhost:4000 |
| Sensor simulator | `npm run dev:simulator` | http://localhost:4100 (control page) |
| Dashboard | `npm run dev:frontend` | **http://localhost:5173** |

**Redis (optional).** Set `REDIS_URL=redis://localhost:6379` to process jobs with BullMQ. Without it, jobs run inline and nothing else changes.

**Tests**
```bash
npm test
```
This runs 12 risk-engine tests (pytest), 8 simulator tests and 17 backend integration tests. The backend tests need `npm run db:start` running and use the `homecare_test` database.

## 12. Demo instructions (≈ 3 minutes)
**Demo credentials:**
| Role | Email | Password |
|---|---|---|
| Caregiver | anita@homecare.demo | Care@123 |
| Caregiver (checked out) | rahul@homecare.demo | Care@123 |
| Admin | admin@homecare.demo | Admin@123 |

Seed patients: **Ramesh Kumar** (stable, used for the demo), **Lakshmi Devi** (COPD + heart failure, gradually deteriorating, note about breathlessness), **Joseph D'Souza** (recovering from pneumonia; his caregiver Rahul is checked out).

Sign in as Anita. Use the **Demo mode** panel at the top of the dashboard (patient: Ramesh):
1. **Normal**: Ramesh is LOW (HR 78, SpO2 97, RR 16, 36.8 °C).
2. **Deterioration** (use **5x** to speed it up): the cards update live, and risk goes LOW → MEDIUM → HIGH with the reason.
3. A **HIGH alert** appears on the right. Open Ramesh to show the charts, "why" bullets and the 24–48 h projection.
4. **Acknowledge**, then **Add response** (a template is pre-filled) → status ACKNOWLEDGED.
5. **⚡ Power / connectivity failure**: cards show *DEVICE OFFLINE — BUFFERING DATA* and the panel counts buffered readings.
6. **Restore connection**: buffered readings sync with no duplicates (orange dots on the charts).
7. **Recovery**: vitals improve and risk falls. **Resolve** the alert.
8. Open **Audit log** to show every step.

The checklist on the right of the demo panel ticks itself off as each step happens. Admin can **Reset demo** at any time.

## 13. Environment variables
| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `DATABASE_URL` | postgres://homecare:homecare@localhost:5433/homecare | backend | PostgreSQL connection |
| `DATABASE_URL_TEST` | …/homecare_test | backend tests | Test database |
| `REDIS_URL` | *(empty)* | backend | Enables BullMQ; empty = inline jobs |
| `JWT_SECRET` | — | backend | **Set your own**; required in production |
| `JWT_EXPIRES_IN` | 8h | backend | Token lifetime |
| `DEVICE_API_KEY` | — | backend + simulator | Shared ingestion key |
| `SIMULATOR_CONTROL_TOKEN` | — | backend + simulator | Protects demo controls |
| `CORS_ORIGIN` | http://localhost:5173 | backend | Allowed origins (comma separated) |
| `RISK_ENGINE_URL` | http://localhost:8000 | backend | Risk engine |
| `SIMULATOR_URL` | http://localhost:4100 | backend | Simulator control API |
| `SENSOR_OFFLINE_SECONDS` | 15 | backend | Silence before "sensor offline" |
| `ACK_TIMEOUT_SECONDS` | 60 | backend | HIGH alert escalation timeout |
| `ALERT_COOLDOWN_SECONDS` | 60 | backend | No re-alert after resolution |
| `RAPID_INCREASE_THRESHOLD` | 20 | backend | Risk velocity that counts as rapid |
| `NOTE_WINDOW_MINUTES` | 120 | backend | How long a note influences risk |
| `BACKEND_URL` | http://localhost:4000 | simulator | Where readings are sent |
| `SIMULATOR_TICK_MS` | 2000 | simulator | Reading interval |
| `RISK_MODEL` | prototype-hybrid-v1 | risk engine | Model implementation |
| `LOCAL_PG_PORT` | 5433 | db:start | Local PostgreSQL port |

## 14. Project structure
```
├── apps/
│   ├── backend/            Express API: routes → controllers → services → repositories
│   │   ├── src/{config,db,lib,middleware,validators,repositories,services,controllers,routes,workers}
│   │   └── test/           integration tests (real PostgreSQL + real risk engine)
│   ├── frontend/           React + Tailwind + Recharts dashboard (src/{pages,components,lib})
│   ├── risk-engine/        FastAPI service (app/engine: vitals, trends, notes, model) + pytest
│   └── sensor-simulator/   virtual wearables, scenarios, store-and-forward uplink, control page
├── packages/shared/        constants shared by all JS apps (scenarios, ranges, demo patients, events)
├── database/{migrations,seeds}
├── docs/architecture.md
├── scripts/local-db.js     project-local PostgreSQL (no Docker)
├── .env.example
└── package.json            npm workspaces + scripts
```

## 15. Safety disclaimer
This prototype is for demonstration purposes only and is not a medical device or substitute for professional medical judgment. Scores and thresholds are illustrative, modelled on public early-warning-score ideas, and have **not** been clinically validated. "Predictions" are trend projections from recent data. Always follow the care plan and contact qualified clinicians.

## 16. Future improvements
- Train and validate an ML model on real outcome data (e.g. MIMIC-IV) behind the existing `RiskModel` interface, with calibration and clinician review.
- Optional LLM note interpretation and translation (Hindi, Telugu, …), still feeding only validated signals.
- Real devices over BLE/MQTT; FHIR integration with hospital systems.
- SMS / WhatsApp / voice notifications with delivery receipts; on-call rotas.
- Fine-grained per-patient access control, refresh tokens, encryption at rest, data-retention and consent (DPDP Act / HIPAA).
- Container deployment (Docker/Kubernetes), managed Postgres/Redis, metrics dashboards.

## Known limitations
- Thresholds and weights are hand-set for demonstration and are not clinically validated.
- The demo runs in compressed time (minutes, not days). The "24–48 h" projection is an extrapolation of the current trend.
- Note understanding is rule-based (English plus a few Hindi/Telugu keywords); unusual phrasing can be missed.
- The simulator's control page embeds its control token and is for local demo use only.
- Docker files are not included: this build runs natively with a project-local PostgreSQL.
