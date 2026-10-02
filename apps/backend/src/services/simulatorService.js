// Demo-only: proxies scenario controls to the sensor simulator's control API.
import { DEMO_PATIENTS } from '@homecare/shared';
import { env } from '../config/env.js';
import { withTransaction } from '../db/pool.js';
import { unavailable } from '../lib/errors.js';
import { alertRepository } from '../repositories/alertRepository.js';
import { audit } from './auditService.js';

async function call(path, body) {
  try {
    const res = await fetch(`${env.simulatorUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-control-token': env.simulatorControlToken },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`simulator responded ${res.status}`);
    return res.json();
  } catch (err) {
    throw unavailable(`Sensor simulator is not reachable (${err.message})`);
  }
}

export const simulatorService = {
  status: () => call('/status'),

  async control(body, ctx) {
    const result = await call('/control', body);
    await audit(ctx, 'CONFIG_CHANGED', 'simulator', body.patientId, { ...body });
    return result;
  },

  /** Back to the starting point: default scenarios, network up, 1x speed, all active alerts resolved. */
  async resetDemo(ctx) {
    const result = await call('/reset', {});
    const active = await alertRepository.list({ status: 'active', limit: 500 });
    for (const alert of active) {
      await withTransaction(async (client) => {
        await alertRepository.update(client, alert.id, { status: 'RESOLVED', resolved_at: new Date(), resolved_by: ctx.actorUserId });
        await alertRepository.insertAction(client, {
          alertId: alert.id, action: 'RESOLVED', actorUserId: ctx.actorUserId, actorLabel: ctx.user?.name || 'system', note: 'Demo reset',
        });
      });
    }
    await audit(ctx, 'CONFIG_CHANGED', 'simulator', 'ALL', { action: 'DEMO_RESET', resolvedAlerts: active.length });
    return { ...result, resolvedAlerts: active.length, patients: DEMO_PATIENTS.map((p) => p.name) };
  },
};
