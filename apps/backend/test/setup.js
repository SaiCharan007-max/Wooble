// Must be imported FIRST by every test file: configures the environment before app modules load.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.RISK_ENGINE_URL = 'http://127.0.0.1:8711';
process.env.SENSOR_OFFLINE_SECONDS = '2';
process.env.ACK_TIMEOUT_SECONDS = '1';
process.env.ALERT_COOLDOWN_SECONDS = '60';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const PATIENT_1 = '11111111-1111-4111-8111-111111111111'; // stable, caregiver Anita (checked in)
export const PATIENT_3 = '33333333-3333-4333-8333-333333333333'; // caregiver Rahul (checked out)

/** Starts the real Python risk engine on a test port. */
export async function startRiskEngine() {
  const proc = spawn(process.env.PYTHON || 'python', ['-m', 'uvicorn', 'app.main:app', '--port', '8711', '--log-level', 'warning'],
    { cwd: path.join(ROOT, 'apps/risk-engine'), stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:8711/health');
      if (res.ok) return () => proc.kill();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error('risk engine did not start (is Python + requirements installed?)');
}

const NORMAL = { heart_rate: 78, spo2: 97, respiratory_rate: 16, temperature: 36.8, systolic_bp: 122, diastolic_bp: 78 };
const BAD = { heart_rate: 118, spo2: 88, respiratory_rate: 29, temperature: 38.7, systolic_bp: 98, diastolic_bp: 62 };

/** A reading `secondsAgo` in the past, linearly between NORMAL and BAD by `progress` (0..1). */
export function reading(seq, { device = 'WEAR-001', patient = PATIENT_1, progress = 0, secondsAgo = 0, source } = {}) {
  const v = {};
  for (const k of Object.keys(NORMAL)) {
    const x = NORMAL[k] + (BAD[k] - NORMAL[k]) * progress;
    v[k] = k === 'temperature' ? Math.round(x * 10) / 10 : Math.round(x);
  }
  return {
    device_id: device, patient_id: patient, timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    ...v, sequence_number: seq, ...(source ? { source } : {}),
  };
}
