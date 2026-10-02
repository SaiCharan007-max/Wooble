"""Risk engine: combines vitals (NEWS2), trends (prediction) and caregiver notes into
one LOW / MEDIUM / HIGH decision with a short, human-readable reason.

Clinical-safety rules (enforced here and covered by tests):
  1. The vitals-based NEWS2 level is a floor. Notes and predictions can only RAISE
     risk, never lower it - a reassuring note cannot hide abnormal vitals.
  2. A red-flag phrase in a caregiver note (chest pain, unresponsive, ...) means HIGH.
  3. A worrying note raises risk by at most one level.
  4. A credible prediction of HIGH risk within the horizon raises a LOW patient to
     MEDIUM ("early warning"), so someone looks before the patient gets sick.
  5. Missing or implausible sensor data is reported, never silently treated as normal.
  6. The output is decision support for caregivers, not a diagnosis.
"""
from . import news2, trends

LEVELS = ["low", "medium", "high"]
DEESCALATE_AFTER = 3  # consecutive improved assessments needed before risk is lowered

RECOMMENDED_ACTIONS = {
    "low": "Continue routine monitoring. Encourage fluids, rest and medication as prescribed.",
    "medium": "Caregiver should check on the patient within 30 minutes and contact the nurse/doctor for an urgent review.",
    "high": "Call the doctor or emergency services (108) now. Stay with the patient and keep them upright if breathless.",
    "unknown": "No recent data - check that the sensors are worn and the home hub is online.",
}


def bump(level, steps=1):
    return LEVELS[min(len(LEVELS) - 1, LEVELS.index(level) + steps)]


def raise_to(level, target):
    return target if news2.LEVEL_RANK[target] > news2.LEVEL_RANK[level] else level


def latest_values(readings):
    """Most recent valid value of each vital (looks back a few readings to skip artifacts)."""
    values = {}
    for r in reversed(readings[-5:]):
        for p in news2.PARAMS:
            if p not in values and r.get(p) is not None:
                values[p] = r[p]
    return values


def combine_notes(notes):
    concerns, red_flags, negated, score = {}, [], [], 0
    for n in notes:
        a = n["analysis"]
        score += a["score"]
        for c in a["concerns"]:
            concerns.setdefault(c["category"], c)
        red_flags += [f for f in a["red_flags"] if f not in red_flags]
        negated += a["negated"]
    return {"concerns": list(concerns.values()), "red_flags": red_flags,
            "negated": negated, "score": score, "count": len(notes)}


