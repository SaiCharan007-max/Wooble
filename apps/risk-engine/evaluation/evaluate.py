"""Evaluation harness: how early does the risk engine warn, and how often does it cry wolf?

Replays every simulator scenario many times (seeded, reproducible) through the *real* risk engine,
exactly as the backend calls it (last 30 readings + risk history), and compares it with two baselines:

  * Threshold alarm   - a conventional monitor that alarms only when a vital crosses a critical limit
  * Values-only score - early-warning points on current values, without trends / context / notes

Run:  python -m evaluation.evaluate      (from apps/risk-engine)
Writes evaluation/results.json and docs/evaluation.md.
"""
import json
import math
import random
import statistics
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.engine import vitals as v
from app.engine.model import get_model
from app.schemas import AssessRequest

ROOT = Path(__file__).resolve().parents[3]
SCENARIOS = json.loads((ROOT / "packages/shared/src/scenarios.json").read_text(encoding="utf-8"))
NORMAL = SCENARIOS["normalVitals"]
NOISE = SCENARIOS["noise"]
TICK_S = 2
RUNS = 100
BASELINE_TICKS = 20
MODEL = get_model()
LIMITS = {"heart_rate": (20, 250), "spo2": (50, 100), "temperature": (30, 43), "systolic_bp": (50, 260),
          "diastolic_bp": (20, 160), "respiratory_rate": (4, 60)}


class Patient:
    """Python twin of apps/sensor-simulator/src/vitalsModel.js (same scenario data, same dynamics)."""

    def __init__(self, start, rng, noise_scale=1.0):
        self.noise_scale = noise_scale
        self.state = dict(start)
        self.target = dict(start)
        self.steps_left = 0
        self.rng = rng

    def set_scenario(self, name):
        p = SCENARIOS["profiles"][name]
        self.target = dict(NORMAL if p["target"] == "normal" else p["target"])
        self.steps_left = p["steps"]

    def step(self):
        if self.steps_left > 0:
            for k in self.state:
                self.state[k] += (self.target[k] - self.state[k]) / self.steps_left
            self.steps_left -= 1
        out = {}
        for k, val in self.state.items():
            lo, hi = LIMITS[k]
            noisy = min(hi, max(lo, val + self.rng.gauss(0, 1) * NOISE[k] * self.noise_scale))
            out[k] = round(noisy, 1) if k == "temperature" else round(noisy)
        out["spo2"] = min(100, out["spo2"])
        return out


def critical(r):
    return any(fn(r[p]) for p, fn in v.CRITICAL.items() if r.get(p) is not None)


def values_only_level(r):
    pts = [v.points(p, r[p]) for p in v.SCORED]
    total = sum(pts)
    return "HIGH" if total >= 7 else "MEDIUM" if total >= 5 or 3 in pts else "LOW"


def run(scenario, rng, ticks, start=NORMAL, age=72, conditions=(), signals=(), pre=None, noise_scale=1.0):
    """Simulate one patient; return per-tick engine level/score plus baseline signals."""
    p = Patient(start, rng, noise_scale)
    if pre:
        p.set_scenario(pre)
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    readings, history, trace = [], [], []
    for i in range(BASELINE_TICKS + ticks):
        if i == BASELINE_TICKS:
            p.set_scenario(scenario)
        r = p.step()
        ts = t0 + timedelta(seconds=i * TICK_S)
        readings.append({"timestamp": ts.isoformat(), **{_camel(k): val for k, val in r.items()}})
        req = AssessRequest.model_validate({
            "patient": {"age": age, "conditions": [{"condition": c, "riskCategory": cat} for c, cat in conditions]},
            "readings": readings[-30:],
            "noteSignals": [{"signal": s} for s in signals],
            "history": history[-40:],
        })
        out = MODEL.assess(req)
        history.append({"timestamp": ts.isoformat(), "riskScore": out["risk_score"]})
        if i >= BASELINE_TICKS:
            trace.append({"level": out["risk_level"], "score": out["risk_score"], "critical": critical(r),
                          "values_only": values_only_level(r)})
    return trace


def _camel(k):
    head, *rest = k.split("_")
    return head + "".join(w.capitalize() for w in rest)


def first(trace, pred):
    return next((i for i, t in enumerate(trace) if pred(t)), None)


def pct(n, d):
    return round(100 * n / d, 1) if d else 0.0


def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.mean(xs), 1) if xs else None


