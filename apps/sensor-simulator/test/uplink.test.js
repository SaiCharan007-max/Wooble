import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore, SendError, Uplink } from '../src/uplink.js';
import { Simulator } from '../src/simulator.js';
import { HubAlarms } from '../src/hubAlarms.js';
import { PROFILES, VirtualPatient } from '../src/vitalsModel.js';

/** Fake backend with idempotent storage keyed by (device, sequence), like the real one. */
function fakeBackend() {
  const stored = new Map();
  let down = false;
  const calls = [];
  return {
    stored, calls,
    setDown: (v) => { down = v; },
    send: async (batch) => {
      calls.push(batch.length);
      if (down) throw new SendError('network error: ECONNREFUSED');
      let created = 0;
      let duplicates = 0;
      for (const r of batch) {
        const key = `${r.device_id}:${r.sequence_number}`;
        if (stored.has(key)) duplicates += 1;
        else { stored.set(key, r); created += 1; }
      }
      return { created, duplicates, rejected: 0 };
    },
  };
}

const reading = (seq) => ({ device_id: 'WEAR-001', patient_id: 'p', timestamp: new Date().toISOString(), heart_rate: 80, sequence_number: seq });

test('readings are delivered immediately when online', async () => {
  const backend = fakeBackend();
  const up = new Uplink({ send: backend.send });
  up.enqueue(reading(1));
  await up.flush();
  assert.equal(up.size, 0);
  assert.equal(backend.stored.size, 1);
  assert.equal(backend.stored.get('WEAR-001:1').source, 'LIVE');
});

test('offline mode buffers locally and syncs everything after reconnection', async () => {
  const backend = fakeBackend();
  const store = new MemoryStore([]);
  const up = new Uplink({ send: backend.send, store });
  up.setForcedOffline(true);
  for (let i = 1; i <= 25; i += 1) {
    up.enqueue(reading(i));
    await up.flush();
  }
  assert.equal(up.size, 25);
  assert.equal(backend.stored.size, 0);
  assert.equal(store.load([]).length, 25, 'buffer is persisted');

  up.setForcedOffline(false);
  await up.flush();
  assert.equal(up.size, 0);
  assert.equal(backend.stored.size, 25);
  assert.ok([...backend.stored.values()].every((r) => r.source === 'BUFFERED'));
});

test('backend failure triggers exponential backoff, then recovery', async () => {
  let clock = 0;
  const backend = fakeBackend();
  const up = new Uplink({ send: backend.send, now: () => clock, random: () => 0, baseDelayMs: 1000 });
  backend.setDown(true);
  up.enqueue(reading(1));
  const delays = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await up.flush();
    delays.push(r.retryInMs);
    clock += r.retryInMs;
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal((await up.flush()).status, 'failed');
  assert.equal(up.status().mode, 'RETRYING');

  backend.setDown(false);
  clock += 1e6;
  up.enqueue(reading(2));
  const ok = await up.flush();
  assert.equal(ok.status, 'sent');
  assert.equal(backend.stored.size, 2);
  assert.equal(up.status().attempt, 0);
});

test('retransmitting the same readings does not create duplicates', async () => {
  const backend = fakeBackend();
  const up = new Uplink({ send: backend.send });
  up.enqueue(reading(1));
  up.enqueue(reading(2));
  await up.flush();
  up.enqueue(reading(1)); // e.g. the hub crashed before it saw the acknowledgement
  up.enqueue(reading(2));
  await up.flush();
  assert.equal(backend.stored.size, 2);
});

test('large buffers upload in batches', async () => {
  const backend = fakeBackend();
  const up = new Uplink({ send: backend.send, batchSize: 10 });
  up.setForcedOffline(true);
  for (let i = 1; i <= 35; i += 1) up.enqueue(reading(i));
  up.setForcedOffline(false);
  await up.flush();
  assert.deepEqual(backend.calls, [10, 10, 10, 5]);
});

test('gradual deterioration follows the expected direction', () => {
  const p = new VirtualPatient(undefined, () => 0.5);
  p.setScenario('GRADUAL_DETERIORATION');
  const first = p.step();
  let last;
  for (let i = 0; i < PROFILES.GRADUAL_DETERIORATION.steps; i += 1) last = p.step();
  assert.ok(last.spo2 < first.spo2 - 5);
  assert.ok(last.heart_rate > first.heart_rate + 25);
  assert.ok(last.respiratory_rate > first.respiratory_rate + 8);
});

