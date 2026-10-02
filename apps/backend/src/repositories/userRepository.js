import { db } from '../db/pool.js';

const SELECT = `SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.is_active, c.id AS caregiver_id
                FROM users u LEFT JOIN caregivers c ON c.user_id = u.id`;

export const userRepository = {
  async findByEmail(email) {
    const { rows } = await db.query(`${SELECT} WHERE u.email = $1`, [email]);
    return rows[0] || null;
  },
  async findById(id) {
    const { rows } = await db.query(`${SELECT} WHERE u.id = $1`, [id]);
    return rows[0] || null;
  },
};
