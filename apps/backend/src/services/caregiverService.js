import { SOCKET_EVENTS } from '@homecare/shared';
import { badRequest, notFound } from '../lib/errors.js';
import { emit } from '../lib/socket.js';
import { caregiverRepository } from '../repositories/caregiverRepository.js';
import { patientRepository } from '../repositories/patientRepository.js';
import { audit } from './auditService.js';

/** Caregivers act for themselves; an admin may act on behalf of a caregiver by passing caregiverId. */
async function resolveCaregiver(ctx, caregiverId) {
  const id = ctx.user?.role === 'ADMIN' ? caregiverId : ctx.user?.caregiverId;
  if (!id) throw badRequest('caregiverId is required');
  const caregiver = await caregiverRepository.findById(id);
  if (!caregiver) throw notFound('Caregiver');
  return caregiver;
}

async function record(ctx, { caregiverId, patientId, type, note }) {
  const caregiver = await resolveCaregiver(ctx, caregiverId);
  if (patientId && !(await patientRepository.exists(patientId))) throw notFound('Patient');
  const entry = await caregiverRepository.insertAttendance({ caregiverId: caregiver.id, patientId, type, note });
  await audit(ctx, `CAREGIVER_${type}`, 'caregiver', caregiver.id, { patientId, note });
  emit(SOCKET_EVENTS.CAREGIVER_ACTIVITY, { ...entry, caregiver_name: caregiver.full_name });
  return { ...entry, caregiver_name: caregiver.full_name };
}

export const caregiverService = {
  checkIn: (ctx, body) => record(ctx, { ...body, type: 'CHECK_IN' }),
  checkOut: (ctx, body) => record(ctx, { ...body, type: 'CHECK_OUT' }),
  recordActivity: (ctx, body) => record(ctx, body),
  async activity({ patientId } = {}) {
    const [caregivers, recent] = await Promise.all([
      caregiverRepository.listWithStatus(),
      caregiverRepository.recentActivity({ patientId }),
    ]);
    return {
      caregivers: caregivers.map((c) => ({ ...c, status: c.present ? 'PRESENT' : 'NOT_CHECKED_IN' })),
      recent,
    };
  },
};
