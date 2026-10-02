// Vital ingestion: validate -> idempotent insert -> device status -> queue risk analysis -> real-time events.
import { SOCKET_EVENTS } from '@homecare/shared';
import { withTransaction } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { enqueue } from '../lib/queue.js';
import { emit } from '../lib/socket.js';
import { formatZod } from '../middleware/validate.js';
import { deviceRepository } from '../repositories/deviceRepository.js';
import { vitalRepository } from '../repositories/vitalRepository.js';
import { vitalReadingSchema } from '../validators/schemas.js';
import { alertService } from './alertService.js';
import { audit } from './auditService.js';

async function ingestOne(raw, deviceCache) {
  const parsed = vitalReadingSchema.safeParse(raw);
  if (!parsed.success) return { status: 'rejected', errors: formatZod(parsed.error), sequence_number: raw?.sequence_number };
  const r = parsed.data;

  let device = deviceCache.get(r.device_id);
  if (device === undefined) {
    device = await deviceRepository.findByUid(r.device_id);
    deviceCache.set(r.device_id, device);
  }
  if (!device) return { status: 'rejected', errors: [{ field: 'device_id', message: 'Unknown device' }], sequence_number: r.sequence_number };
  if (device.patient_id !== r.patient_id) {
    return { status: 'rejected', errors: [{ field: 'patient_id', message: 'Device is not assigned to this patient' }], sequence_number: r.sequence_number };
  }

  return withTransaction(async (client) => {
    const reading = await vitalRepository.insert(client, { ...r, device_db_id: device.id });
    if (!reading) return { status: 'duplicate', sequence_number: r.sequence_number, device };
    const previousStatus = await deviceRepository.markSeen(client, device.id, r.sequence_number);
    let reconnected = false;
    if (previousStatus === 'OFFLINE') {
      reconnected = true;
      await deviceRepository.insertEvent(client, { deviceId: device.id, patientId: device.patient_id, type: 'ONLINE' });
    }
    return { status: 'created', reading, device, reconnected };
  });
}

/**
 * Accepts a single reading or `{ readings: [...] }` (the simulator's buffered upload).
 * Idempotent: re-sending the same (device_id, sequence_number) never creates a duplicate row.
 */
export async function ingest(body, ctx) {
  const started = Date.now();
  const batch = Array.isArray(body?.readings);
  const items = batch ? body.readings : [body];
  if (!items.length) throw badRequest('No readings provided');

  const deviceCache = new Map();
  const results = [];
  for (const item of items) results.push(await ingestOne(item, deviceCache));

  const created = results.filter((r) => r.status === 'created');
  const summary = {
    received: items.length,
    created: created.length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
  };

  // Per device: reconnection, buffered sync, real-time events.
  const byDevice = new Map();
  for (const r of created) {
    const entry = byDevice.get(r.device.id) || { device: r.device, readings: [], reconnected: false };
    entry.readings.push(r.reading);
    entry.reconnected ||= r.reconnected;
    byDevice.set(r.device.id, entry);
  }

  for (const { device, readings, reconnected } of byDevice.values()) {
    const buffered = readings.filter((r) => r.source === 'BUFFERED');
    if (reconnected) {
      await withTransaction((client) =>
        alertService.autoResolveDevice(client, device.patient_id, 'Device back online - buffered readings synchronised'))
        .then((alert) => alert && emit(SOCKET_EVENTS.ALERT_UPDATED, alert));
      emit(SOCKET_EVENTS.DEVICE_STATUS, { patientId: device.patient_id, deviceUid: device.device_uid, status: 'ONLINE' });
      logger.info({ event_type: 'SENSOR_ONLINE', patient_id: device.patient_id, device: device.device_uid });
    }
    if (buffered.length) {
      const details = { count: buffered.length, from: buffered[0].timestamp, to: buffered.at(-1).timestamp };
      await withTransaction((client) => deviceRepository.insertEvent(client, {
        deviceId: device.id, patientId: device.patient_id, type: 'BUFFER_SYNC', details,
      }));
      await audit(ctx, 'BUFFERED_READINGS_SYNCED', 'sensor_device', device.device_uid, { patientId: device.patient_id, ...details });
      logger.info({ event_type: 'BUFFERED_READING_SYNCED', request_id: ctx.requestId, patient_id: device.patient_id, ...details });
      emit(SOCKET_EVENTS.DEVICE_SYNCED, { patientId: device.patient_id, deviceUid: device.device_uid, ...details });
    }
    const live = readings.filter((r) => r.source !== 'BUFFERED');
    for (const reading of live.slice(-5)) emit(SOCKET_EVENTS.VITAL_NEW, reading);
    logger.info({
      event_type: 'VITAL_RECEIVED', request_id: ctx.requestId, patient_id: device.patient_id,
      count: readings.length, processing_time_ms: Date.now() - started,
    });
    // Risk is analysed once per patient per request, on the newest data.
    await enqueue('risk:assess', { patientId: device.patient_id, requestId: ctx.requestId }, { key: device.patient_id });
  }

  await audit(ctx, 'VITALS_INGESTED', 'vital_readings', null, { ...summary, batch });

  if (!batch) {
    const only = results[0];
    if (only.status === 'rejected') throw badRequest('Invalid vital reading', only.errors);
    return { status: only.status, reading: only.reading || null };
  }
  return { ...summary, results: results.map(({ status, sequence_number, errors }) => ({ status, sequence_number, errors })) };
}

export const vitalService = {
  ingest,
  listForPatient: (patientId, opts) => vitalRepository.listForPatient(patientId, opts),
};
