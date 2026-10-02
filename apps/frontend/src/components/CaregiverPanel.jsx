import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { hhmm, timeAgo } from '../lib/format.js';

export default function CaregiverPanel({ data, patients, onChange }) {
  const { user } = useAuth();
  const [visitPatient, setVisitPatient] = useState('');
  const [error, setError] = useState(null);

  async function act(path, body = {}) {
    setError(null);
    try {
      await api(path, { method: 'POST', body });
      onChange?.();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <section className="card p-4">
      <h2 className="label mb-3">Caregivers</h2>
      <ul className="space-y-3">
        {(data?.caregivers || []).map((c) => {
          const mine = c.id === user.caregiverId;
          const present = c.status === 'PRESENT';
          return (
            <li key={c.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{c.full_name}{mine && <span className="text-xs font-normal text-slate-500"> (you)</span>}</span>
                <span className={`text-sm font-semibold ${present ? 'text-emerald-700' : 'text-slate-500'}`}>
                  ● {present ? 'PRESENT' : 'NOT CHECKED IN'}
                </span>
              </div>
              <dl className="mt-1 grid grid-cols-2 gap-x-2 text-xs text-slate-600">
                <dt>Last activity</dt><dd>{timeAgo(c.last_activity_at)}</dd>
                <dt>Patient visit</dt><dd>{c.last_visit ? `${hhmm(c.last_visit.created_at)} · ${c.last_visit.patient_name}` : '—'}</dd>
                <dt>Patients</dt><dd>{c.patients.map((p) => p.name).join(', ') || '—'}</dd>
              </dl>
              {mine && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {present
                    ? <button className="btn" onClick={() => act('/caregivers/check-out')}>Check out</button>
                    : <button className="btn btn-primary" onClick={() => act('/caregivers/check-in')}>Check in</button>}
                  <select className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" value={visitPatient}
                    onChange={(e) => setVisitPatient(e.target.value)} aria-label="Patient visited">
                    <option value="">Mark visit…</option>
                    {patients.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  {visitPatient && (
                    <button className="btn" onClick={() => { act('/caregivers/activity', { type: 'VISIT', patientId: visitPatient }); setVisitPatient(''); }}>
                      Save visit
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
