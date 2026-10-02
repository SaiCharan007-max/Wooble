-- Medical equipment monitoring, outbound notifications, and home-hub (edge) events.

CREATE TYPE equipment_status AS ENUM ('OK', 'ON_BATTERY', 'FAULT', 'UNKNOWN');
ALTER TYPE alert_category ADD VALUE IF NOT EXISTS 'EQUIPMENT';

CREATE TABLE medical_equipment (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    equipment_uid        text NOT NULL UNIQUE,
    patient_id           uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    type                 text NOT NULL CHECK (type IN ('OXYGEN_CONCENTRATOR')),
    prescribed_flow_lpm  numeric(4, 1) NOT NULL CHECK (prescribed_flow_lpm > 0),
    status               equipment_status NOT NULL DEFAULT 'UNKNOWN',
    last_seen_at         timestamptz,
    last_sequence_number bigint,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE equipment_readings (
    id              bigserial PRIMARY KEY,
    equipment_id    uuid NOT NULL REFERENCES medical_equipment (id) ON DELETE CASCADE,
    patient_id      uuid NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
    "timestamp"     timestamptz NOT NULL,
    flow_lpm        numeric(4, 1) NOT NULL CHECK (flow_lpm BETWEEN 0 AND 15),
    power_source    text NOT NULL CHECK (power_source IN ('MAINS', 'BATTERY', 'NONE')),
    source          reading_source NOT NULL DEFAULT 'LIVE',
    sequence_number bigint NOT NULL CHECK (sequence_number >= 0),
    received_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_equipment_reading_sequence UNIQUE (equipment_id, sequence_number)
);
CREATE INDEX idx_equipment_readings_ts ON equipment_readings (equipment_id, "timestamp" DESC);

-- Alerts can now be triggered by equipment faults.
ALTER TABLE alerts DROP CONSTRAINT alerts_trigger_type_check;
ALTER TABLE alerts ADD CONSTRAINT alerts_trigger_type_check
    CHECK (trigger_type IN ('RISK_THRESHOLD', 'RAPID_INCREASE', 'CRITICAL_VITAL', 'SENSOR_OFFLINE', 'EQUIPMENT_FAULT'));

-- Home-hub events (local alarms raised while the cloud was unreachable), synced later.
ALTER TABLE sensor_events DROP CONSTRAINT sensor_events_event_type_check;
ALTER TABLE sensor_events ADD CONSTRAINT sensor_events_event_type_check
    CHECK (event_type IN ('ONLINE', 'OFFLINE', 'BUFFER_SYNC', 'INVALID_READING', 'DUPLICATE_READING',
                          'LOCAL_ALARM', 'LOCAL_ALARM_ACK', 'LOCAL_ALARM_CLEARED'));
ALTER TABLE sensor_events ADD COLUMN event_uid text;
CREATE UNIQUE INDEX uq_sensor_events_uid ON sensor_events (event_uid) WHERE event_uid IS NOT NULL;

-- Every outbound notification (Telegram etc.), for traceability.
CREATE TABLE notifications (
    id         bigserial PRIMARY KEY,
    alert_id   uuid REFERENCES alerts (id) ON DELETE CASCADE,
    channel    text NOT NULL,
    recipient  text,
    kind       text NOT NULL,
    status     text NOT NULL CHECK (status IN ('SENT', 'FAILED', 'SKIPPED')),
    error      text,
    external_id text, -- e.g. Telegram chat:message id, so the message can be updated when the alert changes
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_alert ON notifications (alert_id);
