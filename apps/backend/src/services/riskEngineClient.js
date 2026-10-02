// HTTP client for the Python risk engine, with response validation and a clear failure mode.
import { z } from 'zod';
import { env } from '../config/env.js';

const assessmentSchema = z.object({
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  riskScore: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  reasons: z.array(z.string()),
  contributingFactors: z.array(z.object({
    factor: z.string(), category: z.string(), points: z.number(), detail: z.string(),
  })),
  predictionWindow: z.string(),
  prediction: z.record(z.any()),
  recommendedAction: z.string(),
  engineVersion: z.string(),
});

const ALLOWED_SIGNALS = ['breathing_difficulty', 'chest_discomfort', 'confusion', 'dizziness', 'fatigue',
  'reduced_appetite', 'pain'];

const extractionSchema = z.object({
  language: z.string().max(10),
  translatedText: z.string().nullable(),
  signals: z.array(z.object({ signal: z.string(), label: z.string(), evidence: z.string() })),
  negatedSignals: z.array(z.object({ signal: z.string(), label: z.string(), evidence: z.string() })),
  method: z.string(),
});

async function post(path, body, requestId) {
  const res = await fetch(`${env.riskEngineUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': requestId || '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(env.riskEngineTimeoutMs),
  });
  if (!res.ok) throw new Error(`risk engine responded ${res.status}`);
  return res.json();
}

export const riskEngineClient = {
  async assess(payload, requestId) {
    return assessmentSchema.parse(await post('/v1/assess', payload, requestId));
  },

  /** Free-text note -> structured signals. Anything outside the known vocabulary is dropped here too. */
  async extractSignals(text, requestId) {
    const out = extractionSchema.parse(await post('/v1/notes/extract', { text }, requestId));
    out.signals = out.signals.filter((s) => ALLOWED_SIGNALS.includes(s.signal));
    return out;
  },

  async health() {
    const res = await fetch(`${env.riskEngineUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  },
};
