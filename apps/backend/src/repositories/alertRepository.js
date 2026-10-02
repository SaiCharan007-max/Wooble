import { db } from '../db/pool.js';

const WITH_PATIENT = `SELECT a.*, p.name AS patient_name, ack.full_name AS acknowledged_by_name,
                             res.full_name AS resolved_by_name
                      FROM alerts a
                      JOIN patients p ON p.id = a.patient_id
                      LEFT JOIN users ack ON ack.id = a.acknowledged_by
                      LEFT JOIN users res ON res.id = a.resolved_by`;

export const alertRepository = {
  /** The active (not resolved) alert for a patient + category, locked for update. */
  async findActiveForUpdate(client, patientId, category) {
    const { rows } = await client.query(
      `SELECT * FROM alerts WHERE patient_id = $1 AND category = $2 AND status <> 'RESOLVED' FOR UPDATE`,
      [patientId, category]);
    return rows[0] || null;
  },

  async findByIdForUpdate(client, id) {
    const { rows } = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [id]);
    return rows[0] || null;
  },

  async lastResolved(client, patientId, category) {
    const { rows } = await client.query(
      `SELECT * FROM alerts WHERE patient_id = $1 AND category = $2 AND status = 'RESOLVED'
       ORDER BY resolved_at DESC LIMIT 1`, [patientId, category]);
    return rows[0] || null;
  },

  async insert(client, a) {
    const { rows } = await client.query(
      `INSERT INTO alerts (patient_id, category, trigger_type, risk_level, title, description, reasons)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [a.patientId, a.category, a.triggerType, a.riskLevel, a.title, a.description, JSON.stringify(a.reasons || [])]);
    return rows[0];
  },

  /** Update selected columns. Column names come from code (never user input); values are parameterised. */
  async update(client, id, fields) {
    const allowed = ['status', 'risk_level', 'title', 'description', 'reasons', 'trigger_type', 'acknowledged_at',
      'acknowledged_by', 'resolved_at', 'resolved_by', 'escalated_at', 'escalation_level', 'escalation_reason'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const values = keys.map((k) => (k === 'reasons' ? JSON.stringify(fields[k]) : fields[k]));
    const { rows } = await client.query(
      `UPDATE alerts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...values]);
    return rows[0];
  },

  async insertAction(client, { alertId, action, actorUserId = null, actorLabel, note = null }) {
    await client.query(
      'INSERT INTO alert_actions (alert_id, action, actor_user_id, actor_label, note) VALUES ($1,$2,$3,$4,$5)',
      [alertId, action, actorUserId, actorLabel, note]);
  },

  async findById(id) {
    const { rows } = await db.query(`${WITH_PATIENT} WHERE a.id = $1`, [id]);
    if (!rows[0]) return null;
    const actions = await db.query('SELECT * FROM alert_actions WHERE alert_id = $1 ORDER BY created_at', [id]);
    return { ...rows[0], actions: actions.rows };
  },

  async list({ status = 'active', patientId, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (status === 'active') where.push(`a.status <> 'RESOLVED'`);
    else if (status !== 'all') {
      params.push(status);
      where.push(`a.status = $${params.length}`);
    }
    if (patientId) {
      params.push(patientId);
      where.push(`a.patient_id = $${params.length}`);
    }
    params.push(limit);
    const { rows } = await db.query(
      `${WITH_PATIENT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE a.status WHEN 'RESOLVED' THEN 1 ELSE 0 END,
                CASE a.risk_level WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, a.created_at DESC
       LIMIT $${params.length}`, params);
    if (!rows.length) return rows;
    const actions = await db.query(
      'SELECT * FROM alert_actions WHERE alert_id = ANY($1) ORDER BY created_at', [rows.map((r) => r.id)]);
    return rows.map((r) => ({ ...r, actions: actions.rows.filter((x) => x.alert_id === r.id) }));
  },

  /** HIGH alerts nobody acknowledged within `seconds`. */
  async listUnacknowledgedHigh(seconds) {
    const { rows } = await db.query(
      `SELECT * FROM alerts WHERE status = 'OPEN' AND risk_level = 'HIGH'
       AND updated_at < now() - make_interval(secs => $1)`, [seconds]);
    return rows;
  },
};
