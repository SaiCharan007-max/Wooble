import { useCallback, useEffect, useState } from 'react';
import AlertCard from '../components/AlertCard.jsx';
import CaregiverPanel from '../components/CaregiverPanel.jsx';
import DemoPanel from '../components/DemoPanel.jsx';
import PatientCard from '../components/PatientCard.jsx';
import { api } from '../lib/api.js';
import { useLiveReload } from '../lib/live.js';

export default function DashboardPage() {
  const [patients, setPatients] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [caregivers, setCaregivers] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [p, a, c] = await Promise.all([api('/patients'), api('/alerts?status=active'), api('/caregivers/activity')]);
      setPatients(p);
      setAlerts(a);
      setCaregivers(c);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useLiveReload(['vital:new', 'risk:update', 'alert:new', 'alert:updated', 'device:status', 'device:synced', 'caregiver:activity'], load, 600);

  if (!patients) return <p className="text-slate-500">{error || 'Loading…'}</p>;

  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  patients.forEach((p) => { if (p.latest_risk) counts[p.latest_risk.risk_level] += 1; });

  return (
    <>
      <DemoPanel patients={patients} alerts={alerts} />
      {error && <p className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">{error}</p>}

      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h1 className="text-xl font-bold">Patients</h1>
        <span className="text-sm text-slate-600">
          <b className="text-red-700">{counts.HIGH}</b> high · <b className="text-amber-700">{counts.MEDIUM}</b> medium · <b className="text-emerald-700">{counts.LOW}</b> low risk
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="grid content-start gap-4 md:grid-cols-2">
          {patients.map((p) => <PatientCard key={p.id} patient={p} />)}
        </div>
        <aside className="space-y-5">
          <section>
            <h2 className="label mb-2">Active alerts ({alerts.length})</h2>
            <div className="space-y-3">
              {alerts.length === 0 && <div className="card p-4 text-sm text-slate-500">✓ No active alerts</div>}
              {alerts.map((a) => <AlertCard key={a.id} alert={a} onChange={load} />)}
            </div>
          </section>
          <CaregiverPanel data={caregivers} patients={patients} onChange={load} />
        </aside>
      </div>
    </>
  );
}