def assess(patient, readings, notes=(), device_online=True, previous=None):
    """`previous` is the last assessment; used for hysteresis so an early warning does not
    flicker on and off with sensor noise."""
    readings = sorted(readings, key=lambda r: r["ts"])
    if not readings:
        return {"level": "unknown", "news2": None, "summary": "No readings received yet",
                "reasons": ["No readings received yet"], "action": RECOMMENDED_ACTIONS["unknown"]}

    latest = readings[-1]
    on_oxygen = bool(latest.get("on_oxygen"))
    scale = patient.get("spo2_scale", 1) or 1
    current = latest_values(readings)
    score = news2.compute(current, spo2_scale=scale, on_oxygen=on_oxygen)
    prediction = trends.analyse(readings, spo2_scale=scale, on_oxygen=on_oxygen,
                                consciousness=current.get("consciousness", "A"))
    note_info = combine_notes(notes)

    level = score["level"]
    vitals_level = level
    reasons, drivers = [], []

    # 1. Vitals (NEWS2)
    abnormal = sorted([c for c in score["components"] if c["points"] > 0], key=lambda c: -c["points"])
    if abnormal:
        reasons.append(f"NEWS2 score {score['total']}: " + ", ".join(news2.describe(c) for c in abnormal))
        drivers.append(f"NEWS2 {score['total']} ({', '.join(news2.describe(c) for c in abnormal[:3])})")
    else:
        reasons.append(f"NEWS2 score {score['total']}: all vital signs within normal range")
    if score["any_three"] and score["total"] < 5:
        reasons.append("A single vital sign is severely abnormal (scores 3) - NEWS2 requires an urgent review")

    # 2. Caregiver notes
    if note_info["red_flags"]:
        level = "high"
        flags = ", ".join(note_info["red_flags"])
        reasons.append(f"Caregiver note reports a red-flag symptom: {flags} - treated as HIGH regardless of vitals")
        drivers.append(f"note red flag: {flags}")
    elif note_info["score"] >= 2:
        new_level = bump(level)
        cats = ", ".join(c["category"] for c in note_info["concerns"])
        reasons.append(f"Caregiver notes mention {cats} - risk raised from {level.upper()} to {new_level.upper()}")
        drivers.append(f"notes: {cats}")
        level = new_level
    elif note_info["concerns"]:
        cats = ", ".join(c["category"] for c in note_info["concerns"])
        reasons.append(f"Caregiver notes mention {cats} (minor, monitored but not escalated)")
    if note_info["negated"]:
        neg = ", ".join(sorted({n["category"] for n in note_info["negated"]}))
        reasons.append(f"Notes explicitly rule out: {neg}")

    # 3. Prediction (24-48h early warning)
    early_warning = False
    if prediction.get("available"):
        worsening = [t["text"] for t in prediction["trends"] if t["worsening"]]
        if worsening:
            reasons.append("Trends: " + "; ".join(worsening))
        h_high = prediction["hours_to_high"]
        credible = prediction["worsening_count"] >= 2 and prediction["confidence"] != "low"
        # Hysteresis: once raised, an early warning stays while any adverse trend persists.
        if previous and previous.get("early_warning"):
            credible = credible or prediction["worsening_count"] >= 1
        if h_high and credible:
            reasons.append(f"Projection: NEWS2 likely to reach HIGH in ~{h_high}h "
                           f"(confidence {prediction['confidence']})")
            if level == "low":
                level = "medium"
                early_warning = True
                drivers.insert(0, f"EARLY WARNING: predicted HIGH risk in ~{h_high}h ({', '.join(worsening[:2])})")
        elif prediction["hours_to_medium"] and credible and level == "low":
            reasons.append(f"Projection: may reach MEDIUM in ~{prediction['hours_to_medium']}h - keep watching")
    else:
        reasons.append(prediction.get("reason", "Trend analysis unavailable"))

    # 4. Data quality
    quality = []
    if score["missing"]:
        quality.append("missing " + ", ".join(news2.LABELS[m] for m in score["missing"]))
    if latest.get("artifact"):
        quality.append("sensor artifact: " + latest["artifact"])
    if not device_online:
        quality.append("wearable offline - showing last known values")
    if quality:
        reasons.append("Data quality: " + "; ".join(quality))

    # Safety invariant: never below what the vitals alone say.
    level = raise_to(level, vitals_level)

    # De-escalation must be sustained: a single "better" reading near a threshold is often noise.
    improving_streak = 0
    prev_level = (previous or {}).get("level", "unknown")
    if prev_level in LEVELS and news2.LEVEL_RANK[level] < news2.LEVEL_RANK[prev_level]:
        improving_streak = previous.get("improving_streak", 0) + 1
        if improving_streak < DEESCALATE_AFTER:
            reasons.append(f"Holding {prev_level.upper()}: improvement to {level.upper()} must be sustained for "
                           f"{DEESCALATE_AFTER} readings before de-escalating ({improving_streak}/{DEESCALATE_AFTER})")
            level = prev_level
            early_warning = early_warning or previous.get("early_warning", False)
        else:
            improving_streak = 0

    if not drivers:
        drivers.append("vitals normal and stable")
    summary = f"{level.upper()}: " + "; ".join(drivers)

    return {
        "level": level,
        "vitals_level": vitals_level,
        "news2": score["total"],
        "news2_detail": score,
        "early_warning": early_warning,
        "improving_streak": improving_streak,
        "prediction": prediction,
        "notes": note_info,
        "data_quality": quality,
        "reasons": reasons,
        "summary": summary[:300],
        "action": RECOMMENDED_ACTIONS[level],
        "current": current,
        "ts": latest["ts"],
        "disclaimer": "Decision support only - not a diagnosis. Always follow the doctor's advice.",
    }
