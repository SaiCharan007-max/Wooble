import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
// Local .env (apps/backend/.env) wins over the monorepo root .env; real env vars win over both.
dotenv.config({ path: [path.resolve(ROOT_DIR, 'apps/backend/.env'), path.resolve(ROOT_DIR, '.env')] });

const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));
const list = (value, fallback) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback);

const nodeEnv = process.env.NODE_ENV || 'development';
const isTest = nodeEnv === 'test';

export const env = Object.freeze({
  nodeEnv,
  isTest,
  port: num(process.env.PORT, 4000),
  databaseUrl: (isTest && process.env.DATABASE_URL_TEST) || process.env.DATABASE_URL ||
    'postgres://homecare:homecare@localhost:5433/homecare',
  redisUrl: isTest ? process.env.REDIS_URL_TEST || '' : process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  deviceApiKey: process.env.DEVICE_API_KEY || 'dev-device-key',
  corsOrigins: list(process.env.CORS_ORIGIN, ['http://localhost:5173', 'http://localhost:8080']),
  riskEngineUrl: process.env.RISK_ENGINE_URL || 'http://localhost:8000',
  riskEngineTimeoutMs: num(process.env.RISK_ENGINE_TIMEOUT_MS, 3000),
  simulatorUrl: process.env.SIMULATOR_URL || 'http://localhost:4100',
  simulatorControlToken: process.env.SIMULATOR_CONTROL_TOKEN || 'dev-simulator-token',
  sensorOfflineSeconds: num(process.env.SENSOR_OFFLINE_SECONDS, 15),
  ackTimeoutSeconds: num(process.env.ACK_TIMEOUT_SECONDS, 60),
  alertCooldownSeconds: num(process.env.ALERT_COOLDOWN_SECONDS, 60),
  rapidIncreaseThreshold: num(process.env.RAPID_INCREASE_THRESHOLD, 20),
  noteWindowMinutes: num(process.env.NOTE_WINDOW_MINUTES, 120),
  watchdogIntervalMs: num(process.env.WATCHDOG_INTERVAL_MS, 5000),
  // Telegram caregiver notifications (optional). See README "Phone alerts".
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramEscalationChatId: process.env.TELEGRAM_ESCALATION_CHAT_ID || '',
  telegramUserEmail: process.env.TELEGRAM_USER_EMAIL || 'anita@homecare.demo',
  telegramApiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
  dashboardUrl: process.env.DASHBOARD_URL || 'http://localhost:5173',
  logLevel: isTest ? process.env.LOG_LEVEL_TEST || 'silent' : process.env.LOG_LEVEL || 'info',
});

if (nodeEnv === 'production' && env.jwtSecret.startsWith('dev-only')) {
  throw new Error('JWT_SECRET must be set in production');
}
