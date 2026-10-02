// Applies SQL migrations from /database/migrations and (on an empty database) seeds from /database/seeds.
//   node src/db/migrate.js            migrate + seed if empty
//   node src/db/migrate.js --reset    drop everything, migrate, seed
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { pool } from './pool.js';

const MIGRATIONS_DIR = path.join(ROOT_DIR, 'database', 'migrations');
const SEEDS_DIR = path.join(ROOT_DIR, 'database', 'seeds');

async function sqlFiles(dir) {
  return (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}

export async function runMigrations({ reset = false, seed = 'auto' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)'); // safe if several instances start together
    if (reset) {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      logger.info('database reset');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));

    for (const file of await sqlFiles(MIGRATIONS_DIR)) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ migration: file }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    const { rows } = await client.query('SELECT count(*)::int AS n FROM users');
    if (seed === true || (seed === 'auto' && rows[0].n === 0)) {
      for (const file of await sqlFiles(SEEDS_DIR)) {
        const sql = await fs.readFile(path.join(SEEDS_DIR, file), 'utf8');
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        logger.info({ seed: file }, 'seed applied');
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrations({ reset: process.argv.includes('--reset') })
    .then(() => {
      console.log('Database ready.');
      return pool.end();
    })
    .catch((err) => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}
