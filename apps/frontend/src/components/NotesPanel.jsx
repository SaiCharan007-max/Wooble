import { useState } from 'react';
import { api } from '../lib/api.js';
import { clock } from '../lib/format.js';

const EXAMPLE = 'Patient is more tired than usual and reports difficulty breathing.';

export default function NotesPanel({ patientId, notes, onAdded }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/patients/${patientId}/notes`, { method: 'POST', body: { note: text } });
      setText('');
      onAdded?.();
    } catch (err) {
      setError(err.details?.[0]?.message || err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <h2 className="label mb-2">Caregiver notes</h2>
      <form onSubmit={submit} className="space-y-2">
        <textarea className="w-full rounded-lg border border-slate-300 p-2 text-sm" rows={3} maxLength={2000}
          placeholder={`e.g. ${EXAMPLE}`} value={text} onChange={(e) => setText(e.target.value)} aria-label="New caregiver note" />
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={busy || !text.trim()}>Add note</button>
          <button type="button" className="btn" onClick={() => setText(EXAMPLE)}>Use example</button>
        </div>
        <p className="text-xs text-slate-500">Symptoms are extracted as structured signals that can raise contextual risk — free text never sets the risk directly.</p>
      </form>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      <ul className="mt-3 divide-y divide-slate-100">
        {notes.map((n) => (
          <li key={n.id} className="py-2">
            <div className="text-xs text-slate-500">{n.author || 'Caregiver'} · {clock(n.timestamp)}</div>
            <p className="text-sm">{n.note}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {n.extracted_signals.length
                ? n.extracted_signals.map((s) => (
                  <span key={s.signal} className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900" title={`matched “${s.evidence}”`}>
                    {s.label}
                  </span>))
                : <span className="text-xs text-slate-400">no symptom signals</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
