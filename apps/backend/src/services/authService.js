import bcrypt from 'bcryptjs';
import { unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { signToken } from '../lib/tokens.js';
import { userRepository } from '../repositories/userRepository.js';
import { audit } from './auditService.js';

// Compared against when the e-mail is unknown, so response time does not reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const authService = {
  async login(email, password, ctx) {
    const user = await userRepository.findByEmail(email);
    const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
    if (!user || !ok || !user.is_active) {
      await audit({ ...ctx, actor: email }, 'LOGIN_FAILED', 'user', user?.id || null, {});
      logger.warn({ event_type: 'LOGIN_FAILED', request_id: ctx.requestId });
      throw unauthorized('Invalid email or password');
    }
    await audit({ ...ctx, actor: `${user.full_name} (${user.role})`, actorUserId: user.id }, 'LOGIN', 'user', user.id, {});
    return {
      token: signToken(user),
      user: { id: user.id, email: user.email, name: user.full_name, role: user.role, caregiverId: user.caregiver_id },
    };
  },
};
