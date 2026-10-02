"""Prototype hybrid risk model.

Transparent, deterministic scoring (0-100) built from six evidence sources:
  A. current vital values (early-warning style points)
  B. vital trends over the recent window
  C. several signals deteriorating together
  D. patient context (age, relevant conditions)
  E. structured signals extracted from caregiver notes
  F. recovering / stabilising trends (reduce risk)
plus deterministic safety floors that nothing else can lower.

`RiskModel` is the interface; register a trained ML model under a new name and select it
with the RISK_MODEL environment variable - the API contract stays the same.
"""
from statistics import median

from . import trends as trend_mod
from . import vitals as v

LEVEL_THRESHOLDS = (("HIGH", 65), ("MEDIUM", 35), ("LOW", 0))
# Order in which trends are explained (most clinically telling first).
PRIORITY = {"spo2": 0, "respiratory_rate": 1, "heart_rate": 2, "temperature": 3, "systolic_bp": 4}
VELOCITY_WINDOW_S = 60
MIN_VELOCITY_AGE_S = 20  # a shorter baseline would make the velocity meaningless

NOTE_WEIGHTS = {
    "breathing_difficulty": 10, "chest_discomfort": 12, "confusion": 10,
    "dizziness": 5, "fatigue": 4, "reduced_appetite": 3, "pain": 3,
}
RED_FLAG_SIGNALS = {"chest_discomfort", "confusion"}  # always require caregiver attention
NOTE_CAP = 20
CONTEXT_CAP = 12

ACTIONS = {
    "LOW": "Continue routine monitoring and the usual care plan.",
    "MEDIUM": "Requires caregiver attention: check on the patient within 30 minutes, re-check vitals and "
              "follow the care plan. Contact clinical support if signs persist.",
    "HIGH": "Requires immediate caregiver attention: check the patient now and contact clinical support or "
            "emergency services as set out in the care plan.",
}
PROJECTION_DISCLAIMER = "Prototype trend projection based on recent data - not a clinical prediction."


def lc_first(text):
    """Lower-case the first letter for mid-sentence use, keeping acronyms like SpO2 intact."""
    return text if text[:2].isupper() or text.startswith("SpO2") else text[0].lower() + text[1:]


def level_for(score):
    for name, threshold in LEVEL_THRESHOLDS:
        if score >= threshold:
            return name
    return "LOW"


class RiskModel:
    name = "base"

    def assess(self, req):  # pragma: no cover - interface
        raise NotImplementedError


