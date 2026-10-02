// Background job processing with BullMQ (Redis). If Redis is missing or down, jobs run inline in this
// process instead - slower, but nothing is lost and the demo keeps working (graceful degradation).
import { Queue, Worker } from 'bullmq';
import { logger } from './logger.js';
import { createRedis, isReady } from './redis.js';

const QUEUE_NAME = 'homecare-jobs';
const handlers = new Map();
const inlineChains = new Map(); // per-key promise chains keep jobs for one patient in order
let queue = null;
let queueConn = null;
let worker = null;

export function registerJobHandler(name, handler) {
  handlers.set(name, handler);
}

export async function startQueue() {
  queueConn = createRedis('queue-producer', { failFast: true });
  if (!queueConn) {
    logger.warn('REDIS_URL not set - background jobs run inline');
    return;
  }
  queue = new Queue(QUEUE_NAME, {
    connection: queueConn,
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 500 }, removeOnComplete: 500, removeOnFail: 500 },
  });
  queue.on('error', () => {});
  // concurrency 1 keeps risk calculations for a patient in arrival order
  worker = new Worker(QUEUE_NAME, (job) => runHandler(job.name, job.data), {
    connection: createRedis('queue-worker'),
    concurrency: 1,
  });
  worker.on('failed', (job, err) => logger.error({ job: job?.name, err: err.message }, 'job failed'));
  worker.on('error', () => {});
}

async function runHandler(name, data) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler for job ${name}`);
  return handler(data);
}

function runInline(name, data, key) {
  const chainKey = key || name;
  const previous = inlineChains.get(chainKey) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => runHandler(name, data))
    .catch((err) => logger.error({ job: name, err: err.message }, 'inline job failed'));
  inlineChains.set(chainKey, next);
  next.finally(() => {
    if (inlineChains.get(chainKey) === next) inlineChains.delete(chainKey);
  });
  return next;
}

/** Enqueue a job. Returns 'queued' or 'inline'. Inline jobs are awaited, so callers see their effects. */
export async function enqueue(name, data, { key, jobId } = {}) {
  if (queue && isReady(queueConn)) {
    try {
      await queue.add(name, data, jobId ? { jobId } : undefined);
      return 'queued';
    } catch (err) {
      logger.warn({ job: name, err: err.message }, 'enqueue failed - running inline');
    }
  }
  await runInline(name, data, key);
  return 'inline';
}

export const queueMode = () => (queue && isReady(queueConn) ? 'bullmq' : 'inline');

export async function stopQueue() {
  await Promise.allSettled([worker?.close(), queue?.close()]);
}
