import { db } from '../db/pool.js';

export const equipmentRepository = {
  async findByUid(uid) {
    const { rows } = await db.query('SELECT * FROM medical_equipment WHERE equipment_uid = $1', [uid]);
    return rows[0] || null;
  },

  /** Idempotent insert keyed on (equipment_id, sequence_number); returns null for a duplicate. */
  async insertReading(client, r) {
    const { rows } = await client.query(
      `INSERT INTO equipment_readings (equipment_id, patient_id, "timestamp", flow_lpm, power_source, source, sequence_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (equipment_id, sequence_number) DO NOTHING RETURNING *`,
      [r.equipment_db_id, r.patient_id, r.timestamp, r.flow_lpm, r.power_source, r.source, r.sequence_number]);
    return rows[0] || null;
  },

  /** Sets status + last seen; returns the status before the update. */
  async updateStatus(client, id, status, sequence) {
    const { rows } = await client.query(
      `UPDATE medical_equipment e SET status = $2, last_seen_at = now(),
              last_sequence_number = GREATEST(COALESCE(e.last_sequence_number, 0), $3)
       FROM (SELECT id, status FROM medical_equipment WHERE id = $1 FOR UPDATE) prev
       WHERE e.id = prev.id RETURNING prev.status AS previous_status`, [id, status, sequence]);
    return rows[0]?.previous_status;
  },

  async statusForPatient(patientId) {
    const { rows } = await db.query('SELECT type, status FROM medical_equipment WHERE patient_id = $1', [patientId]);
    return rows;
  },
};

export const hubEventRepository = {
  /** Returns true if stored, false if this event_uid was already synced (idempotent). */
  async insert(client, { deviceId, patientId, type, eventUid, details }) {
    const { rowCount } = await client.query(
      `INSERT INTO sensor_events (device_id, patient_id, event_type, event_uid, details, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (event_uid) WHERE event_uid IS NOT NULL DO NOTHING`,
      [deviceId, patientId, type, eventUid, details, details.timestamp || new Date()]);
    return rowCount > 0;
  },
};
