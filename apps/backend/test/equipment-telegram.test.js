import { PATIENT_1, reading, startRiskEngine } from './setup.js';
import './telegramEnv.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrate.js';
import { db, pool } from '../src/db/pool.js';
import { notificationService } from '../src/services/notificationService.js';

const PATIENT_2 = '22222222-2222-4222-8222-222222222222'; // Lakshmi, home oxygen
const app = createApp();
const DEVICE = { 'x-device-key': env.deviceApiKey };
let stopEngine;
let anita;

// ------------------------------------------------------------------ mock Telegram Bot API
const tgCalls = [];
const updates = [];
let messageId = 100;
const tgServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const payload = body ? JSON.parse(body) : {};
    let result = true;
    if (method === 'getUpdates') {
      const batch = updates.splice(0);
      return setTimeout(() => res.end(JSON.stringify({ ok: true, result: batch })), batch.length ? 0 : 100);
    }
    tgCalls.push({ method, payload });
    if (method === 'sendMessage') result = { message_id: ++messageId };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
});

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for condition');
};

const equipmentReading = (seq, flow, power = 'MAINS') => ({
  equipment_id: 'O2C-002', patient_id: PATIENT_2, timestamp: new Date().toISOString(),
  flow_lpm: flow, power_source: power, sequence_number: seq,
});

before(async () => {
  await new Promise((r) => tgServer.listen(8722, r));
  stopEngine = await startRiskEngine();
  notificationService.start({ poll: true });
});

beforeEach(async () => {
  await runMigrations({ reset: true });
  tgCalls.length = 0;
  const res = await request(app).post('/api/auth/login').send({ email: 'anita@homecare.demo', password: 'Care@123' });
  anita = `Bearer ${res.body.token}`;
});

after(async () => {
  notificationService.stop();
  await notificationService.flush();
  stopEngine?.();
  tgServer.close();
  await pool.end();
});

describe('medical equipment monitoring', () => {
  test('oxygen concentrator failure raises an equipment alert, raises risk, and auto-resolves when fixed', async () => {
    await request(app).post('/api/vitals').set(DEVICE)
      .send(reading(1, { device: 'WEAR-002', patient: PATIENT_2 }));
    let res = await request(app).post('/api/equipment').set(DEVICE).send({ readings: [equipmentReading(1, 2.0)] });
    assert.equal(res.body.created, 1);

    res = await request(app).post('/api/equipment').set(DEVICE).send({ readings: [equipmentReading(2, 0, 'NONE')] });
    assert.equal(res.body.created, 1);
    const alerts = (await request(app).get('/api/alerts').set('authorization', anita)).body;
    const eq = alerts.find((a) => a.category === 'EQUIPMENT');
    assert.equal(eq.title, 'Oxygen concentrator not delivering oxygen');
    assert.equal(eq.risk_level, 'HIGH');

    const risk = (await request(app).get(`/api/patients/${PATIENT_2}/risk`).set('authorization', anita)).body.latest;
    assert.ok(risk.reasons.some((r) => /oxygen/i.test(r)), 'oxygen loss feeds the clinical risk');

    const patient = (await request(app).get(`/api/patients/${PATIENT_2}`).set('authorization', anita)).body;
    assert.equal(patient.equipment[0].status, 'FAULT');

    await request(app).post('/api/equipment').set(DEVICE).send({ readings: [equipmentReading(3, 2.0)] });
    const after = (await request(app).get('/api/alerts').set('authorization', anita)).body;
    assert.ok(!after.some((a) => a.category === 'EQUIPMENT'), 'equipment alert auto-resolved');
  });

  test('battery power is recorded without a false alarm; replays are idempotent', async () => {
    await request(app).post('/api/equipment').set(DEVICE).send({ readings: [equipmentReading(1, 2.0, 'BATTERY')] });
    const replay = await request(app).post('/api/equipment').set(DEVICE).send({ readings: [equipmentReading(1, 2.0, 'BATTERY')] });
    assert.equal(replay.body.duplicates, 1);
    const status = (await db.query(`SELECT status FROM medical_equipment WHERE equipment_uid = 'O2C-002'`)).rows[0].status;
    assert.equal(status, 'ON_BATTERY');
    assert.equal((await db.query(`SELECT count(*)::int n FROM alerts WHERE category = 'EQUIPMENT'`)).rows[0].n, 0);
    const bad = await request(app).post('/api/equipment').set(DEVICE).send({ readings: [{ ...equipmentReading(2, 2), patient_id: PATIENT_1 }] });
    assert.equal(bad.body.rejected, 1, 'equipment belongs to another patient');
  });
});

