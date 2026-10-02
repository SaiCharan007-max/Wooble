import { REFERENCE_RANGES } from '@homecare/shared';
import {
  CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { clock, formatVital, hhmm, isAbnormal } from '../lib/format.js';

const DOMAINS = {
  heart_rate: [40, 150],
  spo2: [80, 100],
  temperature: [35, 40.5],
  respiratory_rate: [8, 36],
};

function trendArrow(points, key) {
  const vals = points.map((p) => p[key]).filter((v) => v != null);
  if (vals.length < 6) return null;
  const recent = vals.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const earlier = vals.slice(-10, -7).reduce((a, b) => a + b, 0) / Math.max(1, vals.slice(-10, -7).length);
  const threshold = key === 'temperature' ? 0.2 : 1.5;
  if (recent - earlier > threshold) return '↑';
  if (earlier - recent > threshold) return '↓';
  return '→';
}

export function VitalChart({ readings, vital }) {
  const ref = REFERENCE_RANGES[vital];
  const data = readings.map((r) => ({ t: new Date(r.timestamp).getTime(), [vital]: r[vital], buffered: r.source === 'BUFFERED' }));
  const last = [...readings].reverse().find((r) => r[vital] != null);
  const value = last?.[vital];
  const abnormal = isAbnormal(vital, value);
  const arrow = trendArrow(readings, vital);

  return (
    <div className="card p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold text-slate-700">{ref.label}</span>
        <span className="text-xs text-slate-500">normal {ref.low}–{ref.high} {ref.unit}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-2xl font-bold tabular-nums ${abnormal ? 'text-red-700' : 'text-slate-900'}`}>{formatVital(vital, value)}</span>
        <span className="text-sm text-slate-500">{ref.unit}</span>
        {arrow && <span className="text-lg text-slate-600" aria-label="trend">{arrow}</span>}
        <span className="ml-auto text-xs text-slate-400">{last ? clock(last.timestamp) : ''}</span>
      </div>
      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -20 }}>
            <CartesianGrid stroke="#f1f5f9" />
            <ReferenceArea y1={ref.low} y2={ref.high} fill="#10b981" fillOpacity={0.08} />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={hhmm} tick={{ fontSize: 10 }} minTickGap={40} />
            <YAxis domain={DOMAINS[vital]} tick={{ fontSize: 10 }} allowDataOverflow />
            <Tooltip labelFormatter={(t) => clock(t)} formatter={(v) => [`${v} ${ref.unit}`, ref.label]} />
            <Line type="monotone" dataKey={vital} stroke={abnormal ? '#dc2626' : '#0369a1'} strokeWidth={2} isAnimationActive={false}
              dot={(props) => (props.payload.buffered
                ? <circle key={props.key} cx={props.cx} cy={props.cy} r={2.5} fill="#f59e0b" />
                : <g key={props.key} />)} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function RiskTrajectory({ history }) {
  const since = Date.now() - 10 * 60 * 1000; // same 10-minute window as the vital charts
  const data = history.filter((h) => new Date(h.created_at).getTime() >= since)
    .map((h) => ({ t: new Date(h.created_at).getTime(), score: h.risk_score }));
  return (
    <div className="card p-3">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-slate-700">Risk trajectory</span>
        <span className="text-xs text-slate-500">score 0–100 · MEDIUM ≥ 35 · HIGH ≥ 65</span>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -20 }}>
            <CartesianGrid stroke="#f1f5f9" />
            <ReferenceArea y1={65} y2={100} fill="#dc2626" fillOpacity={0.06} />
            <ReferenceArea y1={35} y2={65} fill="#f59e0b" fillOpacity={0.06} />
            <ReferenceLine y={65} stroke="#dc2626" strokeDasharray="4 4" />
            <ReferenceLine y={35} stroke="#f59e0b" strokeDasharray="4 4" />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={hhmm} tick={{ fontSize: 10 }} minTickGap={40} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
            <Tooltip labelFormatter={(t) => clock(t)} formatter={(v) => [v, 'Risk score']} />
            <Line type="stepAfter" dataKey="score" stroke="#334155" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
