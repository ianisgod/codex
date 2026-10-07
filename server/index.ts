import { createApp } from './app.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { createApp } from './app.js';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`GENESIS API listening on http://${host}:${port}`);
  });
  function shutdown() {
    server.close(() => {
      app.locals.database.close();
      process.exit(0);
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
