import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyToken } from '../lib/tokens.js';

export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user?.role) ? next() : next(forbidden());

/** Sensor devices authenticate with a shared API key (X-Device-Key), not a user login. */
export function requireDevice(req, _res, next) {
  const given = Buffer.from(req.get('x-device-key') || '');
  const expected = Buffer.from(env.deviceApiKey);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return next(unauthorized('Invalid device key'));
  }
  req.device = 'sensor-gateway';
  next();
}
