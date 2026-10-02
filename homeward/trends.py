"""Trend analysis and deterioration prediction (24-48h look-ahead).

Approach (deliberately simple and explainable):
  1. Take the last TREND_WINDOW_HOURS of readings.
  2. Fit a least-squares line to each vital sign (value vs. hours).
  3. Keep only trends that are statistically meaningful (R^2 and minimum slope).
  4. Project each vital forward with a *damped* trend - real physiology rarely keeps
     changing linearly, so the change slows down the further we look ahead.
  5. Run the projected vitals through NEWS2 hour by hour and report when the patient is
     expected to cross the MEDIUM and HIGH thresholds.

Everything the prediction says can be traced to "vital X is changing by Y per hour".
"""
import math
from datetime import datetime

from . import config, news2

TREND_PARAMS = ("hr", "spo2", "temp", "rr", "sbp")

# A trend smaller than this per hour is treated as noise.
MIN_SLOPE = {"hr": 0.5, "spo2": 0.15, "temp": 0.03, "rr": 0.2, "sbp": 0.6}
MIN_R2 = 0.3
# Projections are clamped to physiologically plausible ranges.
CLAMP = {"hr": (30, 180), "spo2": (70, 100), "temp": (34.0, 41.5), "rr": (6, 40), "sbp": (70, 220)}
NAMES = {"hr": "Heart rate", "spo2": "SpO2", "temp": "Temperature", "rr": "Respiratory rate", "sbp": "Systolic BP"}
UNITS = {"hr": "bpm", "spo2": "%", "temp": "°C", "rr": "breaths/min", "sbp": "mmHg"}
DAMPING_HOURS = 24.0


def parse_ts(ts):
    return ts if isinstance(ts, datetime) else datetime.fromisoformat(ts)


def linear_fit(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0, my, 0.0
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    intercept = my - slope * mx
    ss_tot = sum((y - my) ** 2 for y in ys)
    ss_res = sum((y - (intercept + slope * x)) ** 2 for x, y in zip(xs, ys))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return slope, intercept, max(0.0, r2)


def damped(hours):
    """Effective hours of change after `hours` with a damped trend (log damping)."""
    return DAMPING_HOURS * math.log1p(hours / DAMPING_HOURS)


def analyse(readings, spo2_scale=1, on_oxygen=False, consciousness="A"):
    """`readings` are dicts with 'ts' and vital keys, sorted oldest -> newest."""
    if len(readings) < 2:
        return {"available": False, "reason": "Not enough history yet"}

    latest = parse_ts(readings[-1]["ts"])
    window = [r for r in readings
              if (latest - parse_ts(r["ts"])).total_seconds() / 3600 <= config.TREND_WINDOW_HOURS]
    span_h = (latest - parse_ts(window[0]["ts"])).total_seconds() / 3600
    if len(window) < 6 or span_h < 1.0:
        return {"available": False, "reason": "Need at least 1 hour of readings to judge trends"}

    fits = {}
    for p in TREND_PARAMS:
        pts = [(-(latest - parse_ts(r["ts"])).total_seconds() / 3600, r[p])
               for r in window if r.get(p) is not None]
        if len(pts) < 6:
            continue
        xs, ys = zip(*pts)
        slope, intercept, r2 = linear_fit(xs, ys)
        significant = r2 >= MIN_R2 and abs(slope) >= MIN_SLOPE[p]
        fits[p] = {"slope": slope, "now": intercept, "r2": r2, "significant": significant}

    def project(hours):
        out = {"consciousness": consciousness}
        for p, f in fits.items():
            value = f["now"] + (f["slope"] * damped(hours) if f["significant"] else 0.0)
            lo, hi = CLAMP[p]
            out[p] = min(hi, max(lo, value))
        return out

    now_score = news2.compute(project(0), spo2_scale, on_oxygen)
    now_points = {c["param"]: c["points"] for c in now_score["components"]}

    hours_to = {"medium": None, "high": None}
    timeline = []
    for h in range(1, config.PREDICTION_HORIZON_HOURS + 1):
        s = news2.compute(project(h), spo2_scale, on_oxygen)
        if h in (6, 12, 24, 36, 48):
            timeline.append({"hours": h, "news2": s["total"], "level": s["level"]})
        for lvl in ("medium", "high"):
            if hours_to[lvl] is None and news2.LEVEL_RANK[s["level"]] >= news2.LEVEL_RANK[lvl]:
                hours_to[lvl] = h

    at24 = news2.compute(project(24), spo2_scale, on_oxygen)
    at24_points = {c["param"]: c["points"] for c in at24["components"]}
    at48_points = {c["param"]: c["points"]
                   for c in news2.compute(project(48), spo2_scale, on_oxygen)["components"]}

    trends = []
    for p, f in fits.items():
        if not f["significant"]:
            continue
        worsening = at48_points.get(p, 0) > now_points.get(p, 0)
        direction = "rising" if f["slope"] > 0 else "falling"
        trends.append({
            "param": p,
            "slope_per_hour": round(f["slope"], 3),
            "r2": round(f["r2"], 2),
            "direction": direction,
            "worsening": worsening,
            "text": f"{NAMES[p]} {direction} ~{abs(f['slope']):.2f} {UNITS[p]}/h"
                    + (" (towards abnormal)" if worsening else ""),
        })
    trends.sort(key=lambda t: (not t["worsening"], -t["r2"]))

    worsening = [t for t in trends if t["worsening"]]
    mean_r2 = sum(t["r2"] for t in worsening) / len(worsening) if worsening else 0.0
    confidence = "high" if mean_r2 >= 0.75 else "moderate" if mean_r2 >= 0.5 else "low"

    return {
        "available": True,
        "window_hours": round(span_h, 1),
        "points_used": len(window),
        "trends": trends,
        "worsening_count": len(worsening),
        "hours_to_medium": hours_to["medium"],
        "hours_to_high": hours_to["high"],
        "predicted_level_24h": at24["level"],
        "predicted_news2_24h": at24["total"],
        "timeline": timeline,
        "confidence": confidence,
        "projected_24h": {k: (round(v, 1) if isinstance(v, float) else v)
                          for k, v in project(24).items()},
    }