def evaluate():
    rng = random.Random(42)
    steps = SCENARIOS["profiles"]["GRADUAL_DETERIORATION"]["steps"]
    results = {"runs_per_scenario": RUNS, "tick_seconds": TICK_S, "deterioration_steps": steps}

    # 1. gradual deterioration: lead time vs baselines
    rows = []
    for _ in range(RUNS):
        tr = run("GRADUAL_DETERIORATION", rng, steps + 10)
        rows.append({
            "medium": first(tr, lambda t: t["level"] != "LOW"),
            "high": first(tr, lambda t: t["level"] == "HIGH"),
            "threshold_alarm": first(tr, lambda t: t["critical"]),
            "values_only_medium": first(tr, lambda t: t["values_only"] != "LOW"),
        })
    lead = [r["threshold_alarm"] - r["medium"] for r in rows if r["medium"] is not None and r["threshold_alarm"] is not None]
    lead_vs_values = [r["values_only_medium"] - r["medium"] for r in rows
                      if r["medium"] is not None and r["values_only_medium"] is not None]
    results["gradual"] = {
        "detected_runs_pct": pct(sum(r["medium"] is not None for r in rows), RUNS),
        "first_warning_pct_of_path": round(100 * mean([r["medium"] for r in rows]) / steps, 1),
        "first_high_pct_of_path": round(100 * mean([r["high"] for r in rows]) / steps, 1),
        "threshold_alarm_pct_of_path": round(100 * mean([r["threshold_alarm"] for r in rows]) / steps, 1),
        "values_only_warning_pct_of_path": round(100 * mean([r["values_only_medium"] for r in rows]) / steps, 1),
        "lead_vs_threshold_readings_mean": mean(lead),
        "lead_vs_values_only_readings_mean": mean(lead_vs_values),
        "warned_before_threshold_alarm_pct": pct(sum(x > 0 for x in lead), len(lead)),
    }

    # 2. stable patients: false alarms
    stable = [run("NORMAL", rng, 150) for _ in range(RUNS)]
    results["stable"] = {
        "runs_with_any_alert_pct": pct(sum(any(t["level"] != "LOW" for t in tr) for tr in stable), RUNS),
        "runs_with_high_pct": pct(sum(any(t["level"] == "HIGH" for t in tr) for tr in stable), RUNS),
        "readings_not_low_pct": pct(sum(t["level"] != "LOW" for tr in stable for t in tr), sum(len(tr) for tr in stable)),
        "threshold_alarm_runs_pct": pct(sum(any(t["critical"] for t in tr) for tr in stable), RUNS),
    }

    noisy = [run("NORMAL", rng, 150, noise_scale=2.0) for _ in range(RUNS)]
    results["stable_double_noise"] = {
        "runs_with_any_alert_pct": pct(sum(any(t["level"] != "LOW" for t in tr) for tr in noisy), RUNS),
        "runs_with_high_pct": pct(sum(any(t["level"] == "HIGH" for t in tr) for tr in noisy), RUNS),
        "readings_not_low_pct": pct(sum(t["level"] != "LOW" for tr in noisy for t in tr), sum(len(tr) for tr in noisy)),
    }

    # 3. sudden event: time to HIGH
    sudden = [first(run("SUDDEN_DETERIORATION", rng, 30), lambda t: t["level"] == "HIGH") for _ in range(RUNS)]
    results["sudden"] = {"detected_runs_pct": pct(sum(x is not None for x in sudden), RUNS),
                         "readings_to_high_mean": mean(sudden), "readings_to_high_max": max(x for x in sudden if x is not None)}

    # 4. recovery: time back to LOW after deterioration
    deteriorated = SCENARIOS["profiles"]["GRADUAL_DETERIORATION"]["target"]
    rec = [first(run("RECOVERY", rng, 120, start=deteriorated, pre="GRADUAL_DETERIORATION"), lambda t: t["level"] == "LOW")
           for _ in range(RUNS)]
    results["recovery"] = {"returned_low_pct": pct(sum(x is not None for x in rec), RUNS),
                           "readings_to_low_mean": mean(rec),
                           "recovery_steps": SCENARIOS["profiles"]["RECOVERY"]["steps"]}

    # 5. value of caregiver notes and patient context (same random seed for a fair comparison)
    def warn_at(**kw):
        r = random.Random(7)
        return mean([first(run("GRADUAL_DETERIORATION", r, steps, **kw), lambda t: t["level"] != "LOW") for _ in range(30)])
    plain = warn_at(age=55)
    results["context"] = {
        "plain_first_warning": plain,
        "with_breathing_note_first_warning": warn_at(age=55, signals=["breathing_difficulty", "fatigue"]),
        "copd_age_80_first_warning": warn_at(age=80, conditions=[("COPD", "RESPIRATORY")]),
    }
    return results


