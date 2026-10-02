import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { clock } from '../lib/format.js';
import { useLiveReload } from '../lib/live.js';

const TONE = {
  ALERT_CREATED: 'text-red-700', ALERT_ESCALATED: 'text-purple-700', ALERT_ACKNOWLEDGED: 'text-sky-700',
  CAREGIVER_RESPONSE: 'text-sky-700', ALERT_RESOLVED: 'text-emerald-700', SENSOR_OFFLINE: 'text-amber-700',
  BUFFERED_READINGS_SYNCED: 'text-emerald-700', LOGIN_FAILED: 'text-red-700',
};

function summary(meta) {
  const parts = [];
  for (const [k, v] of Object.entries(meta || {})) {
    if (k === 'patientId' || v == null || v === '') continue;
    parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return parts.join(' · ');
}

export default function AuditPage() {
  const [rows, setRows] = useState([]);
  const [routine, setRoutine] = useState(false);
  const load = useCallback(async () => setRows(await api(`/audit-logs?limit=200&includeRoutine=${routine}`)), [routine]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  useLiveReload(['alert:new', 'alert:updated', 'device:status', 'device:synced', 'note:new', 'caregiver:activity'], load, 800);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">Audit log</h1>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={routine} onChange={(e) => setRoutine(e.target.checked)} />
          Show routine events (every vital ingestion & risk calculation)
        </label>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Actor</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Entity</th><th className="px-3 py-2">Details</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 align-top">
                <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{clock(r.timestamp)}</td>
                <td className="px-3 py-1.5">{r.actor}</td>
                <td className={`px-3 py-1.5 font-semibold ${TONE[r.action] || ''}`}>{r.action}</td>
                <td className="px-3 py-1.5 text-slate-600">{r.entity_type}</td>
                <td className="px-3 py-1.5 text-slate-600">{summary(r.metadata)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
