import { REFERENCE_RANGES } from '@homecare/shared';

export function timeAgo(value) {
  if (!value) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const clock = (value) =>
  value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
export const hhmm = (value) => (value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

export const RISK_STYLE = {
  LOW: { badge: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20', text: 'text-emerald-700', bar: 'bg-emerald-500', border: 'border-slate-200' },
  MEDIUM: { badge: 'bg-amber-100 text-amber-900 ring-amber-600/30', text: 'text-amber-700', bar: 'bg-amber-500', border: 'border-amber-300' },
  HIGH: { badge: 'bg-red-600 text-white ring-red-700', text: 'text-red-700', bar: 'bg-red-600', border: 'border-red-500 ring-2 ring-red-200' },
  NONE: { badge: 'bg-slate-100 text-slate-600 ring-slate-300', text: 'text-slate-500', bar: 'bg-slate-300', border: 'border-slate-200' },
};

export const TREND = {
  INCREASING: { arrow: '↑', label: 'Increasing', cls: 'text-red-600' },
  DECREASING: { arrow: '↓', label: 'Decreasing', cls: 'text-emerald-600' },
  STABLE: { arrow: '→', label: 'Stable', cls: 'text-slate-500' },
};

export function isAbnormal(key, value) {
  const r = REFERENCE_RANGES[key];
  return value != null && r && (value < r.low || value > r.high);
}

export const formatVital = (key, value) =>
  value == null ? '–' : key === 'temperature' ? Number(value).toFixed(1) : Math.round(value);
