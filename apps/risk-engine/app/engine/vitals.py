"""Current-value scoring, modelled on NEWS2-style early-warning thresholds.

Each vital earns 0-3 points depending on how far it is from the adult reference range.
These are well-known, transparent clinical-style thresholds - not a diagnosis.
"""

LABELS = {
    "heart_rate": "Heart rate",
    "spo2": "SpO2",
    "temperature": "Temperature",
    "respiratory_rate": "Respiratory rate",
    "systolic_bp": "Systolic BP",
    "diastolic_bp": "Diastolic BP",
}
UNITS = {"heart_rate": " bpm", "spo2": "%", "temperature": " °C", "respiratory_rate": " breaths/min",
         "systolic_bp": " mmHg", "diastolic_bp": " mmHg"}
REFERENCE = {"heart_rate": (51, 90), "spo2": (96, 100), "temperature": (36.1, 38.0),
             "respiratory_rate": (12, 20), "systolic_bp": (111, 219)}

SCORED = ("respiratory_rate", "spo2", "systolic_bp", "heart_rate", "temperature")


def points(param, v):
    if v is None:
        return 0
    if param == "respiratory_rate":
        v = round(v)
        return 3 if v <= 8 else 1 if v <= 11 else 0 if v <= 20 else 2 if v <= 24 else 3
    if param == "spo2":
        v = round(v)
        return 3 if v <= 91 else 2 if v <= 93 else 1 if v <= 95 else 0
    if param == "systolic_bp":
        v = round(v)
        return 3 if v <= 90 else 2 if v <= 100 else 1 if v <= 110 else 0 if v <= 219 else 3
    if param == "heart_rate":
        v = round(v)
        return 3 if v <= 40 else 1 if v <= 50 else 0 if v <= 90 else 1 if v <= 110 else 2 if v <= 130 else 3
    if param == "temperature":
        v = round(v, 1)
        return 3 if v <= 35.0 else 1 if v <= 36.0 else 0 if v <= 38.0 else 1 if v <= 39.0 else 2
    return 0


# Values at which a single vital alone means HIGH risk (deterministic safety floor).
CRITICAL = {
    "spo2": lambda v: v <= 88,
    "respiratory_rate": lambda v: v >= 30 or v <= 8,
    "heart_rate": lambda v: v >= 131 or v <= 40,
    "systolic_bp": lambda v: v <= 90,
    "temperature": lambda v: v >= 39.5 or v <= 35.0,
}


def fmt(param, v):
    if v is None:
        return "n/a"
    return f"{v:.1f}{UNITS[param]}" if param == "temperature" else f"{round(v)}{UNITS[param]}"


def describe_abnormal(param, v):
    lo, hi = REFERENCE[param]
    direction = "above" if v > hi else "below"
    return f"{LABELS[param]} {fmt(param, v)} is {direction} the reference range ({lo}-{hi})"
