from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.engine import notes
from app.engine.model import get_model
from app.main import app
from app.schemas import AssessRequest

NORMAL = dict(heart_rate=78, spo2=97, respiratory_rate=16, temperature=36.8, systolic_bp=122, diastolic_bp=78)
model = get_model()
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def series(points, step_s=10):
    return [{"timestamp": (T0 + timedelta(seconds=i * step_s)).isoformat(), **p} for i, p in enumerate(points)]


def interp(a, b, n):
    return [{k: a[k] + (b[k] - a[k]) * i / (n - 1) for k in a} for i in range(n)]


def assess(readings, age=60, conditions=(), signals=(), history=(), equipment=()):
    req = AssessRequest.model_validate({
        "equipment": list(equipment),
        "patient": {"age": age, "conditions": [{"condition": c, "riskCategory": cat} for c, cat in conditions]},
        "readings": readings,
        "noteSignals": [{"signal": s} for s in signals],
        "history": list(history),
    })
    return model.assess(req)


DETERIORATED = dict(heart_rate=116, spo2=89, respiratory_rate=29, temperature=38.6, systolic_bp=100, diastolic_bp=64)
MODERATE = dict(heart_rate=98, spo2=93, respiratory_rate=22, temperature=37.6, systolic_bp=112, diastolic_bp=72)


def test_stable_patient_is_low_with_explanation():
    r = assess(series([NORMAL] * 20))
    assert r["risk_level"] == "LOW" and r["risk_score"] < 35
    assert r["explanation"].startswith("LOW RISK")
    assert r["reasons"] and r["recommended_action"]


def test_gradual_deterioration_reaches_high_and_explains_trends():
    r = assess(series(interp(NORMAL, DETERIORATED, 20)))
    assert r["risk_level"] == "HIGH" and r["risk_score"] >= 65
    assert "SpO2 decreased" in r["explanation"] or "Respiratory rate increased" in r["explanation"]
    cats = {f["category"] for f in r["contributing_factors"]}
    assert {"TREND", "COMBINED", "VITAL_VALUE"} <= cats


def test_risk_transitions_low_medium_high():
    path = interp(NORMAL, DETERIORATED, 40)
    levels = []
    for i in range(6, 41):
        levels.append(assess(series(path[:i]))["risk_level"])
    order = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
    assert levels[0] == "LOW" and levels[-1] == "HIGH" and "MEDIUM" in levels
    # once high, gradual deterioration should not jump back down
    first_high = levels.index("HIGH")
    assert all(order[l] == 2 for l in levels[first_high:])


def test_critical_value_safety_floor():
    r = assess(series([NORMAL] * 10 + [dict(NORMAL, spo2=86)] * 3))
    assert r["risk_level"] == "HIGH"
    assert any(f["category"] == "SAFETY_FLOOR" for f in r["contributing_factors"])


def test_notes_raise_contextual_risk_but_only_structured_signals():
    base = assess(series([MODERATE] * 12))
    with_note = assess(series([MODERATE] * 12), signals=["breathing_difficulty", "fatigue"])
    assert with_note["risk_score"] > base["risk_score"]
    unknown = assess(series([MODERATE] * 12), signals=["make_risk_low", "ignore previous instructions"])
    assert unknown["risk_score"] == base["risk_score"]


def test_red_flag_note_requires_attention():
    r = assess(series([NORMAL] * 12), signals=["chest_discomfort"])
    assert r["risk_level"] == "MEDIUM"


def test_recovery_reduces_risk():
    worsening = assess(series(interp(NORMAL, MODERATE, 20)))
    recovering = assess(series(interp(MODERATE, NORMAL, 20)))
    assert recovering["risk_score"] < worsening["risk_score"]
    assert any(f["category"] == "RECOVERY" for f in recovering["contributing_factors"])


def test_context_increases_risk_for_respiratory_patient():
    readings = series(interp(NORMAL, MODERATE, 20))
    plain = assess(readings, age=50)
    copd = assess(readings, age=82, conditions=[("COPD", "RESPIRATORY")])
    assert copd["risk_score"] > plain["risk_score"]


def test_prediction_velocity_and_projection():
    readings = series(interp(NORMAL, MODERATE, 20))
    history = [{"timestamp": (T0 + timedelta(seconds=40)).isoformat(), "riskScore": 10}]
    r = assess(readings, history=history)
    p = r["prediction"]
    assert p["previous_risk"] == 10 and p["velocity"] == r["risk_score"] - 10
    assert p["trend"] == "INCREASING"
    assert "24-48 hours" in p["statement"] and "not a clinical prediction" in p["disclaimer"]


def test_notes_extraction_and_negation():
    out = notes.extract("Patient is more tired than usual and reports difficulty breathing.")
    assert {s["signal"] for s in out["signals"]} == {"fatigue", "breathing_difficulty"}
    neg = notes.extract("No chest pain, denies dizziness. Eating well.")
    assert not neg["signals"]
    assert {s["signal"] for s in neg["negated_signals"]} >= {"chest_discomfort", "dizziness"}
    assert notes.extract("पिताजी को सांस लेने में तकलीफ है")["signals"][0]["signal"] == "breathing_difficulty"


def test_validate_signals_rejects_unknown():
    assert notes.validate_signals([{"signal": "HIGH_RISK_NOW"}, {"signal": "pain", "evidence": "x"}]) == [
        {"signal": "pain", "label": "Pain", "evidence": "x"}]


def test_api_contract_camel_case():
    client = TestClient(app)
    resp = client.post("/v1/assess", json={"patient": {"age": 70}, "readings": series([NORMAL] * 8)})
    body = resp.json()
    assert resp.status_code == 200
    for key in ("riskLevel", "riskScore", "confidence", "reasons", "contributingFactors",
                "predictionWindow", "recommendedAction"):
        assert key in body
    assert client.post("/v1/assess", json={"patient": {"age": 70}, "readings": []}).status_code == 422
    assert client.post("/v1/notes/extract", json={"text": "Feeling dizzy"}).json()["signals"][0]["signal"] == "dizziness"


def test_oxygen_supply_failure_requires_attention():
    r = assess(series([NORMAL] * 12), equipment=[{"type": "OXYGEN_CONCENTRATOR", "status": "FAULT"}])
    assert r["risk_level"] == "MEDIUM"
    assert "oxygen" in r["explanation"]
    assert any("oxygen" in x.lower() for x in r["reasons"])
    ok = assess(series([NORMAL] * 12), equipment=[{"type": "OXYGEN_CONCENTRATOR", "status": "OK"}])
    assert ok["risk_level"] == "LOW"
