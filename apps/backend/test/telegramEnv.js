// Points the Telegram integration at a local mock server. Imported right after setup.js.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHAT_ID = '1001';
process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:8722';
