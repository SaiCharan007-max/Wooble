import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { enqueue, queueMode, startQueue, stopQueue } from './lib/queue.js';
import { closeRedis } from './lib/redis.js';
import { closeSocket, initSocket } from './lib/socket.js';
import { notificationService } from './services/notificationService.js';

const app = createApp();
const server = http.createServer(app);
initSocket(server);
await startQueue();
notificationService.start();

// Watchdog tick: a BullMQ job when Redis is up (one job per interval via jobId), inline otherwise.
const watchdog = setInterval(() => {
  const bucket = Math.floor(Date.now() / env.watchdogIntervalMs);
  enqueue('watchdog', {}, { key: 'watchdog', jobId: `watchdog-${bucket}` })
    .catch((err) => logger.error({ err: err.message }, 'watchdog failed'));
}, env.watchdogIntervalMs);

// Free hosting puts idle services to sleep: wake the simulator and risk engine as soon as we start.
for (const url of [`${env.simulatorUrl}/health`, `${env.riskEngineUrl}/health`]) {
  fetch(url, { signal: AbortSignal.timeout(90000) }).catch(() => {});
}

server.listen(env.port, () => {
  logger.info({ port: env.port, jobs: queueMode() }, `backend listening on http://localhost:${env.port}`);
});

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  clearInterval(watchdog);
  notificationService.stop();
  await notificationService.flush();
  server.close();
  await closeSocket();
  await stopQueue();
  await closeRedis();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
