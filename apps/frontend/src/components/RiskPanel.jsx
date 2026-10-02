import { useState } from 'react';
import { RISK_STYLE, timeAgo, TREND } from '../lib/format.js';
import RiskBadge from './RiskBadge.jsx';

export default function RiskPanel({ risk }) {
  const [details, setDetails] = useState(false);
  if (!risk) return <section className="card p-5 text-slate-500">No risk assessment yet — waiting for readings.</section>;

  const style = RISK_STYLE[risk.risk_level];
  const p = risk.prediction || {};
  const trend = TREND[p.trend] || TREND.STABLE;

  return (
    <section className={`card p-5 ${style.border}`} aria-label="Risk assessment">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="label">Risk signal</div>
          <div className="mt-1 flex items-center gap-3">
            <RiskBadge level={risk.risk_level} size="lg" />
            <span className="text-2xl font-bold tabular-nums">{risk.risk_score}<span className="text-base font-normal text-slate-400">/100</span></span>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div><dt className="label">Trend</dt><dd className={`font-semibold ${trend.cls}`}>{trend.arrow} {trend.label}</dd></div>
          <div><dt className="label">Confidence</dt><dd className="font-semibold">{Math.round(risk.confidence * 100)}%</dd></div>
          <div><dt className="label">Window</dt><dd className="font-semibold">24–48 h</dd></div>
        </dl>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`Risk score ${risk.risk_score} of 100`}>
        <div className={`h-full ${style.bar}`} style={{ width: `${risk.risk_score}%` }} />
      </div>

      <p className="mt-4 text-base font-medium text-slate-800">{risk.explanation}</p>

      <div className="mt-4">
        <div className="label mb-1">Why</div>
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-700">
          {risk.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </div>

      <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm">
        <div className="label mb-1">Projection (next 24–48 h)</div>
        <p className="font-medium">{p.statement}</p>
        {p.previousRisk != null && (
          <p className="mt-1 text-xs text-slate-600">
            Current risk {p.currentRisk} · {p.velocityWindow} ago {p.previousRisk} · velocity {p.velocity > 0 ? '+' : ''}{p.velocity} · projected {p.projectedRisk}
          </p>
        )}
        <p className="mt-1 text-xs italic text-slate-500">{p.disclaimer}</p>
      </div>

      <div className={`mt-3 rounded-lg border-l-4 p-3 text-sm ${risk.risk_level === 'HIGH' ? 'border-red-600 bg-red-50' : risk.risk_level === 'MEDIUM' ? 'border-amber-500 bg-amber-50' : 'border-emerald-500 bg-emerald-50'}`}>
        <b>Recommended action:</b> {risk.recommended_action}
      </div>

      <button className="mt-3 text-sm font-medium text-sky-800 hover:underline" onClick={() => setDetails(!details)}>
        {details ? 'Hide' : 'Show'} contributing factors
      </button>
      {details && (
        <table className="mt-2 w-full text-sm">
          <tbody>
            {risk.contributing_factors.map((f, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-1 pr-2">{f.factor}<div className="text-xs text-slate-500">{f.detail}</div></td>
                <td className="py-1 text-xs text-slate-500">{f.category.replace('_', ' ').toLowerCase()}</td>
                <td className="py-1 text-right font-semibold tabular-nums">{f.points > 0 ? '+' : ''}{f.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-slate-400">Updated {timeAgo(risk.created_at)} · {risk.engine_version} · prototype risk signal, not a diagnosis</p>
    </section>
  );
}
