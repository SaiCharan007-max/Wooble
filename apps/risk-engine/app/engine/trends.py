"""Temporal trend analysis: how each vital has moved over the recent window.

For each vital we compare the average of the first three and last three readings in the
window (robust to single noisy samples), compute the rate of change, and measure how
consistent the movement is (R^2 of a least-squares line).
"""
from .vitals import LABELS, UNITS

TREND_WINDOW = 20      # most recent readings considered
MIN_READINGS = 6

# Minimum change across the window that counts as a meaningful trend.
# direction: +1 = rising is adverse, -1 = falling is adverse.
TREND_RULES = {
    "spo2": {"threshold": 2.0, "adverse": -1},
    "heart_rate": {"threshold": 8.0, "adverse": +1},
    "respiratory_rate": {"threshold": 3.0, "adverse": +1},
    "temperature": {"threshold": 0.4, "adverse": +1},
    "systolic_bp": {"threshold": 10.0, "adverse": -1},
}


def _r2(ys):
    n = len(ys)
    xs = list(range(n))
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return 0.0
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return (sxy * sxy) / (sxx * syy)


def human_duration(seconds):
    seconds = max(1, int(seconds))
    if seconds < 90:
        return f"{seconds} s"
    if seconds < 5400:
        return f"{round(seconds / 60)} min"
    return f"{seconds / 3600:.1f} h"


def analyse(readings):
    """`readings` sorted oldest -> newest. Returns a list of trend dicts."""
    window = readings[-TREND_WINDOW:]
    if len(window) < MIN_READINGS:
        return [], None
    span_s = (window[-1].timestamp - window[0].timestamp).total_seconds()
    duration = human_duration(span_s)
    trends = []
    for param, rule in TREND_RULES.items():
        values = [getattr(r, param) for r in window if getattr(r, param) is not None]
        if len(values) < MIN_READINGS:
            continue
        start = sum(values[:3]) / 3
        end = sum(values[-3:]) / 3
        delta = end - start
        if abs(delta) < rule["threshold"]:
            continue
        adverse = (delta > 0) == (rule["adverse"] > 0)
        verb = "increased" if delta > 0 else "decreased"
        fmt = (lambda v: f"{v:.1f}") if param == "temperature" else (lambda v: f"{round(v)}")
        per_min = delta / (span_s / 60) if span_s > 0 else 0.0
        trends.append({
            "param": param,
            "label": LABELS[param],
            "start": start,
            "end": end,
            "delta": delta,
            "adverse": adverse,
            "severe": abs(delta) >= 2 * rule["threshold"],
            "consistency": round(_r2(values), 2),
            "rate_per_min": per_min,
            "duration": duration,
            "text": f"{LABELS[param]} {verb} from {fmt(start)}{UNITS[param]} to {fmt(end)}{UNITS[param]}",
            "short": f"{LABELS[param]} {'rising' if delta > 0 else 'declining'} "
                     f"({fmt(start)} → {fmt(end)}{UNITS[param]})",
        })
    return trends, duration
