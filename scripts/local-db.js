// Starts a project-local PostgreSQL server (no Docker, no system install needed).
// Data lives in .local/pgdata. Creates the `homecare` and `homecare_test` databases on first run.
//   npm run db:start      (keep this terminal open; Ctrl+C stops Postgres)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.local', 'pgdata');
const port = Number(process.env.LOCAL_PG_PORT || 5433);
const firstRun = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'homecare',
  password: 'homecare',
  port,
  persistent: true,
  // Windows defaults to the WIN1252 code page; vitals explanations use Unicode (e.g. "→"), so force UTF-8.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: (e) => console.error(String(e)),
});

if (firstRun) {
  console.log('Initialising local PostgreSQL cluster in .local/pgdata ...');
  await pg.initialise();
}
await pg.start();
for (const name of ['homecare', 'homecare_test']) {
  try {
    await pg.createDatabase(name);
    console.log(`created database ${name}`);
  } catch {
    /* already exists */
  }
}
console.log(`PostgreSQL running on localhost:${port} (user homecare / password homecare). Ctrl+C to stop.`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
