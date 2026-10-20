// Dev loop: rebuild web + server on save and restart the server — the same single-origin
// setup as production (pages and API from one process), so auth and CSP are exercised.
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { serverBuild } from './build-server.mjs';

const web = spawn('npx', ['vite', 'build', '--watch', '--mode', 'development'], { stdio: 'inherit' });
const ctx = await context(serverBuild);
await ctx.rebuild();
await ctx.watch();
const env = { ...process.env, PORT: process.env.PORT ?? '8080' };
const server = spawn(process.execPath, ['--enable-source-maps', '--watch-path=dist/server', 'dist/server/index.js'], { stdio: 'inherit', env });
const stop = () => {
    web.kill();
    server.kill();
    void ctx.dispose();
    process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