describe('home hub local alarms', () => {
  test('alarms raised offline are synced into the audit trail exactly once', async () => {
    const event = {
      event_uid: 'alarm-1:LOCAL_ALARM', device_id: 'WEAR-001', patient_id: PATIENT_1, type: 'LOCAL_ALARM',
      timestamp: new Date(Date.now() - 60000).toISOString(), details: { findings: ['SpO2 86%'], cloudReachable: false },
    };
    const first = await request(app).post('/api/hub-events').set(DEVICE).send({ readings: [event] });
    const again = await request(app).post('/api/hub-events').set(DEVICE).send({ readings: [event] });
    assert.deepEqual([first.body.created, again.body.duplicates], [1, 1]);
    const rows = (await db.query(`SELECT * FROM audit_logs WHERE action = 'HUB_LOCAL_ALARM'`)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata.cloudReachable, false);
    assert.equal((await request(app).post('/api/hub-events').send({ readings: [event] })).status, 401);
  });
});

describe('Telegram phone alerts', () => {
  test('HIGH alert is sent with buttons; tapping Acknowledge on the phone acknowledges it', async () => {
    const readings = Array.from({ length: 20 }, (_, i) => reading(500 + i, { progress: i / 19, secondsAgo: (19 - i) * 10 }));
    await request(app).post('/api/vitals').set(DEVICE).send({ readings });
    await notificationService.flush();

    const sent = tgCalls.filter((c) => c.method === 'sendMessage');
    assert.ok(sent.length >= 1, 'a message was sent');
    const msg = sent.at(-1).payload;
    assert.equal(msg.chat_id, '1001');
    assert.match(msg.text, /Ramesh Kumar/);
    const ackButton = msg.reply_markup.inline_keyboard[0][0];
    assert.match(ackButton.callback_data, /^ack:/);
    const alertId = ackButton.callback_data.split(':')[1];

    updates.push({ update_id: 1, callback_query: { id: 'cb1', data: ackButton.callback_data, message: { chat: { id: 1001 } } } });
    const acked = await waitFor(async () => {
      const a = (await request(app).get(`/api/alerts/${alertId}`).set('authorization', anita)).body;
      return a.status === 'ACKNOWLEDGED' ? a : null;
    });
    assert.equal(acked.acknowledged_by_name, 'Anita Sharma');
    await notificationService.flush();
    assert.ok(tgCalls.some((c) => c.method === 'answerCallbackQuery' && /Acknowledged/.test(c.payload.text)));
    assert.ok(tgCalls.some((c) => c.method === 'editMessageText' && /Acknowledged by/.test(c.payload.text)),
      'original message updated in place');
    const notes = (await db.query('SELECT status FROM notifications WHERE alert_id = $1', [alertId])).rows;
    assert.ok(notes.some((n) => n.status === 'SENT'));
  });

  test('callbacks from unknown chats are refused; /start replies with the chat id', async () => {
    updates.push({ update_id: 2, callback_query: { id: 'cb2', data: 'ack:00000000-0000-4000-8000-000000000000', message: { chat: { id: 666 } } } });
    updates.push({ update_id: 3, message: { chat: { id: 4242 }, text: '/start' } });
    await waitFor(() => tgCalls.some((c) => c.method === 'sendMessage' && c.payload.chat_id === '4242'));
    assert.ok(tgCalls.some((c) => c.method === 'answerCallbackQuery' && /not authorised/.test(c.payload.text)));
    assert.match(tgCalls.find((c) => c.payload.chat_id === '4242').payload.text, /4242/);
  });
});
