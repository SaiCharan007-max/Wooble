// The "home hub": owns one virtual wearable per patient (plus any medical equipment), produces readings
// every tick, runs the local safety check, and hands everything to the store-and-forward uplink.
import { DEMO_PATIENTS, SCENARIOS, SPEEDS } from '@homecare/shared';
import { HubAlarms } from './hubAlarms.js';
import { NORMAL_VITALS, OxygenConcentrator, VirtualPatient } from './vitalsModel.js';

// Sequence numbers must never go backwards, even if the hub's storage is wiped (e.g. a free cloud instance
// restarting). Starting from the current time in ms guarantees that: new numbers are always larger than old ones.
const startSequence = (saved) => Math.max(saved || 0, Date.now());

export class Simulator {
  constructor({ uplink, stateStore, patients = DEMO_PATIENTS, rng = Math.random, now = () => new Date(), log = () => {}, calm = false }) {
    this.uplink = uplink;
    this.stateStore = stateStore;
    this.now = now;
    this.log = log;
    this.speed = 1;
    this.hub = new HubAlarms({ emit: (event) => this.uplink.enqueue(event), now, log });
    const saved = stateStore.load({ sequences: {} });
    // "calm" demo start: everyone stable and healthy, so visitors (judges) drive the story themselves
    this.devices = patients.map((p) => ({
      deviceUid: p.deviceUid,
      patientId: p.patientId,
      name: p.name,
      defaultScenario: calm ? 'NORMAL' : p.defaultScenario,
      scenario: calm ? 'NORMAL' : p.defaultScenario,
      sequence: startSequence(saved.sequences[p.deviceUid]),
      model: new VirtualPatient(calm ? NORMAL_VITALS : p.start, rng),
      lastReading: null,
      equipment: p.equipment ? {
        ...p.equipment,
        sequence: startSequence(saved.sequences[p.equipment.equipmentUid]),
        model: new OxygenConcentrator(p.equipment, rng),
        lastReading: null,
      } : null,
    }));
    for (const d of this.devices) d.model.setScenario(d.scenario);
  }

  get network() {
    return this.uplink.forcedOffline ? 'OFFLINE' : 'ONLINE';
  }

  findDevices(patientId) {
    return !patientId || patientId === 'ALL' ? this.devices : this.devices.filter((d) => d.patientId === patientId);
  }

  /** Apply a control command: { patientId, scenario, speed, network, equipment: 'FAILURE' | 'OK' }. */
  control({ patientId = 'ALL', scenario, speed, network, equipment } = {}) {
    if (scenario && !SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario ${scenario}`);
    if (speed && !SPEEDS.includes(speed)) throw new Error(`Speed must be one of ${SPEEDS.join(', ')}`);
    const devices = this.findDevices(patientId);
    if (!devices.length) throw new Error('Unknown patient');

    if (scenario === 'NETWORK_FAILURE') {
      network = 'OFFLINE'; // the home's power/connectivity fails; sensors keep measuring on battery
    } else if (scenario) {
      for (const d of devices) {
        d.scenario = scenario;
        d.model.setScenario(scenario);
      }
      this.log(`scenario ${scenario} -> ${devices.map((d) => d.deviceUid).join(', ')}`);
    }
    if (equipment) {
      const withEquipment = devices.filter((d) => d.equipment);
      if (!withEquipment.length) throw new Error('This patient has no monitored equipment');
      for (const d of withEquipment) {
        d.equipment.model.failed = equipment === 'FAILURE';
        d.model.setOxygenFailure(equipment === 'FAILURE');
      }
      this.log(`equipment ${equipment} -> ${withEquipment.map((d) => d.equipment.equipmentUid).join(', ')}`);
    }
    if (speed) this.speed = speed;
    if (network) {
      this.uplink.setForcedOffline(network === 'OFFLINE');
      this.log(network === 'OFFLINE' ? 'power/connectivity failure - buffering locally' : 'connection restored');
    }
    return this.status();
  }

  acknowledgeAlarm(patientId) {
    return this.hub.acknowledge(patientId);
  }

  reset() {
    this.speed = 1;
    this.uplink.setForcedOffline(false);
    this.hub.reset();
    for (const d of this.devices) {
      d.model.reset();
      d.scenario = d.defaultScenario;
      d.model.setScenario(d.scenario);
      if (d.equipment) d.equipment.model.failed = false;
    }
    this.log('demo reset');
    return this.status();
  }

  /** One sampling cycle: every working sensor produces a reading, the hub checks it, the uplink delivers. */
  async tick() {
    const cloudReachable = !this.uplink.forcedOffline && this.uplink.connected;
    const mainsPower = !this.uplink.forcedOffline; // the demo "power/connectivity failure" also cuts mains
    const timestamp = this.now().toISOString();
    for (const d of this.devices) {
      let vitals = null;
      if (d.scenario !== 'SENSOR_FAILURE') { // a detached sensor measures nothing
        vitals = d.model.step(this.speed);
        d.sequence += 1;
        d.lastReading = { ...vitals, timestamp };
        this.uplink.enqueue({
          kind: 'vital', device_id: d.deviceUid, patient_id: d.patientId, timestamp, ...vitals, sequence_number: d.sequence,
        });
      }
      let equipment = null;
      if (d.equipment) {
        equipment = d.equipment.model.sample({ mainsPower });
        d.equipment.sequence += 1;
        d.equipment.lastReading = { ...equipment, timestamp };
        this.uplink.enqueue({
          kind: 'equipment', equipment_id: d.equipment.equipmentUid, patient_id: d.patientId, timestamp, ...equipment,
          sequence_number: d.equipment.sequence,
        });
      }
      this.hub.check({ patientId: d.patientId, deviceUid: d.deviceUid, name: d.name, vitals, equipment, cloudReachable });
    }
    const sequences = {};
    for (const d of this.devices) {
      sequences[d.deviceUid] = d.sequence;
      if (d.equipment) sequences[d.equipment.equipmentUid] = d.equipment.sequence;
    }
    this.stateStore.save({ sequences });
    return this.uplink.flush();
  }

  status() {
    return {
      speed: this.speed,
      network: this.network,
      uplink: this.uplink.status(),
      alarms: this.hub.list(),
      devices: this.devices.map((d) => ({
        deviceUid: d.deviceUid, patientId: d.patientId, name: d.name, scenario: d.scenario,
        sensorWorking: d.scenario !== 'SENSOR_FAILURE', sequence: d.sequence, lastReading: d.lastReading,
        equipment: d.equipment ? {
          equipmentUid: d.equipment.equipmentUid, type: d.equipment.type, prescribedFlow: d.equipment.prescribedFlow,
          failed: d.equipment.model.failed, lastReading: d.equipment.lastReading,
        } : null,
      })),
    };
  }
}
