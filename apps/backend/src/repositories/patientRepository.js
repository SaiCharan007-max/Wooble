import { db } from '../db/pool.js';

// One row per patient with everything the dashboard card needs.
const OVERVIEW = `
  SELECT p.id, p.name, p.age, p.gender, p.medications, p.emergency_contact, p.monitoring_status, p.created_at,
         p.assigned_caregiver_id,
         c.full_name AS assigned_caregiver,
         COALESCE((SELECT json_agg(json_build_object('condition', pc.condition, 'riskCategory', pc.risk_category)
                                   ORDER BY pc.condition)
                   FROM patient_conditions pc WHERE pc.patient_id = p.id), '[]') AS medical_conditions,
         row_to_json(d) AS device,
         row_to_json(v) AS latest_vitals,
         row_to_json(r) AS latest_risk,
         (SELECT count(*)::int FROM alerts a WHERE a.patient_id = p.id AND a.status <> 'RESOLVED') AS active_alerts
  FROM patients p
  LEFT JOIN caregivers c ON c.id = p.assigned_caregiver_id
  LEFT JOIN LATERAL (SELECT id, device_uid, status, last_seen_at, last_sequence_number
                     FROM sensor_devices WHERE patient_id = p.id ORDER BY created_at LIMIT 1) d ON true
  LEFT JOIN LATERAL (SELECT id, "timestamp", heart_rate, spo2, temperature, systolic_bp, diastolic_bp,
                            respiratory_rate, source
                     FROM vital_readings WHERE patient_id = p.id ORDER BY "timestamp" DESC LIMIT 1) v ON true
  LEFT JOIN LATERAL (SELECT id, risk_level, risk_score, confidence, explanation, reasons, prediction,
                            recommended_action, engine_version, created_at
                     FROM risk_assessments WHERE patient_id = p.id ORDER BY created_at DESC, id DESC LIMIT 1) r ON true`;

export const patientRepository = {
  async list() {
    const { rows } = await db.query(`${OVERVIEW} ORDER BY p.name`);
    return rows;
  },
  async findById(id) {
    const { rows } = await db.query(`${OVERVIEW} WHERE p.id = $1`, [id]);
    return rows[0] || null;
  },
  async exists(id) {
    const { rows } = await db.query('SELECT 1 FROM patients WHERE id = $1', [id]);
    return rows.length > 0;
  },
  /** Minimal context the risk engine needs (no names or contact details leave the backend). */
  async riskContext(id) {
    const { rows } = await db.query(
      `SELECT p.id, p.age, p.assigned_caregiver_id,
              COALESCE((SELECT json_agg(json_build_object('condition', condition, 'riskCategory', risk_category))
                        FROM patient_conditions WHERE patient_id = p.id), '[]') AS conditions
       FROM patients p WHERE p.id = $1`, [id]);
    return rows[0] || null;
  },
};
