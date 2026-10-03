// Sensor simulator service: virtual wearables + home hub + demo control API (port 4100).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { Simulator } from './simulator.js';
import { FileStore, httpSender, Uplink } from './uplink.js';

const log = (msg) => console.log(JSON.stringify({ time: new Date().toISOString(), service: 'sensor-simulator', msg }));

const uplink = new Uplink({
  send: httpSender({ backendUrl: config.backendUrl, deviceApiKey: config.deviceApiKey }),
  store: new FileStore(path.join(config.dataDir, 'buffer.json')),
  batchSize: config.batchSize,
  baseDelayMs: config.retryBaseMs,
  maxDelayMs: config.retryMaxMs,
  log,
});
const simulator = new Simulator({
  uplink, stateStore: new FileStore(path.join(config.dataDir, 'state.json')), log, calm: config.demoStart === 'calm',
});
if (uplink.size) log(`resuming with ${uplink.size} buffered readings from a previous run`);

// ---------------------------------------------------------------- tick loop
let running = false;
setInterval(async () => {
  if (running) return; // never overlap ticks
  running = true;
  try {
    await simulator.tick();
  } catch (err) {
    log(`tick error: ${err.message}`);
  } finally {
    running = false;
  }
}, config.tickMs);

// ---------------------------------------------------------------- control API
const app = express();
app.use(express.json());

const requireToken = (req, res, next) =>
  req.get('x-control-token') === config.controlToken ? next() : res.status(401).json({ error: 'invalid control token' });

app.get('/health', (_req, res) => res.json({ status: 'ok', buffered: uplink.size }));
app.get('/status', requireToken, (_req, res) => res.json(simulator.status()));
app.post('/control', requireToken, (req, res) => {
  try {
    res.json(simulator.control(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/reset', requireToken, (_req, res) => res.json(simulator.reset()));
// Silence a local alarm from the home-hub screen (works with no internet at all).
app.post('/alarms/:patientId/ack', requireToken, (req, res) =>
  res.json({ acknowledged: simulator.acknowledgeAlarm(req.params.patientId), alarms: simulator.hub.list() }));

// Home-hub screen + demo controls (local use only; it embeds the control token).
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/token.js', (_req, res) => res.type('js').send(`window.CONTROL_TOKEN=${JSON.stringify(config.controlToken)};`));

app.listen(config.port, () => log(`simulator control API on http://localhost:${config.port} -> sending to ${config.backendUrl}`));
