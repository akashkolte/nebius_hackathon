import { loadConfig } from './config.ts';
import { createApp } from './server.ts';

const config = loadConfig();
const { server, health, store } = createApp(config);

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') throw error;
  console.error(`Port ${config.port} is already in use, probably by another Dispatch server.`);
  console.error(`Stop it with:  lsof -ti tcp:${config.port} | xargs kill`);
  console.error(`Or use another port:  PORT=${config.port + 1} npm start`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`Dispatch is running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Nebius: ${config.nebius.baseUrl} (${config.nebius.apiKey ? 'API key set' : 'no API key — set NEBIUS_API_KEY'})`);
  health.refresh(true).then(snapshot => {
    for (const [name, status] of Object.entries(snapshot)) console.log(`  ${name.padEnd(9)} ${status.state.padEnd(10)} ${status.detail}`);
  }).catch(error => console.error('Health check failed:', error.message));
});
setInterval(() => health.refresh().catch(() => {}), 60000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { store.flush(); server.close(); process.exit(0); });
}
