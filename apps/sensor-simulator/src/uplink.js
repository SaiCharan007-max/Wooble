// Store-and-forward uplink between the home sensors and the backend.
//  * every reading goes into a durable local buffer FIRST, then is sent
//  * if sending fails (backend down, network failure) readings stay buffered
//  * retries use exponential backoff with jitter: 1s, 2s, 4s ... capped at 30s
//  * on reconnection the buffer is uploaded in order, in batches
//  * the backend is idempotent on (device_id, sequence_number), so re-sending is always safe
import fs from 'node:fs';
import path from 'node:path';

export class FileStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  load(fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  save(value) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, this.file); // atomic replace: a crash never leaves a half-written buffer
  }
}

export class MemoryStore {
  constructor(initial) {
    this.value = initial;
  }

  load(fallback) {
    return this.value ?? fallback;
  }

  save(value) {
    this.value = JSON.parse(JSON.stringify(value));
  }
}

export class SendError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** POST a batch to the backend. Throws SendError on network errors and non-2xx responses. */
export function httpSender({ backendUrl, deviceApiKey, timeoutMs = 5000 }) {
  return async (readings) => {
    let res;
    try {
      res = await fetch(`${backendUrl}/api/vitals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device-key': deviceApiKey },
        body: JSON.stringify({ readings }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SendError(`network error: ${err.cause?.code || err.message}`);
    }
    if (!res.ok) throw new SendError(`backend responded ${res.status}`, res.status);
    return res.json();
  };
}

export class Uplink {
  constructor({ send, store = new MemoryStore([]), batchSize = 100, baseDelayMs = 1000, maxDelayMs = 30000,
    now = Date.now, random = Math.random, log = () => {} }) {
    this.send = send;
    this.store = store;
    this.buffer = store.load([]);
    this.batchSize = batchSize;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.now = now;
    this.random = random;
    this.log = log;
    this.forcedOffline = false;
    this.connected = true;
    this.attempt = 0;
    this.nextAttemptAt = 0;
    this.inFlight = false;
    this.lastError = null;
    this.lastSync = null;
    this.stats = { sent: 0, duplicates: 0, rejected: 0, syncedAfterOutage: 0 };
  }

  get size() {
    return this.buffer.length;
  }

  /** Readings created while we cannot deliver are tagged BUFFERED so the dashboard can show them. */
  enqueue(reading) {
    const offline = this.forcedOffline || !this.connected;
    this.buffer.push({ ...reading, source: offline ? 'BUFFERED' : 'LIVE' });
    this.store.save(this.buffer);
  }

  setForcedOffline(offline) {
    this.forcedOffline = offline;
    if (!offline) {
      this.attempt = 0;
      this.nextAttemptAt = 0; // retry immediately when the connection is restored
    }
  }

  backoffDelay() {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, this.attempt - 1));
    return Math.round(exp + this.random() * 250);
  }

  /** Try to upload everything in the buffer. Safe to call every tick. */
  async flush() {
    if (this.forcedOffline || this.inFlight || !this.buffer.length) return { status: 'idle' };
    if (this.now() < this.nextAttemptAt) return { status: 'waiting', retryInMs: this.nextAttemptAt - this.now() };
    this.inFlight = true;
    const wasDisconnected = !this.connected;
    let delivered = 0;
    try {
      while (this.buffer.length && !this.forcedOffline) {
        const batch = this.buffer.slice(0, this.batchSize);
        let result;
        try {
          result = await this.send(batch);
        } catch (err) {
          if (err.status === 400 || err.status === 413) {
            // a malformed batch would block the queue forever: drop it and keep going
            this.log(`dropping malformed batch of ${batch.length}: ${err.message}`);
            this.buffer.splice(0, batch.length);
            this.store.save(this.buffer);
            continue;
          }
          throw err;
        }
        this.buffer.splice(0, batch.length);
        this.store.save(this.buffer);
        delivered += batch.length;
        this.stats.sent += result?.created ?? batch.length;
        this.stats.duplicates += result?.duplicates ?? 0;
        this.stats.rejected += result?.rejected ?? 0;
      }
      if (wasDisconnected) {
        this.stats.syncedAfterOutage += delivered;
        this.log(`connection restored - uploaded ${delivered} buffered readings`);
      }
      this.connected = true;
      this.attempt = 0;
      this.nextAttemptAt = 0;
      this.lastError = null;
      this.lastSync = new Date(this.now()).toISOString();
      return { status: 'sent', delivered };
    } catch (err) {
      this.connected = false;
      this.attempt += 1;
      const delay = this.backoffDelay();
      this.nextAttemptAt = this.now() + delay;
      this.lastError = err.message;
      // everything still waiting is now, by definition, buffered data
      this.buffer = this.buffer.map((r) => ({ ...r, source: 'BUFFERED' }));
      this.store.save(this.buffer);
      this.log(`send failed (${err.message}) - ${this.buffer.length} buffered, retry #${this.attempt} in ${delay} ms`);
      return { status: 'failed', retryInMs: delay, delivered };
    } finally {
      this.inFlight = false;
    }
  }

  status() {
    return {
      mode: this.forcedOffline ? 'OFFLINE' : this.connected ? 'ONLINE' : 'RETRYING',
      buffered: this.buffer.length,
      attempt: this.attempt,
      nextRetryInMs: this.nextAttemptAt ? Math.max(0, this.nextAttemptAt - this.now()) : 0,
      lastError: this.lastError,
      lastSync: this.lastSync,
      stats: this.stats,
    };
  }
}
