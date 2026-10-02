import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const connections = [];
let lastWarn = 0;

/** Creates a Redis connection, or returns null when Redis is not configured (inline fallback mode). */
export function createRedis(name, { failFast = false } = {}) {
  if (!env.redisUrl) return null;
  const conn = new IORedis(env.redisUrl, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableOfflineQueue: !failFast, // queue producer fails fast so we can fall back to inline processing
    retryStrategy: (times) => Math.min(times * 500, 5000),
    connectionName: name,
  });
  conn.on('error', (err) => {
    if (Date.now() - lastWarn > 10000) {
      lastWarn = Date.now();
      logger.warn({ event_type: 'REDIS_UNAVAILABLE', err: err.message }, 'redis unavailable - degrading to inline processing');
    }
  });
  connections.push(conn);
  return conn;
}

export const isReady = (conn) => Boolean(conn && conn.status === 'ready');

export async function closeRedis() {
  await Promise.allSettled(connections.map((c) => c.quit()));
}
