// Edge safety net: the home hub checks every reading itself, so a critical value or an oxygen
// failure sounds an alarm in the home even when the internet (and the cloud platform) is down.
// Alarm events are queued in the same store-and-forward buffer and reach the platform later.
import { randomUUID } from 'node:crypto';
import { criticalFindings } from '@homecare/shared';

const CLEAR_AFTER = 5; // consecutive non-critical readings before an alarm clears itself

export class HubAlarms {
  constructor({ emit, now = () => new Date(), log = () => {} }) {
    this.emit = emit; // (event) => void, pushes a hub_event into the uplink buffer
    this.now = now;
    this.log = log;
    this.alarms = new Map(); // patientId -> alarm
  }

  /** Evaluate one patient's latest data. `cloudReachable` is recorded for the audit trail. */
  check({ patientId, deviceUid, name, vitals, equipment, cloudReachable }) {
    const findings = vitals ? criticalFindings(vitals) : [];
    if (equipment && equipment.power_source === 'NONE') findings.push('Oxygen concentrator stopped (0 L/min)');
    const existing = this.alarms.get(patientId);

    if (findings.length) {
      if (!existing) {
        const alarm = {
          id: randomUUID(), patientId, deviceUid, name, findings, raisedAt: this.now().toISOString(),
          acknowledged: false, cloudReachable, okStreak: 0,
        };
        this.alarms.set(patientId, alarm);
        this.log(`LOCAL ALARM ${name}: ${findings.join(', ')}${cloudReachable ? '' : ' (cloud unreachable)'}`);
        this.record('LOCAL_ALARM', alarm, { findings, cloudReachable });
      } else {
        existing.findings = findings;
        existing.okStreak = 0;
      }
      return;
    }
    if (existing && ++existing.okStreak >= CLEAR_AFTER) {
      this.alarms.delete(patientId);
      this.record('LOCAL_ALARM_CLEARED', existing, { reason: 'values back out of the critical range' });
    }
  }

  acknowledge(patientId, by = 'caregiver at home') {
    const alarm = this.alarms.get(patientId);
    if (!alarm || alarm.acknowledged) return false;
    alarm.acknowledged = true;
    alarm.acknowledgedAt = this.now().toISOString();
    this.record('LOCAL_ALARM_ACK', alarm, { by });
    return true;
  }

  record(type, alarm, details) {
    this.emit({
      kind: 'hub_event',
      event_uid: `${alarm.id}:${type}`,
      device_id: alarm.deviceUid,
      patient_id: alarm.patientId,
      type,
      timestamp: this.now().toISOString(),
      details: { alarmId: alarm.id, ...details },
    });
  }

  list() {
    return [...this.alarms.values()].map(({ okStreak, ...a }) => a);
  }

  reset() {
    this.alarms.clear();
  }
}
