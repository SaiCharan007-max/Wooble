import pino from 'pino';
import { env } from '../config/env.js';

// Structured JSON logs. Important events carry an `event_type` field, e.g.
// VITAL_RECEIVED, RISK_CALCULATED, ALERT_CREATED, ALERT_ACKNOWLEDGED, SENSOR_OFFLINE, BUFFERED_READING_SYNCED.
export const logger = pino({
  level: env.logLevel,
  base: { service: 'backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
});
