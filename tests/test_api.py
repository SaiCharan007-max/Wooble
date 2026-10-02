import time
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from homeward import config
from homeward.server import create_app

KEY = {"X-Device-Key": config.DEVICE_API_KEY}


@pytest.fixture()
def client(tmp_path):
    with TestClient(create_app(str(tmp_path / "test.db"))) as c:
        yield c


def reading(seq, pid="P002", **vitals):
    v = dict(hr=75, spo2=97, temp=36.8, rr=16, sbp=125, consciousness="A") | vitals
    ts = (datetime(2026, 1, 1) + timedelta(minutes=10 * seq)).isoformat(timespec="seconds")
    return {"device_id": f"{pid}-WEARABLE", "patient_id": pid, "seq": seq, "ts": ts,
            "generated_at": time.time(), "vitals": v, "battery": 80}


def test_ingest_requires_device_key(client):
    r = client.post("/api/ingest", json={"readings": [reading(1)]})
    assert r.status_code == 401


def test_ingest_is_idempotent(client):
    batch = {"readings": [reading(i) for i in range(1, 6)]}
    assert client.post("/api/ingest", json=batch, headers=KEY).json()["accepted"] == 5
    again = client.post("/api/ingest", json=batch, headers=KEY).json()
    assert again["accepted"] == 0 and again["duplicates"] == 5


def test_artifact_rejected_not_scored(client):
    client.post("/api/ingest", json={"readings": [reading(1, spo2=0)]}, headers=KEY)
    d = client.get("/api/patients/P002").json()
    assert d["readings"][-1]["spo2"] is None and "rejected" in d["readings"][-1]["artifact"]


def test_backfilled_readings_flagged(client):
    old = reading(1) | {"generated_at": time.time() - 120}
    r = client.post("/api/ingest", json={"readings": [old]}, headers=KEY).json()
    assert r["backfilled"] == 1


def test_full_flow_sensor_to_response(client):
    """Sensor -> Platform -> AI risk -> Alert -> Caregiver response."""
    bad = [reading(i, hr=135, spo2=89, temp=39.5, rr=28, sbp=88) for i in range(1, 4)]
    client.post("/api/ingest", json={"readings": bad}, headers=KEY)
    p = next(p for p in client.get("/api/patients").json() if p["id"] == "P002")
    assert p["risk"]["level"] == "high"
    alerts = [a for a in client.get("/api/alerts").json() if a["kind"] == "clinical"]
    assert len(alerts) == 1 and alerts[0]["severity"] == "high"

    # More bad readings must not create duplicate alerts.
    client.post("/api/ingest", json={"readings": [reading(4, hr=136, spo2=88, rr=29, sbp=86, temp=39.6)]}, headers=KEY)
    assert len([a for a in client.get("/api/alerts").json() if a["kind"] == "clinical"]) == 1

    aid = alerts[0]["id"]
    acked = client.post(f"/api/alerts/{aid}/ack", json={"by": "Suresh", "note": "Called doctor"}).json()
    assert acked["status"] == "acknowledged" and acked["acked_by"] == "Suresh"
    resolved = client.post(f"/api/alerts/{aid}/resolve", json={"by": "Suresh", "note": "Admitted"}).json()
    assert resolved["status"] == "resolved"
    assert client.post(f"/api/alerts/{aid}/ack", json={"by": "X"}).status_code == 409


def test_note_updates_risk(client):
    client.post("/api/ingest", json={"readings": [reading(i) for i in range(1, 4)]}, headers=KEY)
    r = client.post("/api/patients/P002/notes", json={"author": "Suresh", "text": "Complains of chest pain"}).json()
    assert r["assessment"]["level"] == "high"


def test_escalation_when_not_acknowledged(client, monkeypatch):
    client.post("/api/ingest", json={"readings": [reading(1, hr=135, spo2=89, temp=39.5, rr=28, sbp=88)]}, headers=KEY)
    monkeypatch.setitem(config.ESCALATION_SECONDS, "high", 0)
    hub = client.app.state.hub
    assert hub.alerts.escalate_overdue()
    alert = [a for a in client.get("/api/alerts").json() if a["kind"] == "clinical"][0]
    assert alert["escalation_level"] == 1


def test_oxygen_equipment_alert(client):
    r = reading(1, pid="P003", spo2=90) | {"on_oxygen": True, "o2_flow": 0.0}
    client.post("/api/ingest", json={"readings": [r]}, headers=KEY)
    kinds = {a["kind"] for a in client.get("/api/alerts").json()}
    assert "oxygen_supply" in kinds
