// Used ONLY when the risk engine is unreachable. It applies the same deterministic safety
// thresholds so a critically abnormal vital is never missed, and says clearly that it is degraded.
import { REFERENCE_RANGES } from '@homecare/shared';

const CRITICAL = {
  spo2: (v) => v <= 88,
  respiratory_rate: (v) => v >= 30 || v <= 8,
  heart_rate: (v) => v >= 131 || v <= 40,
  systolic_bp: (v) => v <= 90,
  temperature: (v) => v >= 39.5 || v <= 35.0,
};

export function fallbackAssessment(latest) {
  const critical = [];
  const abnormal = [];
  for (const [key, isCritical] of Object.entries(CRITICAL)) {
    const v = latest?.[key];
    if (v == null) continue;
    const ref = REFERENCE_RANGES[key];
    const text = `${ref.label} ${v}${ref.unit}`;
    if (isCritical(v)) critical.push(text);
    else if (v < ref.low || v > ref.high) abnormal.push(text);
  }
  const level = critical.length ? 'HIGH' : abnormal.length ? 'MEDIUM' : 'LOW';
  const score = { HIGH: 70, MEDIUM: 40, LOW: 10 }[level];
  const listed = [...critical, ...abnormal];
  return {
    riskLevel: level,
    riskScore: score,
    confidence: 0.3,
    explanation: `${level} RISK (safety-threshold check only - risk engine unavailable)` +
      (listed.length ? `: ${listed.join(', ')} outside safe range.` : ': no vital outside safe thresholds.'),
    reasons: [...critical.map((c) => `Critical value: ${c}`), ...abnormal.map((a) => `Outside reference range: ${a}`),
      'Risk engine unavailable - trends and notes not analysed'],
    contributingFactors: listed.map((t) => ({ factor: t, category: 'SAFETY_FLOOR', points: 0, detail: 'Fallback threshold check' })),
    predictionWindow: '24-48 hours',
    prediction: {
      window: '24-48 hours', trend: 'STABLE', velocity: 0, currentRisk: score, projectedRisk: score,
      statement: 'Trend projection unavailable while the risk engine is offline.',
      disclaimer: 'Prototype trend projection - not a clinical prediction.',
    },
    recommendedAction: level === 'LOW' ? 'Continue routine monitoring.' :
      'Requires caregiver attention: check the patient and follow the care plan.',
    engineVersion: 'backend-safety-fallback',
  };
}
