"""NEWS2 - National Early Warning Score 2 (Royal College of Physicians, 2017).

NEWS2 is the track-and-trigger score used on UK hospital wards. We use it as the
explainable, clinically-validated backbone of the risk engine: every point it adds
can be traced back to one vital sign and one threshold.

Our 3-level mapping of the official NEWS2 clinical-response bands:
    0-4, no single parameter scoring 3  -> LOW
    5-6, OR any single parameter = 3     -> MEDIUM   (NEWS2 "low-medium"/"medium": urgent review)
    7+                                   -> HIGH     (NEWS2 "high": emergency response)
"""

PARAMS = ("rr", "spo2", "sbp", "hr", "temp", "consciousness")

LABELS = {
    "rr": "Respiratory rate",
    "spo2": "SpO2",
    "oxygen": "Supplemental O2",
    "sbp": "Systolic BP",
    "hr": "Heart rate",
    "temp": "Temperature",
    "consciousness": "Consciousness",
}

UNITS = {"rr": "/min", "spo2": "%", "sbp": " mmHg", "hr": " bpm", "temp": " °C", "consciousness": ""}

LEVEL_RANK = {"unknown": -1, "low": 0, "medium": 1, "high": 2}


def score_rr(v):
    v = round(v)
    if v <= 8:
        return 3
    if v <= 11:
        return 1
    if v <= 20:
        return 0
    if v <= 24:
        return 2
    return 3


def score_spo2(v, scale=1, on_oxygen=False):
    """Scale 1 is the default. Scale 2 is for patients with hypercapnic respiratory
    failure (e.g. COPD) whose prescribed target saturation is 88-92%."""
    v = round(v)
    if scale == 2:
        if v >= 93 and on_oxygen:
            if v <= 94:
                return 1
            if v <= 96:
                return 2
            return 3
        if v >= 88:
            return 0
        if v >= 86:
            return 1
        if v >= 84:
            return 2
        return 3
    if v <= 91:
        return 3
    if v <= 93:
        return 2
    if v <= 95:
        return 1
    return 0


def score_sbp(v):
    v = round(v)
    if v <= 90:
        return 3
    if v <= 100:
        return 2
    if v <= 110:
        return 1
    if v <= 219:
        return 0
    return 3


def score_hr(v):
    v = round(v)
    if v <= 40:
        return 3
    if v <= 50:
        return 1
    if v <= 90:
        return 0
    if v <= 110:
        return 1
    if v <= 130:
        return 2
    return 3


def score_temp(v):
    v = round(v, 1)
    if v <= 35.0:
        return 3
    if v <= 36.0:
        return 1
    if v <= 38.0:
        return 0
    if v <= 39.0:
        return 1
    return 2


def score_consciousness(v):
    # ACVPU: Alert scores 0; new Confusion, responds to Voice/Pain, or Unresponsive score 3.
    return 0 if (v or "A").upper() == "A" else 3


def level_for(total, any_three):
    if total >= 7:
        return "high"
    if total >= 5 or any_three:
        return "medium"
    return "low"


def compute(vitals, spo2_scale=1, on_oxygen=False):
    """Score a dict of vitals. Missing values are reported, never silently treated as normal."""
    components = []
    missing = []

    def add(param, value, points):
        components.append({
            "param": param,
            "label": LABELS[param],
            "value": value,
            "points": points,
        })

    scorers = {
        "rr": score_rr,
        "sbp": score_sbp,
        "hr": score_hr,
        "temp": score_temp,
    }
    for param in PARAMS:
        value = vitals.get(param)
        if value is None:
            if param != "consciousness":
                missing.append(param)
            continue
        if param == "spo2":
            add(param, value, score_spo2(value, spo2_scale, on_oxygen))
        elif param == "consciousness":
            add(param, value, score_consciousness(value))
        else:
            add(param, value, scorers[param](value))

    if on_oxygen:
        add("oxygen", "yes", 2)

    total = sum(c["points"] for c in components)
    any_three = any(c["points"] == 3 for c in components)
    return {
        "total": total,
        "any_three": any_three,
        "level": level_for(total, any_three),
        "components": components,
        "missing": missing,
        "spo2_scale": spo2_scale,
    }


def describe(component):
    """Human-readable reason, e.g. 'Respiratory rate 24/min (+2)'."""
    p = component["param"]
    if p == "oxygen":
        return "On supplemental oxygen (+2)"
    if p == "consciousness":
        return f"Consciousness '{component['value']}' - not alert (+3)"
    value = component["value"]
    shown = f"{value:.1f}" if p == "temp" else f"{round(value)}"
    return f"{LABELS[p]} {shown}{UNITS[p]} (+{component['points']})"
