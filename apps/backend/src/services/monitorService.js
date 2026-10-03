// Watchdog (runs every WATCHDOG_INTERVAL_MS): detects silent sensors and escalates unacknowledged HIGH alerts.
import { SOCKET_EVENTS } from '@homecare/shared';
import { env } from '../config/env.js';
import { withTransaction } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { emit } from '../lib/socket.js';
import { deviceRepository } from '../repositories/deviceRepository.js';
import { alertService, publish } from './alertService.js';
import { audit, SYSTEM_CTX } from './auditService.js';

/** Missing data is treated as a DEVICE problem - it never changes the patient's risk score. */
const startedAt = Date.now();

export async function detectOfflineSensors() {
  if (Date.now() - startedAt < env.offlineGraceSeconds * 1000) return 0; // just woke up: sensors are reconnecting
  const stale = await deviceRepository.listStale(env.sensorOfflineSeconds);
  for (const device of stale) {
    const alert = await withTransaction(async (client) => {
      await deviceRepository.setStatus(client, device.id, 'OFFLINE');
      await deviceRepository.insertEvent(client, {
        deviceId: device.id, patientId: device.patient_id, type: 'OFFLINE',
        details: { lastSeenAt: device.last_seen_at },
      });
      await audit(SYSTEM_CTX, 'SENSOR_OFFLINE', 'sensor_device', device.device_uid,
        { patientId: device.patient_id, lastSeenAt: device.last_seen_at }, client);
      return alertService.raiseSensorOffline(client, device);
    });
    logger.warn({ event_type: 'SENSOR_OFFLINE', patient_id: device.patient_id, device: device.device_uid },
      'Sensor connectivity issue detected');
    emit(SOCKET_EVENTS.DEVICE_STATUS, { patientId: device.patient_id, deviceUid: device.device_uid, status: 'OFFLINE' });
    if (alert) publish([[SOCKET_EVENTS.ALERT_NEW, alert, 'created']]);
  }
  return stale.length;
}

export async function runWatchdog() {
  const offline = await detectOfflineSensors();
  const escalated = await alertService.escalateOverdue();
  return { offline, escalated };
}
