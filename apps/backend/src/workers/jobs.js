// Background job handlers. Run by the BullMQ worker, or inline when Redis is unavailable.
import { registerJobHandler } from '../lib/queue.js';
import { runWatchdog } from '../services/monitorService.js';
import { assessPatient } from '../services/riskService.js';

registerJobHandler('risk:assess', ({ patientId, requestId }) => assessPatient(patientId, { requestId }));
registerJobHandler('watchdog', () => runWatchdog());
