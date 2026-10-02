import { db } from '../db/pool.js';

export const caregiverRepository = {
  async findById(id) {
    const { rows } = await db.query('SELECT * FROM caregivers WHERE id = $1', [id]);
    return rows[0] || null;
  },

  /** PRESENT when the latest check-in/out entry is a check-in. */
  async isCheckedIn(caregiverId, client = db) {
    const { rows } = await client.query(
      `SELECT type FROM caregiver_attendance WHERE caregiver_id = $1 AND type IN ('CHECK_IN','CHECK_OUT')
       ORDER BY created_at DESC LIMIT 1`, [caregiverId]);
    return rows[0]?.type === 'CHECK_IN';
  },

  async insertAttendance({ caregiverId, patientId = null, type, note = null }) {
    const { rows } = await db.query(
      `INSERT INTO caregiver_attendance (caregiver_id, patient_id, type, note) VALUES ($1,$2,$3,$4) RETURNING *`,
      [caregiverId, patientId, type, note]);
    return rows[0];
  },

  async listWithStatus() {
    const { rows } = await db.query(
      `SELECT c.id, c.full_name, c.phone, u.email,
              (SELECT type FROM caregiver_attendance a WHERE a.caregiver_id = c.id AND a.type IN ('CHECK_IN','CHECK_OUT')
               ORDER BY created_at DESC LIMIT 1) = 'CHECK_IN' AS present,
              (SELECT max(created_at) FROM caregiver_attendance a WHERE a.caregiver_id = c.id) AS last_activity_at,
              (SELECT row_to_json(x) FROM (SELECT a.created_at, a.note, p.name AS patient_name
                 FROM caregiver_attendance a JOIN patients p ON p.id = a.patient_id
                 WHERE a.caregiver_id = c.id AND a.type = 'VISIT' ORDER BY a.created_at DESC LIMIT 1) x) AS last_visit,
              COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name)
                        FROM patients p WHERE p.assigned_caregiver_id = c.id), '[]') AS patients
       FROM caregivers c LEFT JOIN users u ON u.id = c.user_id ORDER BY c.full_name`);
    return rows;
  },

  async recentActivity({ patientId, limit = 30 } = {}) {
    const params = [limit];
    let where = '';
    if (patientId) {
      params.push(patientId);
      where = 'WHERE a.patient_id = $2';
    }
    const { rows } = await db.query(
      `SELECT a.*, c.full_name AS caregiver_name, p.name AS patient_name
       FROM caregiver_attendance a JOIN caregivers c ON c.id = a.caregiver_id
       LEFT JOIN patients p ON p.id = a.patient_id ${where}
       ORDER BY a.created_at DESC LIMIT $1`, params);
    return rows;
  },
};
