// The "home hub": owns one virtual wearable per patient, produces readings every tick and
// hands them to the store-and-forward uplink.
import { DEMO_PATIENTS, SCENARIOS, SPEEDS } from '@homecare/shared';
import { VirtualPatient } from './vitalsModel.js';

export class Simulator {
  constructor({ uplink, stateStore, patients = DEMO_PATIENTS, rng = Math.random, now = () => new Date(), log = () => {} }) {
    this.uplink = uplink;
    this.stateStore = stateStore;
    this.now = now;
    this.log = log;
    this.speed = 1;
    const saved = stateStore.load({ sequences: {} });
    this.devices = patients.map((p) => ({
      deviceUid: p.deviceUid,
      patientId: p.patientId,
      name: p.name,
      defaultScenario: p.defaultScenario,
      scenario: p.defaultScenario,
      // sequence numbers survive restarts, otherwise new readings would look like duplicates
      sequence: saved.sequences[p.deviceUid] || 0,
      model: new VirtualPatient(p.start, rng),
      lastReading: null,
    }));
    for (const d of this.devices) d.model.setScenario(d.scenario);
  }

  get network() {
    return this.uplink.forcedOffline ? 'OFFLINE' : 'ONLINE';
  }

  findDevices(patientId) {
    return !patientId || patientId === 'ALL' ? this.devices : this.devices.filter((d) => d.patientId === patientId);
  }

  /** Apply a control command: { patientId, scenario, speed, network }. */
  control({ patientId = 'ALL', scenario, speed, network } = {}) {
    if (scenario && !SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario ${scenario}`);
    if (speed && !SPEEDS.includes(speed)) throw new Error(`Speed must be one of ${SPEEDS.join(', ')}`);
    const devices = this.findDevices(patientId);
    if (!devices.length) throw new Error('Unknown patient');

    if (scenario === 'NETWORK_FAILURE') {
      network = 'OFFLINE'; // the home's connectivity fails; sensors keep measuring
    } else if (scenario) {
      for (const d of devices) {
        d.scenario = scenario;
        d.model.setScenario(scenario);
      }
      this.log(`scenario ${scenario} -> ${devices.map((d) => d.deviceUid).join(', ')}`);
    }
    if (speed) this.speed = speed;
    if (network) {
      this.uplink.setForcedOffline(network === 'OFFLINE');
      this.log(network === 'OFFLINE' ? 'network/power failure - buffering locally' : 'network restored');
    }
    return this.status();
  }

  reset() {
    this.speed = 1;
    this.uplink.setForcedOffline(false);
    for (const d of this.devices) {
      d.model.reset();
      d.scenario = d.defaultScenario;
      d.model.setScenario(d.scenario);
    }
    this.log('demo reset');
    return this.status();
  }

  /** One sampling cycle: every working sensor produces a reading, then the uplink tries to deliver. */
  async tick() {
    for (const d of this.devices) {
      if (d.scenario === 'SENSOR_FAILURE') continue; // sensor detached / dead: nothing is measured
      const vitals = d.model.step(this.speed);
      d.sequence += 1;
      d.lastReading = { ...vitals, timestamp: this.now().toISOString() };
      this.uplink.enqueue({
        device_id: d.deviceUid,
        patient_id: d.patientId,
        timestamp: d.lastReading.timestamp,
        ...vitals,
        sequence_number: d.sequence,
      });
    }
    this.stateStore.save({ sequences: Object.fromEntries(this.devices.map((d) => [d.deviceUid, d.sequence])) });
    return this.uplink.flush();
  }

  status() {
    return {
      speed: this.speed,
      network: this.network,
      uplink: this.uplink.status(),
      devices: this.devices.map((d) => ({
        deviceUid: d.deviceUid, patientId: d.patientId, name: d.name, scenario: d.scenario,
        sensorWorking: d.scenario !== 'SENSOR_FAILURE', sequence: d.sequence, lastReading: d.lastReading,
      })),
    };
  }
}
