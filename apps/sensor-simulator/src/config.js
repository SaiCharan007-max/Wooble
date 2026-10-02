import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: [path.resolve(ROOT, 'apps/sensor-simulator/.env'), path.resolve(ROOT, '.env')] });

export const config = Object.freeze({
  port: Number(process.env.SIMULATOR_PORT || process.env.PORT || 4100), // PORT is set by hosts like Render
  backendUrl: process.env.BACKEND_URL || 'http://localhost:4000',
  deviceApiKey: process.env.DEVICE_API_KEY || 'dev-device-key',
  controlToken: process.env.SIMULATOR_CONTROL_TOKEN || 'dev-simulator-token',
  tickMs: Number(process.env.SIMULATOR_TICK_MS || 2000),
  dataDir: process.env.SIMULATOR_DATA_DIR || path.resolve(ROOT, 'apps/sensor-simulator/data'),
  batchSize: Number(process.env.SIMULATOR_BATCH_SIZE || 100),
  retryBaseMs: Number(process.env.SIMULATOR_RETRY_BASE_MS || 1000),
  retryMaxMs: Number(process.env.SIMULATOR_RETRY_MAX_MS || 30000),
});
