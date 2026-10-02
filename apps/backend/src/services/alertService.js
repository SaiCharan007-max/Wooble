// Alert lifecycle: create (with de-duplication + cooldown) -> acknowledge -> respond -> resolve / escalate.
import { SOCKET_EVENTS } from '@homecare/shared';
import { env } from '../config/env.js';
import { withTransaction } from '../db/pool.js';
import { conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { emit } from '../lib/socket.js';
import { alertRepository } from '../repositories/alertRepository.js';
import { caregiverRepository } from '../repositories/caregiverRepository.js';
import { audit, SYSTEM_CTX } from './auditService.js';

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function triggerFor(assessment, previous) {
  const factors = assessment.contributing_factors || [];
  const critical = factors.find((f) => f.category === 'SAFETY_FLOOR' && /^Critical value/.test(f.detail));
  const velocity = assessment.prediction?.velocity ?? 0;
  const rapid = previous && velocity >= env.rapidIncreaseThreshold;
  const level = assessment.risk_level;
  const rapidText = rapid ? `rapid increase (+${velocity} in ${assessment.prediction.velocityWindow})` : null;
  if (critical) return { type: 'CRITICAL_VITAL', title: `${level} risk - critical ${critical.detail.replace(/^Critical value: /, '')}` };
  if (level !== 'LOW') return { type: rapid ? 'RAPID_INCREASE' : 'RISK_THRESHOLD', title: `${level} risk - ${rapidText || 'requires caregiver attention'}` };
  if (rapid) return { type: 'RAPID_INCREASE', title: `Early warning - ${rapidText}` };
  return null;
}

/**
 * Called inside the risk transaction after each assessment. Returns socket events to publish after commit.
 * Rules: one active clinical alert per patient (dedupe), upgrade when risk rises, cooldown after resolution,
 * immediate escalation for HIGH risk when the assigned caregiver is not checked in.
 */
export async function evaluateRiskAlert(client, patient, assessment, previous) {
  const trigger = triggerFor(assessment, previous);
  if (!trigger) return [];
  const level = assessment.risk_level;
  const events = [];
  const active = await alertRepository.findActiveForUpdate(client, patient.id, 'CLINICAL');

  if (active) {
    if (RANK[level] <= RANK[active.risk_level]) return []; // de-duplicated: already alerting at this level
    const upgraded = await alertRepository.update(client, active.id, {
      risk_level: level, title: trigger.title, trigger_type: trigger.type, description: assessment.explanation,
      reasons: assessment.reasons, status: active.status === 'ESCALATED' ? 'ESCALATED' : 'OPEN',
    });
    await alertRepository.insertAction(client, {
      alertId: active.id, action: 'UPDATED', actorLabel: 'system',
      note: `Risk increased from ${active.risk_level} to ${level}`,
    });
    await audit(SYSTEM_CTX, 'ALERT_UPDATED', 'alert', active.id,
      { patientId: patient.id, from: active.risk_level, to: level }, client);
    events.push([SOCKET_EVENTS.ALERT_UPDATED, upgraded]);
    if (level === 'HIGH') events.push(...await escalateIfCaregiverAbsent(client, patient, upgraded));
    return events;
  }

  const lastResolved = await alertRepository.lastResolved(client, patient.id, 'CLINICAL');
  if (lastResolved && RANK[level] <= RANK[lastResolved.risk_level] &&
      Date.now() - new Date(lastResolved.resolved_at).getTime() < env.alertCooldownSeconds * 1000) {
    logger.info({ event_type: 'ALERT_SUPPRESSED_COOLDOWN', patient_id: patient.id, level }, 'alert in cooldown');
    return [];
  }

  const alert = await alertRepository.insert(client, {
    patientId: patient.id, category: 'CLINICAL', triggerType: trigger.type, riskLevel: level,
    title: trigger.title, description: assessment.explanation, reasons: assessment.reasons,
  });
  await alertRepository.insertAction(client, { alertId: alert.id, action: 'CREATED', actorLabel: 'system', note: trigger.title });
  await audit(SYSTEM_CTX, 'ALERT_CREATED', 'alert', alert.id,
    { patientId: patient.id, level, trigger: trigger.type, score: assessment.risk_score }, client);
  logger.info({ event_type: 'ALERT_CREATED', patient_id: patient.id, alert_id: alert.id, level }, trigger.title);
  events.push([SOCKET_EVENTS.ALERT_NEW, alert]);
  if (level === 'HIGH') events.push(...await escalateIfCaregiverAbsent(client, patient, alert));
  return events;
}

async function escalateIfCaregiverAbsent(client, patient, alert) {
  if (alert.status === 'ESCALATED' || !patient.assigned_caregiver_id) return [];
  if (await caregiverRepository.isCheckedIn(patient.assigned_caregiver_id, client)) return [];
  const reason = 'HIGH risk while the assigned caregiver is not checked in';
  const escalated = await alertRepository.update(client, alert.id, {
    status: 'ESCALATED', escalation_level: alert.escalation_level + 1, escalated_at: new Date(), escalation_reason: reason,
  });
  await alertRepository.insertAction(client, { alertId: alert.id, action: 'ESCALATED', actorLabel: 'system', note: reason });
  await audit(SYSTEM_CTX, 'ALERT_ESCALATED', 'alert', alert.id, { patientId: patient.id, reason }, client);
  return [[SOCKET_EVENTS.ALERT_UPDATED, escalated]];
}

export function publish(events) {
  for (const [event, payload] of events) emit(event, payload);
}

// ------------------------------------------------------------------ caregiver actions
async function act(alertId, ctx, fn) {
  const events = [];
  await withTransaction(async (client) => {
    const alert = await alertRepository.findByIdForUpdate(client, alertId);
    if (!alert) throw notFound('Alert');
    if (alert.status === 'RESOLVED') throw conflict('Alert is already resolved');
    await fn(client, alert, events);
  });
  const full = await alertRepository.findById(alertId);
  emit(SOCKET_EVENTS.ALERT_UPDATED, full);
  return full;
}

const actor = (ctx) => ({ actorUserId: ctx.actorUserId, actorLabel: ctx.user?.name || ctx.actor });

export const alertService = {
  list: (opts) => alertRepository.list(opts),

  async get(id) {
    const alert = await alertRepository.findById(id);
    if (!alert) throw notFound('Alert');
    return alert;
  },

  acknowledge(alertId, ctx, note) {
    return act(alertId, ctx, async (client, alert) => {
      if (alert.status === 'ACKNOWLEDGED') throw conflict('Alert is already acknowledged');
      await alertRepository.update(client, alertId, {
        status: 'ACKNOWLEDGED', acknowledged_at: new Date(), acknowledged_by: ctx.actorUserId,
      });
      await alertRepository.insertAction(client, { alertId, action: 'ACKNOWLEDGED', note: note || null, ...actor(ctx) });
      await audit(ctx, 'ALERT_ACKNOWLEDGED', 'alert', alertId, { patientId: alert.patient_id, note }, client);
      logger.info({ event_type: 'ALERT_ACKNOWLEDGED', request_id: ctx.requestId, alert_id: alertId, patient_id: alert.patient_id });
    });
  },

  /** Record what the caregiver did. Responding to an unacknowledged alert also acknowledges it. */
  respond(alertId, ctx, note) {
    return act(alertId, ctx, async (client, alert) => {
      if (alert.status === 'OPEN' || alert.status === 'ESCALATED') {
        await alertRepository.update(client, alertId, {
          status: 'ACKNOWLEDGED', acknowledged_at: new Date(), acknowledged_by: ctx.actorUserId,
        });
        await alertRepository.insertAction(client, { alertId, action: 'ACKNOWLEDGED', ...actor(ctx) });
        await audit(ctx, 'ALERT_ACKNOWLEDGED', 'alert', alertId, { patientId: alert.patient_id, via: 'response' }, client);
      }
      await alertRepository.insertAction(client, { alertId, action: 'RESPONSE', note, ...actor(ctx) });
      await audit(ctx, 'CAREGIVER_RESPONSE', 'alert', alertId, { patientId: alert.patient_id, note }, client);
    });
  },

  resolve(alertId, ctx, note) {
    return act(alertId, ctx, async (client, alert) => {
      await alertRepository.update(client, alertId, {
        status: 'RESOLVED', resolved_at: new Date(), resolved_by: ctx.actorUserId,
      });
      await alertRepository.insertAction(client, { alertId, action: 'RESOLVED', note: note || null, ...actor(ctx) });
      await audit(ctx, 'ALERT_RESOLVED', 'alert', alertId, { patientId: alert.patient_id, note }, client);
    });
  },

  escalate(alertId, ctx, note) {
    return act(alertId, ctx, async (client, alert) => {
      const reason = note || 'Escalated manually by caregiver';
      await alertRepository.update(client, alertId, {
        status: 'ESCALATED', escalation_level: alert.escalation_level + 1, escalated_at: new Date(),
        escalation_reason: reason,
      });
      await alertRepository.insertAction(client, { alertId, action: 'ESCALATED', note: reason, ...actor(ctx) });
      await audit(ctx, 'ALERT_ESCALATED', 'alert', alertId, { patientId: alert.patient_id, reason }, client);
    });
  },

  /** Watchdog: escalate HIGH alerts not acknowledged within ACK_TIMEOUT_SECONDS. */
  async escalateOverdue() {
    const overdue = await alertRepository.listUnacknowledgedHigh(env.ackTimeoutSeconds);
    for (const alert of overdue) {
      const reason = `Not acknowledged within ${env.ackTimeoutSeconds} s`;
      await withTransaction(async (client) => {
        const current = await alertRepository.findByIdForUpdate(client, alert.id);
        if (current?.status !== 'OPEN') return;
        await alertRepository.update(client, alert.id, {
          status: 'ESCALATED', escalation_level: current.escalation_level + 1, escalated_at: new Date(),
          escalation_reason: reason,
        });
        await alertRepository.insertAction(client, { alertId: alert.id, action: 'ESCALATED', actorLabel: 'system', note: reason });
        await audit(SYSTEM_CTX, 'ALERT_ESCALATED', 'alert', alert.id, { patientId: alert.patient_id, reason }, client);
      });
      logger.warn({ event_type: 'ALERT_ESCALATED', alert_id: alert.id, patient_id: alert.patient_id }, reason);
      emit(SOCKET_EVENTS.ALERT_UPDATED, await alertRepository.findById(alert.id));
    }
    return overdue.length;
  },

  // ------------------------------------------------------------ device alerts (not patient deterioration)
  async raiseSensorOffline(client, device) {
    const existing = await alertRepository.findActiveForUpdate(client, device.patient_id, 'DEVICE');
    if (existing) return null;
    const alert = await alertRepository.insert(client, {
      patientId: device.patient_id, category: 'DEVICE', triggerType: 'SENSOR_OFFLINE', riskLevel: 'MEDIUM',
      title: 'Sensor connectivity issue detected',
      description: `No readings from ${device.device_uid} for over ${env.sensorOfflineSeconds} s. This is a device or ` +
        'connectivity problem, not a change in the patient\'s condition. Readings captured during the outage will ' +
        'upload automatically when the connection returns.',
      reasons: [`Last reading received at ${new Date(device.last_seen_at).toISOString()}`],
    });
    await alertRepository.insertAction(client, { alertId: alert.id, action: 'CREATED', actorLabel: 'system', note: alert.title });
    await audit(SYSTEM_CTX, 'ALERT_CREATED', 'alert', alert.id, { patientId: device.patient_id, trigger: 'SENSOR_OFFLINE' }, client);
    return alert;
  },

  async autoResolveDevice(client, patientId, note) {
    const existing = await alertRepository.findActiveForUpdate(client, patientId, 'DEVICE');
    if (!existing) return null;
    const resolved = await alertRepository.update(client, existing.id, { status: 'RESOLVED', resolved_at: new Date() });
    await alertRepository.insertAction(client, { alertId: existing.id, action: 'AUTO_RESOLVED', actorLabel: 'system', note });
    await audit(SYSTEM_CTX, 'ALERT_RESOLVED', 'alert', existing.id, { patientId, note, automatic: true }, client);
    return resolved;
  },
};