test('sensor failure stops readings; network failure keeps measuring', async () => {
  const backend = fakeBackend();
  const up = new Uplink({ send: backend.send });
  const sim = new Simulator({ uplink: up, stateStore: new MemoryStore({ sequences: {} }) });
  const pid = sim.devices[0].patientId;
  sim.control({ patientId: pid, scenario: 'SENSOR_FAILURE' });
  await sim.tick();
  assert.equal([...backend.stored.values()].filter((r) => r.patient_id === pid).length, 0);

  sim.control({ patientId: pid, scenario: 'NORMAL' });
  sim.control({ scenario: 'NETWORK_FAILURE' });
  await sim.tick();
  await sim.tick();
  assert.equal(up.buffer.filter((r) => r.kind === 'vital').length, 6, 'all three sensors keep buffering during the outage');
  assert.ok(up.buffer.some((r) => r.kind === 'equipment' && r.power_source === 'BATTERY'), 'power cut: concentrator on battery');
  sim.control({ network: 'ONLINE' });
  await sim.tick();
  assert.equal(up.size, 0);
});

test('sequence numbers continue after a restart', async () => {
  const state = new MemoryStore({ sequences: {} });
  const sim1 = new Simulator({ uplink: new Uplink({ send: fakeBackend().send }), stateStore: state });
  await sim1.tick();
  await sim1.tick();
  const sim2 = new Simulator({ uplink: new Uplink({ send: fakeBackend().send }), stateStore: state });
  assert.equal(sim2.devices[0].sequence, 2);
});

test('oxygen concentrator failure: 0 L/min, SpO2 falls, local alarm sounds even with the cloud offline', async () => {
  const up = new Uplink({ send: fakeBackend().send });
  const sim = new Simulator({ uplink: up, stateStore: new MemoryStore({ sequences: {} }), rng: () => 0.5 });
  const lakshmi = sim.devices.find((d) => d.equipment);
  for (const d of sim.devices) d.model.setScenario('NORMAL');
  sim.control({ scenario: 'NETWORK_FAILURE' });
  sim.control({ patientId: lakshmi.patientId, equipment: 'FAILURE' });
  for (let i = 0; i < 30; i += 1) await sim.tick();

  const last = lakshmi.equipment.lastReading;
  assert.equal(last.flow_lpm, 0);
  assert.equal(last.power_source, 'NONE');
  assert.ok(lakshmi.lastReading.spo2 <= 91, `SpO2 fell to ${lakshmi.lastReading.spo2}`);
  const alarm = sim.hub.list().find((a) => a.patientId === lakshmi.patientId);
  assert.ok(alarm, 'local alarm raised');
  assert.equal(alarm.cloudReachable, false);
  assert.ok(up.buffer.some((e) => e.kind === 'hub_event' && e.type === 'LOCAL_ALARM'), 'alarm queued for later sync');

  assert.ok(sim.acknowledgeAlarm(lakshmi.patientId));
  assert.ok(up.buffer.some((e) => e.kind === 'hub_event' && e.type === 'LOCAL_ALARM_ACK'));
});

test('hub alarm clears only after several normal readings', () => {
  const events = [];
  const hub = new HubAlarms({ emit: (e) => events.push(e) });
  const base = { patientId: 'p', deviceUid: 'W', name: 'X', cloudReachable: true };
  hub.check({ ...base, vitals: { spo2: 86, heart_rate: 90 } });
  hub.check({ ...base, vitals: { spo2: 86, heart_rate: 90 } });
  assert.equal(events.length, 1, 'no duplicate alarm events');
  for (let i = 0; i < 4; i += 1) hub.check({ ...base, vitals: { spo2: 96, heart_rate: 80 } });
  assert.equal(hub.list().length, 1);
  hub.check({ ...base, vitals: { spo2: 96, heart_rate: 80 } });
  assert.equal(hub.list().length, 0);
  assert.equal(events.at(-1).type, 'LOCAL_ALARM_CLEARED');
});

test('http sender routes each kind to its endpoint and strips internal fields', async () => {
  const { httpSender } = await import('../src/uplink.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push([new URL(url).pathname, JSON.parse(opts.body).readings]);
    return { ok: true, json: async () => ({ created: 1, duplicates: 0, rejected: 0 }) };
  };
  try {
    const send = httpSender({ backendUrl: 'http://x', deviceApiKey: 'k' });
    const r = await send([{ kind: 'vital', a: 1, source: 'LIVE' }, { kind: 'equipment', b: 2 }, { kind: 'hub_event', c: 3, source: 'LIVE' }]);
    assert.deepEqual(calls.map((c) => c[0]), ['/api/vitals', '/api/equipment', '/api/hub-events']);
    assert.ok(calls.every(([, items]) => items.every((i) => !('kind' in i))));
    assert.ok(!('source' in calls[2][1][0]));
    assert.equal(r.created, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});
