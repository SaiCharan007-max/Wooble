import { z } from 'zod';
import { SCENARIOS, SPEEDS, VITAL_LIMITS } from '@homecare/shared';

const vital = (name, integer = true) => {
  const { min, max } = VITAL_LIMITS[name];
  let n = z.number({ invalid_type_error: `${name} must be a number` });
  if (integer) n = n.int(`${name} must be a whole number`);
  return n.min(min, `${name} below plausible minimum ${min}`).max(max, `${name} above plausible maximum ${max}`)
    .nullable().optional();
};

const VITAL_FIELDS = ['heart_rate', 'spo2', 'temperature', 'systolic_bp', 'diastolic_bp', 'respiratory_rate'];
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export const vitalReadingSchema = z
  .object({
    device_id: z.string().trim().min(1).max(64),
    patient_id: z.string().uuid(),
    timestamp: z.string().datetime({ offset: true }),
    heart_rate: vital('heart_rate'),
    spo2: vital('spo2'),
    temperature: vital('temperature', false),
    systolic_bp: vital('systolic_bp'),
    diastolic_bp: vital('diastolic_bp'),
    respiratory_rate: vital('respiratory_rate'),
    source: z.enum(['LIVE', 'BUFFERED']).default('LIVE'),
    sequence_number: z.number().int().nonnegative(),
  })
  .strict()
  .refine((r) => VITAL_FIELDS.some((f) => r[f] !== null && r[f] !== undefined), {
    message: 'Reading must contain at least one vital sign',
  })
  .refine((r) => new Date(r.timestamp).getTime() <= Date.now() + FUTURE_TOLERANCE_MS, {
    message: 'Timestamp is in the future', path: ['timestamp'],
  })
  .refine((r) => r.systolic_bp == null || r.diastolic_bp == null || r.systolic_bp > r.diastolic_bp, {
    message: 'Systolic BP must be greater than diastolic BP', path: ['diastolic_bp'],
  });

export const equipmentReadingSchema = z.object({
  equipment_id: z.string().trim().min(1).max(64),
  patient_id: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  flow_lpm: z.number().min(0).max(15),
  power_source: z.enum(['MAINS', 'BATTERY', 'NONE']),
  source: z.enum(['LIVE', 'BUFFERED']).default('LIVE'),
  sequence_number: z.number().int().nonnegative(),
}).strict().refine((r) => new Date(r.timestamp).getTime() <= Date.now() + FUTURE_TOLERANCE_MS, {
  message: 'Timestamp is in the future', path: ['timestamp'],
});

export const hubEventSchema = z.object({
  event_uid: z.string().trim().min(1).max(128),
  device_id: z.string().trim().min(1).max(64),
  patient_id: z.string().uuid(),
  type: z.enum(['LOCAL_ALARM', 'LOCAL_ALARM_ACK', 'LOCAL_ALARM_CLEARED']),
  timestamp: z.string().datetime({ offset: true }),
  details: z.record(z.any()).default({}),
}).strict();

export const vitalBatchSchema = z.object({ readings: z.array(z.unknown()).min(1).max(500) });

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

export const uuidParam = z.object({ id: z.string().uuid('Invalid id') });

export const noteSchema = z.object({
  note: z.string({ required_error: 'note is required' }).trim().min(1, 'Note cannot be empty').max(2000, 'Note is too long (max 2000 characters)'),
});

export const alertNoteSchema = z.object({ note: z.string().trim().max(2000).optional() });
export const alertResponseSchema = z.object({ note: z.string().trim().min(1, 'Response cannot be empty').max(2000) });

export const attendanceSchema = z.object({
  caregiverId: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional(),
});
export const activitySchema = attendanceSchema.extend({
  type: z.enum(['VISIT', 'ACTIVITY']),
  patientId: z.string().uuid().optional(),
});

export const scenarioSchema = z.object({
  patientId: z.union([z.string().uuid(), z.literal('ALL')]).default('ALL'),
  scenario: z.enum(SCENARIOS).optional(),
  speed: z.union(SPEEDS.map((s) => z.literal(s))).optional(),
  network: z.enum(['ONLINE', 'OFFLINE']).optional(),
  equipment: z.enum(['FAILURE', 'OK']).optional(),
}).refine((b) => b.scenario || b.speed || b.network || b.equipment, { message: 'Provide scenario, speed, network or equipment' });

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  status: z.enum(['active', 'all', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED']).default('active'),
  patientId: z.string().uuid().optional(),
  minutes: z.coerce.number().int().min(1).max(1440).default(30),
  includeRoutine: z.enum(['true', 'false']).default('false'),
});
