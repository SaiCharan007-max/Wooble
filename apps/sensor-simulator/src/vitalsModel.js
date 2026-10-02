// A virtual patient whose "true" physiology moves smoothly toward a scenario target;
// each reading adds small, realistic sensor noise. Scenario data is shared with the
// risk-engine evaluation (packages/shared/src/scenarios.json) so both use identical dynamics.
import { VITAL_LIMITS } from '@homecare/shared';
import scenarioData from '../../../packages/shared/src/scenarios.json' with { type: 'json' };

export const NORMAL_VITALS = Object.freeze({ ...scenarioData.normalVitals });

export const PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(scenarioData.profiles).map(([name, p]) => [
    name, { target: p.target === 'normal' ? NORMAL_VITALS : p.target, steps: p.steps },
  ]),
));

const NOISE = scenarioData.noise;
const O2_EFFECT = scenarioData.oxygenFailureEffect;

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
    this.oxygenFailure = false;
    this.o2Offset = { spo2: 0, respiratory_rate: 0, heart_rate: 0 };
  }

  /** Physiological scenarios change the trajectory; SENSOR_FAILURE / NETWORK_FAILURE do not. */
  setScenario(name) {
    const profile = PROFILES[name];
    if (!profile) return;
    this.target = { ...profile.target };
    this.stepsLeft = profile.steps;
  }

  /** Losing home oxygen gradually lowers SpO2 and raises breathing/heart rate (and recovers when restored). */
  setOxygenFailure(failed) {
    this.oxygenFailure = failed;
  }

  /** Advance `speed` physiological steps and return one noisy sensor reading. */
  step(speed = 1) {
    for (let i = 0; i < speed; i += 1) {
      if (this.stepsLeft > 0) {
        for (const k of Object.keys(this.state)) this.state[k] += (this.target[k] - this.state[k]) / this.stepsLeft;
        this.stepsLeft -= 1;
      }
      for (const k of Object.keys(this.o2Offset)) {
        const goal = this.oxygenFailure ? O2_EFFECT[k] : 0;
        const stepSize = Math.abs(O2_EFFECT[k]) / O2_EFFECT.steps;
        const diff = goal - this.o2Offset[k];
        this.o2Offset[k] += Math.sign(diff) * Math.min(Math.abs(diff), stepSize);
      }
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
      const noisy = v + (this.o2Offset[k] || 0) + this.gaussian() * NOISE[k];
      const { min, max } = VITAL_LIMITS[k];
      const clamped = Math.min(max, Math.max(min, noisy));
      out[k] = k === 'temperature' ? Math.round(clamped * 10) / 10 : Math.round(clamped);
    }
    out.spo2 = Math.min(100, out.spo2);
    if (out.diastolic_bp >= out.systolic_bp) out.diastolic_bp = out.systolic_bp - 10;
    return out;
  }
}

/** Home oxygen concentrator: flow (L/min) and power source. */
export class OxygenConcentrator {
  constructor({ equipmentUid, prescribedFlow }, rng = Math.random) {
    this.equipmentUid = equipmentUid;
    this.prescribedFlow = prescribedFlow;
    this.rng = rng;
    this.failed = false;
  }

  /** `mainsPower` is false during a simulated power cut: the unit switches to its battery. */
  sample({ mainsPower = true } = {}) {
    if (this.failed) return { flow_lpm: 0, power_source: 'NONE' };
    const flow = this.prescribedFlow + (this.rng() - 0.5) * 0.1;
    return { flow_lpm: Math.round(flow * 10) / 10, power_source: mainsPower ? 'MAINS' : 'BATTERY' };
  }
}
