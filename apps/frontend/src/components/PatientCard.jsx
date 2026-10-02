import { Link } from 'react-router-dom';
import { formatVital, isAbnormal, RISK_STYLE, timeAgo, TREND } from '../lib/format.js';
import RiskBadge from './RiskBadge.jsx';

const MINI = [
  ['heart_rate', 'HR', 'bpm'],
  ['spo2', 'SpO₂', '%'],
  ['respiratory_rate', 'RR', '/min'],
  ['temperature', 'Temp', '°C'],
];

export function DeviceOfflineBanner({ device, buffered }) {
  if (device?.status !== 'OFFLINE') return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900" role="status">
      📡 DEVICE OFFLINE — BUFFERING DATA
      <span className="block text-xs font-normal">
        Last data {timeAgo(device.last_seen_at)}{buffered ? ` · ${buffered} readings stored on the home hub` : ''}.
        This is a connectivity issue, not a change in the patient's condition.
      </span>
    </div>
  );
}

export function EquipmentLine({ equipment }) {
  if (!equipment?.length) return null;
  return equipment.map((e) => {
    const fault = e.status === 'FAULT';
    const battery = e.status === 'ON_BATTERY';
    return (
      <div key={e.equipment_uid} className={`rounded-lg px-3 py-1.5 text-sm ${fault ? 'border border-red-300 bg-red-50 font-semibold text-red-800' : battery ? 'bg-amber-50 text-amber-900' : 'bg-slate-50 text-slate-700'}`}>
        🫁 Oxygen concentrator:{' '}
        {fault ? 'NOT DELIVERING OXYGEN' : e.flow_lpm != null ? `${Number(e.flow_lpm).toFixed(1)} L/min` : '–'}
        {battery && ' · 🔋 on battery'}
        <span className="text-xs font-normal text-slate-500"> (prescribed {Number(e.prescribed_flow_lpm).toFixed(1)})</span>
      </div>
    );
  });
}

export default function PatientCard({ patient, buffered }) {
  const risk = patient.latest_risk;
  const level = risk?.risk_level;
  const style = RISK_STYLE[level] || RISK_STYLE.NONE;
  const v = patient.latest_vitals || {};
  const trend = TREND[risk?.prediction?.trend] || null;

  return (
    <Link to={`/patients/${patient.id}`}
      className={`card block p-4 transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${style.border}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold">{patient.name}</div>
          <div className="text-xs text-slate-500">
            {patient.age} y · {patient.gender.toLowerCase()} · {patient.medical_conditions.map((c) => c.condition).join(', ')}
          </div>
        </div>
        <RiskBadge level={level} />
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="text-3xl font-bold tabular-nums">{risk ? risk.risk_score : '–'}<span className="text-sm font-normal text-slate-400">/100</span></div>
        {trend && <div className={`text-sm font-medium ${trend.cls}`}>{trend.arrow} {trend.label}</div>}
        {patient.active_alerts > 0 && (
          <span className="ml-auto rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700">
            🔔 {patient.active_alerts} active alert{patient.active_alerts > 1 ? 's' : ''}
          </span>
        )}
      </div>

      <p className="mt-2 line-clamp-2 min-h-10 text-sm text-slate-700">{risk?.explanation || 'Waiting for readings…'}</p>

      <div className="mt-3 grid grid-cols-4 gap-2 rounded-lg bg-slate-50 p-2 text-center">
        {MINI.map(([k, label, unit]) => (
          <div key={k}>
            <div className="text-[11px] text-slate-500">{label}</div>
            <div className={`text-sm font-semibold tabular-nums ${isAbnormal(k, v[k]) ? 'text-red-700' : 'text-slate-800'}`}>
              {formatVital(k, v[k])}<span className="text-[10px] font-normal text-slate-400"> {unit}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        <DeviceOfflineBanner device={patient.device} buffered={buffered} />
        <EquipmentLine equipment={patient.equipment} />
        <div className="flex justify-between text-xs text-slate-500">
          <span>Caregiver: {patient.assigned_caregiver || '—'}</span>
          <span>{patient.device?.status === 'ONLINE' ? '🟢 Sensor online' : patient.device?.status === 'OFFLINE' ? '🟠 Sensor offline' : '⚪ Sensor —'} · {timeAgo(v.timestamp)}</span>
        </div>
      </div>
    </Link>
  );
}
