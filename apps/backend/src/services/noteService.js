// Caregiver notes: free text -> structured signals (risk engine NLP) -> stored -> risk re-assessed.
// Free text never sets risk directly; only validated, known signals reach the deterministic engine.
import { SOCKET_EVENTS } from '@homecare/shared';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { enqueue } from '../lib/queue.js';
import { emit } from '../lib/socket.js';
import { noteRepository } from '../repositories/noteRepository.js';
import { patientRepository } from '../repositories/patientRepository.js';
import { audit } from './auditService.js';
import { riskEngineClient } from './riskEngineClient.js';

export const noteService = {
  async addNote(patientId, text, ctx) {
    if (!(await patientRepository.exists(patientId))) throw notFound('Patient');

    let extraction;
    try {
      extraction = await riskEngineClient.extractSignals(text, ctx.requestId);
    } catch (err) {
      logger.warn({ event_type: 'NOTE_EXTRACTION_UNAVAILABLE', patient_id: patientId, err: err.message });
      extraction = { language: 'unknown', translatedText: null, signals: [], negatedSignals: [], method: 'unavailable' };
    }

    const note = await noteRepository.insert({
      patientId, caregiverId: ctx.user?.caregiverId || null, authorUserId: ctx.actorUserId, note: text,
      language: extraction.language, translatedText: extraction.translatedText,
      signals: extraction.signals, method: extraction.method,
    });
    await audit(ctx, 'NOTE_ADDED', 'caregiver_note', note.id, {
      patientId, signals: extraction.signals.map((s) => s.signal), method: extraction.method,
    });
    logger.info({ event_type: 'NOTE_SIGNALS_EXTRACTED', request_id: ctx.requestId, patient_id: patientId,
      signals: extraction.signals.map((s) => s.signal) });

    const result = { ...note, author: ctx.user?.name, negated_signals: extraction.negatedSignals };
    emit(SOCKET_EVENTS.NOTE_NEW, result);
    await enqueue('risk:assess', { patientId, requestId: ctx.requestId }, { key: patientId });
    return result;
  },

  list: (patientId) => noteRepository.listForPatient(patientId),
};