def to_markdown(r):
    g, s, su, rc, c = r["gradual"], r["stable"], r["sudden"], r["recovery"], r["context"]
    sn = r["stable_double_noise"]
    path_hours = 48
    lead_hours = round((g["threshold_alarm_pct_of_path"] - g["first_warning_pct_of_path"]) / 100 * path_hours, 1)
    return f"""# Risk engine evaluation

Generated by `apps/risk-engine/evaluation/evaluate.py` ({r['runs_per_scenario']} seeded runs per scenario,
same scenario data and noise as the sensor simulator, the real risk engine called exactly like the backend does).
Re-run with `npm run evaluate`.

> Synthetic data only. This shows the engine behaves as designed; it is **not** clinical validation.

## Headline
- **Earlier warning:** on a gradual deterioration the engine raises its first warning at **{g['first_warning_pct_of_path']}%** of the
  deterioration path; a conventional critical-threshold alarm fires at **{g['threshold_alarm_pct_of_path']}%**
  (earlier in **{g['warned_before_threshold_alarm_pct']}%** of runs). If the same trajectory unfolded over {path_hours} hours, that is
  roughly **{lead_hours} hours earlier**.
- **No crying wolf:** stable patients produced an alert in **{s['runs_with_any_alert_pct']}%** of runs
  (HIGH in {s['runs_with_high_pct']}%).
- **Sudden events:** detected as HIGH in **{su['detected_runs_pct']}%** of runs, on average within
  **{su['readings_to_high_mean']} readings** (worst case {su['readings_to_high_max']}).

## 1. Gradual deterioration ({r['deterioration_steps']}-step path)
| Signal | Fires at (% of path) |
|---|---|
| HomeWard first warning (MEDIUM) | {g['first_warning_pct_of_path']}% |
| HomeWard HIGH | {g['first_high_pct_of_path']}% |
| Values-only early-warning score (no trends/context) | {g['values_only_warning_pct_of_path']}% |
| Conventional critical-threshold alarm | {g['threshold_alarm_pct_of_path']}% |

Average lead over the threshold alarm: **{g['lead_vs_threshold_readings_mean']} readings**; over the values-only score:
**{g['lead_vs_values_only_readings_mean']} readings**. The gain comes from trend analysis (rate of change across several vitals).
Detected in {g['detected_runs_pct']}% of runs.

## 2. Stable patients (false alarms, 150 readings each)
| Metric | Value |
|---|---|
| Runs with any MEDIUM/HIGH alert | {s['runs_with_any_alert_pct']}% |
| Runs with a HIGH alert | {s['runs_with_high_pct']}% |
| Readings scored above LOW | {s['readings_not_low_pct']}% |

Stress test with **double sensor noise**: alert in {sn['runs_with_any_alert_pct']}% of runs (HIGH in {sn['runs_with_high_pct']}%),
{sn['readings_not_low_pct']}% of readings above LOW. Using the median of the last 3 readings and requiring trends to be
consistent keeps single noisy samples from triggering alerts.

## 3. Sudden deterioration
Detected as HIGH in {su['detected_runs_pct']}% of runs, mean {su['readings_to_high_mean']} readings after onset.

## 4. Recovery
Returned to LOW in {rc['returned_low_pct']}% of runs, mean {rc['readings_to_low_mean']} readings
(physiological recovery path: {rc['recovery_steps']} steps). Risk is only lowered once the improvement is visible in the data.

## 5. What context and notes add (first warning, in readings after onset; lower = earlier)
| Patient | First warning |
|---|---|
| Age 55, no history, no notes | {c['plain_first_warning']} |
| Same + caregiver note "breathing difficulty, tired" | {c['with_breathing_note_first_warning']} |
| Age 80 with COPD | {c['copd_age_80_first_warning']} |
"""


if __name__ == "__main__":
    res = evaluate()
    out_dir = Path(__file__).parent
    (out_dir / "results.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    (ROOT / "docs/evaluation.md").write_text(to_markdown(res), encoding="utf-8")
    print(json.dumps(res, indent=2))
