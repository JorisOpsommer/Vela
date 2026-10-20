import crypto from 'node:crypto';
import { loadConfig } from './config';
import { buildApp } from './app';
import { createServices, ensureAdmin } from './bootstrap';

if (typeof crypto.argon2 !== 'function') throw new Error(`Node ${process.versions.node} lacks crypto.argon2 — use Node 24.7 or newer.`);

const config = loadConfig();
const services = createServices(config, { info: (m) => console.log(`[vela] ${m}`), warn: (m) => console.warn(`[vela] ${m}`) });
const app = await buildApp({ config, ...services });
await ensureAdmin(services.auth, config, { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });

const shutdown = async (signal: string) => {
    app.log.info(`${signal} — shutting down`);
    await app.close().catch(() => undefined);
    services.close();
    process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
