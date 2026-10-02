import { PATIENT_1, PATIENT_3, reading, startRiskEngine } from './setup.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrate.js';
import { db, pool } from '../src/db/pool.js';
import { alertService } from '../src/services/alertService.js';
import { fallbackAssessment } from '../src/services/fallbackRisk.js';
import { detectOfflineSensors } from '../src/services/monitorService.js';

const app = createApp();
const DEVICE = { 'x-device-key': env.deviceApiKey };
let stopEngine;
let anita;
let admin;

async function login(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return `Bearer ${res.body.token}`;
}

const post = (url, body, auth) => request(app).post(url).set('authorization', auth).send(body);
const get = (url, auth) => request(app).get(url).set('authorization', auth);
const count = async (sql, params) => (await db.query(sql, params)).rows[0].n;

/** Deteriorating series ending now: 20 readings, 10 s apart. */
async function sendDeterioration(device = 'WEAR-001', patient = PATIENT_1, startSeq = 1000) {
  const readings = Array.from({ length: 20 }, (_, i) =>
    reading(startSeq + i, { device, patient, progress: i / 19, secondsAgo: (19 - i) * 10 }));
  const res = await request(app).post('/api/vitals').set(DEVICE).send({ readings });
  assert.equal(res.status, 200);
  return res.body;
}

before(async () => {
  stopEngine = await startRiskEngine();
});

beforeEach(async () => {
  await runMigrations({ reset: true });
  anita = await login('anita@homecare.demo', 'Care@123');
  admin = await login('admin@homecare.demo', 'Admin@123');
});

after(async () => {
  stopEngine?.();
  await pool.end();
});

