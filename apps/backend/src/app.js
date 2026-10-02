import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { DISCLAIMER } from '@homecare/shared';
import { env, ROOT_DIR } from './config/env.js';
import { db } from './db/pool.js';
import { queueMode } from './lib/queue.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import routes from './routes/index.js';
import { riskEngineClient } from './services/riskEngineClient.js';
import './workers/jobs.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(requestContext);

  app.get('/api/health', async (_req, res) => {
    const [dbOk, engineOk] = await Promise.all([
      db.query('SELECT 1').then(() => true).catch(() => false),
      riskEngineClient.health().catch(() => false),
    ]);
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'up' : 'down',
      jobs: queueMode(),
      riskEngine: engineOk ? 'up' : 'down (safety-threshold fallback active)',
      disclaimer: DISCLAIMER,
    });
  });

  app.use('/api', routes);

  // In production the built dashboard is served from here too: one URL, same origin, no CORS setup.
  const dist = path.join(ROOT_DIR, 'apps/frontend/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
