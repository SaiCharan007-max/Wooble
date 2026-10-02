# Likely judge questions, with answers

## Concept

**Q: Explain your system in one line.**
A: Simulated wearables send vitals through a home hub to a FastAPI platform. A risk engine combines NEWS2, trend
prediction and caregiver-note analysis into LOW/MEDIUM/HIGH with a reason. Alerts escalate until a caregiver
acknowledges them, and everything is logged.

**Q: What is NEWS2 and why did you use it?**
A: The National Early Warning Score 2 from the UK's Royal College of Physicians. It's used on hospital wards to spot
deteriorating patients. It scores 7 parameters (respiratory rate, SpO2, oxygen use, systolic BP, heart rate,
consciousness, temperature) from 0 to 3 each. I used it because it's clinically validated and fully explainable:
every point traces back to one vital sign and one threshold.

**Q: What's SpO2 scale 2?**
A: COPD patients normally live at 88–92% saturation. On the normal scale they'd always score 3 and be in permanent
alarm. Scale 2 treats 88–92% as normal for them. Our patient P003 uses it.

## AI / ML

**Q: Where is the AI? It looks like rules.**
A: It's a hybrid, explainable AI: a clinical scoring model, a statistical time-series model that fits trends and
projects them, and a rule-based NLP model for notes. I chose this over a black-box model for three reasons: (1) there's
no labelled patient outcome data to train on honestly, (2) the brief asks for explainability and clinical safety, and
(3) caregivers need to trust *why*. The interfaces are designed so a trained model (for example gradient boosting on
MIMIC-IV) can replace the trend module later, inside the same safety rules.

**Q: How do you predict 24–48 hours ahead?**
A: I take the last 6 hours of each vital, fit a least-squares line, and keep it only if it's statistically meaningful
(R² ≥ 0.3 and the slope is above a noise threshold). Then I project forward with *damping*, because the body doesn't
change linearly forever, and re-score NEWS2 for each hour up to 48. If two or more vitals are worsening with at least
moderate confidence and the projection reaches HIGH, I raise an early warning while the patient still looks fine.

**Q: How do you avoid false alarms?**
A: Trends must pass R² and minimum-slope tests. Early warnings need at least 2 worsening vitals and moderate
confidence. Sensor artifacts are rejected. There's one alert per patient per type, so no storms. De-escalation needs
3 consecutive improved readings, so the risk doesn't flip-flop.

**Q: How do you handle notes like "no chest pain"?**
A: Negation detection. If a negating word (no, not, denies, without, n't) appears within the 4 words before a symptom
in the same clause, that symptom is marked as ruled out. "Fell asleep" is also excluded from "fall". It's in the tests.

**Q: Multilingual?**
A: English is fully supported (the requirement). As a bonus, there are basic Hindi and Telugu keywords in native script
and romanised form. Production would use a translation model or a multilingual LLM in front of the same pipeline.

**Q: Why not use ChatGPT/an LLM?**
A: Privacy (patient notes would leave the home), cost, latency, availability during outages, and LLMs can
hallucinate. An LLM could be added later as an extra signal that is only allowed to *raise* risk.

## Clinical safety

**Q: What if the AI is wrong?**
A: The design fails safe. The vitals score is a floor that notes or predictions can never lower. Red-flag symptoms go
straight to HIGH. Clinical alerts never auto-close; a human must resolve them. Unacknowledged alerts escalate up to
the doctor or 108. Every screen says "decision support, not a diagnosis" and gives a recommended action.

**Q: What if the sensor gives a wrong value?**
A: Physically impossible values (SpO2 = 0, HR = 300) are rejected as artifacts, flagged, and shown as gaps. The engine
looks back over recent readings for the last valid value, and missing parameters are reported, not assumed normal.

## Reliability

**Q: What if the internet goes down?**
A: The home hub writes every reading to a local SQLite outbox *before* sending. If sending fails, it keeps buffering
and replays in order when the connection returns. While offline, it runs NEWS2 locally and sounds a local alarm.
The server notices the silence after 12 seconds and raises a "device offline" alert to the caregiver. (Show it live
with the outage button.)

**Q: Won't replaying cause duplicate data?**
A: No. Each reading has a per-device sequence number, and the database has a UNIQUE constraint on (device, sequence),
so re-sent readings are counted as duplicates and ignored. Ingestion is idempotent.

**Q: Power cut?**
A: The hub reports when it runs on battery backup, and that's logged. The outbox is on disk, so even if the hub
reboots it resumes with no loss. Low wearable battery raises its own alert.

**Q: What if the dashboard disconnects?**
A: The WebSocket reconnects automatically, and the dashboard falls back to polling every 3 seconds in the meantime.

## Engineering

**Q: Why this tech stack?**
A: Python because the AI and the simulator are in Python. FastAPI because it's async, supports WebSockets, and gives
free validation and API docs (/docs). SQLite because there's no setup and WAL mode is plenty for a prototype. Vanilla
JS because there's no build step and no CDN, so it works on a home network without internet.

**Q: How would you scale it?**
A: Swap SQLite for PostgreSQL/TimescaleDB, put MQTT or Kafka between the hubs and the platform, run stateless API
instances behind a load balancer, and move WebSocket fan-out to Redis pub/sub. The risk engine is a pure function, so
it scales horizontally.

**Q: Security and privacy?**
A: Devices authenticate with a key, inputs are validated and size-limited, and output is HTML-escaped. No data goes
to third parties. For production: TLS, caregiver login with roles, encryption at rest, audit logs (already there),
consent and retention policies under India's DPDP Act.

**Q: How did you test it?**
A: There are 24 automated tests covering the scoring thresholds, negation, every safety rule, early-warning
prediction, and the full API flow from sensor to alert to acknowledge to resolve. I also ran it end to end:
killed the server mid-stream and checked that the buffered data was backfilled.

**Q: How is caregiver attendance verified?**
A: Caregivers check in on the dashboard, and each check-in is logged with a time and method. If nobody checks in
within the expected interval, an alert is raised. In production the check-in would be NFC or QR at the bedside, or
BLE proximity, so it can't be faked remotely.

## Limitations (say them before they ask)
- NEWS2 is validated in hospitals, not homes.
- The prediction model isn't trained on outcome data.
- The lexicon NLP can miss unusual phrasing.
- No login in the prototype.
