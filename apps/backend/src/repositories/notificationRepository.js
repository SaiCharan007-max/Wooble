import { db } from '../db/pool.js';

export const notificationRepository = {
  async insert({ alertId, channel, recipient, kind, status, error = null, externalId = null }) {
    await db.query(
      `INSERT INTO notifications (alert_id, channel, recipient, kind, status, error, external_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [alertId, channel, recipient, kind, status, error, externalId]);
  },

  /** The most recent message we sent for this alert on this channel/recipient (to update it in place). */
  async lastSent(alertId, channel, recipient) {
    const { rows } = await db.query(
      `SELECT * FROM notifications WHERE alert_id = $1 AND channel = $2 AND recipient = $3 AND status = 'SENT'
       AND external_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [alertId, channel, recipient]);
    return rows[0] || null;
  },

  async listForAlert(alertId) {
    const { rows } = await db.query('SELECT * FROM notifications WHERE alert_id = $1 ORDER BY id', [alertId]);
    return rows;
  },
};