describe('authentication & authorisation', () => {
  test('rejects wrong password and unauthenticated requests', async () => {
    assert.equal((await request(app).post('/api/auth/login').send({ email: 'anita@homecare.demo', password: 'x' })).status, 401);
    assert.equal((await request(app).get('/api/patients')).status, 401);
    assert.equal((await count(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'LOGIN_FAILED'`)), 1);
  });

  test('role-based access: caregivers cannot reset the demo', async () => {
    assert.equal((await post('/api/simulator/reset', {}, anita)).status, 403);
  });
});

describe('vital validation', () => {
  test('rejects implausible, inconsistent, future and unauthenticated readings', async () => {
    const send = (body, headers = DEVICE) => request(app).post('/api/vitals').set(headers).send(body);
    assert.equal((await send(reading(1), {})).status, 401);
    assert.equal((await send({ ...reading(1), spo2: 120 })).status, 400);
    assert.equal((await send({ ...reading(1), systolic_bp: 70, diastolic_bp: 90 })).status, 400);
    assert.equal((await send({ ...reading(1), timestamp: new Date(Date.now() + 3600e3).toISOString() })).status, 400);
    assert.equal((await send({ ...reading(1), device_id: 'UNKNOWN' })).status, 400);
    assert.equal((await send({ ...reading(1), patient_id: PATIENT_3 })).status, 400, 'device belongs to another patient');
    const bad = await send({ heart_rate: 80 });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error.details.length);
  });

  test('a bad reading inside a batch does not block the good ones', async () => {
    const res = await request(app).post('/api/vitals').set(DEVICE)
      .send({ readings: [reading(1), { ...reading(2), spo2: 10 }, reading(3)] });
    assert.deepEqual([res.body.created, res.body.rejected], [2, 1]);
  });
});

describe('idempotent ingestion', () => {
  test('re-sending the same reading never creates a duplicate', async () => {
    const r = reading(42);
    const first = await request(app).post('/api/vitals').set(DEVICE).send(r);
    const second = await request(app).post('/api/vitals').set(DEVICE).send(r);
    assert.equal(first.status, 201);
    assert.equal(second.body.status, 'duplicate');
    const batch = await request(app).post('/api/vitals').set(DEVICE).send({ readings: [r, reading(43)] });
    assert.deepEqual([batch.body.created, batch.body.duplicates], [1, 1]);
    assert.equal(await count(`SELECT count(*)::int AS n FROM vital_readings WHERE sequence_number IN (42, 43)`), 2);
  });
});

describe('risk calculation and transitions', () => {
  test('stable readings stay LOW with an explanation', async () => {
    await request(app).post('/api/vitals').set(DEVICE).send(reading(1));
    const { body } = await get(`/api/patients/${PATIENT_1}/risk`, anita);
    assert.equal(body.latest.risk_level, 'LOW');
    assert.match(body.latest.explanation, /LOW RISK/);
  });

  test('risk moves LOW -> MEDIUM -> HIGH as vitals deteriorate', async () => {
    const levels = [];
    for (let i = 0; i < 20; i += 1) {
      await request(app).post('/api/vitals').set(DEVICE)
        .send(reading(2000 + i, { progress: i / 19, secondsAgo: (19 - i) * 10 }));
      levels.push((await get(`/api/patients/${PATIENT_1}/risk`, anita)).body.latest.risk_level);
    }
    assert.equal(levels.at(-1), 'HIGH');
    assert.ok(levels.includes('MEDIUM'));
    assert.ok(levels.indexOf('MEDIUM') < levels.indexOf('HIGH'));
  });
});

describe('alerts', () => {
  test('full flow: sensor -> backend -> risk engine -> alert -> acknowledge -> response -> resolve', async () => {
    await sendDeterioration();
    const risk = (await get(`/api/patients/${PATIENT_1}/risk`, anita)).body.latest;
    assert.equal(risk.risk_level, 'HIGH');
    assert.match(risk.explanation, /SpO2 decreased/);
    assert.equal(risk.engine_version, 'prototype-hybrid-v1');

    const alerts = (await get('/api/alerts', anita)).body.filter((a) => a.patient_id === PATIENT_1);
    assert.equal(alerts.length, 1);
    const alert = alerts[0];
    assert.equal(alert.risk_level, 'HIGH');
    assert.equal(alert.status, 'OPEN');

    const acked = await post(`/api/alerts/${alert.id}/acknowledge`, {}, anita);
    assert.equal(acked.body.status, 'ACKNOWLEDGED');
    assert.equal(acked.body.acknowledged_by_name, 'Anita Sharma');
    assert.equal((await post(`/api/alerts/${alert.id}/acknowledge`, {}, anita)).status, 409);

    const note = 'Checked patient. Patient is conscious and responsive. Contacting clinical support.';
    const responded = await post(`/api/alerts/${alert.id}/response`, { note }, anita);
    assert.equal(responded.body.actions.at(-1).note, note);

    const resolved = await post(`/api/alerts/${alert.id}/resolve`, { note: 'Stable after review' }, anita);
    assert.equal(resolved.body.status, 'RESOLVED');

    const actions = (await db.query(`SELECT action FROM audit_logs ORDER BY id`)).rows.map((r) => r.action);
    for (const a of ['VITALS_INGESTED', 'RISK_CALCULATED', 'ALERT_CREATED', 'ALERT_ACKNOWLEDGED', 'CAREGIVER_RESPONSE', 'ALERT_RESOLVED']) {
      assert.ok(actions.includes(a), `audit log contains ${a}`);
    }
  });

  test('de-duplication: continued high risk does not create more alerts', async () => {
    await sendDeterioration();
    await sendDeterioration('WEAR-001', PATIENT_1, 3000);
    assert.equal(await count(`SELECT count(*)::int AS n FROM alerts WHERE patient_id = $1 AND category = 'CLINICAL'`, [PATIENT_1]), 1);
  });

  test('cooldown: a resolved alert is not immediately re-raised at the same level', async () => {
    await sendDeterioration();
    const [alert] = (await get('/api/alerts', anita)).body;
    await post(`/api/alerts/${alert.id}/resolve`, {}, anita);
    await sendDeterioration('WEAR-001', PATIENT_1, 3000);
    assert.equal(await count(`SELECT count(*)::int AS n FROM alerts WHERE patient_id = $1`, [PATIENT_1]), 1);
  });

  test('unacknowledged HIGH alert escalates after the timeout', async () => {
    await sendDeterioration();
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(await alertService.escalateOverdue(), 1);
    const [alert] = (await get('/api/alerts', anita)).body;
    assert.equal(alert.status, 'ESCALATED');
    assert.match(alert.escalation_reason, /Not acknowledged/);
  });

  test('HIGH risk escalates immediately when the assigned caregiver is not checked in', async () => {
    await sendDeterioration('WEAR-003', PATIENT_3);
    const alert = (await get('/api/alerts', anita)).body.find((a) => a.patient_id === PATIENT_3);
    assert.equal(alert.status, 'ESCALATED');
    assert.match(alert.escalation_reason, /not checked in/);
  });
});

describe('sensor failure and offline recovery', () => {
  test('silent sensor -> connectivity alert (not deterioration); buffered upload -> recovery', async () => {
    await request(app).post('/api/vitals').set(DEVICE).send(reading(1));
    const assessmentsBefore = await count('SELECT count(*)::int AS n FROM risk_assessments WHERE patient_id = $1', [PATIENT_1]);
    await db.query(`UPDATE sensor_devices SET last_seen_at = now() - interval '1 minute' WHERE device_uid = 'WEAR-001'`);

    assert.equal(await detectOfflineSensors(), 1);
    const device = (await get(`/api/patients/${PATIENT_1}`, anita)).body.device;
    assert.equal(device.status, 'OFFLINE');
    const deviceAlert = (await get('/api/alerts', anita)).body.find((a) => a.category === 'DEVICE');
    assert.equal(deviceAlert.title, 'Sensor connectivity issue detected');
    assert.equal(await count('SELECT count(*)::int AS n FROM risk_assessments WHERE patient_id = $1', [PATIENT_1]),
      assessmentsBefore, 'missing data must not change the risk');

    // the hub reconnects and uploads what it buffered
    const buffered = Array.from({ length: 5 }, (_, i) => reading(10 + i, { secondsAgo: 50 - i * 10, source: 'BUFFERED' }));
    const res = await request(app).post('/api/vitals').set(DEVICE).send({ readings: buffered });
    assert.equal(res.body.created, 5);
    assert.equal((await get(`/api/patients/${PATIENT_1}`, anita)).body.device.status, 'ONLINE');
    assert.ok(!(await get('/api/alerts', anita)).body.some((a) => a.category === 'DEVICE'), 'device alert auto-resolved');
    assert.equal(await count(`SELECT count(*)::int AS n FROM sensor_events WHERE event_type = 'BUFFER_SYNC'`), 1);

    // replaying the same buffer is harmless
    const replay = await request(app).post('/api/vitals').set(DEVICE).send({ readings: buffered });
    assert.equal(replay.body.duplicates, 5);
  });
});

describe('caregiver notes and attendance', () => {
  test('notes are validated, signals extracted and fed into the risk', async () => {
    assert.equal((await post(`/api/patients/${PATIENT_1}/notes`, { note: '   ' }, anita)).status, 400);
    assert.equal((await post(`/api/patients/${PATIENT_1}/notes`, {}, anita)).status, 400);
    await request(app).post('/api/vitals').set(DEVICE).send(reading(1));
    const res = await post(`/api/patients/${PATIENT_1}/notes`,
      { note: 'Patient is more tired than usual and reports difficulty breathing.' }, anita);
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.extracted_signals.map((s) => s.signal).sort(), ['breathing_difficulty', 'fatigue']);
    const risk = (await get(`/api/patients/${PATIENT_1}/risk`, anita)).body.latest;
    assert.ok(risk.reasons.some((r) => /breathing difficulty/.test(r)));
  });

  test('check-in / check-out changes caregiver status', async () => {
    await post('/api/caregivers/check-out', {}, anita);
    let list = (await get('/api/caregivers/activity', anita)).body.caregivers;
    assert.equal(list.find((c) => c.full_name === 'Anita Sharma').status, 'NOT_CHECKED_IN');
    await post('/api/caregivers/check-in', {}, anita);
    await post('/api/caregivers/activity', { type: 'VISIT', patientId: PATIENT_1, note: 'Gave medication' }, anita);
    list = (await get('/api/caregivers/activity', anita)).body.caregivers;
    const me = list.find((c) => c.full_name === 'Anita Sharma');
    assert.equal(me.status, 'PRESENT');
    assert.equal(me.last_visit.patient_name, 'Ramesh Kumar');
  });
});

describe('graceful degradation', () => {
  test('safety-threshold fallback still flags critical vitals', () => {
    const r = fallbackAssessment({ spo2: 86, heart_rate: 80, respiratory_rate: 16, temperature: 36.8, systolic_bp: 120 });
    assert.equal(r.riskLevel, 'HIGH');
    assert.match(r.explanation, /risk engine unavailable/);
  });

  test('risk engine down -> backend uses the fallback, ingestion keeps working', async () => {
    stopEngine();
    stopEngine = null;
    const res = await request(app).post('/api/vitals').set(DEVICE).send({ ...reading(1), spo2: 86 });
    assert.equal(res.status, 201);
    const risk = (await get(`/api/patients/${PATIENT_1}/risk`, admin)).body.latest;
    assert.equal(risk.engine_version, 'backend-safety-fallback');
    assert.equal(risk.risk_level, 'HIGH');
  });
});
