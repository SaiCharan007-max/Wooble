import { db } from '../db/pool.js';

export const riskRepository = {
  async insert(client, patientId, readingId, a) {
    const { rows } = await client.query(
      `INSERT INTO risk_assessments (patient_id, reading_id, risk_level, risk_score, confidence, explanation, reasons,
                                     contributing_factors, prediction, recommended_action, engine_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [patientId, readingId, a.riskLevel, a.riskScore, a.confidence, a.explanation, JSON.stringify(a.reasons),
        JSON.stringify(a.contributingFactors), JSON.stringify(a.prediction), a.recommendedAction, a.engineVersion]);
    return rows[0];
  },

  async latest(patientId) {
    const { rows } = await db.query(
      'SELECT * FROM risk_assessments WHERE patient_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [patientId]);
    return rows[0] || null;
  },

  /** Recent scores, oldest first (risk trajectory + velocity input). */
  async history(patientId, limit = 60) {
    const { rows } = await db.query(
      `SELECT id, risk_level, risk_score, confidence, created_at FROM (
         SELECT * FROM risk_assessments WHERE patient_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2) t
       ORDER BY created_at, id`, [patientId, limit]);
    return rows;
  },
};
