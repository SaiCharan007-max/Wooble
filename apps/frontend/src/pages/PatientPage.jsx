import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AlertCard from '../components/AlertCard.jsx';
import { RiskTrajectory, VitalChart } from '../components/Charts.jsx';
import NotesPanel from '../components/NotesPanel.jsx';
import { DeviceOfflineBanner } from '../components/PatientCard.jsx';
import RiskPanel from '../components/RiskPanel.jsx';
import { api } from '../lib/api.js';
import { clock, timeAgo } from '../lib/format.js';
import { useLive, useLiveReload } from '../lib/live.js';

const MAX_POINTS = 600;

export default function PatientPage() {
  const { id } = useParams();
  const [patient, setPatient] = useState(null);
  const [readings, setReadings] = useState([]);
  const [risk, setRisk] = useState({ latest: null, history: [] });
  const [error, setError] = useState(null);
  const [synced, setSynced] = useState(null);

  const loadPatient = useCallback(async () => {
    try {
      setPatient(await api(`/patients/${id}`));
    } catch (e) {
      setError(e.message);
    }
  }, [id]);
  const loadVitals = useCallback(async () => setReadings(await api(`/patients/${id}/vitals?minutes=10`)), [id]);
  const loadRisk = useCallback(async () => setRisk(await api(`/patients/${id}/risk`)), [id]);

  useEffect(() => {
    loadPatient();
    loadVitals().catch(() => {});
    loadRisk().catch(() => {});
  }, [loadPatient, loadVitals, loadRisk]);

  // Live: append new readings and risk results directly; refetch the rest on change.
  useLive(['vital:new', 'risk:update', 'device:synced'], (event, payload) => {
    if (event === 'vital:new' && payload.patient_id === id) {
      setReadings((prev) => (prev.some((r) => r.id === payload.id) ? prev : [...prev, payload].slice(-MAX_POINTS)));
    }
    if (event === 'risk:update' && payload.patientId === id) {
      setRisk((prev) => ({ latest: payload.assessment, history: [...prev.history, payload.assessment].slice(-200) }));
    }
    if (event === 'device:synced' && payload.patientId === id) {
      setSynced(payload);
      loadVitals();
    }
  });
  useLiveReload(['alert:new', 'alert:updated', 'device:status', 'note:new', 'caregiver:activity'], loadPatient);

  if (!patient) return <p className="text-slate-500">{error || 'Loading…'}</p>;

  return (
    <div className="space-y-5">
      <div>
        <Link to="/" className="text-sm text-sky-800 hover:underline">← All patients</Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{patient.name}</h1>
            <p className="text-sm text-slate-600">
              {patient.age} years · {patient.gender.toLowerCase()} · {patient.medical_conditions.map((c) => c.condition).join(', ')}
            </p>
            <p className="text-xs text-slate-500">
              Medications: {patient.medications.join('; ')} · Emergency contact: {patient.emergency_contact} · Caregiver: {patient.assigned_caregiver}
            </p>
          </div>
          <div className="text-right text-sm text-slate-600">
            Sensor {patient.device?.device_uid}: <b>{patient.device?.status}</b><br />
            <span className="text-xs">last data {timeAgo(patient.device?.last_seen_at)}</span>
          </div>
        </div>
      </div>

      <DeviceOfflineBanner device={patient.device} />
      {synced && patient.device?.status === 'ONLINE' && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
          ✓ Connection restored — {synced.count} buffered readings synchronised ({clock(synced.from)} – {clock(synced.to)}). Shown as orange dots.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[420px_1fr]">
        <RiskPanel risk={risk.latest} />
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {['spo2', 'heart_rate', 'respiratory_rate', 'temperature'].map((v) => <VitalChart key={v} vital={v} readings={readings} />)}
          </div>
          <RiskTrajectory history={risk.history} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <NotesPanel patientId={id} notes={patient.notes} onAdded={() => { loadPatient(); }} />
        <section className="space-y-3">
          <h2 className="label">Alert history</h2>
          {patient.alerts.length === 0 && <div className="card p-4 text-sm text-slate-500">No alerts</div>}
          {patient.alerts.map((a) => <AlertCard key={a.id} alert={a} showPatient={false} onChange={loadPatient} />)}
        </section>
        <section className="card p-4">
          <h2 className="label mb-2">Caregiver activity</h2>
          <ul className="space-y-2 text-sm">
            {patient.activity.length === 0 && <li className="text-slate-500">No activity recorded</li>}
            {patient.activity.map((a) => (
              <li key={a.id} className="flex justify-between gap-2 border-b border-slate-100 pb-1">
                <span><b>{a.caregiver_name}</b> · {a.type.replace('_', ' ').toLowerCase()}{a.note ? ` — ${a.note}` : ''}</span>
                <span className="shrink-0 text-xs text-slate-500">{timeAgo(a.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
