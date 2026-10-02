import { Router } from 'express';
import {
  alertController, auditController, authController, caregiverController, equipmentController, patientController,
  simulatorController, vitalController,
} from '../controllers/index.js';
import { requireAuth, requireDevice, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  activitySchema, alertNoteSchema, alertResponseSchema, attendanceSchema, listQuery, loginSchema, noteSchema,
  scenarioSchema, uuidParam,
} from '../validators/schemas.js';

const r = Router();
const id = validate(uuidParam, 'params');
const query = validate(listQuery, 'query');

// --- auth
r.post('/auth/login', validate(loginSchema), authController.login);
r.get('/auth/me', requireAuth, authController.me);

// --- sensor ingestion (device key, not a user login). Single reading or { readings: [...] }.
r.post('/vitals', requireDevice, vitalController.ingest);
r.post('/equipment', requireDevice, equipmentController.ingest); // medical equipment readings (O2 concentrator)
r.post('/hub-events', requireDevice, equipmentController.hubEvents); // local alarms from the home hub

// everything below needs a signed-in user
r.use(requireAuth);

r.get('/patients', patientController.list);
r.get('/patients/:id', id, patientController.get);
r.get('/patients/:id/vitals', id, query, patientController.vitals);
r.get('/patients/:id/risk', id, patientController.risk);
r.get('/patients/:id/notes', id, patientController.notes);
r.post('/patients/:id/notes', id, validate(noteSchema), patientController.addNote);

r.get('/alerts', query, alertController.list);
r.get('/alerts/:id', id, alertController.get);
r.post('/alerts/:id/acknowledge', id, validate(alertNoteSchema), alertController.acknowledge);
r.post('/alerts/:id/response', id, validate(alertResponseSchema), alertController.respond);
r.post('/alerts/:id/resolve', id, validate(alertNoteSchema), alertController.resolve);
r.post('/alerts/:id/escalate', id, validate(alertNoteSchema), alertController.escalate);

r.post('/caregivers/check-in', validate(attendanceSchema), caregiverController.checkIn);
r.post('/caregivers/check-out', validate(attendanceSchema), caregiverController.checkOut);
r.post('/caregivers/activity', validate(activitySchema), caregiverController.recordActivity);
r.get('/caregivers/activity', query, caregiverController.activity);

// demo controls (prototype only)
r.get('/simulator/status', simulatorController.status);
r.post('/simulator/scenario', validate(scenarioSchema), simulatorController.control);
r.post('/simulator/reset', requireRole('ADMIN'), simulatorController.reset);

r.get('/audit-logs', requireRole('ADMIN', 'CAREGIVER'), query, auditController.list);

export default r;
