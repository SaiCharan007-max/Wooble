// Medical equipment monitoring (home oxygen concentrator) and home-hub event sync.
import { SOCKET_EVENTS } from '@homecare/shared';
import { withTransaction } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { enqueue } from '../lib/queue.js';
import { emit } from '../lib/socket.js';
import { formatZod } from '../middleware/validate.js';
import { deviceRepository } from '../repositories/deviceRepository.js';
import { equipmentRepository, hubEventRepository } from '../repositories/equipmentRepository.js';
import { equipmentReadingSchema, hubEventSchema } from '../validators/schemas.js';
import { alertService, publish } from './alertService.js';
import { audit } from './auditService.js';

/** Flow below half the prescription (or no power at all) means the patient is not getting oxygen. */
export function equipmentStatus(equipment, reading) {
  if (reading.power_source === 'NONE' || reading.flow_lpm < equipment.prescribed_flow_lpm * 0.5) return 'FAULT';
  if (reading.power_source === 'BATTERY') return 'ON_BATTERY';
  return 'OK';
}

async function validateAll(items, schema, resolve) {
  const results = [];
  const cache = new Map();
  for (const raw of items) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      results.push({ status: 'rejected', errors: formatZod(parsed.error) });
      continue;
    }
    const r = parsed.data;
    const key = r.equipment_id || r.device_id;
    if (!cache.has(key)) cache.set(key, await resolve(key));
    const owner = cache.get(key);
    if (!owner || owner.patient_id !== r.patient_id) {
      results.push({ status: 'rejected', errors: [{ field: 'patient_id', message: 'Unknown device or wrong patient' }] });
      continue;
    }
    results.push({ status: 'valid', data: r, owner });
  }
  return results;
}

const summarise = (results) => ({
  received: results.length,
  created: results.filter((r) => r.status === 'created').length,
  duplicates: results.filter((r) => r.status === 'duplicate').length,
  rejected: results.filter((r) => r.status === 'rejected').length,
});

export const equipmentService = {
  async ingest(body, ctx) {
    const items = Array.isArray(body?.readings) ? body.readings : [body];
    if (!items.length) throw badRequest('No readings provided');
    const results = await validateAll(items, equipmentReadingSchema, (uid) => equipmentRepository.findByUid(uid));

    const latest = new Map(); // equipment id -> { equipment, reading }
    for (const r of results) {
      if (r.status !== 'valid') continue;
      const row = await withTransaction((client) =>
        equipmentRepository.insertReading(client, { ...r.data, equipment_db_id: r.owner.id }));
      r.status = row ? 'created' : 'duplicate';
      if (row) {
        const prev = latest.get(r.owner.id);
        if (!prev || new Date(row.timestamp) >= new Date(prev.reading.timestamp)) latest.set(r.owner.id, { equipment: r.owner, reading: row });
      }
    }

    for (const { equipment, reading } of latest.values()) {
      const status = equipmentStatus(equipment, reading);
      let alertEvent = null;
      const previous = await withTransaction(async (client) => {
        const before = await equipmentRepository.updateStatus(client, equipment.id, status, reading.sequence_number);
        if (before === status) return before;
        await audit(ctx, `EQUIPMENT_${status}`, 'medical_equipment', equipment.equipment_uid,
          { patientId: equipment.patient_id, flow: reading.flow_lpm, power: reading.power_source }, client);
        if (status === 'FAULT') {
          const alert = await alertService.raiseEquipmentFault(client, equipment, reading);
          if (alert) alertEvent = [SOCKET_EVENTS.ALERT_NEW, alert, 'created'];
        } else if (before === 'FAULT') {
          const resolved = await alertService.autoResolve(client, equipment.patient_id, 'EQUIPMENT',
            `Oxygen flow restored (${reading.flow_lpm} L/min)`);
          if (resolved) alertEvent = [SOCKET_EVENTS.ALERT_UPDATED, resolved, 'resolved'];
        }
        return before;
      });
      if (alertEvent) publish([alertEvent]);
      emit(SOCKET_EVENTS.EQUIPMENT_STATUS, {
        patientId: equipment.patient_id, equipmentUid: equipment.equipment_uid, status,
        flow: reading.flow_lpm, power: reading.power_source, timestamp: reading.timestamp,
      });
      if (previous !== status) {
        logger.warn({ event_type: `EQUIPMENT_${status}`, patient_id: equipment.patient_id, equipment: equipment.equipment_uid });
        // losing oxygen supply is part of the patient's clinical context: re-assess risk
        await enqueue('risk:assess', { patientId: equipment.patient_id, requestId: ctx.requestId }, { key: equipment.patient_id });
      }
    }
    return { ...summarise(results), results: results.map(({ status, errors }) => ({ status, errors })) };
  },

  /** Local alarms raised by the home hub (possibly while offline), synced later. Idempotent on event_uid. */
  async ingestHubEvents(body, ctx) {
    const items = Array.isArray(body?.readings) ? body.readings : [body];
    const results = await validateAll(items, hubEventSchema, (uid) => deviceRepository.findByUid(uid));
    for (const r of results) {
      if (r.status !== 'valid') continue;
      const e = r.data;
      const stored = await withTransaction(async (client) => {
        const ok = await hubEventRepository.insert(client, {
          deviceId: r.owner.id, patientId: e.patient_id, type: e.type, eventUid: e.event_uid,
          details: { ...e.details, timestamp: e.timestamp },
        });
        if (ok) {
          await audit(ctx, `HUB_${e.type}`, 'sensor_device', e.device_id,
            { patientId: e.patient_id, at: e.timestamp, ...e.details }, client);
        }
        return ok;
      });
      r.status = stored ? 'created' : 'duplicate';
      if (stored) {
        logger.info({ event_type: `HUB_${e.type}`, patient_id: e.patient_id, request_id: ctx.requestId });
        emit('hub:event', { patientId: e.patient_id, type: e.type, timestamp: e.timestamp, details: e.details });
      }
    }
    return { ...summarise(results), results: results.map(({ status, errors }) => ({ status, errors })) };
  },
};
