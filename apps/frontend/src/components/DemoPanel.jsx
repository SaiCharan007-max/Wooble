// Prototype-only control panel: drives the sensor simulator and tracks the 3-minute demo story.
import { DEMO_PATIENTS } from '@homecare/shared';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useLive } from '../lib/live.js';

const SCENARIO_BUTTONS = [
  ['NORMAL', 'Normal'],
  ['GRADUAL_DETERIORATION', 'Deterioration'],
  ['SUDDEN_DETERIORATION', 'Sudden event'],
  ['RECOVERY', 'Recovery'],
  ['SENSOR_FAILURE', 'Sensor failure'],
];

const STEPS = [
  ['low', 'Patient stable (LOW)'],
  ['deteriorating', 'Deterioration started'],
  ['high', 'HIGH risk detected'],
  ['alert', 'Caregiver alerted'],
  ['ack', 'Alert acknowledged'],
  ['response', 'Response recorded'],
  ['offline', 'Connectivity lost — buffering'],
  ['synced', 'Buffered data synced'],
  ['recovery', 'Recovery'],
  ['resolved', 'Alert resolved'],
];

export default function DemoPanel({ patients, alerts }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(true);
  // default to the patient who starts stable, so the demo begins at LOW risk
  const [target, setTarget] = useState(DEMO_PATIENTS.find((p) => p.defaultScenario === 'NORMAL')?.patientId || patients[0]?.id || '');
  const [sim, setSim] = useState(null);
  const [simError, setSimError] = useState(null);
  const [done, setDone] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('homeward.demo') || '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { sessionStorage.setItem('homeward.demo', JSON.stringify(done)); } catch { /* storage unavailable */ }
  }, [done]);

  const mark = (key) => setDone((d) => (d[key] ? d : { ...d, [key]: true }));
  const patient = patients.find((p) => p.id === target);
  const device = sim?.devices.find((d) => d.patientId === target);

  async function refresh() {
    try {
      setSim(await api('/simulator/status'));
      setSimError(null);
    } catch (e) {
      setSimError(e.message);
    }
  }
  useEffect(() => {
    if (!open) return undefined;
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    if (!target && patients[0]) setTarget(patients[0].id);
  }, [patients, target]);

  // derive checklist progress from what the system is actually doing
  useEffect(() => {
    const level = patient?.latest_risk?.risk_level;
    if (level === 'LOW') mark('low');
    if (level === 'HIGH') mark('high');
    const alert = alerts.find((a) => a.patient_id === target && a.category === 'CLINICAL');
    if (alert) mark('alert');
    if (alert?.status === 'ACKNOWLEDGED') mark('ack');
    if (alert?.actions?.some((x) => x.action === 'RESPONSE')) mark('response');
    if (sim?.network === 'OFFLINE') mark('offline');
  }, [patient, alerts, sim, target]);

  useLive(['device:synced', 'alert:updated'], (event, payload) => {
    if (event === 'device:synced' && payload.patientId === target) mark('synced');
    if (event === 'alert:updated' && payload.patient_id === target && payload.status === 'RESOLVED' && payload.category === 'CLINICAL') mark('resolved');
  });

  async function control(body) {
    try {
      setSim(await api('/simulator/scenario', { method: 'POST', body }));
      setSimError(null);
      if (body.scenario === 'GRADUAL_DETERIORATION' || body.scenario === 'SUDDEN_DETERIORATION') mark('deteriorating');
      if (body.scenario === 'RECOVERY') mark('recovery');
    } catch (e) {
      setSimError(e.message);
    }
  }

  async function reset() {
    try {
      await api('/simulator/reset', { method: 'POST' });
      setDone({});
      refresh();
    } catch (e) {
      setSimError(e.message);
    }
  }

  const offline = sim?.network === 'OFFLINE';

  return (
    <section className="card mb-5 border-dashed border-sky-300 bg-sky-50/40">
      <button className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="font-semibold text-sky-900">🎬 Demo mode <span className="font-normal text-slate-500">— simulator controls (prototype only)</span></span>
        <span className="text-sm text-slate-500">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="grid gap-4 border-t border-sky-100 px-4 py-4 lg:grid-cols-[1fr_280px]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="label" htmlFor="demo-patient">Patient</label>
              <select id="demo-patient" className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm" value={target}
                onChange={(e) => { setTarget(e.target.value); setDone({}); }}>
                {patients.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {device && <span className="text-sm text-slate-600">Sensor scenario: <b>{device.scenario.replaceAll('_', ' ')}</b></span>}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="label w-20">Scenario</span>
              {SCENARIO_BUTTONS.map(([value, label]) => (
                <button key={value} className={`btn ${device?.scenario === value ? 'btn-primary' : ''}`}
                  onClick={() => control({ patientId: target, scenario: value })}>{label}</button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="label w-20">Network</span>
              {offline
                ? <button className="btn btn-primary" onClick={() => control({ network: 'ONLINE' })}>Restore connection</button>
                : <button className="btn" onClick={() => control({ scenario: 'NETWORK_FAILURE' })}>⚡ Power / connectivity failure</button>}
              {sim && (
                <span className={`text-sm ${offline ? 'font-semibold text-amber-800' : 'text-slate-600'}`}>
                  {offline ? `Home hub offline · ${sim.uplink.buffered} readings buffered locally` : `Home hub online · ${sim.uplink.buffered} waiting`}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="label w-20">Speed</span>
              {[1, 5, 10].map((s) => (
                <button key={s} className={`btn ${sim?.speed === s ? 'btn-primary' : ''}`} onClick={() => control({ speed: s })}>{s}x</button>
              ))}
              {user.role === 'ADMIN' && <button className="btn ml-auto" onClick={reset}>↺ Reset demo</button>}
            </div>
            {simError && <p className="text-sm text-red-700">{simError}</p>}
          </div>

          <ol className="space-y-1 text-sm" aria-label="Demo progress">
            {STEPS.map(([key, label], i) => (
              <li key={key} className={`flex items-center gap-2 ${done[key] ? 'text-emerald-800' : 'text-slate-400'}`}>
                <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold ${done[key] ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'}`}>
                  {done[key] ? '✓' : i + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
