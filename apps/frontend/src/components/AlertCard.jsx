import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { clock, timeAgo } from '../lib/format.js';
import RiskBadge from './RiskBadge.jsx';

const STATUS = {
  OPEN: 'bg-red-50 text-red-700',
  ESCALATED: 'bg-purple-100 text-purple-800',
  ACKNOWLEDGED: 'bg-sky-50 text-sky-800',
  RESOLVED: 'bg-slate-100 text-slate-600',
};

const RESPONSE_TEMPLATE =
  'Checked patient. Patient is conscious and responsive. Following established care plan and contacting clinical support.';

export default function AlertCard({ alert, onChange, showPatient = true }) {
  const [mode, setMode] = useState(null); // 'response' | 'escalate'
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const active = alert.status !== 'RESOLVED';
  const responses = (alert.actions || []).filter((a) => a.action === 'RESPONSE');

  async function act(action, body = {}) {
    setBusy(true);
    setError(null);
    try {
      await api(`/alerts/${alert.id}/${action}`, { method: 'POST', body });
      setMode(null);
      setText('');
      onChange?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card p-3 ${alert.risk_level === 'HIGH' && active ? 'border-red-400 bg-red-50/40' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        {alert.category === 'DEVICE'
          ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900">DEVICE</span>
          : <RiskBadge level={alert.risk_level} size="sm" />}
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[alert.status]}`}>{alert.status}</span>
        <span className="ml-auto text-xs text-slate-500" title={clock(alert.created_at)}>{timeAgo(alert.created_at)}</span>
      </div>

      <div className="mt-2 font-semibold">
        {showPatient && <Link className="text-sky-800 hover:underline" to={`/patients/${alert.patient_id}`}>{alert.patient_name}</Link>}
        {showPatient && ' — '}{alert.title}
      </div>
      <p className="mt-1 text-sm text-slate-700">{alert.description}</p>

      {alert.status === 'ESCALATED' && (
        <p className="mt-2 rounded-md bg-purple-50 px-2 py-1 text-xs font-medium text-purple-800">
          ⬆ Escalated (level {alert.escalation_level}): {alert.escalation_reason}
        </p>
      )}
      {alert.acknowledged_by_name && (
        <p className="mt-2 text-xs text-slate-600">✓ Acknowledged by {alert.acknowledged_by_name} at {clock(alert.acknowledged_at)}</p>
      )}
      {responses.map((r) => (
        <p key={r.id} className="mt-1 rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-700">💬 {r.actor_label}: “{r.note}”</p>
      ))}
      {alert.status === 'RESOLVED' && <p className="mt-1 text-xs text-slate-600">Resolved {clock(alert.resolved_at)}{alert.resolved_by_name ? ` by ${alert.resolved_by_name}` : ''}</p>}

      {active && !mode && (
        <div className="mt-3 flex flex-wrap gap-2">
          {alert.status !== 'ACKNOWLEDGED' && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act('acknowledge')}>Acknowledge</button>
          )}
          <button className="btn" disabled={busy} onClick={() => { setMode('response'); setText(RESPONSE_TEMPLATE); }}>Add response</button>
          <button className="btn" disabled={busy} onClick={() => act('resolve')}>Resolve</button>
          <button className="btn" disabled={busy} onClick={() => { setMode('escalate'); setText(''); }}>Escalate</button>
        </div>
      )}

      {mode && (
        <form className="mt-3 space-y-2" onSubmit={(e) => {
          e.preventDefault();
          act(mode === 'response' ? 'response' : 'escalate', { note: text.trim() || undefined });
        }}>
          <label className="label" htmlFor={`t-${alert.id}`}>{mode === 'response' ? 'What did you do?' : 'Reason for escalation (optional)'}</label>
          <textarea id={`t-${alert.id}`} className="w-full rounded-lg border border-slate-300 p-2 text-sm" rows={3}
            maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} required={mode === 'response'} />
          <div className="flex gap-2">
            <button className={`btn ${mode === 'escalate' ? 'btn-danger' : 'btn-primary'}`} disabled={busy}>
              {mode === 'response' ? 'Save response' : 'Escalate'}
            </button>
            <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
