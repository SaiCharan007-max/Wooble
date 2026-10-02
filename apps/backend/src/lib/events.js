// In-process domain events. Lets notification channels (Telegram, ...) react to alert changes
// without the alert service depending on them.
import { EventEmitter } from 'node:events';

export const domainEvents = new EventEmitter();
domainEvents.setMaxListeners(20);

export const ALERT_CHANGED = 'alert.changed'; // payload: { change, alertId }
