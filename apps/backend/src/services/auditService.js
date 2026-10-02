import { auditRepository } from '../repositories/auditRepository.js';
import { logger } from '../lib/logger.js';

export const SYSTEM_CTX = Object.freeze({ actor: 'system', actorUserId: null, requestId: null });

/**
 * Record an audit entry. Pass `client` to make the entry part of the caller's transaction
 * (so the audit trail can never disagree with the data). Without a client, failures are
 * logged but never break the user's action.
 */
export async function audit(ctx, action, entityType, entityId, metadata = {}, client) {
  const entry = { ...ctx, action, entityType, entityId, metadata };
  if (client) return auditRepository.insert(entry, client);
  try {
    await auditRepository.insert(entry);
  } catch (err) {
    logger.error({ action, err: err.message }, 'audit write failed');
  }
}

export const listAudit = (opts) => auditRepository.list(opts);
