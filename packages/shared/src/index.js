// Constants shared by the backend, sensor simulator and frontend.
// Keeping them in one place guarantees every service speaks the same language.

export const DISCLAIMER =
  'This prototype is for demonstration purposes only and is not a medical device or substitute for professional medical judgment.';

export const RISK_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
export const ALERT_STATUSES = Object.freeze(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED']);
export const ROLES = Object.freeze({ ADMIN: 'ADMIN', CAREGIVER: 'CAREGIVER' });

export const SCENARIOS = Object.freeze([
  'NORMAL',
  'GRADUAL_DETERIORATION',
  'SUDDEN_DETERIORATION',
  'RECOVERY',
  'SENSOR_FAILURE',
  'NETWORK_FAILURE',
]);
export const SPEEDS = Object.freeze([1, 5, 10]);

// Physically plausible limits. Anything outside is a sensor error, not a vital sign.
export const VITAL_LIMITS = Object.freeze({
  heart_rate: { min: 20, max: 250 },
  spo2: { min: 50, max: 100 },
  temperature: { min: 30, max: 43 },
  systolic_bp: { min: 50, max: 260 },
  diastolic_bp: { min: 20, max: 160 },
  respiratory_rate: { min: 4, max: 60 },
});

// Adult reference ranges used for display (green band on charts).
export const REFERENCE_RANGES = Object.freeze({
  heart_rate: { low: 51, high: 90, unit: 'bpm', label: 'Heart rate' },
  spo2: { low: 96, high: 100, unit: '%', label: 'SpO2' },
  temperature: { low: 36.1, high: 38.0, unit: '°C', label: 'Temperature' },
  respiratory_rate: { low: 12, high: 20, unit: '/min', label: 'Respiratory rate' },
  systolic_bp: { low: 111, high: 219, unit: 'mmHg', label: 'Systolic BP' },
  diastolic_bp: { low: 60, high: 90, unit: 'mmHg', label: 'Diastolic BP' },
});

// Demo patients / devices (ids match database/seeds).
export const DEMO_PATIENTS = Object.freeze([
  {
    patientId: '11111111-1111-4111-8111-111111111111',
    deviceUid: 'WEAR-001',
    name: 'Ramesh Kumar',
    defaultScenario: 'NORMAL',
    start: { heart_rate: 78, spo2: 97, respiratory_rate: 16, temperature: 36.8, systolic_bp: 122, diastolic_bp: 78 },
  },
  {
    patientId: '22222222-2222-4222-8222-222222222222',
    deviceUid: 'WEAR-002',
    name: 'Lakshmi Devi',
    defaultScenario: 'GRADUAL_DETERIORATION',
    start: { heart_rate: 86, spo2: 95, respiratory_rate: 19, temperature: 37.3, systolic_bp: 124, diastolic_bp: 78 },
  },
  {
    patientId: '33333333-3333-4333-8333-333333333333',
    deviceUid: 'WEAR-003',
    name: "Joseph D'Souza",
    defaultScenario: 'RECOVERY',
    start: { heart_rate: 98, spo2: 93, respiratory_rate: 22, temperature: 38.0, systolic_bp: 112, diastolic_bp: 70 },
  },
]);

export const SOCKET_EVENTS = Object.freeze({
  VITAL_NEW: 'vital:new',
  RISK_UPDATE: 'risk:update',
  ALERT_NEW: 'alert:new',
  ALERT_UPDATED: 'alert:updated',
  DEVICE_STATUS: 'device:status',
  DEVICE_SYNCED: 'device:synced',
  CAREGIVER_ACTIVITY: 'caregiver:activity',
  NOTE_NEW: 'note:new',
});
