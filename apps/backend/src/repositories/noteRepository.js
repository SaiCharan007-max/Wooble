import { db } from '../db/pool.js';

export const noteRepository = {
  async insert(n) {
    const { rows } = await db.query(
      `INSERT INTO caregiver_notes (patient_id, caregiver_id, author_user_id, note, language, translated_text,
                                    extracted_signals, extraction_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [n.patientId, n.caregiverId, n.authorUserId, n.note, n.language, n.translatedText,
        JSON.stringify(n.signals), n.method]);
    return rows[0];
  },

  async listForPatient(patientId, limit = 20) {
    const { rows } = await db.query(
      `SELECT n.*, COALESCE(c.full_name, u.full_name) AS author
       FROM caregiver_notes n
       LEFT JOIN caregivers c ON c.id = n.caregiver_id
       LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.patient_id = $1 ORDER BY n."timestamp" DESC LIMIT $2`, [patientId, limit]);
    return rows;
  },

  /** Structured signals from notes written in the last `minutes` - the only note input to the risk engine. */
  async recentSignals(patientId, minutes) {
    const { rows } = await db.query(
      `SELECT s->>'signal' AS signal, n."timestamp"
       FROM caregiver_notes n, jsonb_array_elements(n.extracted_signals) s
       WHERE n.patient_id = $1 AND n."timestamp" >= now() - make_interval(mins => $2)`, [patientId, minutes]);
    return rows;
  },
};
