# 3-minute demo video script

**Before recording**
1. Run `python run_demo.py --fresh` and **start recording immediately**. P001's sepsis begins at once.
2. Put the terminal with the simulator output side by side with the browser, or switch between them.
3. Set the "Signed in as" name to "Priya (caregiver)".

---

### 0:00–0:20 · Problem and idea
> "At home, a patient usually has family, a thermometer and guesswork. HomeWard turns the bedroom into a small,
> always-aware ward. It senses, understands, predicts, alerts, and records the response."

Show the dashboard with three patients.

### 0:20–0:45 · Sense (IoT)
Show the simulator terminal.
> "No hardware: each patient has a virtual wearable sending heart rate, SpO2, breathing rate, temperature, BP and
> consciousness. A home hub batches them and sends them to the platform. One second is ten minutes of patient time."

Point at the live charts and the "wearable online / battery / power" line.

### 0:45–1:25 · Understand and predict (AI)
Click **Ramesh Kumar (P001)**.
> "His vitals are still almost normal, NEWS2 is 1. But the trend engine sees heart rate, temperature and breathing
> slowly rising and blood pressure falling. It projects HIGH risk in about 40 hours. That's an early warning a day or
> two ahead."

Point at the *EARLY WARNING* banner, the "Why" reasons, the +6h…+48h timeline, and the R² values.
> "Every decision is explainable. It's NEWS2, the score hospitals use, plus trends I can show line by line."

### 1:25–1:50 · Caregiver notes
Click the "Sample: Worrying" button and **Add note** (or use the Hindi sample).
> "Caregivers write notes in plain language. The system finds confusion, refusing food and fever, understands
> negations like 'no chest pain', and raises the risk. Notes can raise risk but never lower it. That's a safety rule."

### 1:50–2:25 · Alert, escalation and response
By now P001 is HIGH (red pulsing card).
> "Now he's HIGH. An alert went to the caregiver. Nobody responded within 45 seconds, so it escalated to family and
> the nurse, then to the doctor."

Point at the audit trail escalation lines. Type "Checked patient, called Dr. Rao" and press **Acknowledge**.
> "The caregiver acknowledges and records what they did. The response time is logged."

### 2:25–2:50 · Resilience
Open **Demo controls**, then **Simulate 20s network outage**.
> "If the internet drops, the hub keeps recording to a local buffer and sounds a local alarm if needed."

Show the simulator terminal (OFFLINE, buffering), then the dashboard ("wearable offline" alert). After reconnecting:
> "When the connection returns, every buffered reading is back-filled, the yellow dots on the chart, with no
> duplicates and no data lost."

Optional: click **Unplug P003 oxygen concentrator** and show the equipment alert.

### 2:50–3:00 · Close
> "Sensor, platform, AI risk, alert, caregiver response, end to end. It's explainable, clinically cautious, and keeps
> working when the network doesn't."
