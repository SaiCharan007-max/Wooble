import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthorized } from './errors.js';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.full_name, caregiverId: user.caregiver_id || null },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

export function verifyToken(token) {
  if (!token) throw unauthorized();
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}
