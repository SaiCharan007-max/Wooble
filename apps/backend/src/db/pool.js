import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

// numeric -> JS number, bigint -> JS number (ids stay well below 2^53 in this prototype)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (err) => logger.error({ err: err.message }, 'postgres pool error'));

/** Every query is parameterised - never build SQL with string concatenation of user input. */
export const db = {
  query: (text, params) => pool.query(text, params),
};

/** Run `fn(client)` inside a transaction; commits on success, rolls back on any error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
