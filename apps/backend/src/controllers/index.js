// Thin controllers: read the validated request, call one service, shape the HTTP response.
import { ctx } from '../middleware/requestContext.js';
import { alertService } from '../services/alertService.js';
import { listAudit } from '../services/auditService.js';
import { authService } from '../services/authService.js';
import { caregiverService } from '../services/caregiverService.js';
import { equipmentService } from '../services/equipmentService.js';
import { noteService } from '../services/noteService.js';
import { patientService } from '../services/patientService.js';
import { riskService } from '../services/riskService.js';
import { simulatorService } from '../services/simulatorService.js';
import { vitalService } from '../services/vitalService.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export const authController = {
  login: wrap(async (req, res) => res.json(await authService.login(req.body.email, req.body.password, ctx(req)))),
  me: wrap(async (req, res) => res.json({ user: req.user })),
};

export const patientController = {
  list: wrap(async (_req, res) => res.json(await patientService.list())),
  get: wrap(async (req, res) => res.json(await patientService.get(req.params.id))),
  vitals: wrap(async (req, res) => {
    await patientService.ensureExists(req.params.id);
    res.json(await vitalService.listForPatient(req.params.id, { minutes: req.query.minutes, limit: req.query.limit }));
  }),
  risk: wrap(async (req, res) => res.json(await riskService.getRisk(req.params.id))),
  addNote: wrap(async (req, res) => res.status(201).json(await noteService.addNote(req.params.id, req.body.note, ctx(req)))),
  notes: wrap(async (req, res) => {
    await patientService.ensureExists(req.params.id);
    res.json(await noteService.list(req.params.id));
  }),
};

export const vitalController = {
  ingest: wrap(async (req, res) => {
    const result = await vitalService.ingest(req.body, ctx(req));
    res.status(result.status === 'created' ? 201 : 200).json(result);
  }),
};

export const equipmentController = {
  ingest: wrap(async (req, res) => res.json(await equipmentService.ingest(req.body, ctx(req)))),
  hubEvents: wrap(async (req, res) => res.json(await equipmentService.ingestHubEvents(req.body, ctx(req)))),
};

export const alertController = {
  list: wrap(async (req, res) => res.json(await alertService.list(req.query))),
  get: wrap(async (req, res) => res.json(await alertService.get(req.params.id))),
  acknowledge: wrap(async (req, res) => res.json(await alertService.acknowledge(req.params.id, ctx(req), req.body.note))),
  respond: wrap(async (req, res) => res.json(await alertService.respond(req.params.id, ctx(req), req.body.note))),
  resolve: wrap(async (req, res) => res.json(await alertService.resolve(req.params.id, ctx(req), req.body.note))),
  escalate: wrap(async (req, res) => res.json(await alertService.escalate(req.params.id, ctx(req), req.body.note))),
};

export const caregiverController = {
  checkIn: wrap(async (req, res) => res.status(201).json(await caregiverService.checkIn(ctx(req), req.body))),
  checkOut: wrap(async (req, res) => res.status(201).json(await caregiverService.checkOut(ctx(req), req.body))),
  recordActivity: wrap(async (req, res) => res.status(201).json(await caregiverService.recordActivity(ctx(req), req.body))),
  activity: wrap(async (req, res) => res.json(await caregiverService.activity(req.query))),
};

export const simulatorController = {
  status: wrap(async (_req, res) => res.json(await simulatorService.status())),
  control: wrap(async (req, res) => res.json(await simulatorService.control(req.body, ctx(req)))),
  reset: wrap(async (req, res) => res.json(await simulatorService.resetDemo(ctx(req)))),
};

export const auditController = {
  list: wrap(async (req, res) => res.json(await listAudit({
    limit: req.query.limit, includeRoutine: req.query.includeRoutine === 'true', patientId: req.query.patientId,
  }))),
};
