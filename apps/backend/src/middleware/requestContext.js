import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

/** Attaches a request id (incoming X-Request-Id or a new UUID) and logs each request when it finishes. */
export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info({
      event_type: 'HTTP_REQUEST',
      request_id: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      processing_time_ms: Math.round(ms * 10) / 10,
      user_id: req.user?.sub,
    });
  });
  next();
}

/** Who is doing this - passed from controllers to services for audit logging. */
export function ctx(req) {
  return {
    requestId: req.id,
    actor: req.user ? `${req.user.name} (${req.user.role})` : req.device ? `device:${req.device}` : 'anonymous',
    actorUserId: req.user?.sub || null,
    user: req.user || null,
  };
}
