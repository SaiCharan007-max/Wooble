import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const PG_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '57P01', '57P03', '08001', '08006']);

function translate(err) {
  if (err instanceof AppError) return err;
  if (err.type === 'entity.parse.failed') return new AppError(400, 'MALFORMED_JSON', 'Request body is not valid JSON');
  if (err.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  if (PG_CONNECTION_CODES.has(err.code) || /Connection terminated|connect ECONNREFUSED/.test(err.message || '')) {
    return new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is temporarily unavailable. Please retry.');
  }
  switch (err.code) {
    case '23505': return new AppError(409, 'DUPLICATE', 'Record already exists');
    case '23503': return new AppError(404, 'REFERENCE_NOT_FOUND', 'Referenced record does not exist');
    case '23514':
    case '22P02':
    case '22003': return new AppError(400, 'VALIDATION_ERROR', 'Value is invalid or out of range');
    default: return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
  }
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const appErr = translate(err);
  const log = appErr.status >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
  log({ request_id: req.id, code: appErr.code, err: err.message, path: req.originalUrl }, 'request failed');
  res.status(appErr.status).json({
    error: { code: appErr.code, message: appErr.message, details: appErr.details, requestId: req.id },
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.path}`, requestId: req.id } });
}
