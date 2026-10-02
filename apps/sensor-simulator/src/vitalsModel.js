// A virtual patient whose "true" physiology moves smoothly toward a scenario target;
// each reading adds small, realistic sensor noise.
import { VITAL_LIMITS } from '@homecare/shared';

export const NORMAL_VITALS = Object.freeze({
  heart_rate: 78, spo2: 97, respiratory_rate: 16, temperature: 36.8, systolic_bp: 122, diastolic_bp: 78,
});

// steps = number of 1x ticks to reach the target (tick = 2 s by default)
export const PROFILES = Object.freeze({
  NORMAL: { target: NORMAL_VITALS, steps: 15 },
  GRADUAL_DETERIORATION: {
    target: { heart_rate: 118, spo2: 88, respiratory_rate: 29, temperature: 38.7, systolic_bp: 98, diastolic_bp: 62 },
    steps: 75,
  },
  SUDDEN_DETERIORATION: {
    target: { heart_rate: 134, spo2: 85, respiratory_rate: 32, temperature: 37.6, systolic_bp: 88, diastolic_bp: 54 },
    steps: 4,
  },
  RECOVERY: { target: NORMAL_VITALS, steps: 45 },
});

const NOISE = { heart_rate: 1.5, spo2: 0.4, respiratory_rate: 0.5, temperature: 0.05, systolic_bp: 2, diastolic_bp: 1.5 };

export class VirtualPatient {
  constructor(start = NORMAL_VITALS, rng = Math.random) {
    this.start = { ...start };
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.state = { ...this.start };
    this.target = { ...this.start };
    this.stepsLeft = 0;
  }

  /** Physiological scenarios change the trajectory; SENSOR_FAILURE / NETWORK_FAILURE do not. */
  setScenario(name) {
    const profile = PROFILES[name];
    if (!profile) return;
    this.target = { ...profile.target };
    this.stepsLeft = profile.steps;
  }

  /** Advance `speed` physiological steps and return one noisy sensor reading. */
  step(speed = 1) {
    for (let i = 0; i < speed && this.stepsLeft > 0; i += 1) {
      for (const k of Object.keys(this.state)) this.state[k] += (this.target[k] - this.state[k]) / this.stepsLeft;
      this.stepsLeft -= 1;
    }
    return this.sample();
  }

  gaussian() {
    // Box-Muller
    const u = Math.max(this.rng(), 1e-9);
    const v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  sample() {
    const out = {};
    for (const [k, v] of Object.entries(this.state)) {
      const noisy = v + this.gaussian() * NOISE[k];
      const { min, max } = VITAL_LIMITS[k];
      const clamped = Math.min(max, Math.max(min, noisy));
      out[k] = k === 'temperature' ? Math.round(clamped * 10) / 10 : Math.round(clamped);
    }
    out.spo2 = Math.min(100, out.spo2);
    if (out.diastolic_bp >= out.systolic_bp) out.diastolic_bp = out.systolic_bp - 10;
    return out;
  }
}
