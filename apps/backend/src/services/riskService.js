// Risk pipeline: gather inputs -> risk engine (or safety fallback) -> persist -> alerts -> real-time events.
import { SOCKET_EVENTS } from '@homecare/shared';
import { env } from '../config/env.js';
import { withTransaction } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { emit } from '../lib/socket.js';
import { noteRepository } from '../repositories/noteRepository.js';
import { patientRepository } from '../repositories/patientRepository.js';
import { riskRepository } from '../repositories/riskRepository.js';
import { vitalRepository } from '../repositories/vitalRepository.js';
import { evaluateRiskAlert, publish } from './alertService.js';
import { audit, SYSTEM_CTX } from './auditService.js';
import { fallbackAssessment } from './fallbackRisk.js';
import { riskEngineClient } from './riskEngineClient.js';

const toEngineReading = (r) => ({
  timestamp: new Date(r.timestamp).toISOString(),
  heartRate: r.heart_rate, spo2: r.spo2, temperature: r.temperature, systolicBp: r.systolic_bp,
  diastolicBp: r.diastolic_bp, respiratoryRate: r.respiratory_rate,
});

export async function assessPatient(patientId, { requestId } = {}) {
  const started = Date.now();
  const patient = await patientRepository.riskContext(patientId);
  if (!patient) throw notFound('Patient');
  const readings = await vitalRepository.latest(patientId, 30);
  if (!readings.length) return null;

  const [signals, history, previous] = await Promise.all([
    noteRepository.recentSignals(patientId, env.noteWindowMinutes),
    riskRepository.history(patientId, 40),
    riskRepository.latest(patientId),
  ]);

  let result;
  try {
    result = await riskEngineClient.assess({
      patient: { id: patient.id, age: patient.age, conditions: patient.conditions },
      readings: readings.map(toEngineReading),
      noteSignals: signals.map((s) => ({ signal: s.signal, timestamp: new Date(s.timestamp).toISOString() })),
      history: history.map((h) => ({ timestamp: new Date(h.created_at).toISOString(), riskScore: h.risk_score })),
    }, requestId);
  } catch (err) {
    logger.warn({ event_type: 'RISK_ENGINE_UNAVAILABLE', patient_id: patientId, err: err.message },
      'risk engine unavailable - using safety-threshold fallback');
    result = fallbackAssessment(readings.at(-1));
  }

  const latestReading = readings.at(-1);
  let assessment;
  let events = [];
  await withTransaction(async (client) => {
    assessment = await riskRepository.insert(client, patientId, latestReading.id, result);
    await audit(SYSTEM_CTX, 'RISK_CALCULATED', 'risk_assessment', String(assessment.id), {
      patientId, level: result.riskLevel, score: result.riskScore, engine: result.engineVersion,
    }, client);
    events = await evaluateRiskAlert(client, patient, assessment, previous);
  });

  emit(SOCKET_EVENTS.RISK_UPDATE, { patientId, assessment, previousLevel: previous?.risk_level || null });
  publish(events);
  logger.info({
    event_type: 'RISK_CALCULATED', patient_id: patientId, request_id: requestId, level: result.riskLevel,
    score: result.riskScore, engine: result.engineVersion, processing_time_ms: Date.now() - started,
  });
  return assessment;
}

export const riskService = {
  assessPatient,
  async getRisk(patientId) {
    if (!(await patientRepository.exists(patientId))) throw notFound('Patient');
    const [latest, history] = await Promise.all([riskRepository.latest(patientId), riskRepository.history(patientId, 120)]);
    return { latest, history };
  },
};
