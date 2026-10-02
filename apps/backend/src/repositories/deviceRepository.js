import { db } from '../db/pool.js';

export const deviceRepository = {
  async findByUid(uid) {
    const { rows } = await db.query('SELECT * FROM sensor_devices WHERE device_uid = $1', [uid]);
    return rows[0] || null;
  },

  /** Marks the device as seen now; returns its status *before* this update (to detect reconnections). */
  async markSeen(client, deviceId, sequence) {
    const { rows } = await client.query(
      `UPDATE sensor_devices d SET status = 'ONLINE', last_seen_at = now(),
              last_sequence_number = GREATEST(COALESCE(d.last_sequence_number, 0), $2)
       FROM (SELECT id, status FROM sensor_devices WHERE id = $1 FOR UPDATE) prev
       WHERE d.id = prev.id
       RETURNING prev.status AS previous_status`, [deviceId, sequence]);
    return rows[0]?.previous_status;
  },

  /** Devices that were online but have not reported for `seconds`. */
  async listStale(seconds) {
    const { rows } = await db.query(
      `SELECT d.*, p.name AS patient_name FROM sensor_devices d JOIN patients p ON p.id = d.patient_id
       WHERE d.status = 'ONLINE' AND d.last_seen_at < now() - make_interval(secs => $1)`, [seconds]);
    return rows;
  },

  async setStatus(client, deviceId, status) {
    await client.query('UPDATE sensor_devices SET status = $2 WHERE id = $1', [deviceId, status]);
  },

  async insertEvent(client, { deviceId, patientId, type, details = {} }) {
    await client.query(
      'INSERT INTO sensor_events (device_id, patient_id, event_type, details) VALUES ($1,$2,$3,$4)',
      [deviceId, patientId, type, details]);
  },

  async listAll() {
    const { rows } = await db.query(
      `SELECT d.id, d.device_uid, d.patient_id, d.status, d.last_seen_at, d.last_sequence_number, p.name AS patient_name
       FROM sensor_devices d JOIN patients p ON p.id = d.patient_id ORDER BY d.device_uid`);
    return rows;
  },
};
