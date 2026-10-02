import { db } from '../db/pool.js';

// High-volume, routine events hidden from the audit view unless explicitly requested.
export const ROUTINE_ACTIONS = ['VITALS_INGESTED', 'RISK_CALCULATED'];

export const auditRepository = {
  async insert(entry, client = db) {
    await client.query(
      `INSERT INTO audit_logs (actor, actor_user_id, action, entity_type, entity_id, metadata, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [entry.actor, entry.actorUserId || null, entry.action, entry.entityType, entry.entityId ?? null,
        JSON.stringify(entry.metadata || {}), entry.requestId || null]);
  },

  async list({ limit = 100, includeRoutine = false, patientId } = {}) {
    const where = [];
    const params = [];
    if (!includeRoutine) {
      params.push(ROUTINE_ACTIONS);
      where.push(`action <> ALL($${params.length})`);
    }
    if (patientId) {
      params.push(patientId);
      where.push(`(metadata->>'patientId' = $${params.length} OR entity_id = $${params.length})`);
    }
    params.push(limit);
    const { rows } = await db.query(
      `SELECT * FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY "timestamp" DESC, id DESC LIMIT $${params.length}`, params);
    return rows;
  },
};
