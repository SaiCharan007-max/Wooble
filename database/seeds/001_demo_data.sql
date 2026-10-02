-- Demo data. Passwords: admin@homecare.demo / Admin@123, anita@homecare.demo / Care@123, rahul@homecare.demo / Care@123
-- Ids are fixed so the sensor simulator (packages/shared DEMO_PATIENTS) can address the same patients.

INSERT INTO users (id, email, password_hash, full_name, role) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'admin@homecare.demo',
   '$2b$10$RgifxjYu4XJ4ttQDLBpU6.K1M0/1bjueGlA0AkabmKRkAls40cvqy', 'Demo Admin', 'ADMIN'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'anita@homecare.demo',
   '$2b$10$.hqhxoY6oV6z3xnXsBM6GOt2GJTnavDNT6XJ62qP7sp9gSNjYniA6', 'Anita Sharma', 'CAREGIVER'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'rahul@homecare.demo',
   '$2b$10$.hqhxoY6oV6z3xnXsBM6GOt2GJTnavDNT6XJ62qP7sp9gSNjYniA6', 'Rahul Verma', 'CAREGIVER');

INSERT INTO caregivers (id, user_id, full_name, phone) VALUES
  ('cccccccc-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'Anita Sharma', '+91 90000 11111'),
  ('cccccccc-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003', 'Rahul Verma', '+91 90000 22222');

INSERT INTO patients (id, name, age, gender, medications, emergency_contact, assigned_caregiver_id) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Ramesh Kumar', 68, 'MALE',
   ARRAY['Amlodipine 5 mg once daily', 'Metformin 500 mg twice daily'],
   'Priya Kumar (daughter) +91 90000 33333', 'cccccccc-0000-4000-8000-000000000001'),
  ('22222222-2222-4222-8222-222222222222', 'Lakshmi Devi', 76, 'FEMALE',
   ARRAY['Tiotropium inhaler once daily', 'Furosemide 40 mg once daily', 'Bisoprolol 2.5 mg once daily'],
   'Suresh Devi (son) +91 90000 44444', 'cccccccc-0000-4000-8000-000000000001'),
  ('33333333-3333-4333-8333-333333333333', 'Joseph D''Souza', 71, 'MALE',
   ARRAY['Amoxicillin-clavulanate 625 mg three times daily', 'Apixaban 5 mg twice daily'],
   'Maria D''Souza (wife) +91 90000 55555', 'cccccccc-0000-4000-8000-000000000002');

INSERT INTO patient_conditions (patient_id, condition, risk_category) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Hypertension', 'CARDIAC'),
  ('11111111-1111-4111-8111-111111111111', 'Type 2 diabetes', 'METABOLIC'),
  ('22222222-2222-4222-8222-222222222222', 'COPD', 'RESPIRATORY'),
  ('22222222-2222-4222-8222-222222222222', 'Chronic heart failure', 'CARDIAC'),
  ('33333333-3333-4333-8333-333333333333', 'Pneumonia (recovering)', 'RESPIRATORY'),
  ('33333333-3333-4333-8333-333333333333', 'Atrial fibrillation', 'CARDIAC');

INSERT INTO sensor_devices (device_uid, patient_id) VALUES
  ('WEAR-001', '11111111-1111-4111-8111-111111111111'),
  ('WEAR-002', '22222222-2222-4222-8222-222222222222'),
  ('WEAR-003', '33333333-3333-4333-8333-333333333333');

-- 30 minutes of history (one reading per minute) so charts and trends have context on first launch.
-- Patient 1: stable
INSERT INTO vital_readings (patient_id, "timestamp", heart_rate, spo2, temperature, systolic_bp, diastolic_bp,
                            respiratory_rate, source, sequence_number)
SELECT '11111111-1111-4111-8111-111111111111', now() - make_interval(mins => 31 - g),
       round(78 + random() * 4 - 2), round(97 + random() - 0.5), round((36.8 + random() * 0.2 - 0.1)::numeric, 1),
       round(122 + random() * 6 - 3), round(78 + random() * 4 - 2), round(16 + random() * 2 - 1), 'SEED', g
