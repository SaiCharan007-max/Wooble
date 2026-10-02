from datetime import datetime, timedelta

from homeward import news2
from homeward.engine import assess
from homeward.notes import analyse_note

NORMAL = dict(hr=75, spo2=97, temp=36.8, rr=16, sbp=125, consciousness="A")
PATIENT = {"id": "T1", "spo2_scale": 1}


def series(fn, hours=8, step_min=10):
    start = datetime(2026, 1, 1)
    out = []
    for i in range(int(hours * 60 / step_min) + 1):
        h = i * step_min / 60
        out.append({"ts": (start + timedelta(hours=h)).isoformat(timespec="seconds"), **fn(h)})
    return out


# ---------------------------------------------------------------- NEWS2
def test_news2_normal_is_low():
    s = news2.compute(NORMAL)
    assert s["total"] == 0 and s["level"] == "low"


def test_news2_high():
    s = news2.compute(dict(hr=135, spo2=89, temp=39.5, rr=28, sbp=88, consciousness="C"))
    assert s["total"] >= 7 and s["level"] == "high"


def test_single_parameter_three_is_medium():
    s = news2.compute({**NORMAL, "rr": 26})
    assert s["total"] == 3 and s["level"] == "medium"


def test_spo2_scale_2_for_copd():
    assert news2.score_spo2(89, scale=1) == 3
    assert news2.score_spo2(89, scale=2) == 0
    assert news2.score_spo2(97, scale=2, on_oxygen=True) == 3


def test_missing_values_are_reported():
    s = news2.compute({"hr": 80})
    assert set(s["missing"]) == {"rr", "spo2", "sbp", "temp"}


# ---------------------------------------------------------------- notes
def test_note_detects_concerns():
    a = analyse_note("Seems confused tonight and refused dinner, breathing fast.")
    cats = {c["category"] for c in a["concerns"]}
    assert {"confusion", "poor intake", "breathlessness"} <= cats


def test_note_negation():
    a = analyse_note("No chest pain, denies fever. Did not fall.")
    assert not a["concerns"]
    assert {n["category"] for n in a["negated"]} >= {"chest pain", "fever / chills", "fall"}


def test_note_red_flag():
    assert "chest pain" in analyse_note("Complaining of chest pain since morning")["red_flags"]


def test_note_fell_asleep_is_not_a_fall():
    assert not analyse_note("He fell asleep after lunch")["concerns"]


def test_multilingual_notes():
    assert analyse_note("पिताजी को बुखार है")["concerns"][0]["category"] == "fever / chills"
    assert analyse_note("నాన్నకు జ్వరం ఉంది")["language"] == "te"


# ---------------------------------------------------------------- engine safety rules
def note(text):
    return {"analysis": analyse_note(text)}


def test_reassuring_note_cannot_lower_vitals_risk():
    readings = series(lambda h: dict(hr=135, spo2=89, temp=39.5, rr=28, sbp=88, consciousness="A"), hours=2)
    a = assess(PATIENT, readings, [note("Comfortable, eating well, in good spirits")])
    assert a["level"] == "high"


def test_red_flag_note_makes_high():
    readings = series(lambda h: NORMAL, hours=2)
    a = assess(PATIENT, readings, [note("He has chest pain and is sweating")])
    assert a["level"] == "high"
    assert any("red-flag" in r for r in a["reasons"])


def test_worrying_note_raises_one_level():
    readings = series(lambda h: NORMAL, hours=2)
    a = assess(PATIENT, readings, [note("Seems confused and drowsy today")])
    assert a["level"] == "medium"


def test_stable_patient_low_no_prediction():
    readings = series(lambda h: NORMAL)
    a = assess(PATIENT, readings)
    assert a["level"] == "low" and a["prediction"]["hours_to_high"] is None


def test_early_warning_before_vitals_are_abnormal():
    """Sepsis-like drift: vitals still score LOW today, but the trend predicts HIGH within 48h."""
    def drift(h):
        return dict(hr=78 + 1.3 * h, spo2=97, temp=36.8 + 0.07 * h, rr=16 + 0.32 * h,
                    sbp=128 - 1.0 * h, consciousness="A")
    readings = series(drift, hours=7)
    a = assess(PATIENT, readings)
    assert a["vitals_level"] == "low"
    assert a["prediction"]["hours_to_high"] is not None and a["prediction"]["hours_to_high"] <= 48
    assert a["level"] == "medium" and a["early_warning"]


def test_deescalation_requires_sustained_improvement():
    high = assess(PATIENT, series(lambda h: dict(hr=135, spo2=89, temp=39.5, rr=28, sbp=88, consciousness="A"), 2))
    normal = series(lambda h: NORMAL, 2)
    prev = high
    levels = []
    for _ in range(3):
        prev = assess(PATIENT, normal, previous=prev)
        levels.append(prev["level"])
    assert levels == ["high", "high", "low"]
