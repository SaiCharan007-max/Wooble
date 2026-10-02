// Caregiver phone alerts via a Telegram bot.
//  * New / upgraded / escalated alerts -> a new message (the phone buzzes) with Acknowledge / Escalate buttons.
//  * Acknowledged / responded / resolved -> the same message is updated in place (no extra buzz).
//  * Button taps are received by long-polling getUpdates, so no public URL or webhook is needed.
//  * Send /start to the bot to get your chat id for TELEGRAM_CHAT_ID.
import { env } from '../config/env.js';
import { ALERT_CHANGED, domainEvents } from '../lib/events.js';
import { logger } from '../lib/logger.js';
import { alertRepository } from '../repositories/alertRepository.js';
import { notificationRepository } from '../repositories/notificationRepository.js';
import { patientRepository } from '../repositories/patientRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { alertService } from './alertService.js';
import { audit, SYSTEM_CTX } from './auditService.js';

const CHANNEL = 'telegram';
const NEW_MESSAGE_CHANGES = new Set(['created', 'upgraded', 'escalated']);
const UPDATE_CHANGES = new Set(['acknowledged', 'response', 'resolved']);
const pending = new Set();
let polling = false;
let started = false;

export const telegramEnabled = () => Boolean(env.telegramBotToken && env.telegramChatId);