FROM generate_series(0, 29) AS g;

-- Patient 2: gradually deteriorating (normal -> mildly abnormal)
INSERT INTO vital_readings (patient_id, "timestamp", heart_rate, spo2, temperature, systolic_bp, diastolic_bp,
                            respiratory_rate, source, sequence_number)
SELECT '22222222-2222-4222-8222-222222222222', now() - make_interval(mins => 31 - g),
       round(80 + 6 * g / 29.0 + random() * 2 - 1), round(97 - 2 * g / 29.0), round((36.9 + 0.4 * g / 29.0)::numeric, 1),
       round(128 - 4 * g / 29.0 + random() * 4 - 2), round(80 - 2 * g / 29.0), round(16 + 3 * g / 29.0), 'SEED', g
FROM generate_series(0, 29) AS g;

-- Patient 3: recovering (abnormal -> improving)
INSERT INTO vital_readings (patient_id, "timestamp", heart_rate, spo2, temperature, systolic_bp, diastolic_bp,
                            respiratory_rate, source, sequence_number)
SELECT '33333333-3333-4333-8333-333333333333', now() - make_interval(mins => 31 - g),
       round(108 - 10 * g / 29.0 + random() * 2 - 1), round(91 + 2 * g / 29.0), round((38.6 - 0.6 * g / 29.0)::numeric, 1),
       round(106 + 6 * g / 29.0 + random() * 4 - 2), round(66 + 4 * g / 29.0), round(25 - 3 * g / 29.0), 'SEED', g
FROM generate_series(0, 29) AS g;

INSERT INTO caregiver_notes (patient_id, caregiver_id, author_user_id, note, language, translated_text,
                             extracted_signals, extraction_method, "timestamp") VALUES
  ('11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002',
   'Walked in the garden this morning, eating well, no complaints.', 'en',
   'Walked in the garden this morning, eating well, no complaints.', '[]', 'rule-based-v1', now() - interval '50 minutes'),
  ('22222222-2222-4222-8222-222222222222', 'cccccccc-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002',
   'Patient is more tired than usual and reports difficulty breathing.', 'en',
   'Patient is more tired than usual and reports difficulty breathing.',
   '[{"signal":"breathing_difficulty","label":"Breathing difficulty","evidence":"difficulty breathing"},
     {"signal":"fatigue","label":"Fatigue","evidence":"tired"}]', 'rule-based-v1', now() - interval '20 minutes'),
  ('33333333-3333-4333-8333-333333333333', 'cccccccc-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003',
   'Fever is coming down and he ate a little more today. No chest pain.', 'en',
   'Fever is coming down and he ate a little more today. No chest pain.', '[]', 'rule-based-v1',
   now() - interval '3 hours');

-- Attendance: Anita is on shift; Rahul checked out (so a HIGH alert for his patient escalates).
INSERT INTO caregiver_attendance (caregiver_id, patient_id, type, note, created_at) VALUES
  ('cccccccc-0000-4000-8000-000000000001', NULL, 'CHECK_IN', 'Morning shift', now() - interval '2 hours'),
  ('cccccccc-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'VISIT', 'Morning medication given', now() - interval '90 minutes'),
  ('cccccccc-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'VISIT', 'Inhaler given, patient tired', now() - interval '20 minutes'),
  ('cccccccc-0000-4000-8000-000000000002', NULL, 'CHECK_IN', 'Night shift', now() - interval '14 hours'),
  ('cccccccc-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333', 'VISIT', 'Antibiotics given', now() - interval '4 hours'),
  ('cccccccc-0000-4000-8000-000000000002', NULL, 'CHECK_OUT', 'End of shift', now() - interval '3 hours');

INSERT INTO audit_logs (actor, action, entity_type, metadata) VALUES
  ('system', 'SEED_DATA_LOADED', 'database', '{"patients":3,"caregivers":2}');
