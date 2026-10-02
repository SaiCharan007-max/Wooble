-- Smart Home-Care Patient Monitoring System - initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- enums
CREATE TYPE user_role          AS ENUM ('ADMIN', 'CAREGIVER');
CREATE TYPE monitoring_status  AS ENUM ('ACTIVE', 'PAUSED', 'DISCHARGED');
CREATE TYPE risk_level         AS ENUM ('LOW', 'MEDIUM', 'HIGH');
CREATE TYPE alert_status       AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED');
CREATE TYPE alert_category     AS ENUM ('CLINICAL', 'DEVICE');
CREATE TYPE alert_action_type  AS ENUM ('CREATED', 'UPDATED', 'ACKNOWLEDGED', 'RESPONSE', 'RESOLVED', 'ESCALATED', 'AUTO_RESOLVED');
CREATE TYPE reading_source     AS ENUM ('LIVE', 'BUFFERED', 'SEED');
CREATE TYPE device_status      AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');
CREATE TYPE attendance_type    AS ENUM ('CHECK_IN', 'CHECK_OUT', 'VISIT', 'ACTIVITY');

-- ---------------------------------------------------------------- people
CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE CHECK (email = lower(email)),
    password_hash text NOT NULL,
    full_name     text NOT NULL,
    role          user_role NOT NULL,
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE caregivers (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid UNIQUE REFERENCES users (id) ON DELETE SET NULL,
    full_name  text NOT NULL,
    phone      text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patients (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  text NOT NULL,
    age                   integer NOT NULL CHECK (age BETWEEN 0 AND 130),
    gender                text NOT NULL CHECK (gender IN ('MALE', 'FEMALE', 'OTHER')),
    medications           text[] NOT NULL DEFAULT '{}',
    emergency_contact     text,
    assigned_caregiver_id uuid REFERENCES caregivers (id) ON DELETE SET NULL,
    monitoring_status     monitoring_status NOT NULL DEFAULT 'ACTIVE',
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_patients_caregiver ON patients (assigned_caregiver_id);

CREATE TABLE patient_conditions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id    uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    condition     text NOT NULL,
    risk_category text NOT NULL DEFAULT 'OTHER'
                  CHECK (risk_category IN ('RESPIRATORY', 'CARDIAC', 'METABOLIC', 'INFECTION', 'OTHER')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (patient_id, condition)
);

-- ---------------------------------------------------------------- devices & vitals
CREATE TABLE sensor_devices (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_uid           text NOT NULL UNIQUE,
    patient_id           uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    status               device_status NOT NULL DEFAULT 'UNKNOWN',
    last_seen_at         timestamptz,
    last_sequence_number bigint,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vital_readings (
    id               bigserial PRIMARY KEY,
    patient_id       uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    device_id        uuid REFERENCES sensor_devices (id) ON DELETE SET NULL,
    "timestamp"      timestamptz NOT NULL,
    heart_rate       smallint CHECK (heart_rate BETWEEN 20 AND 250),
    spo2             smallint CHECK (spo2 BETWEEN 50 AND 100),
    temperature      numeric(4, 1) CHECK (temperature BETWEEN 30 AND 43),
    systolic_bp      smallint CHECK (systolic_bp BETWEEN 50 AND 260),
    diastolic_bp     smallint CHECK (diastolic_bp BETWEEN 20 AND 160),
    respiratory_rate smallint CHECK (respiratory_rate BETWEEN 4 AND 60),
    source           reading_source NOT NULL DEFAULT 'LIVE',
    sequence_number  bigint NOT NULL CHECK (sequence_number >= 0),
    received_at      timestamptz NOT NULL DEFAULT now(),
    -- Idempotency: a device can never store the same sequence number twice.
    CONSTRAINT uq_reading_device_sequence UNIQUE (device_id, sequence_number)
);
CREATE INDEX idx_vitals_patient_ts ON vital_readings (patient_id, "timestamp" DESC);

CREATE TABLE sensor_events (
    id          bigserial PRIMARY KEY,
    device_id   uuid REFERENCES sensor_devices (id) ON DELETE CASCADE,
    patient_id  uuid REFERENCES patients (id) ON DELETE CASCADE,
    event_type  text NOT NULL CHECK (event_type IN ('ONLINE', 'OFFLINE', 'BUFFER_SYNC', 'INVALID_READING', 'DUPLICATE_READING')),
    details     jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sensor_events_device ON sensor_events (device_id, created_at DESC);

-- ---------------------------------------------------------------- notes & risk
CREATE TABLE caregiver_notes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id        uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    caregiver_id      uuid REFERENCES caregivers (id) ON DELETE SET NULL,
    author_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    note              text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 2000),
    language          text NOT NULL DEFAULT 'en',
    translated_text   text,
    extracted_signals jsonb NOT NULL DEFAULT '[]',
    extraction_method text NOT NULL DEFAULT 'rule-based',
    "timestamp"       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notes_patient_ts ON caregiver_notes (patient_id, "timestamp" DESC);

CREATE TABLE risk_assessments (
    id                   bigserial PRIMARY KEY,
    patient_id           uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    reading_id           bigint REFERENCES vital_readings (id) ON DELETE SET NULL,
    risk_level           risk_level NOT NULL,
    risk_score           smallint NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
    confidence           numeric(3, 2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    explanation          text NOT NULL,
    reasons              jsonb NOT NULL DEFAULT '[]',
    contributing_factors jsonb NOT NULL DEFAULT '[]',
    prediction           jsonb NOT NULL DEFAULT '{}',
    recommended_action   text NOT NULL,
    engine_version       text NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_risk_patient_created ON risk_assessments (patient_id, created_at DESC);

-- ---------------------------------------------------------------- alerts
CREATE TABLE alerts (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id       uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    category         alert_category NOT NULL,
    trigger_type     text NOT NULL CHECK (trigger_type IN ('RISK_THRESHOLD', 'RAPID_INCREASE', 'CRITICAL_VITAL', 'SENSOR_OFFLINE')),
    risk_level       risk_level NOT NULL,
    title            text NOT NULL,
    description      text NOT NULL,
    reasons          jsonb NOT NULL DEFAULT '[]',
    status           alert_status NOT NULL DEFAULT 'OPEN',
    escalation_level smallint NOT NULL DEFAULT 0,
    escalation_reason text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    acknowledged_at  timestamptz,
    acknowledged_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    resolved_at      timestamptz,
    resolved_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    escalated_at     timestamptz
);
-- De-duplication at the database level: at most one active alert per patient per category.
CREATE UNIQUE INDEX uq_alerts_one_active ON alerts (patient_id, category) WHERE status <> 'RESOLVED';
CREATE INDEX idx_alerts_status_created ON alerts (status, created_at DESC);
CREATE INDEX idx_alerts_patient_created ON alerts (patient_id, created_at DESC);

CREATE TABLE alert_actions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id      uuid NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
    action        alert_action_type NOT NULL,
    actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    actor_label   text NOT NULL,
    note          text CHECK (note IS NULL OR char_length(note) <= 2000),
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_alert_actions_alert ON alert_actions (alert_id, created_at);

-- ---------------------------------------------------------------- attendance & audit
CREATE TABLE caregiver_attendance (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    caregiver_id uuid NOT NULL REFERENCES caregivers (id) ON DELETE CASCADE,
    patient_id   uuid REFERENCES patients (id) ON DELETE SET NULL,
    type         attendance_type NOT NULL,
    note         text CHECK (note IS NULL OR char_length(note) <= 500),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_attendance_caregiver ON caregiver_attendance (caregiver_id, created_at DESC);

CREATE TABLE audit_logs (
    id            bigserial PRIMARY KEY,
    "timestamp"   timestamptz NOT NULL DEFAULT now(),
    actor         text NOT NULL,
    actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    action        text NOT NULL,
    entity_type   text NOT NULL,
    entity_id     text,
    metadata      jsonb NOT NULL DEFAULT '{}',
    request_id    text
);
CREATE INDEX idx_audit_ts ON audit_logs ("timestamp" DESC);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id);