async function tg(method, body, timeoutMs = 10000) {
  const res = await fetch(`${env.telegramApiBase}/bot${env.telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.description || `telegram ${method} failed (${res.status})`);
  return data.result;
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ICON = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟡' };
const CATEGORY_ICON = { DEVICE: '📡', EQUIPMENT: '🫁' };

export function formatAlert(alert) {
  const icon = CATEGORY_ICON[alert.category] || ICON[alert.risk_level] || '⚠️';
  const lines = [
    `${icon} <b>${esc(alert.risk_level)} — ${esc(alert.patient_name)}</b>`,
    `<b>${esc(alert.title)}</b>`,
    '',
    esc(alert.description),
    '',
  ];
  const time = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (alert.status === 'ESCALATED') lines.push(`⬆️ <b>Escalated</b>: ${esc(alert.escalation_reason)}`);
  if (alert.acknowledged_by_name) lines.push(`✅ Acknowledged by ${esc(alert.acknowledged_by_name)} at ${time(alert.acknowledged_at)}`);
  for (const r of (alert.actions || []).filter((a) => a.action === 'RESPONSE')) lines.push(`💬 ${esc(r.actor_label)}: ${esc(r.note)}`);
  if (alert.status === 'RESOLVED') lines.push(`✔️ Resolved at ${time(alert.resolved_at)}`);
  lines.push(`Status: <b>${alert.status}</b>`, '', `<a href="${env.dashboardUrl}/patients/${alert.patient_id}">Open in HomeWard</a>`,
    '<i>Prototype risk signal — not a medical device.</i>');

  let buttons = [];
  if (alert.status === 'OPEN' || alert.status === 'ESCALATED') {
    buttons = [[{ text: '✅ Acknowledge', callback_data: `ack:${alert.id}` }, { text: '⬆️ Escalate', callback_data: `esc:${alert.id}` }]];
  } else if (alert.status === 'ACKNOWLEDGED') {
    buttons = [[{ text: '✔️ Resolve', callback_data: `res:${alert.id}` }]];
  }
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
}

async function sendNew(alert, chatId, kind) {
  try {
    const msg = await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true, ...formatAlert(alert) });
    await notificationRepository.insert({
      alertId: alert.id, channel: CHANNEL, recipient: String(chatId), kind, status: 'SENT', externalId: String(msg.message_id),
    });
    await audit(SYSTEM_CTX, 'NOTIFICATION_SENT', 'alert', alert.id, { patientId: alert.patient_id, channel: CHANNEL, kind });
    logger.info({ event_type: 'NOTIFICATION_SENT', alert_id: alert.id, channel: CHANNEL, kind });
  } catch (err) {
    await notificationRepository.insert({ alertId: alert.id, channel: CHANNEL, recipient: String(chatId), kind, status: 'FAILED', error: err.message });
    logger.warn({ event_type: 'NOTIFICATION_FAILED', alert_id: alert.id, err: err.message });
  }
}

async function updateExisting(alert, chatId) {
  const last = await notificationRepository.lastSent(alert.id, CHANNEL, String(chatId));
  if (!last) return;
  try {
    await tg('editMessageText', {
      chat_id: chatId, message_id: Number(last.external_id), parse_mode: 'HTML', disable_web_page_preview: true, ...formatAlert(alert),
    });
  } catch (err) {
    if (!/message is not modified/.test(err.message)) logger.warn({ event_type: 'NOTIFICATION_UPDATE_FAILED', alert_id: alert.id, err: err.message });
  }
}

async function onAlertChanged({ change, alertId }) {
  const alert = await alertRepository.findById(alertId);
  if (!alert) return;
  // Escalations also go to the escalation contact (family / on-call nurse) when configured.
  const recipients = [env.telegramChatId];
  if (change === 'escalated' && env.telegramEscalationChatId) recipients.push(env.telegramEscalationChatId);
  for (const chatId of recipients) {
    if (NEW_MESSAGE_CHANGES.has(change)) await sendNew(alert, chatId, change);
    else if (UPDATE_CHANGES.has(change)) await updateExisting(alert, chatId);
  }
}

// ------------------------------------------------------------------ incoming: buttons and commands
const authorisedChats = () => new Set([env.telegramChatId, env.telegramEscalationChatId].filter(Boolean).map(String));

async function handleCallback(cq) {
  const chatId = String(cq.message?.chat?.id);
  if (!authorisedChats().has(chatId)) {
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'This chat is not authorised.' });
    return;
  }
  const [action, alertId] = String(cq.data || '').split(':');
  const user = await userRepository.findByEmail(env.telegramUserEmail);
  const name = `${user?.full_name || 'Caregiver'} (Telegram)`;
  const ctx = {
    requestId: `telegram-${cq.id}`, actor: `${name}`, actorUserId: user?.id || null,
    user: { name, role: user?.role, caregiverId: user?.caregiver_id },
  };
  const actions = {
    ack: ['acknowledge', '✅ Acknowledged'],
    esc: ['escalate', '⬆️ Escalated'],
    res: ['resolve', '✔️ Resolved'],
  };
  const [method, done] = actions[action] || [];
  let text = 'Unknown action';
  if (method) {
    try {
      await alertService[method](alertId, ctx, 'via Telegram');
      text = done;
    } catch (err) {
      text = err.message;
    }
  }
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text });
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim().toLowerCase();
  if (text.startsWith('/start') || text.startsWith('/id')) {
    logger.info({ event_type: 'TELEGRAM_START', chat_id: chatId }, 'Telegram /start received - set TELEGRAM_CHAT_ID to this chat id');
    await tg('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `👋 HomeWard alerts bot.\nYour chat id is <code>${esc(chatId)}</code>.\n` +
        'Set it as TELEGRAM_CHAT_ID in .env and restart the backend to receive caregiver alerts here.',
    });
  } else if (text.startsWith('/status') && authorisedChats().has(chatId)) {
    const patients = await patientRepository.list();
    const lines = patients.map((p) => `${ICON[p.latest_risk?.risk_level] || '⚪'} <b>${esc(p.name)}</b>: ${p.latest_risk?.risk_level || 'no data'}` +
      ` (${p.latest_risk?.risk_score ?? '-'}/100)${p.active_alerts ? ` · ${p.active_alerts} active alert(s)` : ''}`);
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: lines.join('\n') || 'No patients' });
  }
}

async function pollLoop() {
  let offset = 0;
  while (polling) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) await handleCallback(u.callback_query).catch((e) => logger.warn({ err: e.message }, 'telegram callback failed'));
        else if (u.message) await handleMessage(u.message).catch((e) => logger.warn({ err: e.message }, 'telegram message failed'));
      }
    } catch (err) {
      if (!polling) break;
      logger.warn({ event_type: 'TELEGRAM_POLL_FAILED', err: err.message });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export const notificationService = {
  /** Subscribe to alert changes and (if a bot token is set) start listening for button taps. */
  start({ poll = true } = {}) {
    if (started) return;
    started = true;
    if (!env.telegramBotToken) {
      logger.info('Telegram not configured (TELEGRAM_BOT_TOKEN empty) - phone alerts disabled');
      return;
    }
    if (!env.telegramChatId) logger.warn('TELEGRAM_CHAT_ID empty - send /start to the bot to get your chat id');
    const chains = new Map(); // per alert, so "created" is sent before "acknowledged" edits it
    domainEvents.on(ALERT_CHANGED, (event) => {
      if (!telegramEnabled()) return;
      const p = (chains.get(event.alertId) || Promise.resolve())
        .then(() => onAlertChanged(event))
        .catch((err) => logger.error({ err: err.message }, 'notification failed'));
      chains.set(event.alertId, p);
      pending.add(p);
      p.finally(() => {
        pending.delete(p);
        if (chains.get(event.alertId) === p) chains.delete(event.alertId);
      });
    });
    if (poll) {
      polling = true;
      pollLoop();
    }
    logger.info({ chat: env.telegramChatId || '(not set)' }, 'Telegram phone alerts enabled');
  },

  stop() {
    polling = false;
  },

  /** Wait for in-flight notifications (used by tests and graceful shutdown). */
  async flush() {
    while (pending.size) await Promise.allSettled([...pending]);
  },
};
