import { notFound } from '../lib/errors.js';
import { alertRepository } from '../repositories/alertRepository.js';
import { caregiverRepository } from '../repositories/caregiverRepository.js';
import { noteRepository } from '../repositories/noteRepository.js';
import { patientRepository } from '../repositories/patientRepository.js';

export const patientService = {
  list: () => patientRepository.list(),

  async get(id) {
    const patient = await patientRepository.findById(id);
    if (!patient) throw notFound('Patient');
    const [notes, alerts, activity] = await Promise.all([
      noteRepository.listForPatient(id),
      alertRepository.list({ status: 'all', patientId: id, limit: 20 }),
      caregiverRepository.recentActivity({ patientId: id, limit: 10 }),
    ]);
    return { ...patient, notes, alerts, activity };
  },

  async ensureExists(id) {
    if (!(await patientRepository.exists(id))) throw notFound('Patient');
  },
};