class PrototypeHybridModel(RiskModel):
    name = "prototype-hybrid-v1"

    def assess(self, req):
        readings = sorted(req.readings, key=lambda r: r.timestamp)
        factors, reasons = [], []
        floor, floor_reason = 0, None

        def add(factor, category, pts, detail):
            factors.append({"factor": factor, "category": category, "points": int(round(pts)), "detail": detail})

        # ---- A. current values (median of last 3 readings to ignore a single noisy sample)
        recent = readings[-3:]
        current = {}
        for p in v.SCORED + ("diastolic_bp",):
            vals = [getattr(r, p) for r in recent if getattr(r, p) is not None]
            current[p] = median(vals) if vals else None
        missing = [p for p in v.SCORED if current[p] is None]
        total_points = 0
        abnormal = []
        for p in v.SCORED:
            pts = v.points(p, current[p])
            total_points += pts
            if pts:
                abnormal.append((p, pts))
                add(f"{v.LABELS[p]} {v.fmt(p, current[p])}", "VITAL_VALUE", pts * 5, v.describe_abnormal(p, current[p]))
        score = total_points * 5

        # ---- Safety floors (deterministic, cannot be reduced by any other factor)
        critical = [p for p in v.SCORED if current[p] is not None and v.CRITICAL[p](current[p])]
        if critical:
            floor = 70
            floor_reason = "Critical value: " + ", ".join(f"{v.LABELS[p]} {v.fmt(p, current[p])}" for p in critical)
        elif total_points >= 7:
            floor = 65
            floor_reason = f"Several vitals outside reference ranges at once (early-warning points {total_points})"
        elif any(pts == 3 for _, pts in abnormal):
            floor = 40
            floor_reason = "One vital sign is far outside its reference range"

        # ---- B. trends
        trend_list, duration = trend_mod.analyse(readings)
        adverse = [t for t in trend_list if t["adverse"]]
        improving = [t for t in trend_list if not t["adverse"]]
        for t in adverse:
            pts = 10 if t["severe"] else 6
            score += pts
            add(t["short"], "TREND", pts, f"{t['text']} over the last {t['duration']} "
                                         f"(consistency {t['consistency']:.2f})")

        # ---- C. multiple signals deteriorating together
        if len(adverse) >= 3:
            score += 15
            add("Multiple signals deteriorating together", "COMBINED", 15,
                f"{len(adverse)} vital signs are worsening at the same time")
        elif len(adverse) == 2:
            score += 8
            add("Two signals deteriorating together", "COMBINED", 8, "Two vital signs are worsening at the same time")

        # ---- D. patient context
        ctx = 0
        age = req.patient.age
        if age >= 80:
            ctx += 6
            add(f"Age {age}", "CONTEXT", 6, "Older age reduces physiological reserve")
        elif age >= 65:
            ctx += 3
            add(f"Age {age}", "CONTEXT", 3, "Older age reduces physiological reserve")
        cats = {c.risk_category for c in req.patient.conditions}
        resp_involved = any(p in ("spo2", "respiratory_rate") for p, _ in abnormal) or \
            any(t["param"] in ("spo2", "respiratory_rate") for t in adverse)
        card_involved = any(p in ("heart_rate", "systolic_bp") for p, _ in abnormal) or \
            any(t["param"] in ("heart_rate", "systolic_bp") for t in adverse)
        if "RESPIRATORY" in cats and resp_involved:
            names = ", ".join(c.condition for c in req.patient.conditions if c.risk_category == "RESPIRATORY")
            ctx += 6
            add(f"Respiratory history ({names})", "CONTEXT", 6, "Breathing-related changes matter more for this patient")
        if "CARDIAC" in cats and card_involved:
            names = ", ".join(c.condition for c in req.patient.conditions if c.risk_category == "CARDIAC")
            ctx += 6
            add(f"Cardiac history ({names})", "CONTEXT", 6, "Heart-rate / blood-pressure changes matter more for this patient")
        score += min(ctx, CONTEXT_CAP)

        # ---- D2. medical equipment: an oxygen-dependent patient without oxygen needs attention now
        oxygen_down = any(e.type == "OXYGEN_CONCENTRATOR" and e.status == "FAULT" for e in req.equipment)
        if oxygen_down:
            score += 12
            add("Home oxygen supply interrupted", "CONTEXT", 12, "Oxygen concentrator is not delivering the prescribed flow")
            if floor < 40:
                floor = 40
                floor_reason = "Oxygen-dependent patient without oxygen supply"

        # ---- E. caregiver notes (structured signals only)
        signals = {s.signal for s in req.note_signals if s.signal in NOTE_WEIGHTS}
        note_pts = 0
        for s in sorted(signals, key=lambda s: -NOTE_WEIGHTS[s]):
            note_pts += NOTE_WEIGHTS[s]
            label = s.replace("_", " ")
            add(f"Caregiver reports {label}", "NOTE", NOTE_WEIGHTS[s], "Signal extracted from a recent caregiver note")
        if "breathing_difficulty" in signals and resp_involved:
            note_pts += 4
            add("Note corroborates vital signs", "NOTE", 4, "Reported breathing difficulty matches SpO2 / respiratory changes")
        score += min(note_pts, NOTE_CAP + 4)
        red_flags = signals & RED_FLAG_SIGNALS
        if red_flags and floor < 35:
            floor = 35
            floor_reason = "Caregiver reported " + " and ".join(s.replace("_", " ") for s in sorted(red_flags))

        # ---- F. recovery / stabilisation
        if len(improving) >= 2 and not adverse:
            score -= 10
            add("Vitals improving", "RECOVERY", -10,
                "; ".join(t["text"] for t in improving) + f" over the last {duration}")

        # ---- combine
        score = max(0, min(100, score))
        if floor and score < floor:
            add("Safety threshold", "SAFETY_FLOOR", floor - score, floor_reason)
            score = floor
        elif critical:  # always flag critical values, even when the score is already above the floor
            add("Safety threshold", "SAFETY_FLOOR", 0, floor_reason)
        level = level_for(score)

        # ---- reasons ("why" bullets)
        for t in sorted(adverse, key=lambda t: PRIORITY[t["param"]]):
            reasons.append(t["short"])
        for p, pts in sorted(abnormal, key=lambda x: -x[1]):
            if not any(t["param"] == p for t in adverse):
                reasons.append(v.describe_abnormal(p, current[p]))
        if oxygen_down:
            reasons.append("Home oxygen concentrator is not delivering oxygen")
        for s in sorted(signals, key=lambda s: -NOTE_WEIGHTS[s]):
            reasons.append(f"Caregiver reports {s.replace('_', ' ')}")
        if len(improving) >= 2 and not adverse:
            reasons.append("Vitals improving: " + ", ".join(t["short"] for t in improving))
        if floor_reason and (score == floor or critical):
            reasons.append(floor_reason)
        if missing:
            reasons.append("Missing data: " + ", ".join(v.LABELS[p] for p in missing))
        if not reasons:
            reasons.append("All vital signs within reference ranges and stable")

        explanation = self._explain(level, adverse, abnormal, current, signals, improving, duration)
        if oxygen_down:
            if "all vital signs are within reference ranges" in explanation:
                explanation = (f"{level} RISK because the home oxygen concentrator is not delivering oxygen "
                               "(vital signs are still within reference ranges).")
            else:
                explanation = explanation.rstrip(".") + "; the home oxygen concentrator is not delivering oxygen."
        prediction = self._project(req, readings, score, level)
        confidence = self._confidence(readings, missing, adverse)

        return {
            "risk_level": level,
            "risk_score": int(score),
            "confidence": confidence,
            "explanation": explanation,
            "reasons": reasons,
            "contributing_factors": factors,
            "prediction_window": "24-48 hours",
            "prediction": prediction,
            "recommended_action": ACTIONS[level],
            "engine_version": self.name,
        }

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _explain(level, adverse, abnormal, current, signals, improving, duration):
        parts = []
        if adverse:
            ordered = sorted(adverse, key=lambda t: PRIORITY[t["param"]])
            first = ordered[0]["text"] + f" over the last {duration}"
            rest = [lc_first(t["text"]) for t in ordered[1:3]]
            parts.append(first + (" while " + " and ".join(rest) if rest else ""))
        elif abnormal:
            p, _ = max(abnormal, key=lambda x: x[1])
            parts.append(v.describe_abnormal(p, current[p]))
        if signals:
            parts.append("caregiver reports " + ", ".join(s.replace("_", " ") for s in sorted(signals)))
        if not parts:
            if len(improving) >= 2:
                return f"{level} RISK: vital signs are improving and within or returning to reference ranges."
            return f"{level} RISK: all vital signs are within reference ranges with no concerning trend."
        sentence = "; ".join(parts)
        if level == "LOW":
            return f"LOW RISK: {lc_first(sentence)}, but overall risk signals remain low."
        return f"{level} RISK because {lc_first(sentence)}."

    @staticmethod
    def _project(req, readings, score, level):
        now = readings[-1].timestamp
        history = sorted(req.history, key=lambda h: h.timestamp)
        previous = None
        for h in history:  # the assessment closest to VELOCITY_WINDOW_S ago
            if (now - h.timestamp).total_seconds() >= VELOCITY_WINDOW_S:
                previous = h
        if previous is None:  # not enough history yet: use the oldest point that is at least MIN_VELOCITY_AGE_S old
            older = [h for h in history if (now - h.timestamp).total_seconds() >= MIN_VELOCITY_AGE_S]
            previous = older[0] if older else None
        prev_score = previous.risk_score if previous else None
        velocity = score - prev_score if prev_score is not None else 0
        window = trend_mod.human_duration((now - previous.timestamp).total_seconds()) if previous else "n/a"
        trend = "INCREASING" if velocity >= 5 else "DECREASING" if velocity <= -5 else "STABLE"
        projected = max(0, min(100, score + velocity))
        projected_level = level_for(projected)

        if trend == "INCREASING" and (projected >= 65 or level == "HIGH"):
            statement = "Elevated deterioration risk over the next 24-48 hours if the current trend persists."
        elif trend == "INCREASING":
            statement = "Risk is rising; possible deterioration over the next 24-48 hours if the trend continues."
        elif trend == "DECREASING":
            statement = "Risk signals are improving; continue observation to confirm recovery."
        elif level == "HIGH":
            statement = "Risk remains high and requires caregiver attention now."
        elif level == "MEDIUM":
            statement = "Risk is elevated but stable; continue close observation over the next 24-48 hours."
        else:
            statement = "No sustained deterioration pattern detected; continue routine monitoring."

        return {
            "window": "24-48 hours",
            "current_risk": int(score),
            "previous_risk": prev_score,
            "velocity": int(velocity),
            "velocity_window": window,
            "trend": trend,
            "projected_risk": int(projected),
            "projected_level": projected_level,
            "statement": statement,
            "disclaimer": PROJECTION_DISCLAIMER,
        }

    @staticmethod
    def _confidence(readings, missing, adverse):
        c = 0.5
        if len(readings) >= 10:
            c += 0.2
        if len(readings) >= 20:
            c += 0.1
        c -= 0.15 * len(missing)
        if adverse and sum(t["consistency"] for t in adverse) / len(adverse) >= 0.6:
            c += 0.1
        return round(max(0.2, min(0.95, c)), 2)


MODELS = {PrototypeHybridModel.name: PrototypeHybridModel}


def get_model(name=None):
    return MODELS.get(name or PrototypeHybridModel.name, PrototypeHybridModel)()
