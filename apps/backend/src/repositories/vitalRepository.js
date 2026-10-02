import { db } from '../db/pool.js';

const COLUMNS = `id, patient_id, "timestamp", heart_rate, spo2, temperature, systolic_bp, diastolic_bp,
                 respiratory_rate, source, sequence_number, received_at`;

export const vitalRepository = {
  /** Idempotent insert: returns the new row, or null if this (device, sequence) was already stored. */
  async insert(client, r) {
    const { rows } = await client.query(
      `INSERT INTO vital_readings (patient_id, device_id, "timestamp", heart_rate, spo2, temperature, systolic_bp,
                                   diastolic_bp, respiratory_rate, source, sequence_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (device_id, sequence_number) DO NOTHING
       RETURNING ${COLUMNS}`,
      [r.patient_id, r.device_db_id, r.timestamp, r.heart_rate ?? null, r.spo2 ?? null, r.temperature ?? null,
        r.systolic_bp ?? null, r.diastolic_bp ?? null, r.respiratory_rate ?? null, r.source, r.sequence_number],
    );
    return rows[0] || null;
  },

  async listForPatient(patientId, { minutes = 30, limit = 1000 } = {}) {
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM (
         SELECT * FROM vital_readings
         WHERE patient_id = $1 AND "timestamp" >= now() - make_interval(mins => $2)
         ORDER BY "timestamp" DESC LIMIT $3) t
       ORDER BY "timestamp"`, [patientId, minutes, limit]);
    return rows;
  },

  /** Most recent `n` readings, oldest first - input for the risk engine. */
  async latest(patientId, n = 30) {
    const { rows } = await db.query(
      `SELECT ${COLUMNS} FROM (
         SELECT * FROM vital_readings WHERE patient_id = $1 ORDER BY "timestamp" DESC LIMIT $2) t
       ORDER BY "timestamp"`, [patientId, n]);
    return rows;
  },

  async countForDevice(deviceDbId) {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM vital_readings WHERE device_id = $1', [deviceDbId]);
    return rows[0].n;
  },
};
