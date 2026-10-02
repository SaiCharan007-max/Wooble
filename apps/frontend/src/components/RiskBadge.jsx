import { RISK_STYLE } from '../lib/format.js';

export default function RiskBadge({ level, size = 'md' }) {
  const style = RISK_STYLE[level] || RISK_STYLE.NONE;
  const sizes = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-sm', lg: 'px-4 py-1.5 text-lg' };
  return (
    <span className={`inline-flex items-center rounded-full font-bold ring-1 ring-inset ${style.badge} ${sizes[size]}`}>
      {level ? `${level} RISK` : 'NO DATA'}
    </span>
  );
}
